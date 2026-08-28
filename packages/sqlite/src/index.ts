import { randomUUID } from "node:crypto";
import type { Clock, IdFactory, SessionRepository } from "@coding-agent/agent";
import { openDatabase, SqliteStorageError } from "./connection/database.js";
import {
  type SqliteLeaseOptions,
  SqliteSessionRepository,
} from "./repository/sqlite-session-repository.js";

export interface SqlitePersistenceOptions {
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly busyTimeoutMs?: number;
  readonly lease: SqliteLeaseOptions;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
}

export interface SqlitePersistence extends AsyncDisposable {
  readonly sessions: SessionRepository;
}

class RandomIdFactory implements IdFactory {
  next(scope: "session" | "branch" | "run" | "record" | "manifest"): string {
    return `${scope}-${randomUUID()}`;
  }
}

export async function createSqlitePersistence(
  options: SqlitePersistenceOptions,
): Promise<SqlitePersistence> {
  if (!options.artifactDirectory || options.artifactDirectory.trim().length === 0) {
    throw new TypeError("artifactDirectory 不能为空");
  }
  const clock = options.clock ?? { now: () => Date.now() };
  const database = await openDatabase({
    databasePath: options.databasePath,
    busyTimeoutMs: options.busyTimeoutMs ?? 2_000,
    now: () => clock.now(),
  });
  let disposed = false;
  const close = (): void => {
    if (disposed) return;
    disposed = true;
    database.close();
  };
  const sessions = new SqliteSessionRepository({
    database,
    clock,
    ids: options.ids ?? new RandomIdFactory(),
    lease: options.lease,
    disposeDatabase: close,
  });
  return {
    sessions,
    async [Symbol.asyncDispose]() {
      close();
    },
  };
}

export { SqliteStorageError, type SqliteLeaseOptions };
