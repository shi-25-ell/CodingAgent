import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/connection/database.js";
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
    expect(afterRollback.pragma("user_version", { simple: true })).toBe(1);
    const columns = afterRollback.pragma("table_info(sessions)") as { readonly name: string }[];
    expect(columns.map((column) => column.name)).not.toContain("lease_epoch");
    afterRollback.close();

    const upgraded = await createSqlitePersistence({
      databasePath,
      artifactDirectory: path.join(root, "artifacts"),
      lease: { ownerId: "migration-test", durationMs: 1_000 },
      clock: new ManualClock(2_000),
      ids: new SequentialIdFactory(),
    });
    await expect(upgraded.checkIntegrity()).resolves.toMatchObject({ schemaVersion: 2, ok: true });
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
    tampered.prepare("UPDATE migration_history SET checksum = 'tampered' WHERE version = 1").run();
    tampered.close();
    await expect(createSqlitePersistence(options)).rejects.toMatchObject({
      code: "SQLITE_MIGRATION",
    });

    const futurePath = path.join(root, "future.sqlite3");
    const future = new Database(futurePath);
    future.pragma("user_version = 999");
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
});
