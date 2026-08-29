import { immutableReadonlySet } from "../../projection/immutable-readonly-set.js";

export type DexKeymapScope =
  | "global"
  | "session"
  | "transcript"
  | "composer"
  | "diff"
  | "approval"
  | "overlay"
  | "dialog"
  | "command_palette"
  | "which_key";

export type DexKeymapMode = "approval" | "overlay" | "dialog" | "command_palette" | "which_key";

export type DexKeymapCommandId =
  | "app.quit"
  | "command.palette.open"
  | "command.palette.close"
  | "which_key.toggle"
  | "which_key.close"
  | "session.new"
  | "session.list"
  | "session.branch"
  | "model.list"
  | "sidebar.toggle"
  | "diff.open"
  | "queue.manage"
  | "context.open"
  | "run.report"
  | "theme.list"
  | "help.open"
  | "run.abort"
  | "run.abort.compatibility"
  | "transcript.page_up"
  | "transcript.page_down"
  | "transcript.first"
  | "transcript.last"
  | "composer.escape"
  | "diff.close"
  | "diff.toggle_item"
  | "diff.expand"
  | "diff.collapse"
  | "diff.expand_all"
  | "diff.switch_focus"
  | "diff.previous_hunk"
  | "diff.next_hunk"
  | "diff.previous_file"
  | "diff.next_file"
  | "diff.toggle_file_tree"
  | "diff.single_patch"
  | "diff.switch_source"
  | "diff.toggle_view"
  | "diff.help"
  | "approval.select_allow"
  | "approval.select_deny"
  | "approval.confirm"
  | "approval.deny"
  | "approval.toggle_fullscreen"
  | "overlay.close"
  | "dialog.close";

export interface DexKeymapBindingDefinition {
  readonly key: string;
  readonly compatibility?: boolean;
}

export interface DexKeymapCommandDefinition {
  readonly id: DexKeymapCommandId;
  readonly title: string;
  readonly category: string;
  readonly scope: DexKeymapScope;
  readonly bindings: readonly DexKeymapBindingDefinition[];
  readonly paletteOnly?: boolean;
  readonly requiresActiveRun?: boolean;
}

export type DexKeymapBindingOverride = false | string | readonly string[];

export interface DexKeymapConfiguration {
  readonly leader?: string | false;
  readonly leaderTimeoutMs?: number;
  readonly bindings?: Readonly<Partial<Record<DexKeymapCommandId, DexKeymapBindingOverride>>>;
}

export type DexKeymapConflictCode =
  | "DUPLICATE_BINDING"
  | "SHADOWED_BINDING"
  | "UNREACHABLE_BINDING"
  | "TEXTAREA_CONFLICT"
  | "UNKNOWN_COMMAND"
  | "INVALID_BINDING";

export interface DexKeymapConflict {
  readonly id: string;
  readonly code: DexKeymapConflictCode;
  readonly severity: "info" | "warning" | "error";
  readonly commandId?: string;
  readonly otherCommandId?: string;
  readonly scope?: DexKeymapScope;
  readonly otherScope?: DexKeymapScope;
  readonly binding?: string;
  readonly message: string;
  readonly resolution: string;
}

export interface ResolvedDexKeymapBinding extends DexKeymapBindingDefinition {
  readonly canonical: string;
}

export interface ResolvedDexKeymapCommand extends Omit<DexKeymapCommandDefinition, "bindings"> {
  readonly bindings: readonly ResolvedDexKeymapBinding[];
  readonly disabled: boolean;
}

export interface ResolvedDexKeymap {
  readonly leader?: string;
  readonly leaderTimeoutMs: number;
  readonly commands: readonly ResolvedDexKeymapCommand[];
  readonly conflicts: readonly DexKeymapConflict[];
  readonly valid: boolean;
}

export interface DexKeymapBaseContext {
  readonly route: "session" | "diff";
  readonly focus: "composer" | "transcript" | "status" | "diff";
  readonly activeRun: boolean;
}

