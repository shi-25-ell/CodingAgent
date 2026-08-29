import {
  CliRenderEvents,
  type CliRenderer,
  type Renderable,
  type SyntaxStyle,
} from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { TuiDiagnostic, TuiViewModel, UiFocusRegion } from "../../projection/contracts.js";
import type { UiIntent } from "./contracts.js";
import type { InteractiveController } from "./controller.js";
import { resolveDexKeymapCommandIntent } from "./keymap-intents.js";
import { DexKeymapModeStack } from "./keymap-policy.js";
import {
  createOpenTuiKeymapAdapter,
  type OpenTuiKeymapAdapter,
  type OpenTuiKeymapAdapterOptions,
} from "./opentui-keymap-adapter.js";
import { OpenTuiSessionApp } from "./opentui-session-app.jsx";
import {
  createOpenTuiSyntaxStyle,
  type OpenTuiTheme,
  resolveOpenTuiTheme,
} from "./opentui-theme-adapter.js";
import { resolveInteractiveSurfacePolicy } from "./surface-policy.js";
import { resolveInteractiveTheme, type TerminalThemeColors, type ThemeMode } from "./theme.js";

export interface OpenTuiSessionCompositionOptions {
  readonly renderer: CliRenderer;
  readonly controller: InteractiveController;
  readonly keymap?: Omit<
    OpenTuiKeymapAdapterOptions,
    "renderer" | "modeStack" | "onCommand" | "onDiagnostic"
  >;
  readonly themeMode?: ThemeMode;
  readonly terminalTheme?: TerminalThemeColors;
}

export interface OpenTuiSessionComposition {
  readonly modeStack: DexKeymapModeStack;
  readonly keymap: OpenTuiKeymapAdapter;
  current(): TuiViewModel;
  dispose(): Promise<void>;
}

function focusRegionFor(renderable: Renderable | null): UiFocusRegion | undefined {
  const id = renderable?.id;
  if (!id) return undefined;
  if (id === "composer" || id.startsWith("composer:")) return "composer";
  if (id === "transcript" || id.startsWith("transcript:")) return "transcript";
  if (id === "diff-viewer" || id.startsWith("diff:")) return "diff";
  if (id.startsWith("approval:")) return "approval";
  if (id === "sidebar") return "context";
  if (id === "session-status") return "status";
  return undefined;
}

async function terminalTheme(
  renderer: CliRenderer,
  viewModel: TuiViewModel,
  options: OpenTuiSessionCompositionOptions,
): Promise<OpenTuiTheme> {
  const mode =
    options.themeMode ?? renderer.themeMode ?? (await renderer.waitForThemeMode(100)) ?? "dark";
  let terminal = options.terminalTheme;
  if (viewModel.ui.themeId === "system" && !terminal) {
    try {
      const palette = await renderer.getPalette({ timeout: 150, size: 16 });
      terminal = {
        ...(palette.defaultForeground
          ? { defaultForeground: palette.defaultForeground as `#${string}` }
          : {}),
        ...(palette.defaultBackground
          ? { defaultBackground: palette.defaultBackground as `#${string}` }
          : {}),
        palette: palette.palette.filter(
          (value): value is `#${string}` => typeof value === "string",
        ),
      };
    } catch {
      terminal = undefined;
    }
  }
  return resolveOpenTuiTheme(
    resolveInteractiveTheme({
      themeId: viewModel.ui.themeId,
      mode,
      ...(terminal ? { terminal } : {}),
    }),
  );
}

/**
 * Production root composition. CodingSession remains behind InteractiveController;
 * the mounted tree receives TuiViewModel and emits UiIntent only.
 */
