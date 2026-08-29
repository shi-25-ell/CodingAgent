import { describe, expect, it } from "bun:test";
import {
  canonicalizeDexKeyBinding,
  DexKeymapModeStack,
  resolveDexKeymap,
  selectDexCommandPaletteEntries,
} from "../../src/modes/interactive/index.js";

function commandBindings(
  keymap: ReturnType<typeof resolveDexKeymap>,
  commandId: string,
): readonly string[] {
  return (
    keymap.commands
      .find((command) => command.id === commandId)
      ?.bindings.map((binding) => binding.key) ?? []
  );
}

describe("Dex scoped keymap policy", () => {
  it("固化 timed leader、palette fallback 与 route direct bindings", () => {
    const keymap = resolveDexKeymap();

    expect(keymap.valid).toBe(true);
    expect(keymap.conflicts.some((conflict) => conflict.code === "SHADOWED_BINDING")).toBe(true);
    expect(keymap.leader).toBe("ctrl+x");
    expect(keymap.leaderTimeoutMs).toBe(2_000);
    expect(commandBindings(keymap, "command.palette.open")).toEqual(["ctrl+p", "<leader>p"]);
    expect(commandBindings(keymap, "run.abort")).toEqual(["<leader>i"]);
    expect(commandBindings(keymap, "diff.switch_focus")).toEqual(["tab"]);
    expect(commandBindings(keymap, "diff.previous_hunk")).toEqual(["["]);
    expect(commandBindings(keymap, "diff.next_hunk")).toEqual(["]"]);
    expect(commandBindings(keymap, "diff.previous_file")).toEqual(["p"]);
    expect(commandBindings(keymap, "diff.next_file")).toEqual(["n"]);
    expect(commandBindings(keymap, "diff.close")).toEqual(["escape", "q"]);
    expect(commandBindings(keymap, "transcript.page_up")).toEqual(["pageup"]);
    expect(commandBindings(keymap, "transcript.last")).toEqual(["end"]);
    expect(canonicalizeDexKeyBinding("<leader>p", keymap.leader)).toBe("ctrl+x p");
  });

  it("根据显式 mode stack 计算 deterministic active scopes", () => {
    const stack = new DexKeymapModeStack({
      route: "session",
      focus: "composer",
      activeRun: true,
    });
    expect([...stack.snapshot().scopes]).toEqual(["global", "session", "composer"]);

    const removeApproval = stack.push("approval");
    expect([...stack.snapshot().scopes]).toEqual(["approval"]);
    const removeDialog = stack.push("dialog");
    expect([...stack.snapshot().scopes]).toEqual(["approval", "dialog"]);
    removeDialog();
    removeApproval();

    stack.update({ route: "diff", focus: "diff", activeRun: true });
    expect([...stack.snapshot().scopes]).toEqual(["global", "session", "diff"]);
    const removePalette = stack.push("command_palette");
    expect([...stack.snapshot().scopes]).toEqual(["command_palette"]);
    removePalette();
  });

  it("拒绝 duplicate/unreachable，而不是静默 last-write-wins", () => {
    const keymap = resolveDexKeymap({
      bindings: { "session.new": "<leader>q" },
    });

    expect(keymap.valid).toBe(false);
    expect(
      keymap.conflicts.some(
        (conflict) =>
          conflict.code === "DUPLICATE_BINDING" &&
          conflict.severity === "error" &&
          conflict.commandId === "queue.manage",
      ),
    ).toBe(true);
    expect(
      keymap.conflicts.some(
        (conflict) => conflict.code === "UNREACHABLE_BINDING" && conflict.severity === "error",
      ),
    ).toBe(true);
  });

  it("报告 Textarea conflict 并让 Composer scope 保持优先", () => {
    const keymap = resolveDexKeymap({
      bindings: { "app.quit": "home" },
    });

    expect(keymap.valid).toBe(true);
    expect(
      keymap.conflicts.find((conflict) => conflict.code === "TEXTAREA_CONFLICT"),
    ).toMatchObject({
      severity: "warning",
      commandId: "app.quit",
      scope: "global",
      otherScope: "composer",
      binding: "home",
    });
  });

  it("拒绝 unknown command 与 invalid binding", () => {
    const keymap = resolveDexKeymap({
      bindings: {
        "app.quit": "ctrl+",
        ...({ "unknown.command": "x" } as Record<string, string>),
      },
    });

    expect(keymap.valid).toBe(false);
    expect(keymap.conflicts.some((conflict) => conflict.code === "UNKNOWN_COMMAND")).toBe(true);
    expect(keymap.conflicts.some((conflict) => conflict.code === "INVALID_BINDING")).toBe(true);
  });

  it("command palette 只投影当前 scope 的 active command", () => {
    const keymap = resolveDexKeymap();
    const stack = new DexKeymapModeStack({
      route: "session",
      focus: "transcript",
      activeRun: false,
    });
    const closePalette = stack.push("command_palette");

    const paletteCommandIds = selectDexCommandPaletteEntries(keymap, stack.snapshot()).map(
      (entry) => entry.id,
    );
    expect(paletteCommandIds).toContain("command.palette.open");
    expect(paletteCommandIds).toContain("transcript.page_up");
    expect(paletteCommandIds).not.toContain("command.palette.close");
    expect(paletteCommandIds).not.toContain("run.abort");
    closePalette();

    const commandIds = selectDexCommandPaletteEntries(keymap, stack.snapshot()).map(
      (entry) => entry.id,
    );
    expect(commandIds).not.toContain("run.abort");
    expect(commandIds).not.toContain("run.abort.compatibility");
  });
});