export interface DexKeymapModeStackSnapshot extends DexKeymapBaseContext {
  readonly modes: readonly DexKeymapMode[];
  readonly scopes: ReadonlySet<DexKeymapScope>;
}

export const dexKeymapScopePriority: Readonly<Record<DexKeymapScope, number>> = Object.freeze({
  global: 100,
  session: 200,
  transcript: 400,
  composer: 500,
  diff: 600,
  approval: 800,
  overlay: 900,
  dialog: 950,
  command_palette: 1_000,
  which_key: 1_000,
});

const command = (
  id: DexKeymapCommandId,
  title: string,
  category: string,
  scope: DexKeymapScope,
  bindings: readonly (string | DexKeymapBindingDefinition)[],
  options: { readonly paletteOnly?: boolean; readonly requiresActiveRun?: boolean } = {},
): DexKeymapCommandDefinition =>
  Object.freeze({
    id,
    title,
    category,
    scope,
    bindings: Object.freeze(
      bindings.map((binding) =>
        Object.freeze(typeof binding === "string" ? { key: binding } : binding),
      ),
    ),
    ...(options.paletteOnly ? { paletteOnly: true } : {}),
    ...(options.requiresActiveRun ? { requiresActiveRun: true } : {}),
  });

export const dexDefaultKeymapCommands: readonly DexKeymapCommandDefinition[] = Object.freeze([
  command("app.quit", "Quit Dex Code", "Application", "global", ["<leader>x"]),
  command("command.palette.open", "Open command palette", "Application", "global", [
    "ctrl+p",
    "<leader>p",
  ]),
  command("which_key.toggle", "Show key bindings", "Application", "global", ["ctrl+alt+k"]),
  command("session.new", "New session", "Session", "session", ["<leader>n"]),
  command("session.list", "List sessions", "Session", "session", ["<leader>l"]),
  command("session.branch", "Select branch", "Session", "session", ["<leader>g"]),
  command("model.list", "Select model", "Session", "session", ["<leader>m"]),
  command("sidebar.toggle", "Toggle sidebar", "Session", "session", ["<leader>b"]),
  command("diff.open", "Open diff viewer", "Session", "session", ["<leader>d"]),
  command("queue.manage", "Manage queued messages", "Run", "session", ["<leader>q"]),
  command("context.open", "Open context details", "Run", "session", [], {
    paletteOnly: true,
  }),
  command("run.report", "Open Run report", "Run", "session", ["<leader>s"]),
  command("theme.list", "Select theme", "Application", "global", ["<leader>t"]),
  command("help.open", "Open help", "Application", "global", ["<leader>h"]),
  command("run.abort", "Abort active Run", "Run", "session", ["<leader>i"], {
    requiresActiveRun: true,
  }),
  command(
    "run.abort.compatibility",
    "Abort active Run (compatibility)",
    "Run",
    "session",
    [{ key: "escape escape", compatibility: true }],
    { requiresActiveRun: true },
  ),
  command("transcript.page_up", "Scroll Transcript up one page", "Transcript", "transcript", [
    "pageup",
  ]),
  command("transcript.page_down", "Scroll Transcript down one page", "Transcript", "transcript", [
    "pagedown",
  ]),
  command("transcript.first", "Jump to first Transcript block", "Transcript", "transcript", [
    "home",
  ]),
  command("transcript.last", "Jump to latest Transcript block", "Transcript", "transcript", [
    "end",
  ]),
  command("composer.escape", "Cancel Composer local state", "Composer", "composer", ["escape"]),
  command("diff.close", "Close diff viewer", "Diff", "diff", ["escape", "q"]),
  command("diff.toggle_item", "Toggle file-tree item", "Diff", "diff", ["return", "space"]),
  command("diff.expand", "Expand file-tree item", "Diff", "diff", ["right"]),
  command("diff.collapse", "Collapse file-tree item", "Diff", "diff", ["left"]),
  command("diff.expand_all", "Expand all file-tree folders", "Diff", "diff", ["shift+e"]),
  command("diff.switch_focus", "Switch files/patches focus", "Diff", "diff", ["tab"]),
  command("diff.previous_hunk", "Previous diff hunk", "Diff", "diff", ["["]),
  command("diff.next_hunk", "Next diff hunk", "Diff", "diff", ["]"]),
  command("diff.previous_file", "Previous changed file", "Diff", "diff", ["p"]),
  command("diff.next_file", "Next changed file", "Diff", "diff", ["n"]),
  command("diff.toggle_file_tree", "Toggle diff file tree", "Diff", "diff", ["b"]),
  command("diff.single_patch", "Toggle single patch", "Diff", "diff", ["s"]),
  command("diff.switch_source", "Switch diff source", "Diff", "diff", ["d"]),
  command("diff.toggle_view", "Toggle split/unified view", "Diff", "diff", ["v"]),
  command("diff.help", "Open Diff shortcuts", "Diff", "diff", ["?"]),
  command("approval.select_allow", "Select Allow once", "Approval", "approval", ["left", "h"]),
  command("approval.select_deny", "Select Deny", "Approval", "approval", ["right", "l"]),
  command("approval.confirm", "Confirm approval decision", "Approval", "approval", ["return"]),
  command("approval.deny", "Deny approval", "Approval", "approval", ["escape"]),
  command("approval.toggle_fullscreen", "Toggle approval full screen", "Approval", "approval", [
    "ctrl+f",
  ]),
  command("overlay.close", "Close overlay", "Overlay", "overlay", ["escape"]),
  command("dialog.close", "Close dialog", "Dialog", "dialog", ["escape"]),
  command("command.palette.close", "Close command palette", "Application", "command_palette", [
    "escape",
  ]),
  command("which_key.close", "Close key bindings", "Application", "which_key", ["escape"]),
]);

