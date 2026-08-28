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
});
