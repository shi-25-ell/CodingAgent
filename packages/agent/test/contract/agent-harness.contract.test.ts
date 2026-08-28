import type { ModelFailure, ModelResponse } from "@coding-agent/model";
import { ScriptedModel } from "@coding-agent/model/testing";
import { describe, expect, it } from "vitest";
import {
  createAgent,
  createAgentHarness,
  createDisabledToolExecutor,
  createFixedRunPolicies,
  createTranscriptContextManager,
  type HarnessEvent,
  type RunReport,
} from "../../src/index.js";
import {
  InMemorySessionRepository,
  ManualClock,
  ManualGate,
  SequentialIdFactory,
} from "../../src/testing/index.js";

interface Scenario {
  readonly report: RunReport;
  readonly events: readonly HarnessEvent[];
  readonly ledgerKinds: readonly string[];
}

function response(
  text: string,
  finishReason: ModelResponse["finishReason"] = "stop",
): ModelResponse {
  return {
    version: 1,
    content: [{ type: "text", text }],
    finishReason,
    usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<readonly T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

async function runScenario(model: ScriptedModel): Promise<Scenario> {
  const clock = new ManualClock(1_000);
  const ids = new SequentialIdFactory();
  const repository = new InMemorySessionRepository({ clock, ids });
  const session = await repository.create({
    workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
  });
  const snapshot = await session.inspect();
  const harness = createAgentHarness({ agent: createAgent() });
  const handle = await harness.startRun({
    session,
    branchId: snapshot.currentBranchId,
    initialMessages: [{ role: "user", text: "完成目标" }],
    model,
    tools: createDisabledToolExecutor(),
    context: createTranscriptContextManager({
      instructions: [{ type: "text", text: "你是 coding agent" }],
      maxOutputTokens: 256,
    }),
    policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 }),
    metadata: { task: "完成目标", configurationRevision: "m0" },
  });
  const eventsPromise = collect(handle.events());
  const report = await handle.finished;
  const events = await eventsPromise;
  const branch = await session.readBranch({ branchId: snapshot.currentBranchId });
  await repository[Symbol.asyncDispose]();
  return { report, events, ledgerKinds: branch.records.map((record) => record.kind) };
}

function expectExactlyOneTerminal(scenario: Scenario, expected: RunReport["status"]): void {
  const terminals = scenario.events.filter((event) => event.type === "terminal");
  expect(terminals).toHaveLength(1);
  expect(terminals[0]).toMatchObject({ report: { status: expected } });
  expect(scenario.ledgerKinds.filter((kind) => kind === "run_terminal")).toHaveLength(1);
  expect(scenario.ledgerKinds.at(-1)).toBe("run_terminal");
}

describe("AgentHarness terminal contract", () => {
  it("completed：assistant commit 后才提交唯一 terminal", async () => {
    const scenario = await runScenario(
      new ScriptedModel([{ outcome: { status: "completed", response: response("已完成") } }]),
    );

    expect(scenario.report).toMatchObject({
      status: "completed",
      terminationReason: "natural_completion",
      finalAnswer: "已完成",
      counts: { modelTurnCount: 1, modelAttemptCount: 1 },
    });
    expect(scenario.ledgerKinds).toEqual([
      "run_started",
      "user_message",
      "assistant_message",
      "run_terminal",
    ]);
    expectExactlyOneTerminal(scenario, "completed");
  });

  it("failed：non-retryable model failure 形成 redacted error report", async () => {
    const failure: ModelFailure = {
      category: "authentication",
      retryable: false,
      message: "credential unavailable",
    };
    const scenario = await runScenario(
      new ScriptedModel([{ outcome: { status: "failed", failure } }]),
    );

    expect(scenario.report).toMatchObject({
      status: "failed",
      terminationReason: "model_failure",
      error: { code: "MODEL_AUTHENTICATION", message: "credential unavailable" },
    });
    expectExactlyOneTerminal(scenario, "failed");
  });

  it("failed：Run 建立后的 context failure 被归一化且不泄漏原始信息", async () => {
    const clock = new ManualClock(1_500);
    const ids = new SequentialIdFactory();
    const repository = new InMemorySessionRepository({ clock, ids });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const harness = createAgentHarness({ agent: createAgent() });
    const handle = await harness.startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "触发 context failure" }],
      model: new ScriptedModel([]),
      tools: createDisabledToolExecutor(),
      context: {
        async prepare() {
          throw new Error("sensitive local detail");
        },
      },
      policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 }),
      metadata: { task: "触发 context failure", configurationRevision: "m0" },
    });
    const eventsPromise = collect(handle.events());

    const report = await handle.finished;
    const events = await eventsPromise;
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });

    expect(report).toMatchObject({
      status: "failed",
      terminationReason: "persistence_failure",
      counts: { modelTurnCount: 1, modelAttemptCount: 1 },
      error: { code: "AGENT_DEPENDENCY_FAILURE", message: "Agent dependency failed" },
    });
    expect(JSON.stringify(report)).not.toContain("sensitive local detail");
    expectExactlyOneTerminal(
      { report, events, ledgerKinds: branch.records.map((record) => record.kind) },
      "failed",
    );
    await repository[Symbol.asyncDispose]();
  });

  it("limited：output token limit 是明确终态而非 completed", async () => {
    const scenario = await runScenario(
      new ScriptedModel([
        { outcome: { status: "completed", response: response("未完整", "length") } },
      ]),
    );

    expect(scenario.report).toMatchObject({
      status: "limited",
      terminationReason: "model_output_limit",
      finalAnswer: "未完整",
      unfinishedWork: ["模型输出达到上限，回答可能不完整"],
    });
    expectExactlyOneTerminal(scenario, "limited");
  });

  it("aborted：重复 abort 与 gate 释放后的 late activity 不产生第二终态", async () => {
    const clock = new ManualClock(2_000);
    const ids = new SequentialIdFactory();
    const repository = new InMemorySessionRepository({ clock, ids });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const gate = new ManualGate();
    const model = new ScriptedModel([
      {
        outcome: { status: "completed", response: response("late") },
        before: (signal) => gate.wait(signal).then(() => undefined),
      },
    ]);
    const harness = createAgentHarness({ agent: createAgent() });
    const handle = await harness.startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "等待中止" }],
      model,
      tools: createDisabledToolExecutor(),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 }),
      metadata: { task: "等待中止", configurationRevision: "m0" },
    });
    const eventsPromise = collect(handle.events());
    await gate.waitUntilBlocked();

    const first = await handle.dispatch({ commandId: "abort-1", type: "abort", reason: "user" });
    const duplicate = await handle.dispatch({
      commandId: "abort-2",
      type: "abort",
      reason: "again",
    });
    gate.open();
    const report = await handle.finished;
    const events = await eventsPromise;
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });

    expect(first).toEqual({ commandId: "abort-1", status: "accepted" });
    expect(duplicate).toEqual({ commandId: "abort-2", status: "already_applied" });
    expect(report).toMatchObject({ status: "aborted", terminationReason: "user_abort" });
    expectExactlyOneTerminal(
      { report, events, ledgerKinds: branch.records.map((record) => record.kind) },
      "aborted",
    );
    await repository[Symbol.asyncDispose]();
  });
});
