import { describe, expect, it } from "bun:test";
import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  bindOpenTuiComposer,
  createOpenTuiComposerOptions,
  createOpenTuiKeymapAdapter,
  type DexKeymapCommandId,
  DexKeymapConfigurationError,
  DexKeymapModeStack,
  resolveInteractiveTheme,
  resolveOpenTuiTheme,
} from "../../src/modes/interactive/index.js";

describe("OpenTUI scoped keymap Adapter", () => {
  it("在注册 layer 前以 typed report 拒绝 blocking conflict", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8, useThread: false });
    const stack = new DexKeymapModeStack({
      route: "session",
      focus: "transcript",
      activeRun: false,
    });
    try {
      expect(() =>
        createOpenTuiKeymapAdapter({
          renderer: setup.renderer,
          modeStack: stack,
          configuration: { bindings: { "session.new": "<leader>q" } },
          onCommand: () => true,
        }),
      ).toThrow(DexKeymapConfigurationError);
      try {
        createOpenTuiKeymapAdapter({
          renderer: setup.renderer,
          modeStack: stack,
          configuration: { bindings: { "session.new": "<leader>q" } },
          onCommand: () => true,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(DexKeymapConfigurationError);
        expect((error as DexKeymapConfigurationError).conflicts.map((item) => item.code)).toEqual([
          "DUPLICATE_BINDING",
          "UNREACHABLE_BINDING",
        ]);
      }
    } finally {
      setup.renderer.destroy();
    }
  });

  it("派发 Ctrl+P、leader fallback、canonical abort 与 Diff direct keys", async () => {
    const setup = await createTestRenderer({
      width: 80,
      height: 20,
      useThread: false,
      kittyKeyboard: true,
    });
    const commands: DexKeymapCommandId[] = [];
    const stack = new DexKeymapModeStack({
      route: "session",
      focus: "transcript",
      activeRun: true,
    });
    const adapter = createOpenTuiKeymapAdapter({
      renderer: setup.renderer,
      modeStack: stack,
      onCommand: (commandId) => {
        commands.push(commandId);
        return true;
      },
    });
    try {
      setup.mockInput.pressKey("p", { ctrl: true });
      setup.mockInput.pressKey("x", { ctrl: true });
      setup.mockInput.pressKey("p");
      setup.mockInput.pressKey("x", { ctrl: true });
      setup.mockInput.pressKey("i");

      stack.update({ route: "session", focus: "transcript", activeRun: false });
      setup.mockInput.pressKey("x", { ctrl: true });
      setup.mockInput.pressKey("i");

      stack.update({ route: "diff", focus: "diff", activeRun: true });
      setup.mockInput.pressKey("]");
      setup.mockInput.pressKey("n");
      setup.mockInput.pressTab();
      setup.mockInput.pressKey("q");
      await setup.flush({ maxPasses: 20 });

      expect(commands).toEqual([
        "command.palette.open",
        "command.palette.open",
        "run.abort",
        "diff.next_hunk",
        "diff.next_file",
        "diff.switch_focus",
        "diff.close",
      ]);
    } finally {
      adapter.dispose();
      setup.renderer.destroy();
    }
  });

  it("managed Textarea scope 保留编辑、newline 与 submit，并遮蔽 global conflict", async () => {
    const setup = await createTestRenderer({
      width: 42,
      height: 8,
      useThread: false,
      kittyKeyboard: true,
    });
    const stack = new DexKeymapModeStack({
      route: "session",
      focus: "composer",
      activeRun: false,
    });
    const commands: DexKeymapCommandId[] = [];
    const adapter = createOpenTuiKeymapAdapter({
      renderer: setup.renderer,
      modeStack: stack,
      configuration: { bindings: { "app.quit": "home" } },
      onCommand: (commandId) => {
        commands.push(commandId);
        return true;
      },
    });
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const submitted: string[] = [];
    const textarea = new TextareaRenderable(setup.renderer, {
      ...createOpenTuiComposerOptions(theme),
      id: "keymap-composer",
      width: "100%",
      height: 4,
    });
    setup.renderer.root.add(textarea);
    const disposeComposer = bindOpenTuiComposer(textarea, {
      onChanged: () => undefined,
      onSubmit: (value) => {
        submitted.push(value);
      },
    });
    textarea.focus();
    try {
      await setup.mockInput.typeText("ab");
      setup.mockInput.pressKey("HOME");
      await setup.mockInput.typeText("X");
      setup.mockInput.pressEnter({ shift: true });
      await setup.mockInput.typeText("tail");
      setup.mockInput.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(textarea.plainText).toBe("X\ntailab");
      expect(submitted).toEqual(["X\ntailab"]);
      expect(commands).not.toContain("app.quit");
    } finally {
      disposeComposer();
      adapter.dispose();
      setup.renderer.destroy();
    }
  });

  it("仅在两个 Escape 都未被更高 scope 消费时触发 compatibility abort", async () => {
    const setup = await createTestRenderer({
      width: 80,
      height: 20,
      useThread: false,
      kittyKeyboard: true,
    });
    const commands: DexKeymapCommandId[] = [];
    let composerConsumesEscape = false;
    const stack = new DexKeymapModeStack({
      route: "session",
      focus: "composer",
      activeRun: true,
    });
    const adapter = createOpenTuiKeymapAdapter({
      renderer: setup.renderer,
      modeStack: stack,
      onCommand: (commandId) => {
        commands.push(commandId);
        if (commandId === "composer.escape") return composerConsumesEscape;
        return true;
      },
    });
    try {
      setup.mockInput.pressKey("x", { ctrl: true });
      setup.mockInput.pressEscape();
      expect(commands).toEqual([]);

      const closeOverlay = stack.push("overlay");
      setup.mockInput.pressEscape();
      expect(commands).toEqual(["overlay.close"]);
      commands.length = 0;
      closeOverlay();

      setup.mockInput.pressEscape();
      setup.mockInput.pressEscape();
      await setup.flush({ maxPasses: 20 });
      expect(commands).toEqual(["composer.escape", "composer.escape", "run.abort.compatibility"]);

      commands.length = 0;
      composerConsumesEscape = true;
      setup.mockInput.pressEscape();
      setup.mockInput.pressEscape();
      expect(commands).toEqual(["composer.escape", "composer.escape"]);

      commands.length = 0;
      stack.update({ route: "diff", focus: "diff", activeRun: true });
      setup.mockInput.pressEscape();
      setup.mockInput.pressEscape();
      expect(commands).toEqual(["diff.close", "diff.close"]);
    } finally {
      adapter.dispose();
      setup.renderer.destroy();
    }
  });
});
