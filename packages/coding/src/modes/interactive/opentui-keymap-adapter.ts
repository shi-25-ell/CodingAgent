import {
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  TextareaRenderable,
} from "@opentui/core";
import type { Binding, Keymap } from "@opentui/keymap";
import {
  registerDeadBindingWarnings,
  registerDefaultKeys,
  registerEscapeClearsPendingSequence,
  registerMetadataFields,
  registerTimedLeader,
  registerUnresolvedCommandWarnings,
} from "@opentui/keymap/addons";
import { createTextareaBindings } from "@opentui/keymap/addons/opentui";
import { createOpenTuiKeymap } from "@opentui/keymap/opentui";
import {
  type DexCommandPaletteEntry,
  type DexKeymapCommandId,
  type DexKeymapConfiguration,
  type DexKeymapConflict,
  type DexKeymapModeStack,
  type DexKeymapScope,
  dexKeymapScopePriority,
  type ResolvedDexKeymap,
  resolveDexKeymap,
  selectDexCommandPaletteEntries,
} from "./keymap-policy.js";

export type DexKeymapRuntimeDiagnosticCode =
  | "KEYMAP_RUNTIME_WARNING"
  | "KEYMAP_RUNTIME_ERROR"
  | "KEYMAP_COMMAND_FAILED";

export interface DexKeymapRuntimeDiagnostic {
  readonly code: DexKeymapRuntimeDiagnosticCode;
  readonly severity: "warning" | "error";
  readonly message: string;
  readonly commandId?: DexKeymapCommandId;
  readonly cause?: unknown;
}

export type DexKeymapCommandHandler = (
  commandId: DexKeymapCommandId,
) => boolean | void | Promise<boolean> | Promise<void>;

export interface OpenTuiKeymapAdapterOptions {
  readonly renderer: CliRenderer;
  readonly modeStack: DexKeymapModeStack;
  readonly configuration?: DexKeymapConfiguration;
  readonly onCommand: DexKeymapCommandHandler;
  readonly onDiagnostic?: (diagnostic: DexKeymapRuntimeDiagnostic) => void;
  readonly now?: () => number;
  readonly doubleEscapeWindowMs?: number;
}

export interface OpenTuiKeymapAdapter {
  readonly keymap: Keymap<Renderable, KeyEvent>;
  readonly resolved: ResolvedDexKeymap;
  readonly conflicts: readonly DexKeymapConflict[];
  commandPaletteEntries(): readonly DexCommandPaletteEntry[];
  dispose(): void;
}

export class DexKeymapConfigurationError extends Error {
  readonly conflicts: readonly DexKeymapConflict[];

  constructor(conflicts: readonly DexKeymapConflict[]) {
    super("Dex Code keymap configuration contains blocking conflicts");
    this.name = "DexKeymapConfigurationError";
    this.conflicts = conflicts;
  }
}

function isPlainEscape(event: KeyEvent): boolean {
  return (
    event.name === "escape" &&
    !event.ctrl &&
    !event.shift &&
    !event.meta &&
    !event.super &&
    !event.hyper
  );
}

function canUseCompatibilityAbort(modeStack: DexKeymapModeStack): boolean {
  const snapshot = modeStack.snapshot();
  return (
    snapshot.route === "session" &&
    snapshot.activeRun &&
    !snapshot.scopes.has("approval") &&
    !snapshot.scopes.has("overlay") &&
    !snapshot.scopes.has("dialog") &&
    !snapshot.scopes.has("command_palette") &&
    !snapshot.scopes.has("which_key")
  );
}

function textareaPassThroughBindings(): readonly Binding<Renderable, KeyEvent>[] {
  const keys = new Set(
    createTextareaBindings().map((binding) =>
      typeof binding.key === "string" ? binding.key : JSON.stringify(binding.key),
    ),
  );
  keys.add("return");
  keys.add("kpenter");
  keys.add("shift+return");
  keys.add("shift+kpenter");
  return Object.freeze(
    [...keys].map((key) =>
      Object.freeze({
        key,
        cmd: () => true,
        preventDefault: false,
        desc: "Composer managed Textarea input",
        group: "Composer",
      }),
    ),
  );
}

/**
 * Bridges product-owned scope policy to OpenTUI. Components only dispatch
 * semantic command IDs; this adapter owns key parsing, precedence and cleanup.
 */