const textareaReservedBindings = new Set([
  "left",
  "right",
  "up",
  "down",
  "shift+left",
  "shift+right",
  "shift+up",
  "shift+down",
  "home",
  "end",
  "shift+home",
  "shift+end",
  "ctrl+a",
  "ctrl+e",
  "ctrl+b",
  "ctrl+f",
  "ctrl+shift+a",
  "ctrl+shift+e",
  "meta+a",
  "meta+e",
  "shift+meta+a",
  "shift+meta+e",
  "ctrl+w",
  "backspace",
  "shift+backspace",
  "delete",
  "shift+delete",
  "ctrl+backspace",
  "ctrl+delete",
  "meta+delete",
  "meta+backspace",
  "meta+d",
  "ctrl+d",
  "ctrl+shift+d",
  "ctrl+k",
  "ctrl+u",
  "return",
  "kpenter",
  "linefeed",
  "shift+return",
  "shift+kpenter",
  "meta+return",
  "meta+kpenter",
  "ctrl+-",
  "ctrl+.",
  "meta+f",
  "meta+b",
  "meta+right",
  "meta+left",
  "ctrl+right",
  "ctrl+left",
  "shift+meta+f",
  "shift+meta+b",
  "shift+meta+right",
  "shift+meta+left",
  "super+z",
  "shift+super+z",
  "super+a",
  "super+left",
  "super+right",
  "super+up",
  "super+down",
  "shift+super+left",
  "shift+super+right",
  "shift+super+up",
  "shift+super+down",
]);

const aliases: Readonly<Record<string, string>> = Object.freeze({
  enter: "return",
  esc: "escape",
  pgup: "pageup",
  pgdn: "pagedown",
  alt: "meta",
});

const modifierOrder = ["ctrl", "shift", "meta", "super", "hyper"] as const;

function normalizeStroke(input: string): string {
  const value = input.trim().toLowerCase();
  if (value.length === 0) return "";
  if (value.startsWith("<") && value.endsWith(">")) return value;
  const pieces = value.split("+").map((piece) => aliases[piece] ?? piece);
  const key = pieces.find(
    (piece) => !modifierOrder.includes(piece as (typeof modifierOrder)[number]),
  );
  const modifiers = modifierOrder.filter((modifier) => pieces.includes(modifier));
  return [...modifiers, key].filter((piece): piece is string => Boolean(piece)).join("+");
}

