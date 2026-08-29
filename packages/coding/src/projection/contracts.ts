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
  SessionRef,
  TokenMeasurement,
  ToolOutcome,
  WorkspaceBinding,
} from "@coding-agent/agent";
import type { AssistantMessage, ModelFailure, ModelRef } from "@coding-agent/model";
import type {
  CodingApprovalSummary,
  CodingRecoveryDiagnostic,
  CodingToolPlanSummary,
} from "../app/coding-events.js";

export type CodingRunDisplayStatus =
  | "idle"
  | "preparing_context"
  | "streaming"
  | "committing"
  | "tool_activity"
  | "awaiting_approval"
  | "compacting"
  | "finalizing"
  | "recovering"
  | RunReport["status"];

export interface CodingTranscriptBlock {
  readonly id: string;
  readonly runId: RunId;
  readonly ledgerSeq: number;
  readonly kind: "user" | "assistant" | "tool" | "model_failure" | "terminal" | "recovery";
  readonly text?: string;
  readonly assistant?: AssistantMessage;
  readonly outcome?: ToolOutcome;
  readonly failure?: ModelFailure;
  readonly report?: RunReport;
  readonly recovery?: CodingRecoveryDiagnostic;
}

export interface CodingAssistantStream {
  readonly modelTurnCount: number;
  readonly modelAttemptCount: number;
  readonly text: string;
  readonly reasoning: string;
}

export interface CodingToolProjection {
  readonly callId: string;
  readonly plan: CodingToolPlanSummary;
  readonly status: "planned" | "running" | "settled";
  readonly progress?: string;
  readonly outcome?: ToolOutcome;
}

export interface CodingContextProjection {
  readonly manifest: ContextManifest;
  readonly measurement: TokenMeasurement;
  readonly checkpoint?: CompactionCheckpointMetadata;
  readonly derivations: readonly ContextDerivationRecord[];
}

export interface CodingRunProjection {
  readonly runId: RunId;
  readonly config?: RunConfigSnapshot;
  readonly phase: RunPhase;
  readonly status: CodingRunDisplayStatus;
  readonly terminal: boolean;
  readonly assistantStream?: CodingAssistantStream;
  readonly tools: Readonly<Record<string, CodingToolProjection>>;
  readonly toolOrder: readonly string[];
  readonly approvals: Readonly<Record<string, CodingApprovalSummary>>;
  readonly approvalOrder: readonly string[];
  readonly context?: CodingContextProjection;
  readonly compactions: readonly ContextDerivationRecord[];
  readonly modelFailure?: ModelFailure;
  readonly recovery?: CodingRecoveryDiagnostic;
  readonly report?: RunReport;
}

export interface CodingProjectionDiagnostic {
  readonly code: "SEMANTIC_SEQUENCE_GAP" | "LATE_PROGRESS_IGNORED" | "STALE_PROGRESS_IGNORED";
  readonly runId: RunId;
  readonly message: string;
}

export interface CodingSessionSnapshot {
  readonly version: 1;
  readonly ref: SessionRef;
  readonly workspace: WorkspaceBinding;
  readonly revision: number;
  readonly currentBranchId: BranchId;
  readonly activeRunId?: RunId;
  readonly branches: readonly SessionBranchSummary[];
  readonly runOrder: readonly RunId[];
  readonly runs: Readonly<Record<string, CodingRunProjection>>;
  readonly transcript: readonly CodingTranscriptBlock[];
  readonly queues: readonly QueueItem[];
  /** Per-Run semantic cursor already represented by an atomic snapshot/live join. */
  readonly eventCursors?: Readonly<Record<string, number>>;
}

export interface CodingProjection extends CodingSessionSnapshot {
  readonly semanticSequences: Readonly<Record<string, number>>;
  readonly progressRevisions: Readonly<Record<string, number>>;
  readonly diagnostics: readonly CodingProjectionDiagnostic[];
  readonly requiresSnapshot: boolean;
}

export type UiFocusRegion =
  | "transcript"
  | "composer"
  | "tools"
  | "approval"
  | "queue"
  | "context"
  | "diff"
  | "status";

export type DiffViewerSource = "working_tree" | "branch" | "last_turn";
export type DiffViewerFocus = "files" | "patches";
export type DiffViewerPatchMode = "all" | "single";
export type DiffViewerView = "split" | "unified";

export interface DiffViewerHunkSelection {
  readonly filePath: string;
  readonly hunkIndex: number;
}

