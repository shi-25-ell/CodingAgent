import type { AssistantMessage, UserMessage } from "../model/protocol.js";
import type { ReportedRunPhase, RunReport, RunStatus, TerminationReason } from "./run-report.js";

export interface IdFactory {
  next(namespace: string): string;
}

export interface WorkspaceBaseline {
  readonly rootPath: string;
  readonly headSha: string;
  readonly fingerprint: string;
  readonly changedFiles: readonly string[];
}

export interface SessionSummary {
  readonly id: string;
  readonly workspacePath: string;
  readonly activeRunId?: string;
}

export interface TranscriptEntry {
  readonly entryId: string;
  readonly parentId?: string;
  readonly ledgerSeq: number;
  readonly branchId: string;
  readonly runId: string;
  readonly message: UserMessage | AssistantMessage;
}

export interface RunView {
  readonly id: string;
  readonly status: "active" | "terminal";
  readonly startedAt: number;
  readonly terminalLedgerSeq?: number;
  readonly report?: RunReport;
}

export interface OperationRecord {
  readonly ledgerSeq: number;
  readonly runId: string;
  readonly operation: LedgerOperation;
}

export interface SessionView {
  readonly id: string;
  readonly workspace: WorkspaceBaseline;
  readonly defaultProviderProfile: string;
  readonly defaultModel: string;
  readonly currentBranchId: string;
  readonly activeRunId?: string;
  readonly transcript: readonly TranscriptEntry[];
  readonly operations: readonly OperationRecord[];
  readonly runs: readonly RunView[];
}

export type LedgerOperation =
  | { readonly type: "run_started" }
  | { readonly type: "phase_changed"; readonly phase: ReportedRunPhase }
  | { readonly type: "model_attempt_started"; readonly attempt: number }
  | {
      readonly type: "model_attempt_failed";
      readonly attempt: number;
      readonly category: string;
      readonly retryable: boolean;
      readonly message: string;
      readonly retryAfterMs?: number;
      readonly httpStatus?: number;
      readonly requestId?: string;
    }
  | { readonly type: "model_retry_scheduled"; readonly delayMs: number }
  | {
      readonly type: "terminal";
      readonly status: RunStatus;
      readonly reason: TerminationReason;
      readonly lastPhase: ReportedRunPhase;
    };

export interface RunLease {
  readonly runId: string;
  commitAssistant(message: AssistantMessage): Promise<void>;
  recordOperation(operation: LedgerOperation): Promise<void>;
  finish(report: RunReport): Promise<void>;
}

export interface SessionLedger {
  createSession(input: {
    workspace: WorkspaceBaseline;
    defaultProviderProfile: string;
    defaultModel: string;
  }): Promise<SessionSummary>;
  listSessions(): Promise<readonly SessionSummary[]>;
  inspectSession(sessionId: string): Promise<SessionView>;
  beginRun(sessionId: string, input: { initialTask: string }): Promise<RunLease>;
}