export function canonicalizeDexKeyBinding(binding: string, leader?: string): string {
  const expanded = binding
    .trim()
    .toLowerCase()
    .replaceAll("<leader>", leader ? `${leader} ` : "<disabled-leader> ");
  return expanded.split(/\s+/).map(normalizeStroke).filter(Boolean).join(" ");
}

function isValidCanonicalBinding(binding: string): boolean {
  if (!binding) return false;
  return binding.split(" ").every((stroke) => {
    if (!stroke || stroke.startsWith("<") || stroke.endsWith(">")) return false;
    const pieces = stroke.split("+");
    const key = pieces.at(-1);
    return Boolean(key && !modifierOrder.includes(key as (typeof modifierOrder)[number]));
  });
}

function overrideBindings(value: DexKeymapBindingOverride): readonly DexKeymapBindingDefinition[] {
  if (value === false) return [];
  const values = typeof value === "string" ? value.split(",") : value;
  return Object.freeze(
    values.map((key) => Object.freeze({ key: key.trim() })).filter((binding) => binding.key),
  );
}

function conflict(sequence: number, value: Omit<DexKeymapConflict, "id">): DexKeymapConflict {
  return Object.freeze({ id: `keymap:${value.code}:${sequence}`, ...value });
}

const representativeContexts: DexKeymapModeStackSnapshot[] = [];

function scopesCanOverlap(left: DexKeymapScope, right: DexKeymapScope): boolean {
  if (left === right) return true;
  if (representativeContexts.length === 0) {
    const bases: DexKeymapBaseContext[] = [
      { route: "session", focus: "composer", activeRun: true },
      { route: "session", focus: "transcript", activeRun: true },
      { route: "diff", focus: "diff", activeRun: true },
    ];
    const stacks: readonly DexKeymapMode[][] = [
      [],
      ["overlay"],
      ["dialog"],
      ["approval"],
      ["approval", "dialog"],
      ["command_palette"],
      ["which_key"],
    ];
    for (const base of bases) {
      for (const modes of stacks) {
        const scopes = resolveDexKeymapScopes(base, modes);
        representativeContexts.push(Object.freeze({ ...base, modes, scopes }));
      }
    }
  }
  return representativeContexts.some(
    (context) => context.scopes.has(left) && context.scopes.has(right),
  );
}

