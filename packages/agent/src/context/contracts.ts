import type {
  InstructionPart,
  ModelMessage,
  ModelRequest,
  ModelToolDefinition,
} from "@coding-agent/model";
import type { RunId } from "../contracts/primitives.js";
import type { CompactionCheckpointMetadata, SessionBranchView } from "../session/contracts.js";

export type ContextOrderingGroup =
  | "system"
  | "project_instructions"
  | "skills"
  | "checkpoint"
  | "conversation"
  | "artifact_previews";

export type ContextSensitivity = "public" | "workspace" | "restricted";

export interface ContextProvenance {
  readonly kind:
    | "built_in"
    | "configuration"
    | "session"
    | "transcript"
    | "queue"
    | "project"
    | "skill"
    | "checkpoint"
    | "artifact";
  readonly id: string;
  readonly digest?: string;
  readonly recordIds?: readonly string[];
  readonly artifactIds?: readonly string[];
  readonly attributes?: Readonly<Record<string, string>>;
}

export type ContextContributionContent =
  | { readonly kind: "instructions"; readonly parts: readonly InstructionPart[] }
  | { readonly kind: "messages"; readonly messages: readonly ModelMessage[] }
  | { readonly kind: "tool_definitions"; readonly tools: readonly ModelToolDefinition[] };

export interface ContextContribution {
  readonly id: string;
  readonly sourceId: string;
  readonly priority: number;
  readonly required: boolean;
  readonly orderingGroup: ContextOrderingGroup;
  readonly sequence: number;
  readonly estimatedTokens: number;
  readonly provenance: ContextProvenance;
  readonly sensitivity: ContextSensitivity;
  readonly content?: ContextContributionContent;
  readonly unavailableReason?: "artifact_missing" | "artifact_corrupt" | "not_applicable";
  /** Transcript contributions are selected and compacted as indivisible complete Model Turns. */
  readonly completeModelTurn?: boolean;
}

export interface ContextSourceInput {
  readonly runId: RunId;
  readonly modelTurnCount: number;
  readonly modelAttemptCount: number;
  readonly branch: SessionBranchView;
  readonly tools: readonly ModelToolDefinition[];
  readonly signal: AbortSignal;
}

export interface ContextSource {
  readonly id: string;
  collect(input: ContextSourceInput): Promise<readonly ContextContribution[]>;
}

export interface ContextPrepareInput extends ContextSourceInput {}

export type ContextDisposition = "selected" | "omitted" | "compacted";

export interface ContextManifestContribution {
  readonly contributionId: string;
  readonly sourceId: string;
  readonly disposition: ContextDisposition;
  readonly reason:
    | "required"
    | "within_budget"
    | "replaced_by_checkpoint"
    | "budget_exhausted"
    | "artifact_missing"
    | "artifact_corrupt"
    | "checkpoint_not_applicable";
  readonly priority: number;
  readonly required: boolean;
  readonly orderingGroup: ContextOrderingGroup;
  readonly estimatedTokens: number;
  readonly provenance: ContextProvenance;
  readonly sensitivity: ContextSensitivity;
}

export interface ContextBudget {
  readonly modelContextWindow: number;
  readonly requestedOutputReserve: number;
  readonly protocolToolSchemaReserve: number;
  readonly safetyMargin: number;
  readonly usableInputBudget: number;
}

export interface LegacyContextManifest {
  readonly version: 1;
  readonly id: string;
  readonly runId: RunId;
  readonly modelAttemptCount: number;
  readonly selectedRecordIds: readonly string[];
  readonly omitted: readonly { readonly source: string; readonly reason: string }[];
}

export interface ContextManifest {
  readonly version: 2;
  readonly id: string;
  readonly runId: RunId;
  readonly modelAttemptCount: number;
  readonly budget: ContextBudget;
  readonly contributions: readonly ContextManifestContribution[];
  readonly selectedRecordIds: readonly string[];
  readonly selectedCheckpointIds: readonly string[];
  readonly selectedArtifactIds: readonly string[];
  readonly omitted: readonly { readonly source: string; readonly reason: string }[];
  readonly requestDigest: string;
}

export type StoredContextManifest = LegacyContextManifest | ContextManifest;

export interface TokenMeasurement {
  readonly method: "estimated_chars";
  readonly inputTokens: number;
  readonly outputReserve: number;
  readonly protocolToolSchemaReserve: number;
  readonly safetyMargin: number;
  readonly usableInputBudget: number;
  readonly requiredTokens: number;
  readonly optionalTokens: number;
}

export interface ContextDerivationRecord {
  readonly version: 1;
  readonly derivationId: string;
  readonly runId: RunId;
  readonly modelAttemptCount: number;
  readonly kind: "summary_compaction";
  readonly status: "succeeded" | "failed" | "aborted";
  readonly model: { readonly providerId: string; readonly modelId: string };
  readonly inputDigest: string;
  readonly outputDigest?: string;
  readonly checkpointId?: string;
  readonly failureCode?: string;
}

export interface PreparedContext {
  readonly request: ModelRequest;
  readonly manifest: ContextManifest;
  readonly measurement: TokenMeasurement;
  readonly checkpoint?: CompactionCheckpointMetadata;
  readonly derivations: readonly ContextDerivationRecord[];
}

export interface ContextManager {
  prepare(input: ContextPrepareInput): Promise<PreparedContext>;
}

export interface CompactionCheckInput {
  readonly totalTokens: number;
  readonly usableInputBudget: number;
  readonly transcriptTokens: number;
  readonly hasCompactableTurns: boolean;
}

export interface CompactionInput {
  readonly request: ContextPrepareInput;
  readonly sourceTurns: readonly ContextContribution[];
  readonly retainedTurns: readonly ContextContribution[];
  readonly priorCheckpoint?: {
    readonly metadata: CompactionCheckpointMetadata;
    readonly summary: string;
  };
  readonly budget: ContextBudget;
}

export interface CompactionResult {
  readonly checkpoint: CompactionCheckpointMetadata;
  readonly summaryContribution: ContextContribution;
  readonly derivation: ContextDerivationRecord;
}

export interface CompactionStrategy {
  readonly version: string;
  shouldCompact(input: CompactionCheckInput): Promise<boolean>;
  compact(input: CompactionInput): Promise<CompactionResult>;
}

export interface ContextManagerOptions {
  readonly sources: readonly ContextSource[];
  readonly compaction: CompactionStrategy;
  readonly modelContextWindow: number;
  readonly requestedOutputReserve: number;
  readonly safetyMargin: number;
  readonly retainedTailTokens: number;
}

export interface TranscriptContextManagerOptions {
  readonly instructions: readonly InstructionPart[];
  readonly maxOutputTokens: number;
  readonly modelContextWindow?: number;
}
