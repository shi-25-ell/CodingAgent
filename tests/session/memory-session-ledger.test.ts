import { describe, expect, it } from "vitest";
import { MemorySessionLedger } from "../../session/memory-session-ledger.js";
import type { RunReport } from "../../session/run-report.js";
import { DeterministicIdFactory } from "../../testing/deterministic-id-factory.js";
import { ManualClock } from "../../testing/manual-clock.js";

describe("MemorySessionLedger", () => {
  it("atomically establishes one active Run with its initial user message", async () => {
    const ledger = createLedger();
    const session = await ledger.createSession({
      workspace: workspaceBaseline(),
      defaultProviderProfile: "scripted",
      defaultModel: "fixture",
    });

    const lease = await ledger.beginRun(session.id, { initialTask: "fix it" });
    await expect(ledger.beginRun(session.id, { initialTask: "race" })).rejects.toThrow(
      "already has an active Run",
    );

    const view = await ledger.inspectSession(session.id);
    expect(view.activeRunId).toBe(lease.runId);
    expect(view.operations).toMatchObject([{ ledgerSeq: 1, operation: { type: "run_started" } }]);
    expect(view.transcript).toMatchObject([
      { ledgerSeq: 2, runId: lease.runId, message: { role: "user", content: "fix it" } },
    ]);
  });

  it("commits the complete assistant message before one terminal RunReport", async () => {
    const ledger = createLedger();
    const session = await ledger.createSession({
      workspace: workspaceBaseline(),
      defaultProviderProfile: "scripted",
      defaultModel: "fixture",
    });
    const lease = await ledger.beginRun(session.id, { initialTask: "hello" });
    await lease.commitAssistant({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      finishReason: "stop",
    });
    await lease.recordOperation({
      type: "terminal",
      status: "completed",
      reason: "no_tool_calls",
      lastPhase: "completion_candidate",
    });
    const report = completedReport(session.id, lease.runId);
    await lease.finish(report);

    await expect(lease.finish(report)).rejects.toThrow("already terminal");
    const view = await ledger.inspectSession(session.id);
    expect(view.activeRunId).toBeUndefined();
    expect(view.transcript.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
    expect(view.runs[0]).toMatchObject({
      id: lease.runId,
      status: "terminal",
      terminalLedgerSeq: 4,
      report: { status: "completed", terminationReason: "no_tool_calls" },
    });
    expect(view.transcript[1]?.ledgerSeq).toBeLessThan(view.runs[0]?.terminalLedgerSeq ?? 0);
  });
});

function createLedger() {
  return new MemorySessionLedger(new DeterministicIdFactory(), new ManualClock(1_000));
}

function workspaceBaseline() {
  return {
    rootPath: "C:/workspace",
    headSha: "a".repeat(40),
    fingerprint: "clean:a",
    changedFiles: [],
  };
}

function completedReport(sessionId: string, runId: string): RunReport {
  return {
    schemaVersion: 1,
    sessionId,
    runId,
    status: "completed",
    terminationReason: "no_tool_calls",
    configuration: {
      providerProfile: "scripted",
      model: "fixture",
      permissionMode: "safe",
      maximumModelTurns: 20,
      maximumModelAttempts: 1,
    },
    finalAnswer: "done",
    counts: {
      modelTurns: 1,
      modelAttempts: 1,
      toolCalls: 0,
      completedToolCalls: 0,
      contextDerivations: 0,
    },
    retrySummary: { retries: 0 },
    toolSummary: { total: 0, succeeded: 0, errors: 0 },
    permissionSummary: { requested: 0, allowed: 0, denied: 0 },
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 0,
    workspace: {
      startingHead: "a".repeat(40),
      startingFingerprint: "clean:a",
      ending: {
        state: "observed",
        head: "a".repeat(40),
        fingerprint: "clean:a",
        changedFiles: [],
      },
    },
    commands: [],
    undelivered: { steering: 0, followUps: 0 },
    unfinishedWork: [],
    lastPhase: "completion_candidate",
  };
}
