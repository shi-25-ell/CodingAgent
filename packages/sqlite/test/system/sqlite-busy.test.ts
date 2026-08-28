import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { describe, expect, it } from "vitest";
import { createSqlitePersistence, SqliteStorageError } from "../../src/index.js";

async function waitForLocked(child: ReturnType<typeof spawn>): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("lock fixture stdout is unavailable");
  let output = "";
  while (!output.includes("LOCKED\n")) {
    const [chunk] = (await once(stdout, "data")) as [Buffer];
    output += chunk.toString("utf8");
  }
}

describe("SQLite busy classification", () => {
  it("bounded busy timeout 返回 SQLite storage error，不伪装成 writer lease conflict", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-busy-"));
    const databasePath = path.join(root, "state.sqlite3");
    const options = {
      databasePath,
      artifactDirectory: path.join(root, "artifacts"),
      busyTimeoutMs: 50,
      lease: { ownerId: "busy-test", durationMs: 1_000 },
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
    } as const;
    const initialized = await createSqlitePersistence(options);
    const competingConnection = await createSqlitePersistence({
      ...options,
      lease: { ownerId: "busy-test-2", durationMs: 1_000 },
    });
    const fixture = path.resolve("packages/sqlite/test/fixtures/hold-write-lock.mjs");
    const child = spawn(process.execPath, [fixture, databasePath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      await waitForLocked(child);
      let failure: unknown;
      try {
        await competingConnection.sessions.create({
          workspace: { root: "D:/work/busy", fingerprint: "head:busy" },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SqliteStorageError);
      expect(failure).toMatchObject({ code: "SQLITE_BUSY" });
    } finally {
      child.stdin.end("release\n");
      await once(child, "exit");
      await initialized[Symbol.asyncDispose]();
      await competingConnection[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true });
    }
  });
});
