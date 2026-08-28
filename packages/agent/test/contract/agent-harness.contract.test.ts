import type { Model, ModelFailure, ModelResponse } from "@coding-agent/model";
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
  type ToolExecutor,
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

async function runScenario(
  model: Model,
  policyOptions = { maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 },
): Promise<Scenario> {
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
    policies: createFixedRunPolicies(policyOptions),
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
  it("Steering 在 tool batch 后的 safe point 按 FIFO durable delivery", async () => {
    const repository = new InMemorySessionRepository({
      clock: new ManualClock(700),
      ids: new SequentialIdFactory(),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const toolGate = new ManualGate();
    const model = new ScriptedModel([
      {
        outcome: {
          status: "completed",
          response: {
            version: 1,
            content: [
              { type: "tool_call", callId: "read-queue", name: "read_file", arguments: {} },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        assertRequest(request) {
          expect(request.messages.slice(-3)).toEqual([
            { role: "tool", callId: "read-queue", content: "done", isError: false },
            { role: "user", content: [{ type: "text", text: "先检查边界" }] },
            { role: "user", content: [{ type: "text", text: "再运行验证" }] },
          ]);
        },
        outcome: { status: "completed", response: response("完成") },
      },
    ]);
    const handle = await createAgentHarness({ agent: createAgent() }).startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "开始" }],
      model,
      tools: {
        definitions: () => [],
        execute(call) {
          return {
            updates: (async function* () {})(),
            outcome: toolGate.wait().then(() => ({
              callId: call.callId,
              status: "succeeded" as const,
              isError: false,
              modelContent: "done",
              effectState: "none" as const,
              abortObserved: false,
              artifacts: [],
            })),
          };
        },
      },
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 2, maxModelAttempts: 2, maxRetries: 0 }),
      metadata: { task: "开始", configurationRevision: "m2" },
    });
    await toolGate.waitUntilBlocked();

    await expect(
      handle.dispatch({ commandId: "steer-1", type: "steer", text: "先检查边界" }),
    ).resolves.toEqual({ commandId: "steer-1", status: "accepted" });
    await expect(
      handle.dispatch({ commandId: "steer-2", type: "steer", text: "再运行验证" }),
    ).resolves.toEqual({ commandId: "steer-2", status: "accepted" });
    await expect(
      handle.dispatch({ commandId: "steer-1", type: "steer", text: "不得重复" }),
    ).resolves.toEqual({ commandId: "steer-1", status: "already_applied" });

    toolGate.open();
    await expect(handle.finished).resolves.toMatchObject({
      status: "completed",
      finalAnswer: "完成",
    });
    model.assertConsumed();
    await repository[Symbol.asyncDispose]();
  });

  it("Follow-up 在 completion candidate 每次取一个并按 FIFO 延续同一 Run", async () => {
    const repository = new InMemorySessionRepository({
      clock: new ManualClock(750),
      ids: new SequentialIdFactory(),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const modelGate = new ManualGate();
    const model = new ScriptedModel([
      {
        before: (signal) => modelGate.wait(signal).then(() => undefined),
        outcome: { status: "completed", response: response("第一段") },
      },
      {
        assertRequest(request) {
          expect(request.messages.at(-1)).toEqual({
            role: "user",
            content: [{ type: "text", text: "补充一" }],
          });
        },
        outcome: { status: "completed", response: response("第二段") },
      },
      {
        assertRequest(request) {
          expect(request.messages.at(-1)).toEqual({
            role: "user",
            content: [{ type: "text", text: "补充二" }],
          });
        },
        outcome: { status: "completed", response: response("最终完成") },
      },
    ]);
    const handle = await createAgentHarness({ agent: createAgent() }).startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "开始" }],
      model,
      tools: createDisabledToolExecutor(),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 3, maxModelAttempts: 3, maxRetries: 0 }),
      metadata: { task: "开始", configurationRevision: "m2" },
    });
    await modelGate.waitUntilBlocked();
    await handle.dispatch({ commandId: "follow-1", type: "follow_up", text: "补充一" });
    await handle.dispatch({ commandId: "follow-2", type: "follow_up", text: "补充二" });
    modelGate.open();

    await expect(handle.finished).resolves.toMatchObject({
      status: "completed",
      finalAnswer: "最终完成",
      counts: { modelTurnCount: 3 },
    });
    model.assertConsumed();
    await repository[Symbol.asyncDispose]();
  });
  it("Attempt 已产生 semantic output 后即使 failure retryable 也不重试", async () => {
    let attempts = 0;
    const descriptor = new ScriptedModel([]).descriptor;
    const model: Model = {
      descriptor,
      capabilities: descriptor.capabilities,
      async *stream() {
        attempts += 1;
        yield { version: 1, type: "turn_started", attemptId: `partial-${attempts}` };
        yield { version: 1, type: "part_started", index: 0, part: { type: "text" } };
        yield { version: 1, type: "text_delta", index: 0, delta: "partial" };
        yield {
          version: 1,
          type: "turn_failed",
          failure: { category: "network", retryable: true, message: "stream interrupted" },
        };
      },
    };
    const scenario = await runScenario(model, {
      maxModelTurns: 1,
      maxModelAttempts: 2,
      maxRetries: 1,
    });

    expect(attempts).toBe(1);
    expect(scenario.report).toMatchObject({ status: "failed", terminationReason: "model_failure" });
  });

  it("retry 获批但 Attempt budget 用尽时进入明确 limited 终态", async () => {
    const scenario = await runScenario(
      new ScriptedModel([
        {
          outcome: {
            status: "failed",
            failure: { category: "rate_limit", retryable: true, message: "busy" },
          },
        },
      ]),
      { maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 1 },
    );

    expect(scenario.report).toMatchObject({
      status: "limited",
      terminationReason: "model_attempt_limit",
      counts: { modelTurnCount: 1, modelAttemptCount: 1 },
    });
  });

  it("retryable ModelFailure 由 Agent policy 在同一 Turn 内重试", async () => {
    const clock = new ManualClock(800);
    const repository = new InMemorySessionRepository({
      clock,
      ids: new SequentialIdFactory(),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const model = new ScriptedModel([
      {
        outcome: {
          status: "failed",
          failure: { category: "rate_limit", retryable: true, message: "稍后重试" },
        },
      },
      { outcome: { status: "completed", response: response("重试后完成") } },
    ]);
    const handle = await createAgentHarness({ agent: createAgent() }).startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "重试" }],
      model,
      tools: createDisabledToolExecutor(),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 2, maxRetries: 1 }),
      metadata: { task: "重试", configurationRevision: "m1" },
    });

    await expect(handle.finished).resolves.toMatchObject({
      status: "completed",
      finalAnswer: "重试后完成",
      counts: { modelTurnCount: 1, modelAttemptCount: 2 },
    });
    model.assertConsumed();
    await repository[Symbol.asyncDispose]();
  });

  it("abort during retry wait 清理 waiter 且不启动下一 Model Attempt", async () => {
    const retryGate = new ManualGate();
    const repository = new InMemorySessionRepository({
      clock: new ManualClock(825),
      ids: new SequentialIdFactory(),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const model = new ScriptedModel([
      {
        outcome: {
          status: "failed",
          failure: { category: "rate_limit", retryable: true, message: "retry later" },
        },
      },
    ]);
    const handle = await createAgentHarness({ agent: createAgent() }).startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "等待 retry" }],
      model,
      tools: createDisabledToolExecutor(),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({
        maxModelTurns: 1,
        maxModelAttempts: 2,
        maxRetries: 1,
        retryDelayMs: 1_000,
        retryWaiter: {
          wait: (delayMs, signal) => {
            expect(delayMs).toBe(1_000);
            return retryGate
              .wait(signal)
              .then((status) => (status === "aborted" ? "aborted" : "elapsed"));
          },
        },
      }),
      metadata: { task: "等待 retry", configurationRevision: "m2" },
    });
    await retryGate.waitUntilBlocked();
    await handle.dispatch({ commandId: "abort-retry", type: "abort" });

    await expect(handle.finished).resolves.toMatchObject({
      status: "aborted",
      terminationReason: "user_abort",
      counts: { modelAttemptCount: 1 },
    });
    expect(retryGate.blockedCount()).toBe(0);
    model.assertConsumed();
    await repository[Symbol.asyncDispose]();
  });

  it("tool-call batch 不一致时在执行前失败", async () => {
    const invalid: ModelResponse = {
      version: 1,
      content: [
        { type: "tool_call", callId: "same", name: "read_file", arguments: {} },
        { type: "tool_call", callId: "same", name: "read_file", arguments: {} },
      ],
      finishReason: "tool_calls",
    };
    const scenario = await runScenario(
      new ScriptedModel([{ outcome: { status: "completed", response: invalid } }]),
    );

    expect(scenario.report).toMatchObject({
      status: "failed",
      terminationReason: "invalid_model_response",
      counts: { toolCallCount: 0, settledToolCallCount: 0 },
    });
    expect(scenario.ledgerKinds).toEqual([
      "run_started",
      "user_message",
      "model_failure",
      "run_terminal",
    ]);
  });

  it("tool batch 完成后没有剩余 Turn 时进入明确 limited 终态", async () => {
    const repository = new InMemorySessionRepository({
      clock: new ManualClock(850),
      ids: new SequentialIdFactory(),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const tools: ToolExecutor = {
      definitions: () => [],
      execute(call) {
        return {
          updates: (async function* () {
            yield { version: 1 as const, type: "progress" as const, message: "读取中" };
          })(),
          outcome: Promise.resolve({
            callId: call.callId,
            status: "failed" as const,
            isError: true,
            modelContent: "文件不存在",
            effectState: "none" as const,
            abortObserved: false,
            artifacts: [],
          }),
        };
      },
    };
    const model = new ScriptedModel([
      {
        outcome: {
          status: "completed",
          response: {
            version: 1,
            content: [
              { type: "tool_call", callId: "call-limit", name: "read_file", arguments: {} },
            ],
            finishReason: "tool_calls",
          },
        },
      },
    ]);
    const handle = await createAgentHarness({ agent: createAgent() }).startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "读取" }],
      model,
      tools,
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 }),
      metadata: { task: "读取", configurationRevision: "m1" },
    });

    await expect(handle.finished).resolves.toMatchObject({
      status: "limited",
      terminationReason: "model_turn_limit",
      counts: { toolCallCount: 1, settledToolCallCount: 1 },
      tools: { failed: 1 },
    });
    await repository[Symbol.asyncDispose]();
  });

  it("ToolExecutor 的同步异常被收敛为基础设施失败", async () => {
    const repository = new InMemorySessionRepository({
      clock: new ManualClock(875),
      ids: new SequentialIdFactory(),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const handle = await createAgentHarness({ agent: createAgent() }).startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "调用" }],
      model: new ScriptedModel([
        {
          outcome: {
            status: "completed",
            response: {
              version: 1,
              content: [
                { type: "tool_call", callId: "call-ok", name: "ok", arguments: {} },
                { type: "tool_call", callId: "call-broken", name: "broken", arguments: {} },
                { type: "tool_call", callId: "call-unstarted", name: "later", arguments: {} },
              ],
              finishReason: "tool_calls",
            },
          },
        },
      ]),
      tools: {
        definitions: () => [],
        execute(call) {
          if (call.callId === "call-broken") throw new Error("private executor detail");
          if (call.callId === "call-unstarted") throw new Error("unstarted call 不得执行");
          return {
            updates: (async function* () {})(),
            outcome: Promise.resolve({
              callId: call.callId,
              status: "succeeded" as const,
              isError: false,
              modelContent: "ok",
              effectState: "none" as const,
              abortObserved: false,
              artifacts: [],
            }),
          };
        },
      },
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 2, maxModelAttempts: 2, maxRetries: 0 }),
      metadata: { task: "调用", configurationRevision: "m1" },
    });

    const report = await handle.finished;
    expect(report).toMatchObject({
      status: "failed",
      terminationReason: "tool_infrastructure_failure",
      error: { code: "TOOL_INFRASTRUCTURE_FAILURE" },
      counts: { toolCallCount: 3, settledToolCallCount: 3 },
      tools: { accepted: 3, settled: 3, succeeded: 1, failed: 2 },
    });
    expect(JSON.stringify(report)).not.toContain("private executor detail");
    await repository[Symbol.asyncDispose]();
  });

  it("assistant durable 后执行 tool，并把 outcome 配对到下一次 Model Turn", async () => {
    const repository = new InMemorySessionRepository({
      clock: new ManualClock(900),
      ids: new SequentialIdFactory(),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    let executeCount = 0;
    const tools: ToolExecutor = {
      definitions: () => [
        {
          name: "read_file",
          description: "读取文件",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      execute(call) {
        executeCount += 1;
        return {
          updates: (async function* () {})(),
          outcome: (async () => {
            const branch = await session.readBranch({ branchId: snapshot.currentBranchId });
            expect(branch.records.at(-1)?.kind).toBe("assistant_message");
            return {
              callId: call.callId,
              status: "succeeded" as const,
              isError: false,
              modelContent: "file contents",
              effectState: "none" as const,
              abortObserved: false,
              artifacts: [],
            };
          })(),
        };
      },
    };
    const model = new ScriptedModel([
      {
        outcome: {
          status: "completed",
          response: {
            version: 1,
            content: [
              {
                type: "tool_call",
                callId: "call-1",
                name: "read_file",
                arguments: { path: "src/a.ts" },
              },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        assertRequest(request) {
          expect(request.messages).toEqual([
            { role: "user", content: [{ type: "text", text: "读取并回答" }] },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  callId: "call-1",
                  name: "read_file",
                  arguments: { path: "src/a.ts" },
                },
              ],
              finishReason: "tool_calls",
            },
            { role: "tool", callId: "call-1", content: "file contents", isError: false },
          ]);
        },
        outcome: { status: "completed", response: response("最终回答") },
      },
    ]);
    const handle = await createAgentHarness({ agent: createAgent() }).startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "读取并回答" }],
      model,
      tools,
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 2, maxModelAttempts: 2, maxRetries: 0 }),
      metadata: { task: "读取并回答", configurationRevision: "m1" },
    });

    const report = await handle.finished;
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });

    expect(executeCount).toBe(1);
    expect(report).toMatchObject({
      status: "completed",
      finalAnswer: "最终回答",
      counts: {
        modelTurnCount: 2,
        modelAttemptCount: 2,
        toolCallCount: 1,
        settledToolCallCount: 1,
      },
      tools: { accepted: 1, settled: 1, succeeded: 1, failed: 0 },
    });
    expect(branch.records.map((record) => record.kind)).toEqual([
      "run_started",
      "user_message",
      "assistant_message",
      "tool_outcome",
      "assistant_message",
      "run_terminal",
    ]);
    model.assertConsumed();
    await repository[Symbol.asyncDispose]();
  });

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
      terminationReason: "context_unavailable",
      counts: { modelTurnCount: 1, modelAttemptCount: 0 },
      error: { code: "CONTEXT_UNAVAILABLE", message: "Model Context unavailable" },
    });
    expect(JSON.stringify(report)).not.toContain("sensitive local detail");
    expectExactlyOneTerminal(
      { report, events, ledgerKinds: branch.records.map((record) => record.kind) },
      "failed",
    );
    await repository[Symbol.asyncDispose]();
  });

  it("aborted：assistant commit 期间接受 abort 后不能落入 completed", async () => {
    const commitGate = new ManualGate();
    const clock = new ManualClock(1_750);
    const ids = new SequentialIdFactory();
    const repository = new InMemorySessionRepository({
      clock,
      ids,
      beforeAppend: () => commitGate.wait().then(() => undefined),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const harness = createAgentHarness({ agent: createAgent() });
    const handle = await harness.startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "commit 中取消" }],
      model: new ScriptedModel([
        { outcome: { status: "completed", response: response("已生成但尚未 commit") } },
      ]),
      tools: createDisabledToolExecutor(),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 }),
      metadata: { task: "commit 中取消", configurationRevision: "m0" },
    });
    const eventsPromise = collect(handle.events());
    await commitGate.waitUntilBlocked();

    await handle.dispatch({ commandId: "abort-commit", type: "abort" });
    commitGate.open();
    const report = await handle.finished;
    const events = await eventsPromise;
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });

    expect(report).toMatchObject({ status: "aborted", terminationReason: "user_abort" });
    expect(branch.records.map((record) => record.kind)).toEqual([
      "run_started",
      "user_message",
      "assistant_message",
      "run_terminal",
    ]);
    expectExactlyOneTerminal(
      { report, events, ledgerKinds: branch.records.map((record) => record.kind) },
      "aborted",
    );
    await repository[Symbol.asyncDispose]();
  });

  it("finalizing：terminal commit 开始后 abort 明确返回 not_active", async () => {
    const finishGate = new ManualGate();
    const clock = new ManualClock(1_900);
    const ids = new SequentialIdFactory();
    const repository = new InMemorySessionRepository({
      clock,
      ids,
      beforeFinish: () => finishGate.wait().then(() => undefined),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const harness = createAgentHarness({ agent: createAgent() });
    const handle = await harness.startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "terminal fault" }],
      model: new ScriptedModel([
        { outcome: { status: "completed", response: response("原始完成回答") } },
      ]),
      tools: createDisabledToolExecutor(),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 }),
      metadata: { task: "terminal fault", configurationRevision: "m0" },
    });
    const eventsPromise = collect(handle.events());
    await finishGate.waitUntilBlocked();

    const ack = await handle.dispatch({ commandId: "abort-finalizing", type: "abort" });
    finishGate.open();
    const report = await handle.finished;
    const events = await eventsPromise;
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });

    expect(ack).toEqual({ commandId: "abort-finalizing", status: "not_active" });
    expect(report).toMatchObject({ status: "completed", terminationReason: "natural_completion" });
    expectExactlyOneTerminal(
      { report, events, ledgerKinds: branch.records.map((record) => record.kind) },
      "completed",
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

  it("abort during model continuation 不重复 tool settlement 或 terminal", async () => {
    const continuationGate = new ManualGate();
    const repository = new InMemorySessionRepository({
      clock: new ManualClock(2_100),
      ids: new SequentialIdFactory(),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const model = new ScriptedModel([
      {
        outcome: {
          status: "completed",
          response: {
            version: 1,
            content: [
              { type: "tool_call", callId: "continuation-tool", name: "read_file", arguments: {} },
            ],
            finishReason: "tool_calls",
          },
        },
      },
      {
        before: (signal) => continuationGate.wait(signal).then(() => undefined),
        outcome: { status: "completed", response: response("late continuation") },
      },
    ]);
    const handle = await createAgentHarness({ agent: createAgent() }).startRun({
      session,
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "先工具后取消" }],
      model,
      tools: {
        definitions: () => [],
        execute(call) {
          return {
            updates: (async function* () {})(),
            outcome: Promise.resolve({
              callId: call.callId,
              status: "succeeded" as const,
              isError: false,
              modelContent: "done",
              effectState: "none" as const,
              abortObserved: false,
              artifacts: [],
            }),
          };
        },
      },
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 2, maxModelAttempts: 2, maxRetries: 0 }),
      metadata: { task: "先工具后取消", configurationRevision: "m2" },
    });
    const eventsPromise = collect(handle.events());
    await continuationGate.waitUntilBlocked();
    await handle.dispatch({ commandId: "abort-continuation", type: "abort" });
    const report = await handle.finished;
    const events = await eventsPromise;
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });

    expect(report).toMatchObject({
      status: "aborted",
      counts: {
        modelTurnCount: 2,
        modelAttemptCount: 2,
        toolCallCount: 1,
        settledToolCallCount: 1,
      },
    });
    expectExactlyOneTerminal(
      { report, events, ledgerKinds: branch.records.map((record) => record.kind) },
      "aborted",
    );
    model.assertConsumed();
    await repository[Symbol.asyncDispose]();
  });
});
