import type {
  BranchId,
  CompactionCheckpointMetadata,
  ContextDerivationRecord,
  ContextManifest,
  QueueItem,
  RunConfigSnapshot,
  RunId,
  RunPhase,
  RunReport,
  SessionBranchSummary,
  SessionId,
  TokenMeasurement,
  ToolOutcome,
  ToolUpdate,
} from "@coding-agent/agent";
import type { AssistantMessage, ModelFailure } from "@coding-agent/model";
import type { ApprovalRequest, ToolEffect, ToolResource } from "../tools/coding-tool-host.js";

export interface CodingToolPlanSummary {
  readonly callId: string;
  readonly toolName: string;
  readonly resources: readonly ToolResource[];
  readonly effects: readonly ToolEffect[];
  readonly risks: readonly string[];
  readonly fingerprint?: string;
}

export interface CodingApprovalSummary {
  readonly approvalId: string;
  readonly callId: string;
  readonly plan: CodingToolPlanSummary;
  readonly decisions: readonly ["allow_once", "deny"];
  readonly status: "pending" | "allowed" | "denied" | "stale" | "withdrawn";
}

export interface CodingRecoveryDiagnostic {
  readonly code: "RUN_INTERRUPTED";
  readonly message: string;
  readonly runId: RunId;
}

interface CodingSemanticEventBase {
  readonly version: 1;
  readonly category: "semantic";
  readonly runId: RunId;
  readonly sequence: number;
  readonly eventId: string;
  readonly occurredAtMs?: number;
}

export type CodingSemanticEvent = CodingSemanticEventBase &
  (
    | {
        readonly type: "run_started";
        readonly sessionId: SessionId;
        readonly branchId: BranchId;
        readonly config: RunConfigSnapshot;
      }
    | { readonly type: "user_accepted"; readonly text: string }
    | {
        readonly type: "assistant_committed";
        readonly message: AssistantMessage;
        readonly ledgerSeq: number;
      }
    | { readonly type: "tool_planned"; readonly plan: CodingToolPlanSummary }
    | { readonly type: "tool_started"; readonly callId: string }
    | {
        readonly type: "tool_settled";
        readonly outcome: ToolOutcome;
        readonly ledgerSeq: number;
      }
    | {
        readonly type: "permission_requested";
        readonly approval: CodingApprovalSummary;
        readonly request: ApprovalRequest;
      }
    | {
        readonly type: "permission_resolved";
        readonly approvalId: string;
        readonly status: Exclude<CodingApprovalSummary["status"], "pending">;
        readonly decision?: "allow_once" | "deny";
      }
    | { readonly type: "queue_changed" | "queue_delivered"; readonly item: QueueItem }
    | {
        readonly type: "context_prepared";
        readonly manifest: ContextManifest;
        readonly measurement: TokenMeasurement;
        readonly checkpoint?: CompactionCheckpointMetadata;
        readonly derivations: readonly ContextDerivationRecord[];
      }
    | {
        readonly type: "compaction_completed";
        readonly derivation: ContextDerivationRecord;
        readonly checkpoint?: CompactionCheckpointMetadata;
      }
    | { readonly type: "compaction_failed"; readonly derivation: ContextDerivationRecord }
    | {
        readonly type: "model_failure_committed";
        readonly failure: ModelFailure;
        readonly ledgerSeq: number;
      }
    | { readonly type: "recovery_observed"; readonly diagnostic: CodingRecoveryDiagnostic }
    | {
        readonly type: "session_updated";
        readonly revision: number;
        readonly currentBranchId: BranchId;
        readonly activeRunId?: RunId;
        readonly branches: readonly SessionBranchSummary[];
      }
    | { readonly type: "terminal_committed"; readonly report: RunReport }
  );

interface CodingProgressEventBase {
  readonly version: 1;
  readonly category: "progress";
  readonly runId: RunId;
  readonly key: string;
  readonly revision: number;
  readonly occurredAtMs?: number;
}

export type CodingProgressEvent = CodingProgressEventBase &
  (
    | { readonly type: "phase_changed"; readonly phase: RunPhase }
    | {
        readonly type: "model_attempt_started";
        readonly modelTurnCount: number;
        readonly modelAttemptCount: number;
      }
    | {
        readonly type: "assistant_delta";
        readonly modelTurnCount: number;
        readonly modelAttemptCount: number;
        readonly partIndex: number;
        readonly channel: "text" | "reasoning";
        readonly delta: string;
      }
    | { readonly type: "tool_update"; readonly callId: string; readonly update: ToolUpdate }
    | {
        readonly type: "compaction_progress";
        readonly state: "preparing" | "compacting";
      }
  );

export type CodingEvent = CodingSemanticEvent | CodingProgressEvent;

export type CodingSemanticPayload<T = CodingSemanticEvent> = T extends CodingSemanticEvent
  ? Omit<T, keyof CodingSemanticEventBase>
  : never;

export type CodingProgressPayload<T = CodingProgressEvent> = T extends CodingProgressEvent
  ? Omit<T, "version" | "category" | "runId" | "revision">
  : never;