export async function mountOpenTuiSessionComposition(
  options: OpenTuiSessionCompositionOptions,
): Promise<OpenTuiSessionComposition> {
  const initial = await options.controller.start();
  let current = initial;
  let disposed = false;
  let diagnosticSequence = 0;
  let focusRevision = 0;
  let themeRevision = 0;
  let syntaxStyle: SyntaxStyle | undefined;
  const initialTheme = await terminalTheme(options.renderer, initial, options);
  syntaxStyle = createOpenTuiSyntaxStyle(initialTheme);
  const [viewModel, setViewModel] = createSignal(initial, { equals: false });
  const [theme, setTheme] = createSignal(initialTheme, { equals: false });
  const [syntax, setSyntax] = createSignal(syntaxStyle, { equals: false });
  const initialSurface = resolveInteractiveSurfacePolicy(initial);
  const modeStack = new DexKeymapModeStack({
    route: initialSurface.route,
    focus: initialSurface.focus,
    activeRun: Boolean(initial.activeRun),
  });
  modeStack.replaceModes(initialSurface.modes);

  const reportRendererDiagnostic = async (diagnostic: TuiDiagnostic): Promise<void> => {
    await options.controller.dispatch({ version: 1, type: "report_diagnostic", diagnostic });
  };
  const keymap = createOpenTuiKeymapAdapter({
    ...options.keymap,
    renderer: options.renderer,
    modeStack,
    async onCommand(commandId) {
      const resolution = resolveDexKeymapCommandIntent(current, commandId);
      if (resolution.status === "unhandled") return false;
      if (resolution.status === "unavailable") {
        await reportRendererDiagnostic(resolution.diagnostic);
        return true;
      }
      const result = await options.controller.dispatch(resolution.intent);
      if (result.status === "rejected") {
        await reportRendererDiagnostic({
          id: `keymap:rejected:${commandId}:${++diagnosticSequence}`,
          source: "renderer",
          severity: "warning",
          code: "KEYMAP_COMMAND_REJECTED",
          message: result.message ?? `${commandId} 被 controller 拒绝`,
          recoverable: true,
        });
      }
      return true;
    },
    onDiagnostic(diagnostic) {
      void reportRendererDiagnostic({
        id: `keymap:runtime:${++diagnosticSequence}`,
        source: "renderer",
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        recoverable: true,
      });
    },
  });

  const syncModeStack = (next: TuiViewModel): void => {
    const policy = resolveInteractiveSurfacePolicy(next);
    modeStack.update({
      route: policy.route,
      focus: policy.focus,
      activeRun: Boolean(next.activeRun),
    });
    modeStack.replaceModes(policy.modes);
  };
  const syncFocus = (next: TuiViewModel): void => {
    const revision = ++focusRevision;
    const targetId = resolveInteractiveSurfacePolicy(next).focusTargetId;
    queueMicrotask(() => {
      if (disposed || revision !== focusRevision) return;
      const target = options.renderer.root.findDescendantById(targetId);
      if (target?.focusable) target.focus();
    });
  };
  const refreshTheme = (next: TuiViewModel): void => {
    const revision = ++themeRevision;
    void terminalTheme(options.renderer, next, options).then((nextTheme) => {
      if (disposed || revision !== themeRevision) return;
      const nextSyntax = createOpenTuiSyntaxStyle(nextTheme);
      const previousSyntax = syntaxStyle;
      syntaxStyle = nextSyntax;
      setTheme(nextTheme);
      setSyntax(nextSyntax);
      options.renderer.setBackgroundColor(nextTheme.colors.background);
      previousSyntax?.destroy();
    });
  };
  const acceptViewModel = (next: TuiViewModel): void => {
    const themeChanged =
      current.ui.themeId !== next.ui.themeId || options.renderer.themeMode !== theme().mode;
    current = next;
    syncModeStack(next);
    setViewModel(next);
    syncFocus(next);
    if (themeChanged) refreshTheme(next);
  };

  const unsubscribe = options.controller.subscribe(acceptViewModel);
  const onResize = (width: number, height: number): void => {
    void options.controller.dispatch({ version: 1, type: "terminal_resized", width, height });
  };
  const onFocus = (renderable: Renderable | null): void => {
    const region = focusRegionFor(renderable);
    if (!region || region === current.ui.focusedRegion) return;
    void options.controller.dispatch({ version: 1, type: "focus_region", region });
  };
  const onThemeMode = (): void => refreshTheme(current);
  options.renderer.on(CliRenderEvents.RESIZE, onResize);
  options.renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, onFocus);
  options.renderer.on(CliRenderEvents.THEME_MODE, onThemeMode);
  options.renderer.setBackgroundColor(initialTheme.colors.background);

  await render(
    () => (
      <OpenTuiSessionApp
        viewModel={viewModel}
        theme={theme}
        syntaxStyle={syntax}
        commandPaletteEntries={() => keymap.commandPaletteEntries()}
        onIntent={async (intent: UiIntent) => {
          await options.controller.dispatch(intent);
        }}
      />
    ),
    options.renderer,
  );
  syncFocus(initial);

  return Object.freeze({
    modeStack,
    keymap,
    current: () => current,
    async dispose() {
      if (disposed) return;
      disposed = true;
      focusRevision += 1;
      themeRevision += 1;
      options.renderer.off(CliRenderEvents.RESIZE, onResize);
      options.renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, onFocus);
      options.renderer.off(CliRenderEvents.THEME_MODE, onThemeMode);
      unsubscribe();
      keymap.dispose();
      syntaxStyle?.destroy();
      syntaxStyle = undefined;
    },
  });
}
