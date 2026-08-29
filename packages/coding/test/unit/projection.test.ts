import { describe, expect, it } from "bun:test";
import {
  branchId,
  type RunConfigSnapshot,
  type RunReport,
  runId,
  sessionId,
} from "@coding-agent/agent";
import { modelId, providerId } from "@coding-agent/model";
import type { CodingEvent } from "../../src/app/coding-events.js";
import type { CodingSessionSnapshot } from "../../src/projection/contracts.js";
import { reduceProjection, selectTuiViewModel } from "../../src/projection/projection.js";

const run = runId("run-projection");
const config: RunConfigSnapshot = {
  version: 1,
  model: { providerId: providerId("test"), modelId: modelId("scripted"), sourceRevision: "1" },
  permissionMode: "safe",
  budgets: { maxModelTurns: 4, maxModelAttempts: 6 },
  tools: ["read_file"],
  extensions: [],
  skills: [],
  policyVersions: { run: "1" },
  configurationRevision: "projection-1",
};
const snapshot: CodingSessionSnapshot = {
  version: 1,
  ref: { sessionId: sessionId("session-projection") },
  workspace: { root: "D:/work", fingerprint: "head:1" },
  revision: 1,
  currentBranchId: branchId("branch-main"),
  branches: [{ branchId: branchId("branch-main"), recordCount: 1 }],
  activeRunId: run,
  runOrder: [],
  runs: {},
  transcript: [],
  queues: [],
};

function semantic(sequence: number, value: object): CodingEvent {
  return {
    version: 1,
    category: "semantic",
    runId: run,
    sequence,
    eventId: `${run}:${sequence}`,
    ...value,
  } as CodingEvent;
}

function progress(revision: number, key: string, value: object): CodingEvent {
  return {
    version: 1,
    category: "progress",
    runId: run,
    revision,
    key,
    ...value,
  } as CodingEvent;
}

