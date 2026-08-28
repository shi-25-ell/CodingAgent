import {
  type ArtifactIntegrity,
  type ArtifactRef,
  type Clock,
  type IdFactory,
  type RunReport,
  recordId,
  runId,
  SessionError,
  sessionId,
  type ToolOutcome,
} from "@coding-agent/agent";
import type Database from "better-sqlite3";
import type { SqliteDatabase } from "../connection/database.js";
import { migrations } from "../migrations/migrations.js";
import type {
  IntegrityIssue,
  IntegrityReport,
  RecoveryAction,
  RecoveryReport,
} from "./contracts.js";

interface OrphanRow {
  readonly session_id: string;
  readonly run_id: string;
  readonly branch_id: string;
}

interface ToolCallRow {
  readonly call_id: string;
  readonly state: "planned" | "started";
}

interface BranchIntegrityRow {
  readonly session_id: string;
  readonly branch_id: string;
  readonly parent_branch_id: string | null;
  readonly fork_record_id: string | null;
  readonly current_branch_id: string;
}

interface RecoveryOptions {
  readonly database: SqliteDatabase;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly verifyArtifactRef: (ref: ArtifactRef) => Promise<ArtifactIntegrity>;
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function appendLedger(
  raw: Database.Database,
  clock: Clock,
  ids: IdFactory,
  session: string,
  branch: string,
  run: string,
  payload: Record<string, unknown> & { readonly kind: string },
): void {
  const sequence = raw
    .prepare(
      "SELECT COALESCE(MAX(ledger_seq), 0) + 1 AS value FROM ledger_records WHERE session_id = ?",
    )
    .get(session) as { readonly value: number };
  const head = raw
    .prepare("SELECT record_id FROM branch_heads WHERE session_id = ? AND branch_id = ?")
    .get(session, branch) as { readonly record_id: string | null };
  const id = recordId(ids.next("record"));
  raw
    .prepare(
      `INSERT INTO ledger_records(
        record_id, session_id, ledger_seq, run_id, branch_id,
        parent_entry_id, kind, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      session,
      sequence.value,
      run,
      branch,
      head.record_id,
      payload.kind,
      encode(payload),
      clock.now(),
    );
  raw
    .prepare("UPDATE branch_heads SET record_id = ? WHERE session_id = ? AND branch_id = ?")
    .run(id, session, branch);
}

function recoveryOutcome(call: ToolCallRow): ToolOutcome {
  if (call.state === "planned") {
    return {
      callId: call.call_id,
      status: "cancelled",
      isError: true,
      modelContent: "Run 中断；durable state 表明 ToolCall 尚未启动",
      effectState: "none",
      abortObserved: false,
      artifacts: [],
    };
  }
  return {
    callId: call.call_id,
    status: "failed",
    isError: true,
    modelContent: "Run 中断；ToolCall effect 无法确认，未自动重放",
    effectState: "unknown",
    abortObserved: false,
    artifacts: [],
  };
}

function recoveredReport(raw: Database.Database, orphan: OrphanRow): RunReport {
  const run = raw
    .prepare("SELECT model_turn_count FROM runs WHERE run_id = ?")
    .get(orphan.run_id) as { readonly model_turn_count: number };
  const manifest = raw
    .prepare("SELECT COUNT(*) AS count FROM context_manifests WHERE run_id = ?")
    .get(orphan.run_id) as { readonly count: number };
  const derivations = raw
    .prepare("SELECT COUNT(*) AS count FROM compaction_checkpoints WHERE run_id = ?")
    .get(orphan.run_id) as { readonly count: number };
  const outcomes = raw
    .prepare("SELECT outcome_json FROM tool_calls WHERE run_id = ? ORDER BY source_order")
    .all(orphan.run_id) as { readonly outcome_json: string }[];
  const accepted = outcomes.length;
  const settled = accepted;
  const succeeded = outcomes.filter((row) => {
    const outcome = JSON.parse(row.outcome_json) as { readonly status?: unknown };
    return outcome.status === "succeeded";
  }).length;
  return {
    version: 1,
    runId: runId(orphan.run_id),
    status: "failed",
    terminationReason: "recovered_interruption",
    counts: {
      modelTurnCount: run.model_turn_count,
      modelAttemptCount: manifest.count,
      contextDerivationCount: derivations.count,
      toolCallCount: accepted,
      settledToolCallCount: settled,
    },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, attemptsWithUnknownUsage: 0 },
    tools: {
      accepted,
      settled,
      succeeded,
      failed: accepted - succeeded,
    },
    permissions: { requested: 0, allowed: 0, denied: 0 },
    changedFiles: [],
    commands: [],
    unfinishedWork: ["Run 在进程中断后被恢复；unknown effect 需要人工核验"],
    error: {
      code: "RECOVERED_INTERRUPTED_RUN",
      message: "active Run 的 writer lease 已过期或丢失",
    },
    lastPhase: "finalizing",
  };
}

export class SqliteRecovery {
  readonly #database: SqliteDatabase;
  readonly #raw: Database.Database;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #verifyArtifactRef: (ref: ArtifactRef) => Promise<ArtifactIntegrity>;

  constructor(options: RecoveryOptions) {
    this.#database = options.database;
    this.#raw = options.database.raw;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#verifyArtifactRef = options.verifyArtifactRef;
  }

  async recoverSession(requestedSession: string): Promise<RecoveryAction | undefined> {
    const orphan = this.#raw
      .prepare(
        `SELECT s.session_id, r.run_id, r.branch_id
         FROM sessions s
         JOIN runs r ON r.run_id = s.active_run_id AND r.status = 'active'
         LEFT JOIN session_leases l ON l.session_id = s.session_id
         WHERE s.session_id = ? AND (l.session_id IS NULL OR l.expires_at <= ?)`,
      )
      .get(requestedSession, this.#clock.now()) as OrphanRow | undefined;
    const action = orphan ? this.#database.immediate(() => this.#settleOrphan(orphan)) : undefined;
    const integrity = await this.checkIntegrity();
    const fatal = integrity.issues.find((issue) => issue.severity === "fatal");
    if (fatal) {
      throw new SessionError("SESSION_CORRUPT", fatal.message);
    }
    this.#database.immediate(() => {
      this.#raw
        .prepare("UPDATE sessions SET degraded_reason = NULL WHERE session_id = ?")
        .run(requestedSession);
      const degraded = integrity.issues.find(
        (issue) => issue.severity === "degraded" && issue.sessionId === requestedSession,
      );
      if (degraded) {
        this.#raw
          .prepare("UPDATE sessions SET degraded_reason = ? WHERE session_id = ?")
          .run(degraded.code, requestedSession);
      }
    });
    return action;
  }

  async recover(): Promise<RecoveryReport> {
    const orphans = this.#raw
      .prepare(
        `SELECT s.session_id, r.run_id, r.branch_id
         FROM sessions s
         JOIN runs r ON r.run_id = s.active_run_id AND r.status = 'active'
         LEFT JOIN session_leases l ON l.session_id = s.session_id
         WHERE l.session_id IS NULL OR l.expires_at <= ?
         ORDER BY s.session_id`,
      )
      .all(this.#clock.now()) as OrphanRow[];
    const actions = orphans.map((orphan) =>
      this.#database.immediate(() => this.#settleOrphan(orphan)),
    );
    this.#database.immediate(() => {
      this.#raw.prepare("DELETE FROM artifacts WHERE state = 'pending'").run();
    });
    const integrity = await this.checkIntegrity();
    this.#database.immediate(() => {
      this.#raw.prepare("UPDATE sessions SET degraded_reason = NULL").run();
      for (const issue of integrity.issues) {
        if (issue.severity !== "degraded" || !issue.sessionId) continue;
        this.#raw
          .prepare("UPDATE sessions SET degraded_reason = ? WHERE session_id = ?")
          .run(issue.code, issue.sessionId);
      }
    });
    return { version: 1, actions, integrity };
  }

  #settleOrphan(orphan: OrphanRow): RecoveryAction {
    const stillOrphan = this.#raw
      .prepare(
        `SELECT s.session_id, r.run_id, r.branch_id
         FROM sessions s
         JOIN runs r ON r.run_id = s.active_run_id AND r.status = 'active'
         LEFT JOIN session_leases l ON l.session_id = s.session_id
         WHERE s.session_id = ? AND r.run_id = ?
           AND (l.session_id IS NULL OR l.expires_at <= ?)`,
      )
      .get(orphan.session_id, orphan.run_id, this.#clock.now()) as OrphanRow | undefined;
    if (!stillOrphan) {
      throw new Error("orphan Run recovery CAS 已失效");
    }
    const calls = this.#raw
      .prepare(
        `SELECT call_id, state FROM tool_calls
         WHERE run_id = ? AND state IN ('planned', 'started') ORDER BY source_order`,
      )
      .all(orphan.run_id) as ToolCallRow[];
    let cancelled = 0;
    let unknown = 0;
    for (const call of calls) {
      const outcome = recoveryOutcome(call);
      const state = call.state === "planned" ? "cancelled" : "unknown_effect";
      if (call.state === "planned") cancelled += 1;
      else unknown += 1;
      this.#raw
        .prepare(
          `UPDATE tool_calls
           SET state = ?, outcome_json = ?, effect_state = ?, settled_at = ?
           WHERE run_id = ? AND call_id = ? AND state = ?`,
        )
        .run(
          state,
          encode(outcome),
          outcome.effectState,
          this.#clock.now(),
          orphan.run_id,
          call.call_id,
          call.state,
        );
      appendLedger(
        this.#raw,
        this.#clock,
        this.#ids,
        orphan.session_id,
        orphan.branch_id,
        orphan.run_id,
        {
          kind: "tool_outcome",
          outcome,
        },
      );
    }
    const drafted = this.#raw
      .prepare(
        `UPDATE queue_items
         SET status = 'draft', revision = revision + 1, updated_at = ?
         WHERE run_id = ? AND status = 'queued'`,
      )
      .run(this.#clock.now(), orphan.run_id).changes;
    const report = recoveredReport(this.#raw, orphan);
    appendLedger(
      this.#raw,
      this.#clock,
      this.#ids,
      orphan.session_id,
      orphan.branch_id,
      orphan.run_id,
      {
        kind: "recovery",
        reason: "interrupted",
      },
    );
    appendLedger(
      this.#raw,
      this.#clock,
      this.#ids,
      orphan.session_id,
      orphan.branch_id,
      orphan.run_id,
      {
        kind: "run_boundary",
        report,
      },
    );
    appendLedger(
      this.#raw,
      this.#clock,
      this.#ids,
      orphan.session_id,
      orphan.branch_id,
      orphan.run_id,
      {
        kind: "run_terminal",
        report,
      },
    );
    const now = this.#clock.now();
    this.#raw
      .prepare(
        `UPDATE runs SET status = 'failed', report_json = ?, terminal_at = ?
         WHERE run_id = ? AND status = 'active'`,
      )
      .run(encode(report), now, orphan.run_id);
    this.#raw
      .prepare(
        `UPDATE sessions
         SET active_run_id = NULL, revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND active_run_id = ?`,
      )
      .run(now, orphan.session_id, orphan.run_id);
    this.#raw.prepare("DELETE FROM session_leases WHERE session_id = ?").run(orphan.session_id);
    return {
      sessionId: sessionId(orphan.session_id),
      runId: runId(orphan.run_id),
      action: "orphan_run_interrupted",
      cancelledToolCalls: cancelled,
      unknownEffectToolCalls: unknown,
      draftedQueueItems: drafted,
    };
  }

  async checkIntegrity(): Promise<IntegrityReport> {
    const issues: IntegrityIssue[] = [];
    const schemaVersion = this.#raw.pragma("user_version", { simple: true }) as number;
    const expectedVersion = migrations.at(-1)?.version ?? 0;
    if (schemaVersion !== expectedVersion) {
      issues.push({
        code: "DATABASE_CHECK_FAILED",
        severity: "fatal",
        message: `schema version ${schemaVersion} 与 expected ${expectedVersion} 不一致`,
      });
    }
    const quickCheck = this.#raw.pragma("quick_check") as { readonly quick_check: string }[];
    if (quickCheck.some((row) => row.quick_check !== "ok")) {
      issues.push({
        code: "DATABASE_CHECK_FAILED",
        severity: "fatal",
        message: "SQLite quick_check 未通过",
      });
    }
    const foreignKeys = this.#raw.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length > 0) {
      issues.push({
        code: "FOREIGN_KEY_VIOLATION",
        severity: "fatal",
        message: `发现 ${foreignKeys.length} 个 foreign key violation`,
      });
    }
    const gaps = this.#raw
      .prepare(
        `SELECT session_id, COUNT(*) AS count, MIN(ledger_seq) AS minimum, MAX(ledger_seq) AS maximum
         FROM ledger_records GROUP BY session_id
         HAVING minimum <> 1 OR count <> maximum`,
      )
      .all() as { readonly session_id: string; readonly count: number }[];
    for (const gap of gaps) {
      issues.push({
        code: "LEDGER_GAP",
        severity: "degraded",
        message: "Session ledger sequence 存在 gap",
        sessionId: sessionId(gap.session_id),
      });
    }
    this.#checkBranches(issues);
    const terminalMismatch = this.#raw
      .prepare(
        `SELECT r.session_id, r.run_id, r.status, COUNT(l.record_id) AS terminal_count
         FROM runs r
         LEFT JOIN ledger_records l ON l.run_id = r.run_id AND l.kind = 'run_terminal'
         GROUP BY r.run_id
         HAVING (r.status = 'active' AND terminal_count <> 0)
            OR (r.status <> 'active' AND terminal_count <> 1)`,
      )
      .all() as { readonly session_id: string; readonly run_id: string }[];
    for (const mismatch of terminalMismatch) {
      issues.push({
        code: "TERMINAL_UNIQUENESS",
        severity: "degraded",
        message: "Run terminal record 数量与 durable status 不一致",
        sessionId: sessionId(mismatch.session_id),
        runId: runId(mismatch.run_id),
      });
    }
    const unsettledTerminalCalls = this.#raw
      .prepare(
        `SELECT t.session_id, t.run_id
         FROM tool_calls t JOIN runs r ON r.run_id = t.run_id
         WHERE r.status <> 'active' AND t.state IN ('planned', 'started')
         GROUP BY t.run_id`,
      )
      .all() as { readonly session_id: string; readonly run_id: string }[];
    for (const mismatch of unsettledTerminalCalls) {
      issues.push({
        code: "TOOL_PAIRING_INVALID",
        severity: "degraded",
        message: "terminal Run 仍有未结算 ToolCall",
        sessionId: sessionId(mismatch.session_id),
        runId: runId(mismatch.run_id),
      });
    }
    const stale = this.#raw
      .prepare(
        `SELECT s.session_id, s.active_run_id AS run_id
         FROM sessions s LEFT JOIN session_leases l ON l.session_id = s.session_id
         WHERE s.active_run_id IS NOT NULL AND (l.session_id IS NULL OR l.expires_at <= ?)`,
      )
      .all(this.#clock.now()) as { readonly session_id: string; readonly run_id: string }[];
    for (const row of stale) {
      issues.push({
        code: "ORPHAN_RUN",
        severity: "warning",
        message: "active Run 的 writer lease 已过期或缺失",
        sessionId: sessionId(row.session_id),
        runId: runId(row.run_id),
      });
    }
    this.#checkContextReferences(issues);
    await this.#checkArtifacts(issues);
    return { version: 1, schemaVersion, ok: issues.length === 0, issues };
  }

  #checkBranches(issues: IntegrityIssue[]): void {
    const branches = this.#raw
      .prepare(
        `SELECT b.session_id, b.branch_id, b.parent_branch_id, b.fork_record_id,
                s.current_branch_id
         FROM branches b JOIN sessions s ON s.session_id = b.session_id`,
      )
      .all() as BranchIntegrityRow[];
    const bySession = new Map<string, Map<string, BranchIntegrityRow>>();
    for (const branch of branches) {
      const map = bySession.get(branch.session_id) ?? new Map<string, BranchIntegrityRow>();
      map.set(branch.branch_id, branch);
      bySession.set(branch.session_id, map);
    }
    for (const [session, map] of bySession) {
      for (const branch of map.values()) {
        const seen = new Set<string>();
        let current: BranchIntegrityRow | undefined = branch;
        let invalid = false;
        while (current) {
          if (seen.has(current.branch_id)) {
            invalid = true;
            break;
          }
          seen.add(current.branch_id);
          current = current.parent_branch_id ? map.get(current.parent_branch_id) : undefined;
        }
        if (branch.parent_branch_id && !map.has(branch.parent_branch_id)) invalid = true;
        if (branch.fork_record_id) {
          const record = this.#raw
            .prepare("SELECT 1 FROM ledger_records WHERE session_id = ? AND record_id = ?")
            .get(session, branch.fork_record_id);
          if (!record) invalid = true;
        }
        if (invalid) {
          issues.push({
            code: "BRANCH_ANCESTRY_INVALID",
            severity: branch.branch_id === branch.current_branch_id ? "degraded" : "warning",
            message: "Conversation Branch ancestry 或 fork point 损坏",
            sessionId: sessionId(session),
          });
        }
      }
    }
  }

  #checkContextReferences(issues: IntegrityIssue[]): void {
    const manifests = this.#raw
      .prepare("SELECT session_id, run_id, payload_json FROM context_manifests")
      .all() as {
      readonly session_id: string;
      readonly run_id: string;
      readonly payload_json: string;
    }[];
    for (const row of manifests) {
      let selected: readonly string[];
      try {
        const payload = JSON.parse(row.payload_json) as { readonly selectedRecordIds?: unknown };
        selected = Array.isArray(payload.selectedRecordIds)
          ? payload.selectedRecordIds.filter((value): value is string => typeof value === "string")
          : [];
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        selected = ["__invalid_json__"];
      }
      const invalid = selected.some((record) => {
        if (record === "__invalid_json__") return true;
        return !this.#raw
          .prepare("SELECT 1 FROM ledger_records WHERE session_id = ? AND record_id = ?")
          .get(row.session_id, record);
      });
      if (invalid) {
        issues.push({
          code: "CONTEXT_REFERENCE_INVALID",
          severity: "degraded",
          message: "Context Manifest 引用了不存在的 Transcript record",
          sessionId: sessionId(row.session_id),
          runId: runId(row.run_id),
        });
      }
    }
  }

  async #checkArtifacts(issues: IntegrityIssue[]): Promise<void> {
    const artifacts = this.#raw
      .prepare("SELECT artifact_id FROM artifacts WHERE state = 'committed' ORDER BY artifact_id")
      .all() as { readonly artifact_id: string }[];
    const currentRecords = this.#currentBranchRecordIds();
    const ledgerRows = this.#raw
      .prepare(
        `SELECT session_id, record_id, payload_json
         FROM ledger_records WHERE kind = 'tool_outcome'`,
      )
      .all() as {
      readonly session_id: string;
      readonly record_id: string;
      readonly payload_json: string;
    }[];
    const references = new Map<string, { readonly session: string; readonly current: boolean }[]>();
    for (const row of ledgerRows) {
      let artifactIds: readonly string[] = [];
      try {
        const payload = JSON.parse(row.payload_json) as {
          readonly outcome?: { readonly artifacts?: readonly { readonly id?: unknown }[] };
        };
        artifactIds = (payload.outcome?.artifacts ?? [])
          .map((ref) => ref.id)
          .filter((id): id is string => typeof id === "string");
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      for (const artifact of artifactIds) {
        const list = references.get(artifact) ?? [];
        list.push({
          session: row.session_id,
          current: currentRecords.get(row.session_id)?.has(row.record_id) ?? false,
        });
        references.set(artifact, list);
      }
    }
    for (const artifact of artifacts) {
      const integrity = await this.#verifyArtifactRef({ id: artifact.artifact_id });
      if (integrity.status === "verified") continue;
      const refs = references.get(artifact.artifact_id) ?? [];
      if (refs.length === 0) {
        issues.push({
          code: integrity.status === "missing" ? "ARTIFACT_MISSING" : "ARTIFACT_CORRUPT",
          severity: "warning",
          message: "unreferenced committed Artifact bytes 缺失或 digest 不匹配",
        });
        continue;
      }
      for (const ref of refs) {
        issues.push({
          code: integrity.status === "missing" ? "ARTIFACT_MISSING" : "ARTIFACT_CORRUPT",
          severity: ref.current ? "degraded" : "warning",
          message: "Transcript 引用的 committed Artifact bytes 缺失或 digest 不匹配",
          sessionId: sessionId(ref.session),
        });
      }
    }
  }

  #currentBranchRecordIds(): Map<string, Set<string>> {
    const sessions = this.#raw
      .prepare("SELECT session_id, current_branch_id FROM sessions")
      .all() as { readonly session_id: string; readonly current_branch_id: string }[];
    const branchRows = this.#raw
      .prepare("SELECT session_id, branch_id, parent_branch_id, fork_record_id FROM branches")
      .all() as {
      readonly session_id: string;
      readonly branch_id: string;
      readonly parent_branch_id: string | null;
      readonly fork_record_id: string | null;
    }[];
    const branches = new Map(branchRows.map((row) => [`${row.session_id}\0${row.branch_id}`, row]));
    const load = (session: string, branch: string, seen = new Set<string>()): string[] => {
      if (seen.has(branch)) return [];
      seen.add(branch);
      const row = branches.get(`${session}\0${branch}`);
      if (!row) return [];
      let inherited: string[] = [];
      if (row.parent_branch_id) {
        inherited = load(session, row.parent_branch_id, seen);
        if (row.fork_record_id) {
          const index = inherited.indexOf(row.fork_record_id);
          inherited = index >= 0 ? inherited.slice(0, index + 1) : [];
        } else {
          inherited = [];
        }
      }
      const own = this.#raw
        .prepare(
          "SELECT record_id FROM ledger_records WHERE session_id = ? AND branch_id = ? ORDER BY ledger_seq",
        )
        .all(session, branch) as { readonly record_id: string }[];
      return [...inherited, ...own.map((record) => record.record_id)];
    };
    return new Map(
      sessions.map((session) => [
        session.session_id,
        new Set(load(session.session_id, session.current_branch_id)),
      ]),
    );
  }
}
