import { createHash, randomBytes } from "node:crypto";
import {
  type BeginRunInput,
  type BranchId,
  type BranchRef,
  branchId,
  type Clock,
  type CommitReceipt,
  type CreateSessionInput,
  type IdFactory,
  type LedgerRecord,
  type NewLedgerRecord,
  type QueueInput,
  type QueueItem,
  type RunId,
  type RunLease,
  type RunReport,
  recordId,
  runId,
  type SessionBranchView,
  SessionError,
  type SessionHandle,
  type SessionRef,
  type SessionRepository,
  type SessionSnapshot,
  type SessionSummary,
  sessionId,
  type TerminalCommit,
} from "@coding-agent/agent";
import type Database from "better-sqlite3";
import type { SqliteDatabase } from "../connection/database.js";

interface SessionRow {
  readonly session_id: string;
  readonly workspace_root: string;
  readonly workspace_fingerprint: string;
  readonly revision: number;
  readonly current_branch_id: string;
  readonly active_run_id: string | null;
  readonly degraded_reason: string | null;
}

interface BranchRow {
  readonly branch_id: string;
  readonly parent_branch_id: string | null;
  readonly fork_record_id: string | null;
}

interface LedgerRow {
  readonly record_id: string;
  readonly ledger_seq: number;
  readonly run_id: string;
  readonly branch_id: string;
  readonly kind: LedgerRecord["kind"];
  readonly payload_json: string;
  readonly created_at: number;
}

interface LeaseRow {
  readonly owner_id: string;
  readonly token_digest: string;
  readonly epoch: number;
  readonly expires_at: number;
}

export interface SqliteLeaseOptions {
  readonly ownerId: string;
  readonly durationMs: number;
}

export interface SqliteSessionRepositoryOptions {
  readonly database: SqliteDatabase;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly lease: SqliteLeaseOptions;
  readonly disposeDatabase: () => void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new SessionError("SESSION_TERMINAL_CONFLICT", `${label} durable JSON 损坏`, {
      cause: error,
    });
  }
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function ensureWorkspace(input: CreateSessionInput): void {
  if (input.workspace.root.trim().length === 0 || input.workspace.fingerprint.trim().length === 0) {
    throw new TypeError("workspace root 与 fingerprint 不能为空");
  }
}

function ensureLeaseOptions(options: SqliteLeaseOptions): void {
  if (options.ownerId.trim().length === 0) throw new TypeError("lease ownerId 不能为空");
  if (!Number.isInteger(options.durationMs) || options.durationMs <= 0) {
    throw new TypeError("lease durationMs 必须是正整数");
  }
}

function sessionFromRow(row: SessionRow): SessionSummary {
  return {
    ref: { sessionId: sessionId(row.session_id) },
    workspace: { root: row.workspace_root, fingerprint: row.workspace_fingerprint },
    revision: row.revision,
    ...(row.active_run_id ? { activeRunId: runId(row.active_run_id) } : {}),
  };
}

function terminalStatus(report: RunReport): Exclude<SessionRow["active_run_id"], undefined> {
  return report.status;
}

export class SqliteSessionRepository implements SessionRepository {
  readonly #database: SqliteDatabase;
  readonly #raw: Database.Database;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #lease: SqliteLeaseOptions;
  readonly #disposeDatabase: () => void;
  #disposed = false;

  constructor(options: SqliteSessionRepositoryOptions) {
    ensureLeaseOptions(options.lease);
    this.#database = options.database;
    this.#raw = options.database.raw;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#lease = options.lease;
    this.#disposeDatabase = options.disposeDatabase;
  }

  async create(input: CreateSessionInput): Promise<SessionHandle> {
    this.#assertAvailable();
    ensureWorkspace(input);
    const id = sessionId(this.#ids.next("session"));
    const initialBranch = branchId(this.#ids.next("branch"));
    const now = this.#clock.now();
    this.#database.immediate(() => {
      this.#raw
        .prepare(
          `INSERT INTO sessions(
            session_id, workspace_root, workspace_fingerprint, revision,
            current_branch_id, active_run_id, degraded_reason, created_at, updated_at
          ) VALUES (?, ?, ?, 1, NULL, NULL, NULL, ?, ?)`,
        )
        .run(id, input.workspace.root, input.workspace.fingerprint, now, now);
      this.#raw
        .prepare(
          `INSERT INTO branches(branch_id, session_id, parent_branch_id, fork_record_id, created_at)
           VALUES (?, ?, NULL, NULL, ?)`,
        )
        .run(initialBranch, id, now);
      this.#raw
        .prepare("INSERT INTO branch_heads(branch_id, session_id, record_id) VALUES (?, ?, NULL)")
        .run(initialBranch, id);
      this.#raw
        .prepare("UPDATE sessions SET current_branch_id = ? WHERE session_id = ?")
        .run(initialBranch, id);
    });
    return this.#handle({ sessionId: id });
  }

