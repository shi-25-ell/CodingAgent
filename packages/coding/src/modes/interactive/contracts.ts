import type { BranchId } from "@coding-agent/agent";
import type { ModelRef } from "@coding-agent/model";
import type {
  ApprovalPromptLocalState,
  ComposerLocalState,
  DiffViewerFocus,
  DiffViewerHunkSelection,
  DiffViewerLocalState,
  DiffViewerPatchMode,
  DiffViewerSource,
  DiffViewerView,
  SidebarLocalState,
  SidebarPreference,
  TerminalDimensions,
  TranscriptViewportState,
  TuiDiagnostic,
  UiFocusRegion,
  UiSurface,
  UiThemeId,
} from "../../projection/contracts.js";

export type {
  ApprovalPromptLocalState,
  ComposerLocalState,
  DiffViewerFocus,
  DiffViewerHunkSelection,
  DiffViewerLocalState,
  DiffViewerPatchMode,
  DiffViewerSource,
  DiffViewerView,
  SidebarLocalState,
  SidebarPreference,
  TerminalDimensions,
  TranscriptViewportState,
  TuiDiagnostic,
  UiFocusRegion,
  UiSurface,
  UiThemeId,
} from "../../projection/contracts.js";

interface UiIntentBase {
  readonly version: 1;
}

export type UiLocalIntent = UiIntentBase &
  (
    | { readonly type: "focus_region"; readonly region: UiFocusRegion }
    | { readonly type: "set_expanded"; readonly id: string; readonly expanded: boolean }
    | { readonly type: "composer_changed"; readonly value: string }
    | {
        readonly type: "set_composer_delivery";
        readonly delivery: "steering" | "follow_up";
      }
    | {
        readonly type: "set_approval_selection";
        readonly approvalId: string;
        readonly decision: "allow_once" | "deny";
      }
    | {
        readonly type: "set_approval_fullscreen";
        readonly approvalId: string;
        readonly fullscreen: boolean;
      }
    | {
        readonly type: "open_diff_viewer";
        readonly source: DiffViewerSource;
        readonly file?: string;
      }
    | { readonly type: "close_diff_viewer" }
    | { readonly type: "set_diff_focus"; readonly focus: DiffViewerFocus }
    | { readonly type: "set_diff_file_tree_visible"; readonly visible: boolean }
    | { readonly type: "set_diff_patch_mode"; readonly mode: DiffViewerPatchMode }
    | { readonly type: "set_diff_view"; readonly view?: DiffViewerView }
    | { readonly type: "select_diff_file"; readonly filePath: string }
    | {
        readonly type: "set_diff_hunk";
        readonly selection?: DiffViewerHunkSelection;
      }
    | {
        readonly type: "set_diff_directory_expanded";
        readonly path: string;
        readonly expanded: boolean;
      }
    | {
        readonly type: "set_diff_file_reviewed";
        readonly filePath: string;
        readonly reviewed: boolean;
      }
    | { readonly type: "set_diff_scroll"; readonly scrollTop: number }
    | {
        readonly type: "transcript_viewport_changed";
        readonly scrollTop: number;
        readonly followTail: boolean;
        readonly anchorBlockId?: string;
        readonly anchorOffsetRows?: number;
      }
    | { readonly type: "open_surface"; readonly surface: UiSurface }
    | { readonly type: "close_surface"; readonly kind?: UiSurface["kind"] }
    | { readonly type: "terminal_resized"; readonly width: number; readonly height: number }
    | { readonly type: "report_diagnostic"; readonly diagnostic: TuiDiagnostic }
    | { readonly type: "dismiss_diagnostic"; readonly id: string }
    | { readonly type: "select_model"; readonly model: ModelRef }
    | { readonly type: "set_sidebar_preference"; readonly preference: SidebarPreference }
    | { readonly type: "set_sidebar_open"; readonly open: boolean }
    | { readonly type: "select_theme"; readonly themeId: UiThemeId }
    | { readonly type: "set_tool_details_visible"; readonly visible: boolean }
    | { readonly type: "set_generic_tool_output_visible"; readonly visible: boolean }
  );

export type UiApplicationIntent = UiIntentBase &
  (
    | {
        readonly type: "submit_task";
        readonly text: string;
        readonly model?: ModelRef;
        readonly acceptWorkspaceFingerprint?: string;
      }
    | {
        readonly type: "submit_composer";
        readonly expectedRevision: number;
        readonly acceptWorkspaceFingerprint?: string;
      }
    | {
        readonly type: "send_run_message";
        readonly delivery: "steering" | "follow_up";
        readonly text: string;
      }
    | {
        readonly type: "respond_approval";
        readonly approvalId: string;
        readonly decision: "allow_once" | "deny";
        readonly planFingerprint: string;
      }
    | {
        readonly type: "update_queue";
        readonly targetCommandId: string;
        readonly expectedRevision: number;
        readonly status: "queued" | "draft" | "cancelled";
        readonly text?: string;
      }
    | { readonly type: "abort_run"; readonly reason?: string }
    | {
        readonly type: "select_branch";
        readonly branchId: BranchId;
        readonly expectedRevision: number;
      }
    | {
        readonly type: "fork_branch";
        readonly fromBranchId: BranchId;
        readonly expectedRevision: number;
      }
    | { readonly type: "quit" }
  );

export type UiIntent = UiLocalIntent | UiApplicationIntent;

export interface InteractiveLocalState {
  readonly version: 1;
  readonly focusedRegion: UiFocusRegion;
  readonly expandedIds: ReadonlySet<string>;
  readonly composer: ComposerLocalState;
  readonly approvalPrompt?: ApprovalPromptLocalState;
  readonly diffViewer?: DiffViewerLocalState;
  readonly transcriptViewport: TranscriptViewportState;
  readonly surfaceStack: readonly UiSurface[];
  readonly terminal: TerminalDimensions;
  readonly diagnostics: readonly TuiDiagnostic[];
  readonly dismissedDiagnosticIds: ReadonlySet<string>;
  readonly selectedModel?: ModelRef;
  readonly sidebar: SidebarLocalState;
  readonly themeId: UiThemeId;
  readonly toolDisplay: {
    readonly showDetails: boolean;
    readonly showGenericOutput: boolean;
  };
}

export interface InteractiveLocalStateOptions {
  readonly width: number;
  readonly height: number;
  readonly focusedRegion?: UiFocusRegion;
  readonly sidebarPreference?: SidebarPreference;
  readonly sidebarOpen?: boolean;
  readonly themeId?: UiThemeId;
  readonly showToolDetails?: boolean;
  readonly showGenericToolOutput?: boolean;
}
