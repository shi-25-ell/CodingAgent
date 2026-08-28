import { randomUUID } from "node:crypto";
import type { ArtifactStore, Clock, IdFactory, SessionRepository } from "@coding-agent/agent";
import { DurableArtifactStore, SqliteArtifactError } from "./artifacts/durable-artifact-store.js";
import { openDatabase, SqliteStorageError } from "./connection/database.js";
import type { IntegrityReport, RecoveryReport } from "./recovery/contracts.js";
import { SqliteRecovery } from "./recovery/recovery.js";
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
  readonly previewRedactor?: (text: string) => string;
}

export interface SqlitePersistence extends AsyncDisposable {
  readonly sessions: SessionRepository;
  readonly artifacts: ArtifactStore;
  checkIntegrity(): Promise<IntegrityReport>;
  recover(): Promise<RecoveryReport>;
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
  const ids = options.ids ?? new RandomIdFactory();
  const database = await openDatabase({
    databasePath: options.databasePath,
    busyTimeoutMs: options.busyTimeoutMs ?? 2_000,
    now: () => clock.now(),
  });
  let artifacts: DurableArtifactStore;
  try {
    artifacts = await DurableArtifactStore.create({
      database,
      directory: options.artifactDirectory,
      clock,
      ...(options.previewRedactor ? { previewRedactor: options.previewRedactor } : {}),
    });
  } catch (error) {
    database.close();
    throw error;
  }
  let disposed = false;
  const close = (): void => {
    if (disposed) return;
    disposed = true;
    void artifacts[Symbol.asyncDispose]();
    database.close();
  };
  const recovery = new SqliteRecovery({
    database,
    clock,
    ids,
    verifyArtifactRef: (ref) => artifacts.verify(ref),
  });
  const sessions = new SqliteSessionRepository({
    database,
    clock,
    ids,
    lease: options.lease,
    recoverSession: async (sessionId) => {
      await recovery.recoverSession(sessionId);
    },
    verifyArtifactRef: (ref) => artifacts.verify(ref),
    disposeDatabase: close,
  });
  return {
    sessions,
    artifacts,
    checkIntegrity: () => recovery.checkIntegrity(),
    recover: () => recovery.recover(),
    async [Symbol.asyncDispose]() {
      close();
    },
  };
}

export type {
  IntegrityIssue,
  IntegrityIssueCode,
  IntegrityReport,
  RecoveryAction,
  RecoveryReport,
} from "./recovery/contracts.js";
export { SqliteStorageError, type SqliteLeaseOptions };
export { SqliteArtifactError };
