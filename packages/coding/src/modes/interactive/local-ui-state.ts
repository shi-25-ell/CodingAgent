import type { CodingApprovalSummary } from "../../app/coding-events.js";
import { immutableReadonlySet } from "../../projection/immutable-readonly-set.js";
import type {
  InteractiveLocalState,
  InteractiveLocalStateOptions,
  UiLocalIntent,
  UiSurface,
} from "./contracts.js";
import { createDiffViewerLocalState } from "./diff-viewer.js";

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`);
  return value;
}

function freezeState(state: InteractiveLocalState): InteractiveLocalState {
  Object.freeze(state.composer);
  if (state.approvalPrompt) Object.freeze(state.approvalPrompt);
  if (state.diffViewer) {
    if (state.diffViewer.selectedHunk) Object.freeze(state.diffViewer.selectedHunk);
    Object.freeze(state.diffViewer);
  }
  Object.freeze(state.transcriptViewport);
  Object.freeze(state.terminal);
  Object.freeze(state.sidebar);
  Object.freeze(state.toolDisplay);
  Object.freeze(state.diagnostics);
  Object.freeze(state.surfaceStack);
  return Object.freeze(state);
}

function sameSurface(left: UiSurface, right: UiSurface): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "approval":
    case "diagnostic":
      return right.kind === left.kind && right.id === left.id;
    case "diff":
      return right.kind === "diff" && right.source === left.source && right.file === left.file;
    case "run_report":
      return right.kind === "run_report" && right.runId === left.runId;
    default:
      return true;
  }
}

export function createInteractiveLocalState(
  options: InteractiveLocalStateOptions,
): InteractiveLocalState {
  return freezeState({
    version: 1,
    focusedRegion: options.focusedRegion ?? "composer",
    expandedIds: immutableReadonlySet<string>(),
    composer: { value: "", revision: 0, deliveryMode: "steering" },
    transcriptViewport: { scrollTop: 0, followTail: true, unseenBlockCount: 0 },
    surfaceStack: [],
    terminal: {
      width: positiveInteger(options.width, "terminal width"),
      height: positiveInteger(options.height, "terminal height"),
    },
    diagnostics: [],
    dismissedDiagnosticIds: immutableReadonlySet<string>(),
    sidebar: {
      preference: options.sidebarPreference ?? "auto",
      open: options.sidebarOpen ?? false,
    },
    themeId: options.themeId ?? "dex",
    toolDisplay: {
      showDetails: options.showToolDetails ?? true,
      showGenericOutput: options.showGenericToolOutput ?? false,
    },
  });
}

export function reduceInteractiveLocalState(
  previous: InteractiveLocalState,
  intent: UiLocalIntent,
): InteractiveLocalState {
  switch (intent.type) {
    case "focus_region":
      if (previous.approvalPrompt && intent.region !== "approval") return previous;
      if (previous.diffViewer && intent.region !== "diff") return previous;
      return previous.focusedRegion === intent.region
        ? previous
        : freezeState({ ...previous, focusedRegion: intent.region });
    case "set_expanded": {
      if (previous.expandedIds.has(intent.id) === intent.expanded) return previous;
      const values = [...previous.expandedIds];
      const expandedIds = intent.expanded
        ? immutableReadonlySet([...values, intent.id])
        : immutableReadonlySet(values.filter((id) => id !== intent.id));
      return freezeState({ ...previous, expandedIds });
    }
    case "composer_changed":
      if (previous.approvalPrompt || previous.diffViewer) return previous;
      return previous.composer.value === intent.value
        ? previous
        : freezeState({
            ...previous,
            composer: {
              ...previous.composer,
              value: intent.value,
              revision: previous.composer.revision + 1,
            },
          });
    case "set_composer_delivery":
      if (previous.approvalPrompt || previous.diffViewer) return previous;
      return previous.composer.deliveryMode === intent.delivery
        ? previous
        : freezeState({
            ...previous,
            composer: { ...previous.composer, deliveryMode: intent.delivery },
          });
    case "set_approval_selection":
      if (
        previous.approvalPrompt?.approvalId !== intent.approvalId ||
        previous.approvalPrompt.selectedDecision === intent.decision
      ) {
        return previous;
      }
      return freezeState({
        ...previous,
        approvalPrompt: { ...previous.approvalPrompt, selectedDecision: intent.decision },
      });
    case "set_approval_fullscreen":
      if (
        previous.approvalPrompt?.approvalId !== intent.approvalId ||
        previous.approvalPrompt.fullscreen === intent.fullscreen
      ) {
        return previous;
      }
      return freezeState({
        ...previous,
        approvalPrompt: { ...previous.approvalPrompt, fullscreen: intent.fullscreen },
      });
    case "open_diff_viewer": {
      if (previous.approvalPrompt) return previous;
      const returnFocus = previous.diffViewer?.returnFocus ?? previous.focusedRegion;
      const diffViewer = createDiffViewerLocalState({
        source: intent.source,
        returnFocus,
        ...(intent.file ? { file: intent.file } : {}),
      });
      return freezeState({
        ...previous,
        focusedRegion: "diff",
        diffViewer,
        surfaceStack: [
          ...previous.surfaceStack.filter((surface) => surface.kind !== "diff"),
          { kind: "diff", source: intent.source, ...(intent.file ? { file: intent.file } : {}) },
        ],
      });
    }
    case "close_diff_viewer": {
      if (previous.approvalPrompt || !previous.diffViewer) return previous;
      const { diffViewer, ...withoutDiffViewer } = previous;
      return freezeState({
        ...withoutDiffViewer,
        focusedRegion: diffViewer.returnFocus,
        surfaceStack: previous.surfaceStack.filter((surface) => surface.kind !== "diff"),
      });
    }
    case "set_diff_focus": {
      const current = previous.diffViewer;
      if (!current || current.focus === intent.focus) return previous;
      return freezeState({
        ...previous,
        focusedRegion: "diff",
        diffViewer: { ...current, focus: intent.focus },
      });
    }
    case "set_diff_file_tree_visible": {
      const current = previous.diffViewer;
      if (!current || current.fileTreeVisible === intent.visible) return previous;
      return freezeState({
        ...previous,
        diffViewer: {
          ...current,
          fileTreeVisible: intent.visible,
          focus: !intent.visible && current.focus === "files" ? "patches" : current.focus,
        },
      });
    }
    case "set_diff_patch_mode": {
      const current = previous.diffViewer;
      if (!current || current.patchMode === intent.mode) return previous;
      const { selectedHunk: _selectedHunk, ...withoutSelectedHunk } = current;
      return freezeState({
        ...previous,
        diffViewer: { ...withoutSelectedHunk, patchMode: intent.mode },
      });
    }
    case "set_diff_view": {
      const current = previous.diffViewer;
      if (!current || current.viewOverride === intent.view) return previous;
      const { viewOverride: _viewOverride, ...withoutViewOverride } = current;
      return freezeState({
        ...previous,
        diffViewer:
          intent.view === undefined
            ? withoutViewOverride
            : { ...withoutViewOverride, viewOverride: intent.view },
      });
    }
    case "select_diff_file": {
      const current = previous.diffViewer;
      const filePath = intent.filePath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
      if (!current || filePath.length === 0 || current.selectedFilePath === filePath)
        return previous;
      const { selectedHunk: _selectedHunk, ...withoutSelectedHunk } = current;
      return freezeState({
        ...previous,
        diffViewer: { ...withoutSelectedHunk, selectedFilePath: filePath },
      });
    }
    case "set_diff_hunk": {
      const current = previous.diffViewer;
      if (!current) return previous;
      const selected = current.selectedHunk;
      if (
        selected?.filePath === intent.selection?.filePath &&
        selected?.hunkIndex === intent.selection?.hunkIndex
      ) {
        return previous;
      }
      if (
        intent.selection &&
        (!Number.isInteger(intent.selection.hunkIndex) || intent.selection.hunkIndex < 0)
      ) {
        throw new RangeError("diff hunkIndex 必须是非负整数");
      }
      const { selectedHunk: _selectedHunk, ...withoutSelectedHunk } = current;
      return freezeState({
        ...previous,
        diffViewer:
          intent.selection === undefined
            ? withoutSelectedHunk
            : { ...withoutSelectedHunk, selectedHunk: intent.selection },
      });
    }
    case "set_diff_directory_expanded": {
      const current = previous.diffViewer;
      if (!current || current.expandedDirectoryPaths.has(intent.path) === intent.expanded) {
        return previous;
      }
      const values = [...current.expandedDirectoryPaths];
      return freezeState({
        ...previous,
        diffViewer: {
          ...current,
          expandedDirectoryPaths: intent.expanded
            ? immutableReadonlySet([...values, intent.path])
            : immutableReadonlySet(values.filter((path) => path !== intent.path)),
        },
      });
    }
    case "set_diff_all_directories_expanded": {
      const current = previous.diffViewer;
      if (!current) return previous;
      return freezeState({
        ...previous,
        diffViewer: {
          ...current,
          expandedDirectoryPaths: immutableReadonlySet(intent.expanded ? intent.paths : []),
        },
      });
    }
    case "set_diff_file_reviewed": {
      const current = previous.diffViewer;
      if (!current || current.reviewedFilePaths.has(intent.filePath) === intent.reviewed) {
        return previous;
      }
      const values = [...current.reviewedFilePaths];
      return freezeState({
        ...previous,
        diffViewer: {
          ...current,
          reviewedFilePaths: intent.reviewed
            ? immutableReadonlySet([...values, intent.filePath])
            : immutableReadonlySet(values.filter((path) => path !== intent.filePath)),
        },
      });
    }
    case "set_diff_scroll": {
      const current = previous.diffViewer;
      if (!current) return previous;
      if (!Number.isFinite(intent.scrollTop) || intent.scrollTop < 0) {
        throw new RangeError("Diff scrollTop 必须是非负有限数");
      }
      return current.scrollTop === intent.scrollTop
        ? previous
        : freezeState({ ...previous, diffViewer: { ...current, scrollTop: intent.scrollTop } });
    }
    case "transcript_viewport_changed": {
      if (!Number.isFinite(intent.scrollTop) || intent.scrollTop < 0) {
        throw new RangeError("Transcript scrollTop 必须是非负有限数");
      }
      if (
        intent.anchorOffsetRows !== undefined &&
        (!Number.isInteger(intent.anchorOffsetRows) || intent.anchorOffsetRows < 0)
      ) {
        throw new RangeError("Transcript anchorOffsetRows 必须是非负整数");
      }
      const viewport = {
        scrollTop: intent.scrollTop,
        followTail: intent.followTail,
        unseenBlockCount: intent.followTail ? 0 : previous.transcriptViewport.unseenBlockCount,
        ...(intent.anchorBlockId ? { anchorBlockId: intent.anchorBlockId } : {}),
        ...(intent.anchorOffsetRows !== undefined
          ? { anchorOffsetRows: intent.anchorOffsetRows }
          : {}),
      };
      return freezeState({ ...previous, transcriptViewport: viewport });
    }
    case "open_surface": {
      if (previous.approvalPrompt && intent.surface.kind !== "approval") return previous;
      if (intent.surface.kind === "diff") {
        return reduceInteractiveLocalState(previous, {
          version: 1,
          type: "open_diff_viewer",
          source: intent.surface.source ?? "working_tree",
          ...(intent.surface.file ? { file: intent.surface.file } : {}),
        });
      }
      const existingIndex = previous.surfaceStack.findIndex((surface) =>
        sameSurface(surface, intent.surface),
      );
      const surfaceStack =
        existingIndex < 0
          ? [...previous.surfaceStack, intent.surface]
          : [
              ...previous.surfaceStack.slice(0, existingIndex),
              ...previous.surfaceStack.slice(existingIndex + 1),
              intent.surface,
            ];
      return freezeState({ ...previous, surfaceStack });
    }
    case "close_surface": {
      if (previous.approvalPrompt) return previous;
      if (previous.surfaceStack.length === 0) return previous;
      const index = intent.kind
        ? previous.surfaceStack.findLastIndex((surface) => surface.kind === intent.kind)
        : previous.surfaceStack.length - 1;
      if (index < 0) return previous;
      const closing = previous.surfaceStack[index];
      if (closing?.kind === "diff" && previous.diffViewer) {
        return reduceInteractiveLocalState(previous, { version: 1, type: "close_diff_viewer" });
      }
      return freezeState({
        ...previous,
        surfaceStack: [
          ...previous.surfaceStack.slice(0, index),
          ...previous.surfaceStack.slice(index + 1),
        ],
      });
    }
    case "terminal_resized": {
      const width = positiveInteger(intent.width, "terminal width");
      const height = positiveInteger(intent.height, "terminal height");
      return width === previous.terminal.width && height === previous.terminal.height
        ? previous
        : freezeState({ ...previous, terminal: { width, height } });
    }
    case "report_diagnostic":
      return appendInteractiveDiagnostic(previous, intent.diagnostic);
    case "dismiss_diagnostic": {
      if (previous.dismissedDiagnosticIds.has(intent.id)) return previous;
      return freezeState({
        ...previous,
        dismissedDiagnosticIds: immutableReadonlySet([
          ...previous.dismissedDiagnosticIds,
          intent.id,
        ]),
      });
    }
    case "select_model":
      return previous.selectedModel?.providerId === intent.model.providerId &&
        previous.selectedModel.modelId === intent.model.modelId
        ? previous
        : freezeState({ ...previous, selectedModel: intent.model });
    case "set_sidebar_preference":
      return previous.sidebar.preference === intent.preference
        ? previous
        : freezeState({
            ...previous,
            sidebar: { ...previous.sidebar, preference: intent.preference },
          });
    case "set_sidebar_open":
      return previous.sidebar.open === intent.open
        ? previous
        : freezeState({
            ...previous,
            sidebar: { ...previous.sidebar, open: intent.open },
          });
    case "select_theme":
      return previous.themeId === intent.themeId
        ? previous
        : freezeState({ ...previous, themeId: intent.themeId });
    case "set_tool_details_visible":
      return previous.toolDisplay.showDetails === intent.visible
        ? previous
        : freezeState({
            ...previous,
            toolDisplay: { ...previous.toolDisplay, showDetails: intent.visible },
          });
    case "set_generic_tool_output_visible":
      return previous.toolDisplay.showGenericOutput === intent.visible
        ? previous
        : freezeState({
            ...previous,
            toolDisplay: { ...previous.toolDisplay, showGenericOutput: intent.visible },
          });
  }
}

export function reconcilePendingApproval(
  previous: InteractiveLocalState,
  approvals: readonly CodingApprovalSummary[],
): InteractiveLocalState {
  const pending = approvals.find((approval) => approval.status === "pending");
  if (!pending) {
    if (!previous.approvalPrompt) return previous;
    const { approvalPrompt, ...withoutApprovalPrompt } = previous;
    return freezeState({
      ...withoutApprovalPrompt,
      focusedRegion: approvalPrompt.returnFocus,
      surfaceStack: previous.surfaceStack.filter((surface) => surface.kind !== "approval"),
    });
  }
  if (previous.approvalPrompt?.approvalId === pending.approvalId) return previous;
  const returnFocus = previous.approvalPrompt?.returnFocus ?? previous.focusedRegion;
  return freezeState({
    ...previous,
    focusedRegion: "approval",
    approvalPrompt: {
      approvalId: pending.approvalId,
      selectedDecision: "allow_once",
      fullscreen: false,
      returnFocus,
    },
    surfaceStack: [
      ...previous.surfaceStack.filter((surface) => surface.kind !== "approval"),
      { kind: "approval", id: pending.approvalId },
    ],
  });
}

export function observeTranscriptGrowth(
  previous: InteractiveLocalState,
  addedBlockCount: number,
): InteractiveLocalState {
  if (!Number.isInteger(addedBlockCount) || addedBlockCount < 0) {
    throw new RangeError("addedBlockCount 必须是非负整数");
  }
  if (addedBlockCount === 0 || previous.transcriptViewport.followTail) return previous;
  return freezeState({
    ...previous,
    transcriptViewport: {
      ...previous.transcriptViewport,
      unseenBlockCount: previous.transcriptViewport.unseenBlockCount + addedBlockCount,
    },
  });
}

export function appendInteractiveDiagnostic(
  previous: InteractiveLocalState,
  diagnostic: InteractiveLocalState["diagnostics"][number],
): InteractiveLocalState {
  const index = previous.diagnostics.findIndex((current) => current.id === diagnostic.id);
  const diagnostics =
    index < 0
      ? [...previous.diagnostics, diagnostic]
      : previous.diagnostics.map((current, currentIndex) =>
          currentIndex === index ? diagnostic : current,
        );
  return freezeState({ ...previous, diagnostics });
}
