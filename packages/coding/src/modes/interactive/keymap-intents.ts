import type { TuiDiagnostic, TuiViewModel, UiSurface } from "../../projection/contracts.js";
import type { UiIntent } from "./contracts.js";
import {
  allDiffDirectoryPaths,
  collectDiffViewerHunks,
  moveDiffFileSelection,
  moveDiffHunkSelection,
} from "./diff-viewer.js";
import type { DexKeymapCommandId } from "./keymap-policy.js";
import { resolveInteractiveLayout } from "./layout-policy.js";

export type DexCommandIntentResolution =
  | { readonly status: "dispatch"; readonly intent: UiIntent }
  | { readonly status: "unhandled" }
  | { readonly status: "unavailable"; readonly diagnostic: TuiDiagnostic };

function local<T extends Omit<UiIntent, "version">>(intent: T): UiIntent {
  return Object.freeze({ version: 1, ...intent }) as UiIntent;
}

function openSurface(surface: UiSurface): DexCommandIntentResolution {
  return {
    status: "dispatch",
    intent: local({ type: "open_surface", surface }),
  };
}

function unavailable(
  viewModel: TuiViewModel,
  commandId: DexKeymapCommandId,
  message: string,
): DexCommandIntentResolution {
  return {
    status: "unavailable",
    diagnostic: Object.freeze({
      id: `keymap:${commandId}:${viewModel.session.revision}`,
      source: "renderer",
      severity: "warning",
      code: "KEYMAP_COMMAND_UNAVAILABLE",
      message,
      recoverable: true,
    }),
  };
}

function closeSurface(kind?: UiSurface["kind"]): DexCommandIntentResolution {
  return {
    status: "dispatch",
    intent: local({ type: "close_surface", ...(kind ? { kind } : {}) }),
  };
}

function transcriptScroll(
  viewModel: TuiViewModel,
  commandId: DexKeymapCommandId,
): DexCommandIntentResolution {
  const viewport = viewModel.ui.transcriptViewport;
  const layout = resolveInteractiveLayout(
    viewModel.ui.terminal.width,
    viewModel.ui.terminal.height,
    viewModel.ui.sidebar,
  );
  const pageRows = Math.max(
    1,
    layout.height -
      layout.headerRows -
      layout.statusRows -
      layout.composer.minRows -
      layout.composer.footerRows,
  );
  if (commandId === "transcript.first") {
    return {
      status: "dispatch",
      intent: local({
        type: "transcript_viewport_changed",
        scrollTop: 0,
        followTail: false,
      }),
    };
  }
  if (commandId === "transcript.last") {
    return {
      status: "dispatch",
      intent: local({
        type: "transcript_viewport_changed",
        scrollTop: Number.MAX_SAFE_INTEGER,
        followTail: true,
      }),
    };
  }
  const direction = commandId === "transcript.page_up" ? -1 : 1;
  return {
    status: "dispatch",
    intent: local({
      type: "transcript_viewport_changed",
      scrollTop: Math.max(0, viewport.scrollTop + direction * pageRows),
      followTail: false,
    }),
  };
}

function toggleSidebar(viewModel: TuiViewModel): DexCommandIntentResolution {
  const layout = resolveInteractiveLayout(
    viewModel.ui.terminal.width,
    viewModel.ui.terminal.height,
    viewModel.ui.sidebar,
  );
  if (!layout.sidebar.visible) {
    return {
      status: "dispatch",
      intent: local({ type: "set_sidebar_open", open: true }),
    };
  }
  if (viewModel.ui.sidebar.open) {
    return {
      status: "dispatch",
      intent: local({ type: "set_sidebar_open", open: false }),
    };
  }
  return {
    status: "dispatch",
    intent: local({ type: "set_sidebar_preference", preference: "hide" }),
  };
}

