import type { RunId, SessionId } from "@coding-agent/agent";

export type IntegrityIssueCode =
  | "DATABASE_CHECK_FAILED"
  | "FOREIGN_KEY_VIOLATION"
  | "LEDGER_GAP"
  | "BRANCH_ANCESTRY_INVALID"
  | "TERMINAL_UNIQUENESS"
  | "TOOL_PAIRING_INVALID"
  | "CONTEXT_REFERENCE_INVALID"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_CORRUPT"
  | "STALE_LEASE"
  | "ORPHAN_RUN";

export interface IntegrityIssue {
  readonly code: IntegrityIssueCode;
  readonly severity: "warning" | "degraded" | "fatal";
  readonly message: string;
  readonly sessionId?: SessionId;
  readonly runId?: RunId;
}

export interface IntegrityReport {
  readonly version: 1;
  readonly schemaVersion: number;
  readonly ok: boolean;
  readonly issues: readonly IntegrityIssue[];
}

export interface RecoveryAction {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly action: "orphan_run_interrupted";
  readonly cancelledToolCalls: number;
  readonly unknownEffectToolCalls: number;
  readonly draftedQueueItems: number;
}

export interface RecoveryReport {
  readonly version: 1;
  readonly actions: readonly RecoveryAction[];
  readonly integrity: IntegrityReport;
}
