import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunLease, RunReport } from "@coding-agent/agent";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { describe, expect, it } from "vitest";
import { DurableArtifactStore } from "../../src/artifacts/durable-artifact-store.js";
import { openDatabase } from "../../src/connection/database.js";
import { createSqlitePersistence } from "../../src/index.js";

const artifactText = "crash durable bytes";
const digest = "21123eca36ffd853d5a880b50d0de55566ccd58e8061c633e44ba6131ca34ace";
const ref = { id: `sha256:${digest}` };

function report(lease: RunLease): RunReport {
  return {
    version: 1,
    runId: lease.runId,
    status: "completed",
    terminationReason: "natural_completion",
    counts: {
      modelTurnCount: 1,
      modelAttemptCount: 1,
      contextDerivationCount: 0,
      toolCallCount: 1,
      settledToolCallCount: 1,
    },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, attemptsWithUnknownUsage: 1 },
    tools: { accepted: 1, settled: 1, succeeded: 1, failed: 0 },
    permissions: { requested: 0, allowed: 0, denied: 0 },
    changedFiles: [],
    commands: [],
    unfinishedWork: [],
    lastPhase: "finalizing",
  };
}

describe("Artifact crash recovery", () => {
  it("pending metadata 前后 crash 都不会形成悬空 committed reference", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-artifact-crash-"));
    const databasePath = path.join(root, "state.sqlite3");
    const artifactDirectory = path.join(root, "artifacts");
    const database = await openDatabase({ databasePath, busyTimeoutMs: 100, now: () => 1_000 });
    const beforeRename = await DurableArtifactStore.create({
      database,
      directory: artifactDirectory,
      clock: { now: () => 1_000 },
      faults: {
        afterPending() {
          throw new Error("crash after pending");
        },
      },
    });
    await expect(
      beforeRename.put({
        bytes: Buffer.from(artifactText),
        mediaType: "text/plain",
        provenance: "fault:before-rename",
      }),
    ).rejects.toThrow("crash after pending");
    await expect(beforeRename.verify(ref)).resolves.toEqual({ status: "missing" });
    await beforeRename[Symbol.asyncDispose]();
    database.close();

    const afterPendingRecovery = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      lease: { ownerId: "artifact-recovery", durationMs: 1_000 },
    });
    await expect(afterPendingRecovery.recover()).resolves.toMatchObject({
      integrity: { ok: true },
    });
    await afterPendingRecovery[Symbol.asyncDispose]();

    const renameDatabase = await openDatabase({
      databasePath,
      busyTimeoutMs: 100,
      now: () => 2_000,
    });
    const afterRename = await DurableArtifactStore.create({
      database: renameDatabase,
      directory: artifactDirectory,
      clock: { now: () => 2_000 },
      faults: {
        afterRename() {
          throw new Error("crash after rename");
        },
      },
    });
    await expect(
      afterRename.put({
        bytes: Buffer.from(artifactText),
        mediaType: "text/plain",
        provenance: "fault:after-rename",
      }),
    ).rejects.toThrow("crash after rename");
    await expect(afterRename.verify(ref)).resolves.toEqual({ status: "missing" });
    await afterRename[Symbol.asyncDispose]();
    renameDatabase.close();

    const resumed = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      lease: { ownerId: "artifact-resume", durationMs: 1_000 },
    });
    await expect(
      resumed.artifacts.put({
        bytes: Buffer.from(artifactText),
        mediaType: "text/plain",
        provenance: "fault:after-rename",
      }),
    ).resolves.toEqual(ref);
    await expect(resumed.artifacts.verify(ref)).resolves.toEqual({ status: "verified" });
    await resumed[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });

  it("current branch 引用的 Artifact digest 损坏会进入 degraded read-only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-artifact-corrupt-"));
    const artifactDirectory = path.join(root, "artifacts");
    const persistence = await createSqlitePersistence({
      databasePath: path.join(root, "state.sqlite3"),
      artifactDirectory,
      lease: { ownerId: "artifact-corrupt", durationMs: 1_000 },
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
    });
    const artifact = await persistence.artifacts.put({
      bytes: Buffer.from(artifactText),
      mediaType: "text/plain",
      provenance: "tool:call-1",
    });
    const session = await persistence.sessions.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const lease = await session.beginRun({
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "produce artifact" }],
      metadata: { task: "produce artifact", configurationRevision: "m3" },
    });
    await lease.append([
      {
        kind: "assistant_message",
        message: {
          role: "assistant",
          content: [{ type: "tool_call", callId: "call-1", name: "run_command", arguments: {} }],
          finishReason: "tool_calls",
        },
      },
    ]);
    await lease.markToolCallStarted("call-1");
    await lease.append([
      {
        kind: "tool_outcome",
        outcome: {
          callId: "call-1",
          status: "succeeded",
          isError: false,
          modelContent: "artifact committed",
          effectState: "none",
          abortObserved: false,
          artifacts: [artifact],
        },
      },
    ]);
    await lease.finish(report(lease));

    const target = path.join(artifactDirectory, "sha256", digest.slice(0, 2), digest);
    await writeFile(target, "tampered", { encoding: "utf8" });
    await expect(persistence.artifacts.verify(artifact)).resolves.toEqual({ status: "corrupt" });
    const recovery = await persistence.recover();
    expect(recovery.integrity).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "ARTIFACT_CORRUPT", severity: "degraded" })],
    });
    const degraded = await persistence.sessions.open(session.ref);
    expect(degraded.readOnly).toBe(true);
    await expect(
      degraded.beginRun({
        branchId: snapshot.currentBranchId,
        initialMessages: [{ role: "user", text: "must not write" }],
        metadata: { task: "must not write", configurationRevision: "m3" },
      }),
    ).rejects.toMatchObject({ code: "SESSION_READ_ONLY" });

    await persistence[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });
});
