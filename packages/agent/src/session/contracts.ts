import type { AssistantMessage, ModelFailure } from "@coding-agent/model";
import type {
  ContextDerivationRecord,
  ContextManifest,
  StoredContextManifest,
} from "../context/contracts.js";
import type { BranchId, RecordId, RunId, SessionId } from "../contracts/primitives.js";
import type { RunReport } from "../runtime/contracts.js";
import type { ToolOutcome } from "../tools/contracts.js";

export interface SessionRef {
  readonly sessionId: SessionId;
}

export interface OpenSessionOptions {
  readonly mode?: "read_write" | "read_only";
}

export interface BranchRef {
  readonly sessionId: SessionId;
  readonly branchId: BranchId;
}

export interface WorkspaceBinding {
  readonly root: string;
  readonly fingerprint: string;
}

export interface CreateSessionInput {
  readonly workspace: WorkspaceBinding;
}

export interface SessionBranchSummary {
  readonly branchId: BranchId;
  readonly parentBranchId?: BranchId;
  readonly recordCount: number;
}

export interface SessionSnapshot {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceBinding;
  readonly revision: number;
  readonly currentBranchId: BranchId;
  readonly activeRunId?: RunId;
  readonly branches: readonly SessionBranchSummary[];
}

export interface SessionSummary {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceBinding;
  readonly revision: number;
  readonly activeRunId?: RunId;
}

interface LedgerRecordBase {
  readonly version: 1;
  readonly recordId: RecordId;
  readonly ledgerSeq: number;
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly createdAt: number;
}

export type LedgerRecord =
  | (LedgerRecordBase & {
      readonly kind: "run_started";
      readonly metadata: RunMetadata;
    })
  | (LedgerRecordBase & {
      readonly kind: "user_message";
      readonly text: string;
      readonly origin: "current_task" | "steering" | "follow_up";
    })
  | (LedgerRecordBase & { readonly kind: "assistant_message"; readonly message: AssistantMessage })
  | (LedgerRecordBase & { readonly kind: "model_failure"; readonly failure: ModelFailure })
  | (LedgerRecordBase & { readonly kind: "tool_started"; readonly callId: string })
  | (LedgerRecordBase & { readonly kind: "tool_outcome"; readonly outcome: ToolOutcome })
  | (LedgerRecordBase & { readonly kind: "run_terminal"; readonly report: RunReport })
  | (LedgerRecordBase & { readonly kind: "run_boundary"; readonly report: RunReport })
  | (LedgerRecordBase & {
      readonly kind: "recovery";
      readonly reason: "interrupted";
    });

export type NewLedgerRecord =
  | { readonly kind: "assistant_message"; readonly message: AssistantMessage }
  | { readonly kind: "tool_outcome"; readonly outcome: ToolOutcome }
  | { readonly kind: "model_failure"; readonly failure: ModelFailure };

export interface AgentInputMessage {
  readonly role: "user";
  readonly text: string;
}

export type QueueKind = "steering" | "follow_up";

export interface QueueInput {
  readonly commandId: string;
  readonly kind: QueueKind;
  readonly text: string;
}

export interface QueueItem extends QueueInput {
  readonly ordinal: number;
  readonly status: "queued" | "delivered" | "draft" | "cancelled";
  readonly revision: number;
}

export interface QueueUpdate {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly text?: string;
  readonly status: "queued" | "draft" | "cancelled";
}

export interface CompactionCheckpointMetadata {
  readonly version: 1;
  readonly checkpointId: string;
  readonly runId: RunId;
  readonly branchId: BranchId;
  readonly sourceStartLedgerSeq: number;
  readonly sourceEndLedgerSeq: number;
  readonly sourceStartRecordId: string;
  readonly sourceEndRecordId: string;
  readonly sourceDigest: string;
  readonly branchLeafRecordId: string;
  readonly retainedRecordIds: readonly string[];
  readonly priorCheckpointId?: string;
  readonly strategyVersion: string;
  readonly summaryArtifact: import("../tools/contracts.js").ArtifactRef;
  readonly summaryDigest: string;
  readonly tokenProvenance: {
    readonly method: "estimated_chars";
    readonly sourceTokens: number;
    readonly retainedTokens: number;
    readonly summaryTokens: number;
  };
}

export interface RunMetadata {
  readonly task: string;
  readonly configurationRevision: string;
}

export interface BeginRunInput {
  readonly branchId: BranchId;
  readonly expectedRevision: number;
  readonly initialMessages: readonly AgentInputMessage[];
  readonly metadata: RunMetadata;
}

export interface ReadBranchInput {
  readonly branchId: BranchId;
}

export interface SessionBranchView {
  readonly branch: BranchRef;
  readonly records: readonly LedgerRecord[];
  readonly checkpoints: readonly CompactionCheckpointMetadata[];
}

export interface ForkBranchInput {
  readonly fromBranchId: BranchId;
  readonly expectedRevision: number;
}

export interface CommitReceipt {
  readonly firstLedgerSeq: number;
  readonly lastLedgerSeq: number;
}

export interface TerminalCommit {
  readonly committed: boolean;
  readonly report: RunReport;
}

export interface RunLease extends AsyncDisposable {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly branchId: BranchId;
  readonly heartbeatIntervalMs: number;
  heartbeat(): Promise<void>;
  markModelTurnStarted(modelTurnCount: number): Promise<void>;
  append(entries: readonly NewLedgerRecord[]): Promise<CommitReceipt>;
  markToolCallStarted(callId: string): Promise<void>;
  drainSteering(): Promise<readonly QueueItem[]>;
  takeFollowUp(): Promise<QueueItem | undefined>;
  commitContext(
    manifest: ContextManifest,
    checkpoint?: CompactionCheckpointMetadata,
    derivations?: readonly ContextDerivationRecord[],
  ): Promise<void>;
  commitContextFailure(derivations: readonly ContextDerivationRecord[]): Promise<void>;
  /**
   * Durability seam for terminal arbitration. Implementations resolve only after a terminal report is
   * durable, returning that durable report (including an idempotently recovered existing report).
   * Expected storage uncertainty is settled inside the persistence Adapter; rejection denotes an
   * Adapter contract/invariant failure that cannot be represented as a Run terminal.
   */
  finish(report: RunReport): Promise<TerminalCommit>;
}

export interface SessionHandle extends AsyncDisposable {
  readonly ref: SessionRef;
  readonly readOnly: boolean;
  inspect(): Promise<SessionSnapshot>;
  readBranch(input: ReadBranchInput): Promise<SessionBranchView>;
  readRunReport(runId: RunId): Promise<RunReport | undefined>;
  listQueue(runId?: RunId): Promise<readonly QueueItem[]>;
  readContextManifests(runId: RunId): Promise<readonly StoredContextManifest[]>;
  readContextDerivations(runId: RunId): Promise<readonly ContextDerivationRecord[]>;
  selectBranch(branchId: BranchId, expectedRevision: number): Promise<SessionSnapshot>;
  forkBranch(input: ForkBranchInput): Promise<BranchRef>;
  enqueue(input: QueueInput): Promise<QueueItem>;
  updateQueue(input: QueueUpdate): Promise<QueueItem>;
  beginRun(input: BeginRunInput): Promise<RunLease>;
}

export interface SessionRepository extends AsyncDisposable {
  create(input: CreateSessionInput): Promise<SessionHandle>;
  open(ref: SessionRef, options?: OpenSessionOptions): Promise<SessionHandle>;
  list(): Promise<readonly SessionSummary[]>;
  delete(ref: SessionRef): Promise<void>;
}
