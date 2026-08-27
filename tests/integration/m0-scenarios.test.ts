import { describe, expect, it } from "vitest";
import type { ScriptedModelStep } from "../../model/scripted-model-adapter.js";
import { ScenarioHarness } from "../../testing/scenario-harness.js";

describe("Fast M0 vertical scenarios", () => {
  it("walks FastController through the real Modules to completed/no_tool_calls", async () => {
    const harness = new ScenarioHarness({ steps: [completedStep("implement complete")] });

    const result = await harness.run("M0 task");

    expect(result.report).toMatchObject({
      status: "completed",
      terminationReason: "no_tool_calls",
      finalAnswer: "implement complete",
      counts: { modelTurns: 1, modelAttempts: 1, toolCalls: 0 },
      workspace: { ending: { state: "observed", changedFiles: [] } },
    });
    expect(result.session.transcript.map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual(
      result.events.map((_, index) => index + 1),
    );
    expect(result.events.filter((event) => event.type === "run_finished")).toHaveLength(1);
    harness.assertClean();
  });

  it("normalizes model failure into one failed RunReport", async () => {
    const harness = new ScenarioHarness({
      steps: [
        {
          emissions: [
            { event: { type: "turn_started", requestId: "request-auth" } },
            {
              event: {
                type: "turn_failed",
                failure: {
                  category: "authentication",
                  retryable: false,
                  message: "credential rejected",
                },
              },
            },
          ],
        },
      ],
    });

    const result = await harness.run("M0 task");

    expect(result.report).toMatchObject({
      status: "failed",
      terminationReason: "model_error",
      errorSummary: "credential rejected",
    });
    expect(result.session.runs).toHaveLength(1);
    expect(result.session.runs[0]?.status).toBe("terminal");
    expect(result.session.operations).toContainEqual(
      expect.objectContaining({
        operation: expect.objectContaining({
          type: "model_attempt_failed",
          message: "credential rejected",
          requestId: "request-auth",
        }),
      }),
    );
    harness.assertClean();
  });

  it("commits the assistant before a policy-limited RunReport", async () => {
    const harness = new ScenarioHarness({
      steps: [completedStep("partial")],
      maximumModelTurns: 1,
    });

    const result = await harness.run("M0 task");

    expect(result.report).toMatchObject({
      status: "limited",
      terminationReason: "policy_limit",
      unfinishedWork: ["Run stopped by the configured Model Turn limit"],
    });
    expect(result.session.transcript.at(-1)?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
    });
    harness.assertClean();
  });

  it("aborts an established Run before its first model request", async () => {
    const harness = new ScenarioHarness({ steps: [] });

    const result = await harness.run("M0 task", { abortBeforeRequest: true });

    expect(result.abortAck).toEqual({
      commandId: "abort-1",
      accepted: true,
      kind: "abort_requested",
    });
    expect(result.report).toMatchObject({
      status: "aborted",
      terminationReason: "user_abort",
      counts: { modelTurns: 0, modelAttempts: 0 },
    });
    expect(result.session.transcript.map((entry) => entry.message.role)).toEqual(["user"]);
    harness.assertClean();
  });

  it("resolves one failed RunReport and releases handles after a persistence fault", async () => {
    const harness = new ScenarioHarness({ steps: [], failFirstRuntimeRecord: true });

    const result = await harness.run("M0 task");

    expect(result.report).toMatchObject({
      status: "failed",
      terminationReason: "persistence_error",
      counts: { modelTurns: 0, modelAttempts: 0 },
    });
    expect(result.events.filter((event) => event.type === "run_finished")).toHaveLength(1);
    expect(result.session.runs[0]).toMatchObject({
      status: "terminal",
      report: { terminationReason: "persistence_error" },
    });
    harness.assertClean();
  });

  it("reconciles an ambiguous finish fault without a second terminal", async () => {
    const harness = new ScenarioHarness({
      steps: [completedStep("finish recovered")],
      failFirstFinish: true,
    });

    const result = await harness.run("M0 task");

    expect(result.report).toMatchObject({
      status: "completed",
      terminationReason: "no_tool_calls",
    });
    expect(result.session.activeRunId).toBeUndefined();
    expect(
      result.session.operations.filter((record) => record.operation.type === "terminal"),
    ).toHaveLength(1);
    harness.assertClean();
  });

  it("records the observed ending workspace instead of copying the starting baseline", async () => {
    const harness = new ScenarioHarness({
      steps: [completedStep("workspace observed")],
      endingChangedFiles: ["src/example.ts"],
    });

    const result = await harness.run("M0 task");

    expect(result.report.workspace.ending).toEqual({
      state: "observed",
      head: "b".repeat(40),
      fingerprint: "dirty:b",
      changedFiles: ["src/example.ts"],
    });
    harness.assertClean();
  });

  it("reconciles a finish fault raised after the report was committed", async () => {
    const harness = new ScenarioHarness({
      steps: [completedStep("committed before fault")],
      failFirstFinishAfterCommit: true,
    });

    const result = await harness.run("M0 task");

    expect(result.report).toEqual(result.session.runs[0]?.report);
    expect(result.report).toMatchObject({
      status: "completed",
      terminationReason: "no_tool_calls",
    });
    expect(result.session.activeRunId).toBeUndefined();
    expect(
      result.session.operations.filter((record) => record.operation.type === "terminal"),
    ).toHaveLength(1);
    harness.assertClean();
  });
});

function completedStep(text: string): ScriptedModelStep {
  return {
    expectedRequest: { lastUserText: "M0 task", messageCount: 1, toolChoice: "none" },
    emissions: [
      { event: { type: "turn_started", requestId: "request-1" } },
      { event: { type: "part_started", index: 0, part: { type: "text" } } },
      { event: { type: "text_delta", index: 0, delta: text } },
      { event: { type: "part_completed", index: 0 } },
      {
        event: {
          type: "turn_completed",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 3 },
        },
      },
    ],
  };
}