  async open(ref: SessionRef): Promise<SessionHandle> {
    this.#assertAvailable();
    this.#sessionRow(ref.sessionId);
    return this.#handle(ref);
  }

  async list(): Promise<readonly SessionSummary[]> {
    this.#assertAvailable();
    const rows = this.#raw
      .prepare(
        `SELECT session_id, workspace_root, workspace_fingerprint, revision,
                current_branch_id, active_run_id, degraded_reason
         FROM sessions ORDER BY created_at, session_id`,
      )
      .all() as SessionRow[];
    return rows.map(sessionFromRow);
  }

  async delete(ref: SessionRef): Promise<void> {
    this.#assertAvailable();
    this.#database.immediate(() => {
      const row = this.#sessionRow(ref.sessionId);
      if (row.active_run_id) {
        throw new SessionError("SESSION_ACTIVE_RUN", "active Run 期间不能删除 Session");
      }
      this.#raw.prepare("DELETE FROM sessions WHERE session_id = ?").run(ref.sessionId);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeDatabase();
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new SessionError("SESSION_DISPOSED", "SessionRepository 已释放");
  }

  #sessionRow(id: string): SessionRow {
    const row = this.#raw
      .prepare(
        `SELECT session_id, workspace_root, workspace_fingerprint, revision,
                current_branch_id, active_run_id, degraded_reason
         FROM sessions WHERE session_id = ?`,
      )
      .get(id) as SessionRow | undefined;
    if (!row) throw new SessionError("SESSION_NOT_FOUND", "Session 不存在");
    return row;
  }

  #branchRow(session: string, branch: string): BranchRow {
    const row = this.#raw
      .prepare(
        `SELECT branch_id, parent_branch_id, fork_record_id
         FROM branches WHERE session_id = ? AND branch_id = ?`,
      )
      .get(session, branch) as BranchRow | undefined;
    if (!row) throw new SessionError("SESSION_BRANCH_NOT_FOUND", "Conversation Branch 不存在");
    return row;
  }

  #recordRowsForBranch(session: string, branch: string, visited = new Set<string>()): LedgerRow[] {
    if (visited.has(branch)) {
      throw new SessionError("SESSION_TERMINAL_CONFLICT", "Conversation Branch ancestry 存在环");
    }
    visited.add(branch);
    const branchRow = this.#branchRow(session, branch);
    let inherited: LedgerRow[] = [];
    if (branchRow.parent_branch_id) {
      inherited = this.#recordRowsForBranch(session, branchRow.parent_branch_id, visited);
      if (branchRow.fork_record_id) {
        const forkIndex = inherited.findIndex(
          (record) => record.record_id === branchRow.fork_record_id,
        );
        if (forkIndex < 0) {
          throw new SessionError(
            "SESSION_TERMINAL_CONFLICT",
            "Conversation Branch fork point 不属于 parent ancestry",
          );
        }
        inherited = inherited.slice(0, forkIndex + 1);
      } else {
        inherited = [];
      }
    }
    const own = this.#raw
      .prepare(
        `SELECT record_id, ledger_seq, run_id, branch_id, kind, payload_json, created_at
         FROM ledger_records WHERE session_id = ? AND branch_id = ? ORDER BY ledger_seq`,
      )
      .all(session, branch) as LedgerRow[];
    visited.delete(branch);
    return [...inherited, ...own];
  }

  #ledgerRecord(row: LedgerRow): LedgerRecord {
    const payload = decode<Record<string, unknown>>(row.payload_json, "ledger record");
    return {
      version: 1,
      recordId: recordId(row.record_id),
      ledgerSeq: row.ledger_seq,
      runId: runId(row.run_id),
      branchId: branchId(row.branch_id),
      createdAt: row.created_at,
      ...payload,
    } as LedgerRecord;
  }

  #snapshot(id: string): SessionSnapshot {
    const session = this.#sessionRow(id);
    const branches = this.#raw
      .prepare(
        `SELECT branch_id, parent_branch_id, fork_record_id
         FROM branches WHERE session_id = ? ORDER BY created_at, branch_id`,
      )
      .all(id) as BranchRow[];
    return clone({
      ...sessionFromRow(session),
      currentBranchId: branchId(session.current_branch_id),
      branches: branches.map((branch) => ({
        branchId: branchId(branch.branch_id),
        ...(branch.parent_branch_id ? { parentBranchId: branchId(branch.parent_branch_id) } : {}),
        recordCount: this.#recordRowsForBranch(id, branch.branch_id).length,
      })),
    });
  }

  #handle(ref: SessionRef): SessionHandle {
    let disposed = false;
    const assertHandle = (): void => {
      this.#assertAvailable();
      if (disposed) throw new SessionError("SESSION_DISPOSED", "SessionHandle 已释放");
    };
    return {
      ref: clone(ref),
      inspect: async () => {
        assertHandle();
        return this.#snapshot(ref.sessionId);
      },
      readBranch: async (input): Promise<SessionBranchView> => {
        assertHandle();
        this.#branchRow(ref.sessionId, input.branchId);
        return clone({
          branch: { sessionId: ref.sessionId, branchId: input.branchId },
          records: this.#recordRowsForBranch(ref.sessionId, input.branchId).map((row) =>
            this.#ledgerRecord(row),
          ),
        });
      },
      readRunReport: async (requestedRun) => {
        assertHandle();
        const row = this.#raw
          .prepare(
            `SELECT report_json FROM runs
             WHERE session_id = ? AND run_id = ? AND status <> 'active'`,
          )
          .get(ref.sessionId, requestedRun) as { readonly report_json: string } | undefined;
        return row ? clone(decode<RunReport>(row.report_json, "RunReport")) : undefined;
      },
      selectBranch: async (selected, expectedRevision) => {
        assertHandle();
        this.#database.immediate(() => {
          const state = this.#sessionRow(ref.sessionId);
          this.#assertRevision(state, expectedRevision);
          if (state.active_run_id) {
            throw new SessionError(
              "SESSION_ACTIVE_RUN",
              "active Run 期间不能切换 Conversation Branch",
            );
          }
          this.#branchRow(ref.sessionId, selected);
          const changed = this.#raw
            .prepare(
              `UPDATE sessions SET current_branch_id = ?, revision = revision + 1, updated_at = ?
               WHERE session_id = ? AND revision = ?`,
            )
            .run(selected, this.#clock.now(), ref.sessionId, expectedRevision);
          if (changed.changes !== 1) this.#revisionConflict(expectedRevision);
        });
        return this.#snapshot(ref.sessionId);
      },
      forkBranch: async (input) => {
        assertHandle();
        return this.#forkBranch(ref.sessionId, input.fromBranchId, input.expectedRevision);
      },
      enqueue: async (input) => {
        assertHandle();
        return this.#enqueue(ref.sessionId, input);
      },
      beginRun: async (input) => {
        assertHandle();
        return this.#beginRun(ref.sessionId, input, assertHandle);
      },
      [Symbol.asyncDispose]: async () => {
        disposed = true;
      },
    };
  }

  #assertRevision(row: SessionRow, expected: number): void {
    if (row.revision !== expected) this.#revisionConflict(expected, row.revision);
  }

  #revisionConflict(expected: number, actual?: number): never {
    throw new SessionError(
      "SESSION_REVISION_CONFLICT",
      actual === undefined
        ? `Session revision 已从 ${expected} 变化`
        : `Session revision 已从 ${expected} 变为 ${actual}`,
    );
  }

  #forkBranch(session: string, from: BranchId, expectedRevision: number): BranchRef {
    return this.#database.immediate(() => {
      const state = this.#sessionRow(session);
      this.#assertRevision(state, expectedRevision);
      if (state.active_run_id) {
        throw new SessionError(
          "SESSION_ACTIVE_RUN",
          "active Run 期间不能 fork Conversation Branch",
        );
      }
      this.#branchRow(session, from);
      const head = this.#raw
        .prepare("SELECT record_id FROM branch_heads WHERE branch_id = ? AND session_id = ?")
        .get(from, session) as { readonly record_id: string | null } | undefined;
      const id = branchId(this.#ids.next("branch"));
      const now = this.#clock.now();
      this.#raw
        .prepare(
          `INSERT INTO branches(branch_id, session_id, parent_branch_id, fork_record_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, session, from, head?.record_id ?? null, now);
      this.#raw
        .prepare("INSERT INTO branch_heads(branch_id, session_id, record_id) VALUES (?, ?, ?)")
        .run(id, session, head?.record_id ?? null);
      const changed = this.#raw
        .prepare(
          `UPDATE sessions SET revision = revision + 1, updated_at = ?
           WHERE session_id = ? AND revision = ?`,
        )
        .run(now, session, expectedRevision);
      if (changed.changes !== 1) this.#revisionConflict(expectedRevision);
      return { sessionId: sessionId(session), branchId: id };
    });
  }

  #enqueue(session: string, input: QueueInput): QueueItem {
    if (input.commandId.trim().length === 0 || input.text.trim().length === 0) {
      throw new TypeError("queue commandId 与 text 不能为空");
    }
    return this.#database.immediate(() => {
      const state = this.#sessionRow(session);
      if (!state.active_run_id) {
        throw new SessionError("SESSION_LEASE_LOST", "没有 active Run 可接收 queue message");
      }
      const existing = this.#raw
        .prepare(
          `SELECT command_id, kind, text, ordinal, status
           FROM queue_items WHERE session_id = ? AND command_id = ?`,
        )
        .get(session, input.commandId) as
        | {
            readonly command_id: string;
            readonly kind: QueueItem["kind"];
            readonly text: string;
            readonly ordinal: number;
            readonly status: QueueItem["status"];
          }
        | undefined;
      if (existing) {
        return clone({
          commandId: existing.command_id,
          kind: existing.kind,
          text: existing.text,
          ordinal: existing.ordinal,
          status: existing.status,
        });
      }
      const next = this.#raw
        .prepare(
          "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM queue_items WHERE run_id = ?",
        )
        .get(state.active_run_id) as { readonly ordinal: number };
      const now = this.#clock.now();
      this.#raw
        .prepare(
          `INSERT INTO queue_items(
            session_id, command_id, run_id, kind, text, ordinal, status,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)`,
        )
        .run(
          session,
          input.commandId,
          state.active_run_id,
          input.kind,
          input.text,
          next.ordinal,
          now,
          now,
        );
      return { ...input, ordinal: next.ordinal, status: "queued" };
    });
  }

  #beginRun(session: string, input: BeginRunInput, assertHandle: () => void): RunLease {
    if (input.initialMessages.length === 0) throw new TypeError("Run 至少需要一条 initial message");
    for (const message of input.initialMessages) {
      if (message.text.trim().length === 0) throw new TypeError("initial message 不能为空");
    }
    const run = runId(this.#ids.next("run"));
    const token = randomBytes(32).toString("base64url");
    const digest = tokenDigest(token);
    const now = this.#clock.now();
    const epoch = this.#database.immediate(() => {
      const state = this.#sessionRow(session);
      if (state.active_run_id)
        throw new SessionError("SESSION_ACTIVE_RUN", "Session 已有 active Run");
      this.#branchRow(session, input.branchId);
      const priorLease = this.#raw
        .prepare("SELECT epoch, expires_at FROM session_leases WHERE session_id = ?")
        .get(session) as { readonly epoch: number; readonly expires_at: number } | undefined;
      if (priorLease && priorLease.expires_at > now) {
        throw new SessionError("SESSION_ACTIVE_RUN", "Session writer lease 已被占用");
      }
      const nextEpoch = (priorLease?.epoch ?? 0) + 1;
      this.#raw
        .prepare(
          `INSERT INTO session_leases(
            session_id, owner_id, token_digest, epoch, acquired_at, heartbeat_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            owner_id = excluded.owner_id,
            token_digest = excluded.token_digest,
            epoch = excluded.epoch,
            acquired_at = excluded.acquired_at,
            heartbeat_at = excluded.heartbeat_at,
            expires_at = excluded.expires_at`,
        )
        .run(
          session,
          this.#lease.ownerId,
          digest,
          nextEpoch,
          now,
          now,
          now + this.#lease.durationMs,
        );
      this.#raw
        .prepare(
          `INSERT INTO runs(
            run_id, session_id, branch_id, status, metadata_json, report_json,
            started_at, terminal_at, lease_epoch
          ) VALUES (?, ?, ?, 'active', ?, NULL, ?, NULL, ?)`,
        )
        .run(run, session, input.branchId, encode(input.metadata), now, nextEpoch);
      const changed = this.#raw
        .prepare(
          `UPDATE sessions SET active_run_id = ?, revision = revision + 1, updated_at = ?
           WHERE session_id = ? AND active_run_id IS NULL`,
        )
        .run(run, now, session);
      if (changed.changes !== 1)
        throw new SessionError("SESSION_ACTIVE_RUN", "Session 已有 active Run");
      this.#appendLedger(session, input.branchId, run, {
        kind: "run_started",
        metadata: input.metadata,
      });
      for (const message of input.initialMessages) {
        this.#appendLedger(session, input.branchId, run, {
          kind: "user_message",
          text: message.text,
        });
      }
      return nextEpoch;
    });
    return this.#runLease({
      session: sessionId(session),
      branch: input.branchId,
      run,
      token,
      tokenDigest: digest,
      epoch,
      assertHandle,
    });
  }

  #runLease(identity: {
    readonly session: ReturnType<typeof sessionId>;
    readonly branch: BranchId;
    readonly run: RunId;
    readonly token: string;
    readonly tokenDigest: string;
    readonly epoch: number;
    readonly assertHandle: () => void;
  }): RunLease {
    let disposed = false;
    const assertCapability = (): void => {
      identity.assertHandle();
      if (disposed) throw new SessionError("SESSION_LEASE_LOST", "RunLease 已释放");
    };
    return {
      runId: identity.run,
      sessionId: identity.session,
      branchId: identity.branch,
      append: async (entries): Promise<CommitReceipt> => {
        assertCapability();
        if (entries.length === 0) throw new TypeError("append entries 不能为空");
        return this.#database.immediate(() => {
          this.#assertLease(identity);
          const first = this.#nextLedgerSequence(identity.session);
          for (const entry of entries) {
            this.#appendLedger(identity.session, identity.branch, identity.run, entry);
            this.#trackToolFacts(identity.session, identity.run, entry);
          }
          this.#heartbeat(identity);
          return {
            firstLedgerSeq: first,
            lastLedgerSeq: this.#nextLedgerSequence(identity.session) - 1,
          };
        });
      },
      drainSteering: async (): Promise<readonly QueueItem[]> => {
        assertCapability();
        return this.#deliverQueue(identity, "steering", false);
      },
      takeFollowUp: async (): Promise<QueueItem | undefined> => {
        assertCapability();
        return (await this.#deliverQueue(identity, "follow_up", true))[0];
      },
      finish: async (report): Promise<TerminalCommit> => {
        assertCapability();
        return this.#finish(identity, report);
      },
      [Symbol.asyncDispose]: async () => {
        disposed = true;
      },
    };
  }

  #assertLease(identity: {
    readonly session: string;
    readonly run: string;
    readonly tokenDigest: string;
    readonly epoch: number;
  }): LeaseRow {
    const state = this.#sessionRow(identity.session);
    const lease = this.#raw
      .prepare(
        `SELECT owner_id, token_digest, epoch, expires_at
         FROM session_leases WHERE session_id = ?`,
      )
      .get(identity.session) as LeaseRow | undefined;
    if (
      !lease ||
      state.active_run_id !== identity.run ||
      lease.token_digest !== identity.tokenDigest ||
      lease.epoch !== identity.epoch ||
      lease.expires_at <= this.#clock.now()
    ) {
      throw new SessionError("SESSION_LEASE_LOST", "writer lease 已失效或被 fencing");
    }
    return lease;
  }

  #heartbeat(identity: {
    readonly session: string;
    readonly tokenDigest: string;
    readonly epoch: number;
  }): void {
    const now = this.#clock.now();
    const changed = this.#raw
      .prepare(
        `UPDATE session_leases SET heartbeat_at = ?, expires_at = ?
         WHERE session_id = ? AND token_digest = ? AND epoch = ? AND expires_at > ?`,
      )
      .run(
        now,
        now + this.#lease.durationMs,
        identity.session,
        identity.tokenDigest,
        identity.epoch,
        now,
      );
    if (changed.changes !== 1) {
      throw new SessionError("SESSION_LEASE_LOST", "writer lease heartbeat 被 fencing");
    }
  }

  #nextLedgerSequence(session: string): number {
    const row = this.#raw
      .prepare(
        "SELECT COALESCE(MAX(ledger_seq), 0) + 1 AS next_sequence FROM ledger_records WHERE session_id = ?",
      )
      .get(session) as { readonly next_sequence: number };
    return row.next_sequence;
  }

  #appendLedger(
    session: string,
    branch: string,
    run: string,
    payload:
      | { readonly kind: "run_started"; readonly metadata: BeginRunInput["metadata"] }
      | { readonly kind: "user_message"; readonly text: string }
      | NewLedgerRecord
      | { readonly kind: "run_terminal"; readonly report: RunReport },
  ): void {
    const nextSequence = this.#nextLedgerSequence(session);
    const id = recordId(this.#ids.next("record"));
    const head = this.#raw
      .prepare("SELECT record_id FROM branch_heads WHERE session_id = ? AND branch_id = ?")
      .get(session, branch) as { readonly record_id: string | null };
    this.#raw
      .prepare(
        `INSERT INTO ledger_records(
          record_id, session_id, ledger_seq, run_id, branch_id,
          parent_entry_id, kind, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        session,
        nextSequence,
        run,
        branch,
        head.record_id,
        payload.kind,
        encode(payload),
        this.#clock.now(),
      );
    this.#raw
      .prepare("UPDATE branch_heads SET record_id = ? WHERE session_id = ? AND branch_id = ?")
      .run(id, session, branch);
  }

  #trackToolFacts(session: string, run: string, entry: NewLedgerRecord): void {
    if (entry.kind === "assistant_message") {
      const calls = entry.message.content.filter((part) => part.type === "tool_call");
      const current = this.#raw
        .prepare(
          "SELECT COALESCE(MAX(source_order), -1) + 1 AS next_order FROM tool_calls WHERE run_id = ?",
        )
        .get(run) as { readonly next_order: number };
      calls.forEach((call, offset) => {
        this.#raw
          .prepare(
            `INSERT INTO tool_calls(
              run_id, call_id, session_id, source_order, state, call_json,
              outcome_json, effect_state, created_at, settled_at
            ) VALUES (?, ?, ?, ?, 'planned', ?, NULL, NULL, ?, NULL)`,
          )
          .run(
            run,
            call.callId,
            session,
            current.next_order + offset,
            encode(call),
            this.#clock.now(),
          );
      });
      return;
    }
    if (entry.kind !== "tool_outcome") return;
    const changed = this.#raw
      .prepare(
        `UPDATE tool_calls
         SET state = 'settled', outcome_json = ?, effect_state = ?, settled_at = ?
         WHERE run_id = ? AND call_id = ? AND state IN ('planned', 'started')`,
      )
      .run(
        encode(entry.outcome),
        entry.outcome.effectState,
        this.#clock.now(),
        run,
        entry.outcome.callId,
      );
    if (changed.changes !== 1) {
      throw new SessionError(
        "SESSION_TERMINAL_CONFLICT",
        "ToolOutcome 没有唯一对应的 accepted ToolCall",
      );
    }
  }

  #deliverQueue(
    identity: {
      readonly session: ReturnType<typeof sessionId>;
      readonly branch: BranchId;
      readonly run: RunId;
      readonly tokenDigest: string;
      readonly epoch: number;
    },
    kind: QueueItem["kind"],
    firstOnly: boolean,
  ): readonly QueueItem[] {
    return this.#database.immediate(() => {
      this.#assertLease(identity);
      const rows = this.#raw
        .prepare(
          `SELECT command_id, kind, text, ordinal, status
           FROM queue_items
           WHERE run_id = ? AND kind = ? AND status = 'queued'
           ORDER BY ordinal ${firstOnly ? "LIMIT 1" : ""}`,
        )
        .all(identity.run, kind) as {
        readonly command_id: string;
        readonly kind: QueueItem["kind"];
        readonly text: string;
        readonly ordinal: number;
        readonly status: QueueItem["status"];
      }[];
      const delivered: QueueItem[] = [];
      for (const row of rows) {
        const now = this.#clock.now();
        const changed = this.#raw
          .prepare(
            `UPDATE queue_items
             SET status = 'delivered', revision = revision + 1, updated_at = ?
             WHERE session_id = ? AND command_id = ? AND status = 'queued'`,
          )
          .run(now, identity.session, row.command_id);
        if (changed.changes !== 1) continue;
        this.#appendLedger(identity.session, identity.branch, identity.run, {
          kind: "user_message",
          text: row.text,
        });
        delivered.push({
          commandId: row.command_id,
          kind: row.kind,
          text: row.text,
          ordinal: row.ordinal,
          status: "delivered",
        });
      }
      this.#heartbeat(identity);
      return clone(delivered);
    });
  }

  #finish(
    identity: {
      readonly session: ReturnType<typeof sessionId>;
      readonly branch: BranchId;
      readonly run: RunId;
      readonly tokenDigest: string;
      readonly epoch: number;
    },
    report: RunReport,
  ): TerminalCommit {
    if (report.runId !== identity.run) throw new TypeError("RunReport runId 与 lease 不一致");
    return this.#database.immediate(() => {
      const existing = this.#raw
        .prepare("SELECT report_json FROM runs WHERE run_id = ? AND status <> 'active'")
        .get(identity.run) as { readonly report_json: string } | undefined;
      if (existing) {
        return { committed: false, report: clone(decode(existing.report_json, "RunReport")) };
      }
      this.#assertLease(identity);
      const facts = this.#raw
        .prepare(
          `SELECT COUNT(*) AS accepted,
                  COALESCE(SUM(CASE WHEN state IN ('settled', 'cancelled', 'unknown_effect') THEN 1 ELSE 0 END), 0)
                    AS settled
           FROM tool_calls WHERE run_id = ?`,
        )
        .get(identity.run) as { readonly accepted: number; readonly settled: number };
      if (facts.accepted !== facts.settled) {
        throw new SessionError(
          "SESSION_TERMINAL_CONFLICT",
          "Run 仍有未结算的 accepted ToolCall，不能 finish",
        );
      }
      if (
        report.counts.toolCallCount !== facts.accepted ||
        report.counts.settledToolCallCount !== facts.settled ||
        report.tools.accepted !== facts.accepted ||
        report.tools.settled !== facts.settled
      ) {
        throw new SessionError(
          "SESSION_TERMINAL_CONFLICT",
          "RunReport counts 与 durable facts 不一致",
        );
      }
      this.#appendLedger(identity.session, identity.branch, identity.run, {
        kind: "run_terminal",
        report,
      });
      const now = this.#clock.now();
      const terminal = this.#raw
        .prepare(
          `UPDATE runs SET status = ?, report_json = ?, terminal_at = ?
           WHERE run_id = ? AND status = 'active' AND lease_epoch = ?`,
        )
        .run(terminalStatus(report), encode(report), now, identity.run, identity.epoch);
      if (terminal.changes !== 1) {
        throw new SessionError("SESSION_TERMINAL_CONFLICT", "Run terminal CAS 失败");
      }
      const session = this.#raw
        .prepare(
          `UPDATE sessions
           SET active_run_id = NULL, revision = revision + 1, updated_at = ?
           WHERE session_id = ? AND active_run_id = ?`,
        )
        .run(now, identity.session, identity.run);
      if (session.changes !== 1) {
        throw new SessionError("SESSION_TERMINAL_CONFLICT", "Session terminal CAS 失败");
      }
      const lease = this.#raw
        .prepare(
          `DELETE FROM session_leases
           WHERE session_id = ? AND token_digest = ? AND epoch = ?`,
        )
        .run(identity.session, identity.tokenDigest, identity.epoch);
      if (lease.changes !== 1) {
        throw new SessionError("SESSION_LEASE_LOST", "terminal transaction 的 lease fencing 失败");
      }
      return { committed: true, report: clone(report) };
    });
  }
}