describe("pure Coding projection", () => {
  it("retry reset、tool/approval/terminal 状态表收敛，terminal 后忽略 late progress", () => {
    let projection = reduceProjection(undefined, snapshot);
    projection = reduceProjection(
      projection,
      semantic(1, {
        type: "run_started",
        sessionId: snapshot.ref.sessionId,
        branchId: snapshot.currentBranchId,
        config,
      }),
    );
    projection = reduceProjection(
      projection,
      progress(1, "attempt", {
        type: "model_attempt_started",
        modelTurnCount: 1,
        modelAttemptCount: 1,
      }),
    );
    projection = reduceProjection(
      projection,
      progress(2, "assistant:1", {
        type: "assistant_delta",
        modelTurnCount: 1,
        modelAttemptCount: 1,
        partIndex: 0,
        channel: "text",
        delta: "discarded",
      }),
    );
    projection = reduceProjection(
      projection,
      progress(3, "attempt", {
        type: "model_attempt_started",
        modelTurnCount: 1,
        modelAttemptCount: 2,
      }),
    );
    projection = reduceProjection(
      projection,
      progress(4, "assistant:old", {
        type: "assistant_delta",
        modelTurnCount: 1,
        modelAttemptCount: 1,
        partIndex: 0,
        channel: "text",
        delta: "late-old",
      }),
    );
    projection = reduceProjection(
      projection,
      progress(5, "assistant:2", {
        type: "assistant_delta",
        modelTurnCount: 1,
        modelAttemptCount: 2,
        partIndex: 0,
        channel: "text",
        delta: "canonical draft",
      }),
    );
    expect(projection.runs[run]?.assistantStream?.text).toBe("canonical draft");

    projection = reduceProjection(
      projection,
      semantic(2, {
        type: "assistant_committed",
        ledgerSeq: 3,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "committed" }],
          finishReason: "stop",
        },
      }),
    );
    projection = reduceProjection(
      projection,
      semantic(3, {
        type: "tool_planned",
        plan: { callId: "call-1", toolName: "read_file", resources: [], effects: [], risks: [] },
      }),
    );
    projection = reduceProjection(
      projection,
      semantic(4, { type: "tool_started", callId: "call-1" }),
    );
    projection = reduceProjection(
      projection,
      semantic(5, {
        type: "permission_requested",
        request: {
          approvalId: "approval-1",
          runId: run,
          plan: {
            callId: "call-1",
            toolName: "read_file",
            normalizedArguments: {},
            resources: [],
            effects: [],
            risks: [],
            preconditions: [],
            policyVersion: "1",
            fingerprint: "fp",
          },
        },
        approval: {
          approvalId: "approval-1",
          callId: "call-1",
          plan: {
            callId: "call-1",
            toolName: "read_file",
            resources: [],
            effects: [],
            risks: [],
            fingerprint: "fp",
          },
          decisions: ["allow_once", "deny"],
          status: "pending",
        },
      }),
    );
    projection = reduceProjection(
      projection,
      semantic(6, {
        type: "permission_resolved",
        approvalId: "approval-1",
        status: "allowed",
        decision: "allow_once",
      }),
    );
    projection = reduceProjection(
      projection,
      semantic(7, {
        type: "tool_settled",
        ledgerSeq: 5,
        outcome: {
          callId: "call-1",
          status: "succeeded",
          isError: false,
          modelContent: "ok",
          effectState: "none",
          abortObserved: false,
          artifacts: [],
        },
      }),
    );
    const report: RunReport = {
      version: 1,
      runId: run,
      status: "completed",
      terminationReason: "natural_completion",
      finalAnswer: "committed",
      counts: {
        modelTurnCount: 1,
        modelAttemptCount: 2,
        contextDerivationCount: 0,
        toolCallCount: 1,
        settledToolCallCount: 1,
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, attemptsWithUnknownUsage: 0 },
      tools: { accepted: 1, settled: 1, succeeded: 1, failed: 0 },
      permissions: { requested: 1, allowed: 1, denied: 0 },
      changedFiles: [],
      commands: [],
      unfinishedWork: [],
      lastPhase: "finalizing",
    };
    projection = reduceProjection(projection, semantic(8, { type: "terminal_committed", report }));
    const terminal = projection;
    projection = reduceProjection(
      projection,
      progress(6, "phase", { type: "phase_changed", phase: "model_streaming" }),
    );
    projection = reduceProjection(projection, semantic(8, { type: "terminal_committed", report }));

    expect(projection.runs[run]).toMatchObject({ terminal: true, status: "completed", report });
    expect(projection.runs[run]?.assistantStream).toBeUndefined();
    expect(projection.runs[run]?.approvals).toEqual({});
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LATE_PROGRESS_IGNORED" }),
    );
    expect(projection.runs[run]?.status).toBe(terminal.runs[run]?.status);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(selectTuiViewModel(projection))).toBe(true);
  });

  it("semantic duplicate 幂等，gap 明确要求重新 snapshot", () => {
    let projection = reduceProjection(undefined, snapshot);
    const started = semantic(1, {
      type: "run_started",
      sessionId: snapshot.ref.sessionId,
      branchId: snapshot.currentBranchId,
      config,
    });
    projection = reduceProjection(projection, started);
    expect(reduceProjection(projection, started)).toBe(projection);
    projection = reduceProjection(projection, semantic(3, { type: "user_accepted", text: "gap" }));
    expect(projection.requiresSnapshot).toBe(true);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SEMANTIC_SEQUENCE_GAP" }),
    );
  });

  it("并发 tool、queue、context/compaction 与 recovery 使用 stable identity 收敛", () => {
    let projection = reduceProjection(undefined, snapshot);
    const events: CodingEvent[] = [
      semantic(1, {
        type: "run_started",
        sessionId: snapshot.ref.sessionId,
        branchId: snapshot.currentBranchId,
        config,
      }),
      semantic(2, {
        type: "tool_planned",
        plan: { callId: "call-a", toolName: "read_file", resources: [], effects: [], risks: [] },
      }),
      semantic(3, {
        type: "tool_planned",
        plan: { callId: "call-b", toolName: "git_status", resources: [], effects: [], risks: [] },
      }),
      semantic(4, { type: "tool_started", callId: "call-a" }),
      semantic(5, { type: "tool_started", callId: "call-b" }),
      semantic(6, {
        type: "tool_settled",
        ledgerSeq: 6,
        outcome: {
          callId: "call-b",
          status: "succeeded",
          isError: false,
          modelContent: "clean",
          effectState: "none",
          abortObserved: false,
          artifacts: [],
        },
      }),
      semantic(7, {
        type: "tool_settled",
        ledgerSeq: 7,
        outcome: {
          callId: "call-a",
          status: "succeeded",
          isError: false,
          modelContent: "content",
          effectState: "none",
          abortObserved: false,
          artifacts: [],
        },
      }),
      semantic(8, {
        type: "queue_changed",
        item: {
          commandId: "queue-1",
          kind: "steering",
          text: "focus tests",
          ordinal: 1,
          status: "queued",
          revision: 1,
        },
      }),
      semantic(9, {
        type: "queue_delivered",
        item: {
          commandId: "queue-1",
          kind: "steering",
          text: "focus tests",
          ordinal: 1,
          status: "delivered",
          revision: 2,
        },
      }),
      semantic(10, {
        type: "context_prepared",
        manifest: {
          version: 2,
          id: "manifest-1",
          runId: run,
          modelAttemptCount: 1,
          budget: {
            modelContextWindow: 100,
            requestedOutputReserve: 10,
            protocolToolSchemaReserve: 5,
            safetyMargin: 5,
            usableInputBudget: 80,
          },
          contributions: [],
          selectedRecordIds: [],
          selectedCheckpointIds: [],
          selectedArtifactIds: [],
          omitted: [],
          requestDigest: "digest",
        },
        measurement: {
          method: "estimated_chars",
          inputTokens: 20,
          outputReserve: 10,
          protocolToolSchemaReserve: 5,
          safetyMargin: 5,
          usableInputBudget: 80,
          requiredTokens: 20,
          optionalTokens: 0,
        },
        derivations: [],
      }),
      semantic(11, {
        type: "compaction_completed",
        derivation: {
          version: 1,
          derivationId: "derivation-1",
          runId: run,
          modelAttemptCount: 1,
          kind: "summary_compaction",
          status: "succeeded",
          model: { providerId: "test", modelId: "scripted" },
          inputDigest: "input",
          outputDigest: "output",
        },
      }),
      semantic(12, {
        type: "recovery_observed",
        diagnostic: {
          code: "RUN_INTERRUPTED",
          message: "recovered",
          runId: run,
        },
      }),
    ];
    for (const event of events) projection = reduceProjection(projection, event);

    expect(projection.runs[run]?.toolOrder).toEqual(["call-a", "call-b"]);
    expect(projection.runs[run]?.tools["call-a"]?.status).toBe("settled");
    expect(projection.runs[run]?.tools["call-b"]?.status).toBe("settled");
    expect(projection.queues).toEqual([
      expect.objectContaining({ status: "delivered", revision: 2 }),
    ]);
    expect(projection.runs[run]?.context?.manifest.id).toBe("manifest-1");
    expect(projection.runs[run]?.compactions).toHaveLength(1);
    expect(projection.runs[run]).toMatchObject({ terminal: true, status: "recovering" });
  });

  it("TuiViewModel 将 durable projection 与 local snapshot 分区", () => {
    const projection = reduceProjection(undefined, snapshot);
    const viewModel = selectTuiViewModel(projection, {
      focusedRegion: "context",
      composer: { value: "draft", revision: 2, deliveryMode: "steering" },
      transcriptViewport: {
        scrollTop: 3,
        followTail: false,
        anchorBlockId: "ledger:2",
        unseenBlockCount: 1,
      },
      terminal: { width: 120, height: 32 },
      surfaceStack: [{ kind: "context" }],
    });

    expect(viewModel.ui).toMatchObject({
      focusedRegion: "context",
      composer: { value: "draft", revision: 2, deliveryMode: "steering" },
      transcriptViewport: { followTail: false, unseenBlockCount: 1 },
      terminal: { width: 120, height: 32 },
      surfaceStack: [{ kind: "context" }],
    });
    expect("composer" in viewModel.session).toBe(false);
    expect(Object.isFrozen(viewModel.ui)).toBe(true);
    expect(() => (viewModel.ui.expandedIds as Set<string>).add("renderer-mutation")).toThrow();
  });
});
