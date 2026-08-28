import { mkdir, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { migrations } from "../migrations/migrations.js";

const maximumBusyTimeoutMs = 30_000;
const knownNetworkFilesystemTypes = new Set([0x517b, 0x6969, 0x6e667364, 0xff534d42]);

export class SqliteStorageError extends Error {
  readonly code:
    | "SQLITE_BUSY"
    | "SQLITE_CONFIGURATION"
    | "SQLITE_MIGRATION"
    | "SQLITE_FUTURE_VERSION"
    | "SQLITE_DISPOSED"
    | "NETWORK_FILESYSTEM";

  constructor(code: SqliteStorageError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteStorageError";
    this.code = code;
  }
}

export interface OpenDatabaseOptions {
  readonly databasePath: string;
  readonly busyTimeoutMs: number;
  readonly now: () => number;
  readonly beforeMigrationCommit?: (version: number) => void;
}

export interface SqliteDatabase {
  readonly raw: Database.Database;
  immediate<T>(operation: () => T): T;
  close(): void;
}

function sqliteCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

export function translateSqliteError(error: unknown, operation: string): never {
  const code = sqliteCode(error);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    throw new SqliteStorageError("SQLITE_BUSY", `${operation} 遇到 SQLite busy`, { cause: error });
  }
  throw error;
}

async function assertLocalFilesystem(databasePath: string): Promise<void> {
  if (!path.isAbsolute(databasePath)) {
    throw new SqliteStorageError("SQLITE_CONFIGURATION", "databasePath 必须是 absolute path");
  }
  if (databasePath.startsWith("\\\\") || databasePath.startsWith("//")) {
    throw new SqliteStorageError("NETWORK_FILESYSTEM", "不支持 network filesystem 上的 SQLite");
  }
  const parent = path.dirname(databasePath);
  await mkdir(parent, { recursive: true });
  const resolvedParent = await realpath(parent);
  if (resolvedParent.startsWith("\\\\") || resolvedParent.startsWith("//")) {
    throw new SqliteStorageError("NETWORK_FILESYSTEM", "不支持 network filesystem 上的 SQLite");
  }
  const statistics = await statfs(resolvedParent);
  if (knownNetworkFilesystemTypes.has(Number(statistics.type))) {
    throw new SqliteStorageError(
      "NETWORK_FILESYSTEM",
      "检测到 network filesystem，拒绝打开 SQLite",
    );
  }
}

function validateMigrationHistory(database: Database.Database): void {
  const currentVersion = database.pragma("user_version", { simple: true }) as number;
  const latestVersion = migrations.at(-1)?.version ?? 0;
  if (currentVersion > latestVersion) {
    throw new SqliteStorageError(
      "SQLITE_FUTURE_VERSION",
      `database schema version ${currentVersion} 高于当前支持的 ${latestVersion}`,
    );
  }
  if (currentVersion === 0) return;
  const rows = database
    .prepare("SELECT version, checksum FROM migration_history ORDER BY version")
    .all() as { readonly version: number; readonly checksum: string }[];
  for (const applied of rows) {
    const expected = migrations.find((candidate) => candidate.version === applied.version);
    if (!expected || expected.checksum !== applied.checksum) {
      throw new SqliteStorageError(
        "SQLITE_MIGRATION",
        `migration ${applied.version} checksum 不匹配`,
      );
    }
  }
  if (rows.length !== currentVersion || rows.at(-1)?.version !== currentVersion) {
    throw new SqliteStorageError("SQLITE_MIGRATION", "migration_history 与 user_version 不一致");
  }
}

function migrate(
  database: Database.Database,
  now: () => number,
  beforeCommit?: (version: number) => void,
): void {
  while (true) {
    try {
      database.exec("BEGIN EXCLUSIVE");
      validateMigrationHistory(database);
      const currentVersion = database.pragma("user_version", { simple: true }) as number;
      const migration = migrations.find((candidate) => candidate.version > currentVersion);
      if (!migration) {
        database.exec("COMMIT");
        return;
      }
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO migration_history(version, checksum, applied_at, tool_version) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.checksum, now(), "fast-m3");
      database.pragma(`user_version = ${migration.version}`);
      beforeCommit?.(migration.version);
      database.exec("COMMIT");
    } catch (error) {
      if (database.inTransaction) database.exec("ROLLBACK");
      if (error instanceof SqliteStorageError) throw error;
      const code = sqliteCode(error);
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
        translateSqliteError(error, "SQLite migration");
      }
      throw new SqliteStorageError("SQLITE_MIGRATION", "migration 失败", {
        cause: error,
      });
    }
  }
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<SqliteDatabase> {
  if (
    !Number.isInteger(options.busyTimeoutMs) ||
    options.busyTimeoutMs <= 0 ||
    options.busyTimeoutMs > maximumBusyTimeoutMs
  ) {
    throw new SqliteStorageError(
      "SQLITE_CONFIGURATION",
      `busyTimeoutMs 必须在 1..${maximumBusyTimeoutMs} 范围内`,
    );
  }
  await assertLocalFilesystem(options.databasePath);
  const raw = new Database(options.databasePath);
  try {
    raw.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    raw.pragma("foreign_keys = ON");
    raw.pragma("synchronous = FULL");
    const journalMode = raw.pragma("journal_mode = WAL", { simple: true });
    if (String(journalMode).toLowerCase() !== "wal") {
      throw new SqliteStorageError("SQLITE_CONFIGURATION", "SQLite WAL 未成功启用");
    }
    migrate(raw, options.now, options.beforeMigrationCommit);
  } catch (error) {
    raw.close();
    if (error instanceof SqliteStorageError) throw error;
    translateSqliteError(error, "SQLite initialization");
  }
  let closed = false;
  return {
    raw,
    immediate<T>(operation: () => T): T {
      if (closed) throw new SqliteStorageError("SQLITE_DISPOSED", "SQLite connection 已关闭");
      try {
        raw.exec("BEGIN IMMEDIATE");
        const result = operation();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        if (raw.inTransaction) raw.exec("ROLLBACK");
        translateSqliteError(error, "SQLite write transaction");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      raw.close();
    },
  };
}
