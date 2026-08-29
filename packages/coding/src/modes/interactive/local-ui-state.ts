import { immutableReadonlySet } from "../../projection/immutable-readonly-set.js";
import type {
  InteractiveLocalState,
  InteractiveLocalStateOptions,
  UiLocalIntent,
  UiSurface,
} from "./contracts.js";

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`);
  return value;
}

function freezeState(state: InteractiveLocalState): InteractiveLocalState {
  Object.freeze(state.composer);
  Object.freeze(state.transcriptViewport);
  Object.freeze(state.terminal);
  Object.freeze(state.sidebar);
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
      return right.kind === "diff" && right.file === left.file;
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
    composer: { value: "", revision: 0 },
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
  });
}

export function reduceInteractiveLocalState(
  previous: InteractiveLocalState,
  intent: UiLocalIntent,
): InteractiveLocalState {
  switch (intent.type) {
    case "focus_region":
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
      return previous.composer.value === intent.value
        ? previous
        : freezeState({
            ...previous,
            composer: { value: intent.value, revision: previous.composer.revision + 1 },
          });
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
      if (previous.surfaceStack.length === 0) return previous;
      const index = intent.kind
        ? previous.surfaceStack.findLastIndex((surface) => surface.kind === intent.kind)
        : previous.surfaceStack.length - 1;
      if (index < 0) return previous;
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
  }
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
