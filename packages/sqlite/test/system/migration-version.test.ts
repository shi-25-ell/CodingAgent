import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { openDatabase, translateSqliteError } from "../../src/connection/database.js";
import { createSqlitePersistence, SqliteStorageError } from "../../src/index.js";

describe("SQLite migration runner", () => {
  it("每个 migration 独立 rollback，旧 version 可在下一次启动继续升级", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-migration-rollback-"));
    const databasePath = path.join(root, "state.sqlite3");
    await expect(
      openDatabase({
        databasePath,
        busyTimeoutMs: 100,
        now: () => 1_000,
        beforeMigrationCommit(version) {
          if (version === 2) throw new Error("injected migration failure");
        },
      }),
    ).rejects.toMatchObject({ code: "SQLITE_MIGRATION" });

    const afterRollback = new Database(databasePath);
    expect(afterRollback.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    const columns = afterRollback.query("PRAGMA table_info(sessions)").all() as {
      readonly name: string;
    }[];
    expect(columns.map((column) => column.name)).not.toContain("lease_epoch");
    afterRollback.close();

    const upgraded = await createSqlitePersistence({
      databasePath,
      artifactDirectory: path.join(root, "artifacts"),
      lease: { ownerId: "migration-test", durationMs: 1_000 },
      clock: new ManualClock(2_000),
      ids: new SequentialIdFactory(),
    });
    await expect(upgraded.checkIntegrity()).resolves.toMatchObject({ schemaVersion: 4, ok: true });
    await upgraded[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });

  it("未知未来 schema version 与 migration checksum 改写都 fail closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-migration-version-"));
    const databasePath = path.join(root, "state.sqlite3");
    const options = {
      databasePath,
      artifactDirectory: path.join(root, "artifacts"),
      lease: { ownerId: "migration-test", durationMs: 1_000 },
      clock: new ManualClock(2_000),
      ids: new SequentialIdFactory(),
    } as const;
    const initialized = await createSqlitePersistence(options);
    await initialized[Symbol.asyncDispose]();

    const tampered = new Database(databasePath);
    tampered.run("UPDATE migration_history SET checksum = 'tampered' WHERE version = 1");
    tampered.close();
    await expect(createSqlitePersistence(options)).rejects.toMatchObject({
      code: "SQLITE_MIGRATION",
    });

    const futurePath = path.join(root, "future.sqlite3");
    const future = new Database(futurePath);
    future.run("PRAGMA user_version = 999");
    future.close();
    await expect(
      createSqlitePersistence({ ...options, databasePath: futurePath }),
    ).rejects.toMatchObject({ code: "SQLITE_FUTURE_VERSION" });
    await rm(root, { recursive: true, force: true });
  });

  it("UNC network filesystem path 在连接前 fail closed", async () => {
    await expect(
      createSqlitePersistence({
        databasePath: "\\\\server\\share\\state.sqlite3",
        artifactDirectory: "\\\\server\\share\\artifacts",
        lease: { ownerId: "network-test", durationMs: 1_000 },
      }),
    ).rejects.toBeInstanceOf(SqliteStorageError);
    await expect(
      createSqlitePersistence({
        databasePath: "\\\\server\\share\\state.sqlite3",
        artifactDirectory: "\\\\server\\share\\artifacts",
        lease: { ownerId: "network-test", durationMs: 1_000 },
      }),
    ).rejects.toMatchObject({ code: "NETWORK_FILESYSTEM" });
  });

  it("配置、transaction rollback 与 disposed connection 都 fail closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-database-guards-"));
    for (const busyTimeoutMs of [0, 30_001, 1.5]) {
      await expect(
        openDatabase({
          databasePath: path.join(root, `${busyTimeoutMs}.sqlite3`),
          busyTimeoutMs,
          now: () => 1_000,
        }),
      ).rejects.toMatchObject({ code: "SQLITE_CONFIGURATION" });
    }
    await expect(
      openDatabase({ databasePath: "relative.sqlite3", busyTimeoutMs: 100, now: () => 1_000 }),
    ).rejects.toMatchObject({ code: "SQLITE_CONFIGURATION" });
    expect(() => translateSqliteError({ code: "SQLITE_LOCKED" }, "test")).toThrowError(
      SqliteStorageError,
    );
    const original = new Error("ordinary failure");
    expect(() => translateSqliteError(original, "test")).toThrow(original);

    const database = await openDatabase({
      databasePath: path.join(root, "state.sqlite3"),
      busyTimeoutMs: 100,
      now: () => 1_000,
    });
    expect(() =>
      database.immediate(() => {
        database.raw
          .prepare(
            "INSERT INTO sessions(session_id, workspace_root, workspace_fingerprint, revision, current_branch_id, active_run_id, degraded_reason, created_at, updated_at, lease_epoch) VALUES ('rolled-back', 'D:/work', 'head:x', 1, NULL, NULL, NULL, 1, 1, 0)",
          )
          .run();
        throw original;
      }),
    ).toThrow(original);
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = 'rolled-back'")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
    database.close();
    expect(() => database.immediate(() => undefined)).toThrowError(SqliteStorageError);
    await rm(root, { recursive: true, force: true });
  });
});
