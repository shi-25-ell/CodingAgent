import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createSqlitePersistence } from "../../src/index.js";

describe("SQLite persistence lifecycle", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("空库 migration 后创建 Session，close/reopen 保持 tree、current branch 与 revision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-lifecycle-"));
    temporaryRoots.push(root);
    const databasePath = path.join(root, "state.sqlite3");
    const artifactDirectory = path.join(root, "artifacts");
    const clock = new ManualClock(1_000);
    const ids = new SequentialIdFactory();

    const first = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      busyTimeoutMs: 250,
      lease: { ownerId: "lifecycle-owner", durationMs: 30_000 },
      clock,
      ids,
    });
    const created = await first.sessions.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const beforeClose = await created.inspect();
    await first[Symbol.asyncDispose]();

    const reopenedPersistence = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      busyTimeoutMs: 250,
      lease: { ownerId: "reopen-owner", durationMs: 30_000 },
      clock,
      ids,
    });
    const reopened = await reopenedPersistence.sessions.open(created.ref);

    await expect(reopened.inspect()).resolves.toEqual(beforeClose);
    await expect(reopenedPersistence.sessions.list()).resolves.toEqual([
      expect.objectContaining({ ref: created.ref, revision: 1 }),
    ]);
    await reopenedPersistence[Symbol.asyncDispose]();
  });

  it("beginRun 在同一 transaction 拒绝 stale revision 与非 current branch，且不留下 active Run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m4-begin-run-cas-"));
    temporaryRoots.push(root);
    const persistence = await createSqlitePersistence({
      databasePath: path.join(root, "state.sqlite3"),
      artifactDirectory: path.join(root, "artifacts"),
      busyTimeoutMs: 250,
      lease: { ownerId: "begin-run-cas", durationMs: 30_000 },
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
    });
    const session = await persistence.sessions.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const initial = await session.inspect();
    const fork = await session.forkBranch({
      fromBranchId: initial.currentBranchId,
      expectedRevision: initial.revision,
    });
    const afterFork = await session.inspect();

    await expect(
      session.beginRun({
        branchId: fork.branchId,
        expectedRevision: afterFork.revision,
        initialMessages: [{ role: "user", text: "wrong branch" }],
        metadata: { task: "wrong branch", configurationRevision: "m4" },
      }),
    ).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    await expect(session.inspect()).resolves.toEqual(afterFork);

    const selected = await session.selectBranch(fork.branchId, afterFork.revision);
    await expect(
      session.beginRun({
        branchId: selected.currentBranchId,
        expectedRevision: afterFork.revision,
        initialMessages: [{ role: "user", text: "stale revision" }],
        metadata: { task: "stale revision", configurationRevision: "m4" },
      }),
    ).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    await expect(session.inspect()).resolves.toEqual(selected);
    await persistence[Symbol.asyncDispose]();
  });
});
