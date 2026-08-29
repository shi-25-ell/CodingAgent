import type { TuiViewModel, UiSurface } from "../../projection/contracts.js";
import type { DexKeymapBaseContext, DexKeymapMode } from "./keymap-policy.js";
import { resolveInteractiveLayout } from "./layout-policy.js";

export type InteractiveSurfaceLayer =
  | "session"
  | "diff"
  | "approval"
  | "overlay"
  | "dialog"
  | "command_palette"
  | "which_key"
  | "fatal_error";

export interface InteractiveSurfacePolicy {
  readonly layer: InteractiveSurfaceLayer;
  readonly priority: number;
  readonly route: DexKeymapBaseContext["route"];
  readonly focus: DexKeymapBaseContext["focus"];
  readonly modes: readonly DexKeymapMode[];
  readonly focusTargetId: string;
  readonly topSurface?: UiSurface;
  readonly blocksBackgroundInput: boolean;
}

export const interactiveSurfacePriority: Readonly<Record<InteractiveSurfaceLayer, number>> =
  Object.freeze({
    session: 100,
    diff: 600,
    overlay: 700,
    approval: 800,
    dialog: 950,
    command_palette: 1_000,
    which_key: 1_000,
    fatal_error: 1_100,
  });

const dialogKinds: ReadonlySet<UiSurface["kind"]> = new Set([
  "session_selector",
  "model_selector",
  "branch_selector",
  "theme_selector",
  "diff_source_selector",
  "help",
]);
const overlayKinds: ReadonlySet<UiSurface["kind"]> = new Set([
  "context",
  "queue",
  "run_report",
  "diagnostic",
]);

function surfaceLayer(surface: UiSurface): InteractiveSurfaceLayer {
  if (surface.kind === "command_palette") return "command_palette";
  if (surface.kind === "which_key") return "which_key";
  if (surface.kind === "approval") return "approval";
  if (surface.kind === "diff") return "diff";
  if (dialogKinds.has(surface.kind)) return "dialog";
  if (overlayKinds.has(surface.kind)) return "overlay";
  return "overlay";
}

function topSurface(surfaces: readonly UiSurface[]): UiSurface | undefined {
  let winner: UiSurface | undefined;
  let winnerPriority = Number.NEGATIVE_INFINITY;
  for (const surface of surfaces) {
    const priority = interactiveSurfacePriority[surfaceLayer(surface)];
    if (priority >= winnerPriority) {
      winner = surface;
      winnerPriority = priority;
    }
  }
  return winner;
}

function baseFocus(viewModel: TuiViewModel): DexKeymapBaseContext["focus"] {
  if (viewModel.ui.diffViewer) return "diff";
  if (viewModel.ui.focusedRegion === "composer") return "composer";
  if (viewModel.ui.focusedRegion === "transcript") return "transcript";
  return "status";
}

function sessionFocusTarget(viewModel: TuiViewModel): string {
  if (viewModel.ui.focusedRegion === "composer") return "composer";
  if (viewModel.ui.focusedRegion === "transcript") return "transcript";
  return "session-status";
}

function genericSurfaceId(surface: UiSurface): string {
  if (surface.kind === "diagnostic") return `surface:diagnostic:${surface.id}`;
  if (surface.kind === "run_report") return `surface:run_report:${surface.runId}`;
  return `surface:${surface.kind}`;
}

function keymapModes(...values: DexKeymapMode[]): readonly DexKeymapMode[] {
  return Object.freeze(values);
}

/** Central precedence used by rendering, focus ownership and keymap activation. */
export function resolveInteractiveSurfacePolicy(viewModel: TuiViewModel): InteractiveSurfacePolicy {
  const route: DexKeymapBaseContext["route"] = viewModel.ui.diffViewer ? "diff" : "session";
  const fatal = viewModel.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error" && !diagnostic.recoverable,
  );
  if (fatal) {
    return Object.freeze({
      layer: "fatal_error",
      priority: interactiveSurfacePriority.fatal_error,
      route,
      focus: baseFocus(viewModel),
      modes: keymapModes("dialog"),
      focusTargetId: "fatal-error",
      blocksBackgroundInput: true,
    });
  }

  const selectedSurface = topSurface(viewModel.ui.surfaceStack);
  if (selectedSurface) {
    const layer = surfaceLayer(selectedSurface);
    if (layer !== "approval" && layer !== "diff") {
      const mode = layer as DexKeymapMode;
      return Object.freeze({
        layer,
        priority: interactiveSurfacePriority[layer],
        route,
        focus: baseFocus(viewModel),
        modes: keymapModes(mode),
        focusTargetId: genericSurfaceId(selectedSurface),
        topSurface: selectedSurface,
        blocksBackgroundInput: true,
      });
    }
  }

  if (viewModel.ui.approvalPrompt) {
    return Object.freeze({
      layer: "approval",
      priority: interactiveSurfacePriority.approval,
      route,
      focus: baseFocus(viewModel),
      modes: keymapModes("approval"),
      focusTargetId: `approval:${viewModel.ui.approvalPrompt.approvalId}`,
      ...(selectedSurface ? { topSurface: selectedSurface } : {}),
      blocksBackgroundInput: true,
    });
  }

  const layout = resolveInteractiveLayout(
    viewModel.ui.terminal.width,
    viewModel.ui.terminal.height,
    viewModel.ui.sidebar,
  );
  if (layout.sidebar.placement === "overlay") {
    return Object.freeze({
      layer: "overlay",
      priority: interactiveSurfacePriority.overlay,
      route,
      focus: baseFocus(viewModel),
      modes: keymapModes("overlay"),
      focusTargetId: "sidebar",
      blocksBackgroundInput: true,
    });
  }

  if (viewModel.ui.diffViewer) {
    return Object.freeze({
      layer: "diff",
      priority: interactiveSurfacePriority.diff,
      route: "diff",
      focus: "diff",
      modes: keymapModes(),
      focusTargetId: "diff-viewer",
      ...(selectedSurface ? { topSurface: selectedSurface } : {}),
      blocksBackgroundInput: true,
    });
  }

  return Object.freeze({
    layer: "session",
    priority: interactiveSurfacePriority.session,
    route: "session",
    focus: baseFocus(viewModel),
    modes: keymapModes(),
    focusTargetId: sessionFocusTarget(viewModel),
    blocksBackgroundInput: false,
  });
}
