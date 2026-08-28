import { createHash } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CompactionCheckpointMetadata,
  ContextDerivationRecord,
  ContextManifest,
  LegacyContextManifest,
  RunLease,
  RunReport,
} from "@coding-agent/agent";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createSqlitePersistence } from "../../src/index.js";

function manifest(
  lease: RunLease,
  attempt: number,
  selectedRecordIds: readonly string[],
): ContextManifest {
  return {
    version: 2,
    id: `${lease.runId}:manifest:${attempt}`,
    runId: lease.runId,
    modelAttemptCount: attempt,
    budget: {
      modelContextWindow: 16_384,
      requestedOutputReserve: 2_048,
      protocolToolSchemaReserve: 256,
      safetyMargin: 512,
      usableInputBudget: 13_568,
    },
    contributions: [],
    selectedRecordIds,
    selectedCheckpointIds: [],
    selectedArtifactIds: [],
    omitted: [],
    requestDigest: `request-${attempt}`,
  };
}

function derivation(
  lease: RunLease,
  derivationId: string,
  status: ContextDerivationRecord["status"],
  checkpointId?: string,
): ContextDerivationRecord {
  const base = {
    version: 1,
    derivationId,
    runId: lease.runId,
    modelAttemptCount: 1,
    kind: "summary_compaction",
    model: { providerId: "test", modelId: "context-model" },
    inputDigest: "input-digest",
  } as const;
  if (status === "succeeded") {
    if (!checkpointId) throw new Error("succeeded derivation fixture 需要 checkpointId");
    return { ...base, status, outputDigest: "summary-digest", checkpointId };
  }
  return { ...base, status, failureCode: "injected_failure" };
}

function checkpoint(
  lease: RunLease,
  artifactId: string,
  records: readonly {
    readonly recordId: string;
    readonly ledgerSeq: number;
  }[],
): CompactionCheckpointMetadata {
  const first = records[0];
  const last = records.at(-1);
  if (!first || !last) throw new Error("checkpoint fixture 需要 Transcript records");
  return {
    version: 1,
    checkpointId: `${lease.runId}:checkpoint`,
    runId: lease.runId,
    branchId: lease.branchId,
    sourceStartLedgerSeq: first.ledgerSeq,
    sourceEndLedgerSeq: last.ledgerSeq,
    sourceStartRecordId: first.recordId,
    sourceEndRecordId: last.recordId,
    sourceDigest: "source-digest",
    branchLeafRecordId: last.recordId,
    retainedRecordIds: [],
    strategyVersion: "summary-v1",
    summaryArtifact: { id: artifactId },
    summaryDigest: "summary-digest",
    tokenProvenance: {
      method: "estimated_chars",
      sourceTokens: 10,
      retainedTokens: 0,
      summaryTokens: 3,
    },
  };
}

function completedReport(lease: RunLease, contextDerivationCount: number): RunReport {
  return {
    version: 1,
    runId: lease.runId,
    status: "completed",
    terminationReason: "natural_completion",
    finalAnswer: "done",
    counts: {
      modelTurnCount: 1,
      modelAttemptCount: 1,
      contextDerivationCount,
      toolCallCount: 0,
      settledToolCallCount: 0,
    },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, attemptsWithUnknownUsage: 0 },
    tools: { accepted: 0, settled: 0, succeeded: 0, failed: 0 },
    permissions: { requested: 0, allowed: 0, denied: 0 },
    changedFiles: [],
    commands: [],
    unfinishedWork: [],
    lastPhase: "finalizing",
  };
}

async function finishRun(lease: RunLease, contextDerivationCount = 0): Promise<void> {
  await lease.append([
    {
      kind: "assistant_message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        finishReason: "stop",
      },
    },
  ]);
  await lease.finish(completedReport(lease, contextDerivationCount));
}