export function createOpenTuiKeymapAdapter(
  options: OpenTuiKeymapAdapterOptions,
): OpenTuiKeymapAdapter {
  const resolved = resolveDexKeymap(options.configuration);
  if (!resolved.valid) {
    throw new DexKeymapConfigurationError(
      resolved.conflicts.filter((item) => item.severity === "error"),
    );
  }

  const keymap = createOpenTuiKeymap(options.renderer);
  const cleanup: (() => void)[] = [];
  const report = options.onDiagnostic ?? (() => undefined);
  const now = options.now ?? Date.now;
  const doubleEscapeWindowMs = options.doubleEscapeWindowMs ?? 500;
  let modeRevision = 0;
  let firstUnhandledEscapeAt: number | undefined;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;

  const clearCompatibilityEscape = (): void => {
    firstUnhandledEscapeAt = undefined;
    if (escapeTimer !== undefined) clearTimeout(escapeTimer);
    escapeTimer = undefined;
  };
  const dispatch = (
    commandId: DexKeymapCommandId,
  ): boolean | undefined | Promise<boolean | undefined> => {
    try {
      const result = options.onCommand(commandId);
      if (result instanceof Promise) {
        return Promise.resolve(result)
          .then((value) => value ?? undefined)
          .catch((cause: unknown) => {
            report({
              code: "KEYMAP_COMMAND_FAILED",
              severity: "error",
              commandId,
              message: `keymap command ${commandId} 执行失败`,
              cause,
            });
            return false;
          });
      }
      return result ?? undefined;
    } catch (cause) {
      report({
        code: "KEYMAP_COMMAND_FAILED",
        severity: "error",
        commandId,
        message: `keymap command ${commandId} 执行失败`,
        cause,
      });
      return false;
    }
  };

  cleanup.push(registerDefaultKeys(keymap));
  cleanup.push(registerMetadataFields(keymap));
  cleanup.push(registerDeadBindingWarnings(keymap));
  cleanup.push(registerUnresolvedCommandWarnings(keymap));
  cleanup.push(
    keymap.registerLayerFields({
      dexScope(value, context) {
        context.activeWhen(() => options.modeStack.snapshot().scopes.has(value as DexKeymapScope));
      },
      dexTextarea(value, context) {
        if (!value) return;
        context.activeWhen(
          () => options.renderer.currentFocusedEditor instanceof TextareaRenderable,
        );
      },
      dexActiveRun(value, context) {
        if (!value) return;
        context.activeWhen(() => options.modeStack.snapshot().activeRun);
      },
    }),
  );
  cleanup.push(
    options.modeStack.subscribe(() => {
      modeRevision += 1;
      keymap.setData("dex.modeRevision", modeRevision);
      clearCompatibilityEscape();
    }),
  );
  if (resolved.leader) {
    cleanup.push(
      registerTimedLeader(keymap, {
        name: "leader",
        trigger: resolved.leader,
        timeoutMs: resolved.leaderTimeoutMs,
      }),
    );
  }
  cleanup.push(
    registerEscapeClearsPendingSequence(keymap, {
      priority: 10_000,
      preventDefault: true,
    }),
  );
  cleanup.push(
    keymap.on("warning", (event) =>
      report({
        code: "KEYMAP_RUNTIME_WARNING",
        severity: "warning",
        message: `${event.code}: ${event.message}`,
        cause: event.warning,
      }),
    ),
  );
  cleanup.push(
    keymap.on("error", (event) =>
      report({
        code: "KEYMAP_RUNTIME_ERROR",
        severity: "error",
        message: `${event.code}: ${event.message}`,
        cause: event.error,
      }),
    ),
  );

  cleanup.push(
    keymap.registerLayer({
      priority: dexKeymapScopePriority.composer + 100,
      dexScope: "composer",
      dexTextarea: true,
      bindings: textareaPassThroughBindings(),
    }),
  );

  for (const item of resolved.commands) {
    if (item.disabled) continue;
    cleanup.push(
      keymap.registerLayer({
        priority: dexKeymapScopePriority[item.scope],
        dexScope: item.scope,
        dexActiveRun: item.requiresActiveRun,
        commands: [
          {
            name: item.id,
            title: item.title,
            category: item.category,
            run: () => dispatch(item.id),
          },
        ],
        bindings: item.bindings.flatMap((binding) =>
          binding.compatibility
            ? []
            : [
                {
                  key: binding.key,
                  cmd: item.id,
                  desc: item.title,
                  group: item.category,
                },
              ],
        ),
      }),
    );
  }

  cleanup.push(
    keymap.intercept(
      "key:after",
      (context) => {
        if (context.eventType !== "press" || !isPlainEscape(context.event)) {
          clearCompatibilityEscape();
          return;
        }
        if (context.handled || !canUseCompatibilityAbort(options.modeStack)) {
          clearCompatibilityEscape();
          return;
        }
        const current = now();
        if (
          firstUnhandledEscapeAt !== undefined &&
          current - firstUnhandledEscapeAt <= doubleEscapeWindowMs
        ) {
          clearCompatibilityEscape();
          context.consume();
          void dispatch("run.abort.compatibility");
          return;
        }
        firstUnhandledEscapeAt = current;
        context.consume();
        escapeTimer = setTimeout(clearCompatibilityEscape, doubleEscapeWindowMs);
      },
      { priority: -10_000 },
    ),
  );

  let disposed = false;
  return Object.freeze({
    keymap,
    resolved,
    conflicts: resolved.conflicts,
    commandPaletteEntries: () =>
      selectDexCommandPaletteEntries(resolved, options.modeStack.snapshot()),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearCompatibilityEscape();
      for (const dispose of cleanup.reverse()) dispose();
    },
  });
}