export interface DiffViewerLocalState {
  readonly source: DiffViewerSource;
  readonly documentRevision?: string;
  readonly focus: DiffViewerFocus;
  readonly fileTreeVisible: boolean;
  readonly patchMode: DiffViewerPatchMode;
  readonly viewOverride?: DiffViewerView;
  readonly selectedFilePath?: string;
  readonly selectedHunk?: DiffViewerHunkSelection;
  readonly reviewedFilePaths: ReadonlySet<string>;
  readonly expandedDirectoryPaths: ReadonlySet<string>;
  readonly scrollTop: number;
  readonly returnFocus: UiFocusRegion;
}

export type UiSurface =
  | { readonly kind: "approval"; readonly id: string }
  | { readonly kind: "context" }
  | {
      readonly kind: "diff";
      readonly source?: DiffViewerSource;
      readonly file?: string;
    }
  | { readonly kind: "queue" }
  | { readonly kind: "run_report"; readonly runId: RunId }
  | { readonly kind: "session_selector" }
  | { readonly kind: "model_selector" }
  | { readonly kind: "branch_selector" }
  | { readonly kind: "theme_selector" }
  | { readonly kind: "diff_source_selector" }
  | { readonly kind: "command_palette" }
  | { readonly kind: "which_key" }
  | { readonly kind: "help" }
  | { readonly kind: "diagnostic"; readonly id: string };

export interface ComposerLocalState {
  readonly value: string;
  readonly revision: number;
  readonly deliveryMode: "steering" | "follow_up";
}

export interface ApprovalPromptLocalState {
  readonly approvalId: string;
  readonly selectedDecision: "allow_once" | "deny";
  readonly fullscreen: boolean;
  readonly returnFocus: UiFocusRegion;
}

export interface TranscriptViewportState {
  readonly scrollTop: number;
  readonly followTail: boolean;
  readonly anchorBlockId?: string;
  readonly anchorOffsetRows?: number;
  readonly unseenBlockCount: number;
}

export interface TerminalDimensions {
  readonly width: number;
  readonly height: number;
}

export type SidebarPreference = "auto" | "hide";
export type UiThemeId = "dex" | "system";

export interface SidebarLocalState {
  readonly preference: SidebarPreference;
  readonly open: boolean;
}

export interface TuiDiagnostic {
  readonly id: string;
  readonly source: "projection" | "controller" | "renderer";
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export interface LocalUiState {
  readonly focusedRegion?: UiFocusRegion;
  readonly expandedIds?: ReadonlySet<string>;
  readonly composer?: ComposerLocalState;
  readonly approvalPrompt?: ApprovalPromptLocalState;
  readonly diffViewer?: DiffViewerLocalState;
  readonly transcriptViewport?: TranscriptViewportState;
  readonly surfaceStack?: readonly UiSurface[];
  readonly terminal?: TerminalDimensions;
  readonly diagnostics?: readonly TuiDiagnostic[];
  readonly dismissedDiagnosticIds?: ReadonlySet<string>;
  readonly selectedModel?: ModelRef;
  readonly sidebar?: SidebarLocalState;
  readonly themeId?: UiThemeId;
  readonly toolDisplay?: {
    readonly showDetails: boolean;
    readonly showGenericOutput: boolean;
  };
}

export interface TuiLocalViewModel {
  readonly focusedRegion: UiFocusRegion;
  readonly expandedIds: ReadonlySet<string>;
  readonly composer: ComposerLocalState;
  readonly approvalPrompt?: ApprovalPromptLocalState;
  readonly diffViewer?: DiffViewerLocalState;
  readonly transcriptViewport: TranscriptViewportState;
  readonly surfaceStack: readonly UiSurface[];
  readonly terminal: TerminalDimensions;
  readonly selectedModel?: ModelRef;
  readonly sidebar: SidebarLocalState;
  readonly themeId: UiThemeId;
  readonly toolDisplay: {
    readonly showDetails: boolean;
    readonly showGenericOutput: boolean;
  };
}

export interface TuiViewModel {
  readonly version: 1;
  readonly session: {
    readonly ref: SessionRef;
    readonly workspace: WorkspaceBinding;
    readonly revision: number;
    readonly currentBranchId: BranchId;
    readonly branches: readonly SessionBranchSummary[];
  };
  readonly activeRun?: {
    readonly runId: RunId;
    readonly status: CodingRunDisplayStatus;
    readonly phase: RunPhase;
    readonly config?: RunConfigSnapshot;
    readonly assistantStream?: CodingAssistantStream;
  };
  readonly transcript: readonly CodingTranscriptBlock[];
  readonly tools: readonly CodingToolProjection[];
  readonly approvals: readonly CodingApprovalSummary[];
  readonly queues: readonly QueueItem[];
  readonly context?: CodingContextProjection;
  readonly terminalReport?: RunReport;
  readonly diagnostics: readonly TuiDiagnostic[];
  readonly ui: TuiLocalViewModel;
}