describe("SQLite Context persistence", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("原子持久化 Manifest、Derivation 与 Checkpoint，并在 reopen 后按 branch ancestry 投影", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m4-context-reopen-"));
    temporaryRoots.push(root);
    const clock = new ManualClock(1_000);
    const ids = new SequentialIdFactory();
    const options = {
      databasePath: path.join(root, "state.sqlite3"),
      artifactDirectory: path.join(root, "artifacts"),
      busyTimeoutMs: 250,
      lease: { ownerId: "context-reopen", durationMs: 30_000 },
      clock,
      ids,
    } as const;
    const first = await createSqlitePersistence(options);
    const session = await first.sessions.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const initial = await session.inspect();
    const seed = await session.beginRun({
      branchId: initial.currentBranchId,
      expectedRevision: initial.revision,
      initialMessages: [{ role: "user", text: "seed" }],
      metadata: { task: "seed", configurationRevision: "m4" },
    });
    await seed.markModelTurnStarted(1);
    await seed.commitContext(manifest(seed, 1, []));
    await finishRun(seed);

    const beforeFork = await session.inspect();
    const fork = await session.forkBranch({
      fromBranchId: beforeFork.currentBranchId,
      expectedRevision: beforeFork.revision,
    });
    const afterFork = await session.inspect();
    const lease = await session.beginRun({
      branchId: afterFork.currentBranchId,
      expectedRevision: afterFork.revision,
      initialMessages: [{ role: "user", text: "compact parent only" }],
      metadata: { task: "compact", configurationRevision: "m4" },
    });
    const branch = await session.readBranch({ branchId: lease.branchId });
    const sourceRecords = branch.records.filter((record) => record.runId === lease.runId);
    const artifact = await first.artifacts.put({
      bytes: Buffer.from("durable summary", "utf8"),
      mediaType: "text/plain",
      provenance: "context-derivation:test",
    });
    const durableCheckpoint = checkpoint(lease, artifact.id, sourceRecords);
    const durableDerivation = derivation(
      lease,
      `${lease.runId}:derivation`,
      "succeeded",
      durableCheckpoint.checkpointId,
    );
    const durableManifest: ContextManifest = {
      ...manifest(
        lease,
        1,
        sourceRecords.map((record) => record.recordId),
      ),
      selectedCheckpointIds: [durableCheckpoint.checkpointId],
      selectedArtifactIds: [artifact.id],
    };
    await lease.markModelTurnStarted(1);
    await lease.commitContext(durableManifest, durableCheckpoint, [durableDerivation]);
    await lease.commitContext(durableManifest, durableCheckpoint, [durableDerivation]);
    await finishRun(lease, 1);

    expect((await session.readBranch({ branchId: lease.branchId })).checkpoints).toEqual([
      durableCheckpoint,
    ]);
    expect((await session.readBranch({ branchId: fork.branchId })).checkpoints).toEqual([]);
    await first[Symbol.asyncDispose]();

    const reopened = await createSqlitePersistence({
      ...options,
      lease: { ...options.lease, ownerId: "context-reopened" },
    });
    const reopenedSession = await reopened.sessions.open(session.ref);
    await expect(reopenedSession.readContextManifests(lease.runId)).resolves.toEqual([
      durableManifest,
    ]);
    await expect(reopenedSession.readContextDerivations(lease.runId)).resolves.toEqual([
      durableDerivation,
    ]);
    await expect(reopenedSession.readBranch({ branchId: lease.branchId })).resolves.toMatchObject({
      checkpoints: [durableCheckpoint],
    });
    await expect(reopenedSession.readBranch({ branchId: fork.branchId })).resolves.toMatchObject({
      checkpoints: [],
    });
    const beforeChild = await reopenedSession.inspect();
    const selectedChild = await reopenedSession.selectBranch(fork.branchId, beforeChild.revision);
    const childLease = await reopenedSession.beginRun({
      branchId: selectedChild.currentBranchId,
      expectedRevision: selectedChild.revision,
      initialMessages: [{ role: "user", text: "continue child" }],
      metadata: { task: "continue child", configurationRevision: "m4" },
    });
    await childLease.markModelTurnStarted(1);
    const siblingRecord = sourceRecords[0];
    if (!siblingRecord) throw new Error("sibling record fixture missing");
    await expect(
      childLease.commitContext(manifest(childLease, 1, [siblingRecord.recordId])),
    ).rejects.toMatchObject({ code: "SESSION_CORRUPT" });
    await childLease.commitContext(manifest(childLease, 1, []));
    await finishRun(childLease);
    await reopened[Symbol.asyncDispose]();
  });

  it("reopen 时保留并读取 M3 durable Manifest，而不伪造 M4 provenance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m4-context-legacy-"));
    temporaryRoots.push(root);
    const databasePath = path.join(root, "state.sqlite3");
    const options = {
      databasePath,
      artifactDirectory: path.join(root, "artifacts"),
      busyTimeoutMs: 250,
      lease: { ownerId: "context-legacy", durationMs: 30_000 },
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
    } as const;
    const first = await createSqlitePersistence(options);
    const session = await first.sessions.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const initial = await session.inspect();
    const lease = await session.beginRun({
      branchId: initial.currentBranchId,
      expectedRevision: initial.revision,
      initialMessages: [{ role: "user", text: "legacy context" }],
      metadata: { task: "legacy", configurationRevision: "m3" },
    });
    await lease.markModelTurnStarted(1);
    await lease.commitContext(manifest(lease, 1, []));
    await finishRun(lease);
    await first[Symbol.asyncDispose]();

    const legacy: LegacyContextManifest = {
      version: 1,
      id: `${lease.runId}:manifest:1`,
      runId: lease.runId,
      modelAttemptCount: 1,
      selectedRecordIds: [],
      omitted: [{ source: "transcript", reason: "outside_budget" }],
    };
    const payload = JSON.stringify(legacy);
    const digest = createHash("sha256").update(payload, "utf8").digest("hex");
    const database = new Database(databasePath);
    database
      .prepare("UPDATE context_manifests SET payload_json = ?, digest = ? WHERE manifest_id = ?")
      .run(payload, digest, legacy.id);
    database.close();

    const reopened = await createSqlitePersistence({
      ...options,
      lease: { ...options.lease, ownerId: "context-legacy-reopened" },
    });
    const reopenedSession = await reopened.sessions.open(session.ref);
    await expect(reopenedSession.readContextManifests(lease.runId)).resolves.toEqual([legacy]);
    await reopened[Symbol.asyncDispose]();
  });

  it("Derivation CAS 冲突回滚同事务 Manifest 与 Checkpoint，失败记录单独 durable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m4-context-atomic-"));
    temporaryRoots.push(root);
    const persistence = await createSqlitePersistence({
      databasePath: path.join(root, "state.sqlite3"),
      artifactDirectory: path.join(root, "artifacts"),
      busyTimeoutMs: 250,
      lease: { ownerId: "context-atomic", durationMs: 30_000 },
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
    });
    const session = await persistence.sessions.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const lease = await session.beginRun({
      branchId: snapshot.currentBranchId,
      expectedRevision: snapshot.revision,
      initialMessages: [{ role: "user", text: "compact" }],
      metadata: { task: "compact", configurationRevision: "m4" },
    });
    const branch = await session.readBranch({ branchId: lease.branchId });
    const artifact = await persistence.artifacts.put({
      bytes: Buffer.from("summary", "utf8"),
      mediaType: "text/plain",
      provenance: "context-derivation:test",
    });
    const durableCheckpoint = checkpoint(lease, artifact.id, branch.records);
    await expect(
      lease.commitContext(
        manifest(lease, 1, []),
        {
          ...durableCheckpoint,
          checkpointId: `${lease.runId}:missing-artifact-checkpoint`,
          summaryArtifact: { id: `sha256:${"0".repeat(64)}` },
        },
        [],
      ),
    ).rejects.toMatchObject({ code: "SESSION_CORRUPT" });
    await expect(session.readContextManifests(lease.runId)).resolves.toEqual([]);
    await expect(session.readBranch({ branchId: lease.branchId })).resolves.toMatchObject({
      checkpoints: [],
    });
    await expect(
      lease.commitContext(
        manifest(lease, 1, []),
        {
          ...durableCheckpoint,
          checkpointId: `${lease.runId}:missing-prior-checkpoint`,
          priorCheckpointId: "checkpoint-does-not-exist",
        },
        [],
      ),
    ).rejects.toMatchObject({ code: "SESSION_CORRUPT" });
    await expect(session.readContextManifests(lease.runId)).resolves.toEqual([]);
    await expect(session.readBranch({ branchId: lease.branchId })).resolves.toMatchObject({
      checkpoints: [],
    });
    const failed = derivation(lease, `${lease.runId}:derivation`, "failed");
    await lease.commitContextFailure([failed]);
    await lease.commitContextFailure([failed]);

    const conflicting = derivation(
      lease,
      failed.derivationId,
      "succeeded",
      durableCheckpoint.checkpointId,
    );
    await expect(
      lease.commitContext(manifest(lease, 1, []), durableCheckpoint, [conflicting]),
    ).rejects.toMatchObject({ code: "SESSION_TERMINAL_CONFLICT" });
    await expect(session.readContextManifests(lease.runId)).resolves.toEqual([]);
    await expect(session.readContextDerivations(lease.runId)).resolves.toEqual([failed]);
    await expect(session.readBranch({ branchId: lease.branchId })).resolves.toMatchObject({
      checkpoints: [],
    });
    await expect(
      lease.commitContextFailure([{ ...failed, failureCode: "different" }]),
    ).rejects.toMatchObject({ code: "SESSION_TERMINAL_CONFLICT" });
    await expect(lease.commitContextFailure([conflicting])).rejects.toBeInstanceOf(TypeError);

    await lease.markModelTurnStarted(1);
    await lease.commitContext(manifest(lease, 1, []));
    await finishRun(lease, 1);
    await persistence[Symbol.asyncDispose]();
  });

  it("当前 branch checkpoint 的 summary bytes 丢失会被 integrity check 标记为 degraded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m4-checkpoint-artifact-"));
    temporaryRoots.push(root);
    const artifactDirectory = path.join(root, "artifacts");
    const persistence = await createSqlitePersistence({
      databasePath: path.join(root, "state.sqlite3"),
      artifactDirectory,
      busyTimeoutMs: 250,
      lease: { ownerId: "checkpoint-artifact", durationMs: 30_000 },
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
    });
    const session = await persistence.sessions.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const lease = await session.beginRun({
      branchId: snapshot.currentBranchId,
      expectedRevision: snapshot.revision,
      initialMessages: [{ role: "user", text: "compact" }],
      metadata: { task: "compact", configurationRevision: "m4" },
    });
    const branch = await session.readBranch({ branchId: lease.branchId });
    const artifact = await persistence.artifacts.put({
      bytes: Buffer.from("summary bytes", "utf8"),
      mediaType: "text/plain",
      provenance: "context-derivation:test",
    });
    const durableCheckpoint = checkpoint(lease, artifact.id, branch.records);
    const durableDerivation = derivation(
      lease,
      `${lease.runId}:derivation`,
      "succeeded",
      durableCheckpoint.checkpointId,
    );
    await lease.markModelTurnStarted(1);
    await lease.commitContext(manifest(lease, 1, []), durableCheckpoint, [durableDerivation]);

    const digest = artifact.id.slice("sha256:".length);
    await unlink(path.join(artifactDirectory, "sha256", digest.slice(0, 2), digest));
    await expect(persistence.checkIntegrity()).resolves.toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "ARTIFACT_MISSING",
          severity: "degraded",
          sessionId: session.ref.sessionId,
        }),
      ],
    });
    await persistence[Symbol.asyncDispose]();
  });

  it("durable Context digest 损坏时 CAS、finish、recovery 与 integrity 全部 fail closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m4-context-digest-"));
    temporaryRoots.push(root);
    const databasePath = path.join(root, "state.sqlite3");
    const artifactDirectory = path.join(root, "artifacts");
    const clock = new ManualClock(1_000);
    const ids = new SequentialIdFactory();
    const first = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      busyTimeoutMs: 250,
      lease: { ownerId: "context-digest-a", durationMs: 30_000 },
      clock,
      ids,
    });
    const session = await first.sessions.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const lease = await session.beginRun({
      branchId: snapshot.currentBranchId,
      expectedRevision: snapshot.revision,
      initialMessages: [{ role: "user", text: "digest validation" }],
      metadata: { task: "digest validation", configurationRevision: "m4" },
    });
    const durableManifest = manifest(lease, 1, []);
    const failed = derivation(lease, `${lease.runId}:failed-derivation`, "failed");
    await lease.markModelTurnStarted(1);
    await lease.commitContext(durableManifest);
    await lease.commitContextFailure([failed]);
    await lease.append([
      {
        kind: "assistant_message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          finishReason: "stop",
        },
      },
    ]);

    const database = new Database(databasePath);
    const manifestRow = database
      .prepare("SELECT payload_json FROM context_manifests WHERE manifest_id = ?")
      .get(durableManifest.id) as { readonly payload_json: string };
    const derivationRow = database
      .prepare("SELECT payload_json FROM context_derivations WHERE derivation_id = ?")
      .get(failed.derivationId) as { readonly payload_json: string };
    database.prepare("UPDATE context_manifests SET payload_json = ? WHERE manifest_id = ?").run(
      JSON.stringify({
        ...(JSON.parse(manifestRow.payload_json) as ContextManifest),
        requestDigest: "tampered",
      }),
      durableManifest.id,
    );
    database.prepare("UPDATE context_derivations SET payload_json = ? WHERE derivation_id = ?").run(
      JSON.stringify({
        ...(JSON.parse(derivationRow.payload_json) as ContextDerivationRecord),
        failureCode: "tampered",
      }),
      failed.derivationId,
    );
    database.close();

    await expect(lease.commitContext(durableManifest)).rejects.toMatchObject({
      code: "SESSION_CORRUPT",
    });
    await expect(lease.commitContextFailure([failed])).rejects.toMatchObject({
      code: "SESSION_CORRUPT",
    });
    await expect(first.checkIntegrity()).resolves.toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "CONTEXT_REFERENCE_INVALID",
          severity: "degraded",
          runId: lease.runId,
        }),
      ]),
    });
    await expect(lease.finish(completedReport(lease, 1))).rejects.toMatchObject({
      code: "SESSION_CORRUPT",
    });

    clock.advance(30_001);
    const second = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      busyTimeoutMs: 250,
      lease: { ownerId: "context-digest-b", durationMs: 30_000 },
      clock,
      ids,
    });
    await expect(second.sessions.open(session.ref)).rejects.toMatchObject({
      code: "SESSION_CORRUPT",
    });
    const readOnly = await second.sessions.open(session.ref, { mode: "read_only" });
    await expect(readOnly.inspect()).resolves.toMatchObject({ activeRunId: lease.runId });
    await first[Symbol.asyncDispose]();
    await second[Symbol.asyncDispose]();
  });
});
