import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunLease, RunReport } from "@coding-agent/agent";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { createSqlitePersistence } from "../../src/index.js";

function completedReport(lease: RunLease): RunReport {
  return {
    version: 1,
    runId: lease.runId,
    status: "completed",
    terminationReason: "natural_completion",
    finalAnswer: "continued safely",
    counts: {
      modelTurnCount: 0,
      modelAttemptCount: 0,
      contextDerivationCount: 0,
      toolCallCount: 0,
      settledToolCallCount: 0,
    },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, attemptsWithUnknownUsage: 1 },
    tools: { accepted: 0, settled: 0, succeeded: 0, failed: 0 },
    permissions: { requested: 0, allowed: 0, denied: 0 },
    changedFiles: [],
    commands: [],
    unfinishedWork: [],
    lastPhase: "finalizing",
  };
}

describe("SQLite writer lease and recovery", () => {
  it("stale takeover 使用 monotonic fencing，planned/started call 分别恢复为 cancelled/unknown effect", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-lease-"));
    const databasePath = path.join(root, "state.sqlite3");
    const artifactDirectory = path.join(root, "artifacts");
    const clock = new ManualClock(10_000);
    const ids = new SequentialIdFactory();
    const first = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      busyTimeoutMs: 100,
      lease: { ownerId: "writer-a", durationMs: 500 },
      clock,
      ids,
    });
    const session = await first.sessions.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const initial = await session.inspect();
    const staleLease = await session.beginRun({
      branchId: initial.currentBranchId,
      expectedRevision: initial.revision,
      initialMessages: [{ role: "user", text: "run before crash" }],
      metadata: { task: "run before crash", configurationRevision: "m3" },
    });
    await staleLease.markModelTurnStarted(1);
    await staleLease.commitContext({
      version: 2,
      id: `${staleLease.runId}:attempt-1`,
      runId: staleLease.runId,
      modelAttemptCount: 1,
      budget: {
        modelContextWindow: 16_384,
        requestedOutputReserve: 2_048,
        protocolToolSchemaReserve: 256,
        safetyMargin: 512,
        usableInputBudget: 13_568,
      },
      contributions: [],
      selectedRecordIds: [],
      selectedCheckpointIds: [],
      selectedArtifactIds: [],
      omitted: [],
      requestDigest: "request-1",
    });
    await staleLease.commitContextFailure([
      {
        version: 1,
        derivationId: `${staleLease.runId}:failed-derivation`,
        runId: staleLease.runId,
        modelAttemptCount: 1,
        kind: "summary_compaction",
        status: "failed",
        model: { providerId: "test", modelId: "context-model" },
        inputDigest: "input-digest",
        failureCode: "injected_failure",
      },
    ]);
    await staleLease.append([
      {
        kind: "assistant_message",
        message: {
          role: "assistant",
          content: [
            { type: "tool_call", callId: "never-started", name: "read_file", arguments: {} },
            { type: "tool_call", callId: "effect-unknown", name: "run_command", arguments: {} },
          ],
          finishReason: "tool_calls",
        },
      },
    ]);
    await staleLease.markToolCallStarted("effect-unknown");
    await session.enqueue({
      commandId: "queued-follow-up",
      kind: "follow_up",
      text: "continue after this",
    });

    const second = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      busyTimeoutMs: 100,
      lease: { ownerId: "writer-b", durationMs: 500 },
      clock,
      ids,
    });
    const browser = await second.sessions.open(session.ref, { mode: "read_only" });
    expect(browser.readOnly).toBe(true);
    await expect(
      browser.beginRun({
        branchId: initial.currentBranchId,
        expectedRevision: initial.revision,
        initialMessages: [{ role: "user", text: "forbidden" }],
        metadata: { task: "forbidden", configurationRevision: "m3" },
      }),
    ).rejects.toMatchObject({ code: "SESSION_READ_ONLY" });
    const competing = await second.sessions.open(session.ref);
    const competingSnapshot = await competing.inspect();
    await expect(
      competing.beginRun({
        branchId: initial.currentBranchId,
        expectedRevision: competingSnapshot.revision,
        initialMessages: [{ role: "user", text: "too early" }],
        metadata: { task: "too early", configurationRevision: "m3" },
      }),
    ).rejects.toMatchObject({ code: "SESSION_ACTIVE_RUN" });

    clock.advance(501);
    await expect(second.checkIntegrity()).resolves.toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "ORPHAN_RUN", runId: staleLease.runId })],
    });
    const recovered = await second.sessions.open(session.ref);
    const recoveredReport = await recovered.readRunReport(staleLease.runId);
    expect(recoveredReport).toMatchObject({
      status: "failed",
      terminationReason: "recovered_interruption",
      counts: { contextDerivationCount: 1 },
      tools: { accepted: 2, settled: 2, failed: 2 },
    });
    await expect(recovered.listQueue(staleLease.runId)).resolves.toEqual([
      expect.objectContaining({ commandId: "queued-follow-up", status: "draft" }),
    ]);
    const branchAfterRecovery = await recovered.readBranch({ branchId: initial.currentBranchId });
    const recoveryOutcomes = branchAfterRecovery.records
      .filter((record) => record.kind === "tool_outcome")
      .map((record) => record.outcome);
    expect(recoveryOutcomes).toEqual([
      expect.objectContaining({
        callId: "never-started",
        status: "cancelled",
        effectState: "none",
      }),
      expect.objectContaining({
        callId: "effect-unknown",
        status: "failed",
        effectState: "unknown",
      }),
    ]);

    const recoveredSnapshot = await recovered.inspect();
    const next = await recovered.beginRun({
      branchId: initial.currentBranchId,
      expectedRevision: recoveredSnapshot.revision,
      initialMessages: [{ role: "user", text: "new owner" }],
      metadata: { task: "new owner", configurationRevision: "m3" },
    });
    await expect(staleLease.heartbeat()).rejects.toMatchObject({ code: "SESSION_LEASE_LOST" });
    await expect(
      staleLease.commitContextFailure([
        {
          version: 1,
          derivationId: `${staleLease.runId}:late-derivation`,
          runId: staleLease.runId,
          modelAttemptCount: 2,
          kind: "summary_compaction",
          status: "aborted",
          model: { providerId: "test", modelId: "context-model" },
          inputDigest: "late-input",
          failureCode: "cancelled",
        },
      ]),
    ).rejects.toMatchObject({ code: "SESSION_LEASE_LOST" });
    await expect(
      staleLease.append([
        {
          kind: "model_failure",
          failure: { category: "network", retryable: true, message: "late write" },
        },
      ]),
    ).rejects.toMatchObject({ code: "SESSION_LEASE_LOST" });
    await next.finish(completedReport(next));
    await expect(second.checkIntegrity()).resolves.toMatchObject({ ok: true, issues: [] });

    await first[Symbol.asyncDispose]();
    await second[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });
});