export function resolveDexKeymap(configuration: DexKeymapConfiguration = {}): ResolvedDexKeymap {
  const conflicts: DexKeymapConflict[] = [];
  let sequence = 0;
  const leader =
    configuration.leader === false
      ? undefined
      : canonicalizeDexKeyBinding(configuration.leader ?? "ctrl+x");
  const leaderTimeoutMs = configuration.leaderTimeoutMs ?? 2_000;
  if (leader && (leader.includes(" ") || !isValidCanonicalBinding(leader))) {
    conflicts.push(
      conflict(++sequence, {
        code: "INVALID_BINDING",
        severity: "error",
        binding: configuration.leader || "ctrl+x",
        message: `无效 timed leader: ${configuration.leader || "ctrl+x"}`,
        resolution: "拒绝 keymap configuration；leader 必须是单个可解析 key stroke",
      }),
    );
  }
  if (!Number.isInteger(leaderTimeoutMs) || leaderTimeoutMs < 1) {
    conflicts.push(
      conflict(++sequence, {
        code: "INVALID_BINDING",
        severity: "error",
        message: "leaderTimeoutMs 必须是正整数",
        resolution: "拒绝 keymap configuration",
      }),
    );
  }

  const known = new Set(dexDefaultKeymapCommands.map((item) => item.id));
  for (const commandId of Object.keys(configuration.bindings ?? {})) {
    if (known.has(commandId as DexKeymapCommandId)) continue;
    conflicts.push(
      conflict(++sequence, {
        code: "UNKNOWN_COMMAND",
        severity: "error",
        commandId,
        message: `未知 keymap command: ${commandId}`,
        resolution: "拒绝 unknown command override",
      }),
    );
  }

  const commands = dexDefaultKeymapCommands.map((definition): ResolvedDexKeymapCommand => {
    const override = configuration.bindings?.[definition.id];
    const disabled = override === false;
    const source = override === undefined ? definition.bindings : overrideBindings(override);
    const bindings = source.flatMap((binding) => {
      const canonical = canonicalizeDexKeyBinding(binding.key, leader);
      if (!canonical || canonical.includes("<disabled-leader>")) return [];
      if (!isValidCanonicalBinding(canonical)) {
        conflicts.push(
          conflict(++sequence, {
            code: "INVALID_BINDING",
            severity: "error",
            commandId: definition.id,
            scope: definition.scope,
            binding: binding.key,
            message: `${definition.id} 包含无效 binding: ${binding.key}`,
            resolution: "拒绝 keymap configuration；使用可解析的 key sequence",
          }),
        );
        return [];
      }
      return [Object.freeze({ ...binding, canonical })];
    });
    if (!disabled && bindings.length === 0 && !definition.paletteOnly) {
      conflicts.push(
        conflict(++sequence, {
          code: "UNREACHABLE_BINDING",
          severity: "warning",
          commandId: definition.id,
          scope: definition.scope,
          message: `${definition.id} 没有 reachable binding`,
          resolution: "command 仅能从 command palette 调用，或补充 binding",
        }),
      );
    }
    return Object.freeze({
      ...definition,
      bindings: Object.freeze(bindings),
      disabled,
    });
  });

  const activeBindings = commands.flatMap((item) =>
    item.disabled ? [] : item.bindings.map((binding) => ({ command: item, binding })),
  );
  const sameScope = new Map<string, (typeof activeBindings)[number]>();
  for (const current of activeBindings) {
    const key = `${current.command.scope}\0${current.binding.canonical}`;
    const existing = sameScope.get(key);
    if (existing) {
      conflicts.push(
        conflict(++sequence, {
          code: "DUPLICATE_BINDING",
          severity: "error",
          commandId: current.command.id,
          otherCommandId: existing.command.id,
          scope: current.command.scope,
          binding: current.binding.key,
          message: `${current.binding.key} 在 ${current.command.scope} scope 重复`,
          resolution: "拒绝 registration-order override；必须显式修改或禁用其中一个 binding",
        }),
      );
      conflicts.push(
        conflict(++sequence, {
          code: "UNREACHABLE_BINDING",
          severity: "error",
          commandId: current.command.id,
          otherCommandId: existing.command.id,
          scope: current.command.scope,
          binding: current.binding.key,
          message: `${current.command.id} 会被同 scope binding 遮蔽`,
          resolution: "拒绝 keymap configuration",
        }),
      );
    } else {
      sameScope.set(key, current);
    }
  }

  for (let leftIndex = 0; leftIndex < activeBindings.length; leftIndex += 1) {
    const left = activeBindings[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < activeBindings.length; rightIndex += 1) {
      const right = activeBindings[rightIndex];
      if (
        !right ||
        left.command.scope === right.command.scope ||
        left.binding.canonical !== right.binding.canonical ||
        !scopesCanOverlap(left.command.scope, right.command.scope)
      ) {
        continue;
      }
      const winner =
        dexKeymapScopePriority[left.command.scope] > dexKeymapScopePriority[right.command.scope]
          ? left
          : right;
      const loser = winner === left ? right : left;
      conflicts.push(
        conflict(++sequence, {
          code: "SHADOWED_BINDING",
          severity: "info",
          commandId: loser.command.id,
          otherCommandId: winner.command.id,
          scope: loser.command.scope,
          otherScope: winner.command.scope,
          binding: loser.binding.key,
          message: `${winner.command.scope} scope 在重叠 context 中优先处理 ${winner.binding.key}`,
          resolution: `固定 precedence ${dexKeymapScopePriority[winner.command.scope]} > ${dexKeymapScopePriority[loser.command.scope]}`,
        }),
      );
    }
  }

  for (const current of activeBindings) {
    if (
      (current.command.scope !== "global" && current.command.scope !== "session") ||
      current.binding.compatibility ||
      !textareaReservedBindings.has(current.binding.canonical)
    ) {
      continue;
    }
    conflicts.push(
      conflict(++sequence, {
        code: "TEXTAREA_CONFLICT",
        severity: "warning",
        commandId: current.command.id,
        scope: current.command.scope,
        otherScope: "composer",
        binding: current.binding.key,
        message: `${current.binding.key} 在 Composer focus 下由 managed Textarea 优先处理`,
        resolution: "保留 command metadata，但 Composer scope 阻止 route/global 抢占编辑行为",
      }),
    );
  }

  return Object.freeze({
    ...(leader ? { leader } : {}),
    leaderTimeoutMs,
    commands: Object.freeze(commands),
    conflicts: Object.freeze(conflicts),
    valid: conflicts.every((item) => item.severity !== "error"),
  });
}

