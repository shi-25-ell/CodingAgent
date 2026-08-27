import { describe, expect, it } from "vitest";
import {
  ScriptedModelAdapter,
  type ScriptedModelStep,
} from "../../model/scripted-model-adapter.js";
import { AgentRuntime } from "../../runtime/agent-runtime.js";
import {
  BoundedModelRetryPolicy,
  FixedTurnLimitStopPolicy,
  NeverStopPolicy,
} from "../../runtime/policies.js";
import type { RuntimeHost, RuntimeSemanticEvent } from "../../runtime/runtime.js";
import { EmptyToolPort } from "../../runtime/tool-port.js";
import { ManualClock } from "../../testing/manual-clock.js";

describe("AgentRuntime", () => {
  it("commits one complete assistant message before completed/no_tool_calls", async () => {
    const fixture = createRuntime([completedStep("answer")]);

    const result = await runToEnd(fixture);

    expect(result.outcome).toMatchObject({
      status: "completed",
      reason: "no_tool_calls",
      finalAnswer: "answer",
      counts: { modelTurns: 1, modelAttempts: 1, toolCalls: 0 },
    });
    expect(fixture.host.records.map((event) => event.type)).toEqual([
      "phase_changed",
      "phase_changed",
      "model_attempt_started",
      "phase_changed",
      "phase_changed",
      "assistant_committed",
      "phase_changed",
      "phase_changed",
      "terminal",
    ]);
    expect(result.events.filter((event) => event.type === "terminal")).toHaveLength(1);
    fixture.adapter.assertComplete();
    fixture.clock.assertIdle();
  });

  it("ends with failed/model_error when a non-retryable model attempt fails", async () => {
    const fixture = createRuntime([failedStep("authentication", false)]);

    const { outcome, events } = await runToEnd(fixture);

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "model_error",
      counts: { modelTurns: 1, modelAttempts: 1 },
      errorSummary: "provider failure",
    });
    expect(events.filter((event) => event.type === "terminal")).toHaveLength(1);
    fixture.adapter.assertComplete();
  });

  it("retries transport failure without creating a second Model Turn", async () => {
    const fixture = createRuntime([failedStep("network", true), completedStep("recovered")], {
      retryPolicy: new BoundedModelRetryPolicy(2, () => 0),
    });

    const { outcome } = await runToEnd(fixture);

    expect(outcome).toMatchObject({
      status: "completed",
      counts: { modelTurns: 1, modelAttempts: 2 },
      retries: 1,
    });
    fixture.adapter.assertComplete();
  });

  it("applies an injected policy limit only after committing the assistant turn", async () => {
    const fixture = createRuntime([completedStep("partial")], {
      stopPolicy: new FixedTurnLimitStopPolicy(1),
    });

    const { outcome } = await runToEnd(fixture);

    expect(outcome).toMatchObject({
      status: "limited",
      reason: "policy_limit",
      finalAnswer: "partial",
      unfinishedWork: ["Run stopped by the configured Model Turn limit"],
    });
    const types = fixture.host.records.map((event) => event.type);
    expect(types.indexOf("assistant_committed")).toBeLessThan(types.indexOf("terminal"));
  });

  it("aborts before the first request without consuming a Model Attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = createRuntime([], { signal: controller.signal });

    const { outcome, events } = await runToEnd(fixture);

    expect(outcome).toMatchObject({
      status: "aborted",
      reason: "user_abort",
      counts: { modelTurns: 0, modelAttempts: 0 },
    });
    expect(events.filter((event) => event.type === "terminal")).toHaveLength(1);
    fixture.adapter.assertComplete();
  });

  it("resolves failed/persistence_error and closes handles when semantic persistence fails", async () => {
    const fixture = createRuntime([]);
    const host = new FailOnceHost();
    fixture.host = host;

    const { outcome, events } = await runToEnd(fixture);

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "persistence_error",
      counts: { modelTurns: 0, modelAttempts: 0 },
    });
    expect(events.filter((event) => event.type === "terminal")).toHaveLength(1);
    expect(host.records.at(-1)).toMatchObject({
      type: "terminal",
      status: "failed",
      reason: "persistence_error",
    });
    fixture.adapter.assertComplete();
  });

  it("records request diagnostics when a stream ends without a terminal event", async () => {
    const fixture = createRuntime([
      {
        emissions: [{ event: { type: "turn_started", requestId: "request-truncated" } }],
      },
    ]);

    const { outcome } = await runToEnd(fixture);

    expect(outcome).toMatchObject({ status: "failed", reason: "stream_truncated" });
    expect(fixture.host.records).toContainEqual(
      expect.objectContaining({
        type: "model_attempt_failed",
        requestId: "request-truncated",
        failure: expect.objectContaining({ category: "provider_protocol" }),
      }),
    );
    fixture.adapter.assertComplete();
  });
});

class RecordingHost implements RuntimeHost {
  public readonly records: RuntimeSemanticEvent[] = [];

  public async record(event: RuntimeSemanticEvent): Promise<void> {
    this.records.push(event);
  }

  public async drainSteering() {
    return [];
  }

  public async takeFollowUp() {
    return undefined;
  }
}

class FailOnceHost extends RecordingHost {
  private shouldFail = true;

  public override async record(event: RuntimeSemanticEvent): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("injected persistence failure");
    }
    await super.record(event);
  }
}

function createRuntime(
  steps: readonly ScriptedModelStep[],
  overrides: {
    stopPolicy?: NeverStopPolicy | FixedTurnLimitStopPolicy;
    retryPolicy?: BoundedModelRetryPolicy;
    signal?: AbortSignal;
  } = {},
) {
  const clock = new ManualClock(1_000);
  return {
    runtime: new AgentRuntime(),
    adapter: new ScriptedModelAdapter(steps, clock),
    clock,
    host: new RecordingHost(),
    signal: overrides.signal ?? new AbortController().signal,
    stopPolicy: overrides.stopPolicy ?? new NeverStopPolicy(),
    retryPolicy: overrides.retryPolicy ?? new BoundedModelRetryPolicy(1, () => 0),
  };
}

async function runToEnd(fixture: ReturnType<typeof createRuntime>) {
  const execution = fixture.runtime.run(
    {
      instructions: "You are a coding agent.",
      messages: [{ role: "user", content: "task" }],
      model: fixture.adapter,
      tools: new EmptyToolPort(),
      stopPolicy: fixture.stopPolicy,
      retryPolicy: fixture.retryPolicy,
      clock: fixture.clock,
      signal: fixture.signal,
    },
    fixture.host,
  );
  const outcome = await execution.completion;
  const events = [];
  for await (const event of execution.events) {
    events.push(event);
  }
  return { outcome, events };
}

function completedStep(text: string): ScriptedModelStep {
  return {
    expectedRequest: { lastUserText: "task", toolChoice: "none" },
    emissions: [
      { event: { type: "turn_started", requestId: "request-ok" } },
      { event: { type: "part_started", index: 0, part: { type: "text" } } },
      { event: { type: "text_delta", index: 0, delta: text } },
      { event: { type: "part_completed", index: 0 } },
      {
        event: {
          type: "turn_completed",
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      },
    ],
  };
}

function failedStep(category: "authentication" | "network", retryable: boolean): ScriptedModelStep {
  return {
    expectedRequest: { lastUserText: "task" },
    emissions: [
      { event: { type: "turn_started", requestId: "request-failed" } },
      {
        event: {
          type: "turn_failed",
          failure: { category, retryable, message: "provider failure" },
        },
      },
    ],
  };
}