/** Maps executable keymap commands to the only accepted renderer output: UiIntent. */
export function resolveDexKeymapCommandIntent(
  viewModel: TuiViewModel,
  commandId: DexKeymapCommandId,
): DexCommandIntentResolution {
  switch (commandId) {
    case "app.quit":
      return { status: "dispatch", intent: local({ type: "quit" }) };
    case "command.palette.open":
      return openSurface({ kind: "command_palette" });
    case "command.palette.close":
      return closeSurface("command_palette");
    case "which_key.toggle":
      return viewModel.ui.surfaceStack.some((surface) => surface.kind === "which_key")
        ? closeSurface("which_key")
        : openSurface({ kind: "which_key" });
    case "which_key.close":
      return closeSurface("which_key");
    case "session.new":
      return { status: "dispatch", intent: local({ type: "new_session" }) };
    case "session.list":
      return openSurface({ kind: "session_selector" });
    case "session.branch":
      return openSurface({ kind: "branch_selector" });
    case "model.list":
      return openSurface({ kind: "model_selector" });
    case "sidebar.toggle":
      return toggleSidebar(viewModel);
    case "diff.open":
      return {
        status: "dispatch",
        intent: local({ type: "open_diff_viewer", source: "working_tree" }),
      };
    case "queue.manage":
      return openSurface({ kind: "queue" });
    case "context.open":
      return openSurface({ kind: "context" });
    case "run.report": {
      const runId = viewModel.activeRun?.runId ?? viewModel.terminalReport?.runId;
      return runId
        ? openSurface({ kind: "run_report", runId })
        : unavailable(viewModel, commandId, "当前 Session 尚无 RunReport。");
    }
    case "theme.list":
      return openSurface({ kind: "theme_selector" });
    case "help.open":
      return openSurface({ kind: "help" });
    case "run.abort":
    case "run.abort.compatibility":
      return viewModel.activeRun
        ? {
            status: "dispatch",
            intent: local({
              type: "abort_run",
              reason:
                commandId === "run.abort.compatibility"
                  ? "compatibility_double_escape"
                  : "user_keymap",
            }),
          }
        : unavailable(viewModel, commandId, "当前没有 active Run 可终止。");
    case "transcript.page_up":
    case "transcript.page_down":
    case "transcript.first":
    case "transcript.last":
      return transcriptScroll(viewModel, commandId);
    case "composer.escape":
      return { status: "unhandled" };
    case "diff.close":
      return viewModel.ui.diffViewer
        ? { status: "dispatch", intent: local({ type: "close_diff_viewer" }) }
        : { status: "unhandled" };
    case "diff.switch_focus":
      return viewModel.ui.diffViewer
        ? {
            status: "dispatch",
            intent: local({
              type: "set_diff_focus",
              focus: viewModel.ui.diffViewer.focus === "files" ? "patches" : "files",
            }),
          }
        : { status: "unhandled" };
    case "diff.toggle_file_tree":
      return viewModel.ui.diffViewer
        ? {
            status: "dispatch",
            intent: local({
              type: "set_diff_file_tree_visible",
              visible: !viewModel.ui.diffViewer.fileTreeVisible,
            }),
          }
        : { status: "unhandled" };
    case "diff.single_patch":
      return viewModel.ui.diffViewer
        ? {
            status: "dispatch",
            intent: local({
              type: "set_diff_patch_mode",
              mode: viewModel.ui.diffViewer.patchMode === "all" ? "single" : "all",
            }),
          }
        : { status: "unhandled" };
    case "diff.switch_source":
      return openSurface({ kind: "diff_source_selector" });
    case "diff.toggle_view":
      return viewModel.ui.diffViewer
        ? {
            status: "dispatch",
            intent: local({
              type: "set_diff_view",
              view: viewModel.ui.diffViewer.viewOverride === "unified" ? "split" : "unified",
            }),
          }
        : { status: "unhandled" };
    case "diff.help":
      return openSurface({ kind: "help" });
    case "diff.toggle_item":
      return viewModel.ui.diffViewer?.selectedFilePath
        ? {
            status: "dispatch",
            intent: local({
              type: "set_diff_file_reviewed",
              filePath: viewModel.ui.diffViewer.selectedFilePath,
              reviewed: !viewModel.ui.diffViewer.reviewedFilePaths.has(
                viewModel.ui.diffViewer.selectedFilePath,
              ),
            }),
          }
        : { status: "unhandled" };
    case "diff.expand":
    case "diff.collapse": {
      if (!viewModel.ui.diffViewer?.selectedFilePath) return { status: "unhandled" };
      const directoryPath = viewModel.ui.diffViewer.selectedFilePath
        .split("/")
        .slice(0, -1)
        .join("/");
      if (!directoryPath) return { status: "unhandled" };
      return {
        status: "dispatch",
        intent: local({
          type: "set_diff_directory_expanded",
          path: directoryPath,
          expanded: commandId === "diff.expand",
        }),
      };
    }
    case "diff.expand_all":
      return viewModel.diffDocument && viewModel.ui.diffViewer
        ? {
            status: "dispatch",
            intent: local({
              type: "set_diff_all_directories_expanded",
              paths: [...allDiffDirectoryPaths(viewModel.diffDocument.files)],
              expanded: true,
            }),
          }
        : { status: "unhandled" };
    case "diff.previous_hunk":
    case "diff.next_hunk": {
      const document = viewModel.diffDocument;
      const state = viewModel.ui.diffViewer;
      if (!document || !state) return { status: "unhandled" };
      const selection = moveDiffHunkSelection(
        collectDiffViewerHunks(document.files),
        state.selectedHunk,
        commandId === "diff.previous_hunk" ? -1 : 1,
      );
      return selection
        ? { status: "dispatch", intent: local({ type: "set_diff_hunk", selection }) }
        : { status: "unhandled" };
    }
    case "diff.previous_file":
    case "diff.next_file": {
      const document = viewModel.diffDocument;
      const state = viewModel.ui.diffViewer;
      if (!document || !state) return { status: "unhandled" };
      const filePath = moveDiffFileSelection(
        document.files,
        state.selectedFilePath,
        commandId === "diff.previous_file" ? -1 : 1,
      );
      return filePath
        ? { status: "dispatch", intent: local({ type: "select_diff_file", filePath }) }
        : { status: "unhandled" };
    }
    case "approval.select_allow":
    case "approval.select_deny": {
      const approval = viewModel.ui.approvalPrompt;
      return approval
        ? {
            status: "dispatch",
            intent: local({
              type: "set_approval_selection",
              approvalId: approval.approvalId,
              decision: commandId === "approval.select_allow" ? "allow_once" : "deny",
            }),
          }
        : { status: "unhandled" };
    }
    case "approval.confirm":
    case "approval.deny": {
      const localApproval = viewModel.ui.approvalPrompt;
      const approval = viewModel.approvals.find(
        (item) => item.approvalId === localApproval?.approvalId,
      );
      if (!localApproval || !approval) return { status: "unhandled" };
      return {
        status: "dispatch",
        intent: local({
          type: "respond_approval",
          approvalId: approval.approvalId,
          decision: commandId === "approval.deny" ? "deny" : localApproval.selectedDecision,
          planFingerprint: approval.plan.fingerprint,
        }),
      };
    }
    case "approval.toggle_fullscreen": {
      const approval = viewModel.ui.approvalPrompt;
      return approval
        ? {
            status: "dispatch",
            intent: local({
              type: "set_approval_fullscreen",
              approvalId: approval.approvalId,
              fullscreen: !approval.fullscreen,
            }),
          }
        : { status: "unhandled" };
    }
    case "overlay.close": {
      const layout = resolveInteractiveLayout(
        viewModel.ui.terminal.width,
        viewModel.ui.terminal.height,
        viewModel.ui.sidebar,
      );
      return layout.sidebar.placement === "overlay"
        ? {
            status: "dispatch",
            intent: local({ type: "set_sidebar_open", open: false }),
          }
        : closeSurface();
    }
    case "dialog.close":
      return closeSurface();
  }
}