export function resolveDexKeymapScopes(
  base: DexKeymapBaseContext,
  modes: readonly DexKeymapMode[],
): ReadonlySet<DexKeymapScope> {
  const top = modes.at(-1);
  if (top === "command_palette" || top === "which_key") {
    return immutableReadonlySet([top]);
  }
  const approvalIndex = modes.lastIndexOf("approval");
  if (approvalIndex >= 0) {
    return immutableReadonlySet<DexKeymapScope>(modes.slice(approvalIndex));
  }
  const scopes = new Set<DexKeymapScope>(["global", "session"]);
  if (base.route === "diff") scopes.add("diff");
  else if (base.focus === "composer") scopes.add("composer");
  else if (base.focus === "transcript") scopes.add("transcript");
  for (const mode of modes) scopes.add(mode);
  return immutableReadonlySet(scopes);
}

export class DexKeymapModeStack {
  #base: DexKeymapBaseContext;
  readonly #stack: { readonly id: symbol; readonly mode: DexKeymapMode }[] = [];
  readonly #listeners = new Set<(snapshot: DexKeymapModeStackSnapshot) => void>();

  constructor(base: DexKeymapBaseContext) {
    this.#base = { ...base };
  }

  snapshot(): DexKeymapModeStackSnapshot {
    const modes = Object.freeze(this.#stack.map((entry) => entry.mode));
    return Object.freeze({
      ...this.#base,
      modes,
      scopes: resolveDexKeymapScopes(this.#base, modes),
    });
  }

  update(base: DexKeymapBaseContext): void {
    if (
      this.#base.route === base.route &&
      this.#base.focus === base.focus &&
      this.#base.activeRun === base.activeRun
    ) {
      return;
    }
    this.#base = { ...base };
    this.#emit();
  }

  push(mode: DexKeymapMode): () => void {
    const entry = { id: Symbol(mode), mode };
    this.#stack.push(entry);
    this.#emit();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.#stack.findIndex((current) => current.id === entry.id);
      if (index < 0) return;
      this.#stack.splice(index, 1);
      this.#emit();
    };
  }

  subscribe(listener: (snapshot: DexKeymapModeStackSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

export interface DexCommandPaletteEntry {
  readonly id: DexKeymapCommandId;
  readonly title: string;
  readonly category: string;
  readonly bindings: readonly string[];
}

export function selectDexCommandPaletteEntries(
  keymap: ResolvedDexKeymap,
  context: DexKeymapModeStackSnapshot,
): readonly DexCommandPaletteEntry[] {
  return Object.freeze(
    keymap.commands.flatMap((command) =>
      command.disabled ||
      !context.scopes.has(command.scope) ||
      (command.requiresActiveRun && !context.activeRun)
        ? []
        : [
            Object.freeze({
              id: command.id,
              title: command.title,
              category: command.category,
              bindings: Object.freeze(command.bindings.map((binding) => binding.key)),
            }),
          ],
    ),
  );
}
