import { describe, expect, it } from "bun:test";
import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  bindOpenTuiComposer,
  createOpenTuiComposerOptions,
  resolveInteractiveTheme,
  resolveOpenTuiTheme,
} from "../../src/modes/interactive/index.js";

describe("OpenTUI Composer Adapter", () => {
  it("支持 multiline、normalized bracketed paste 与 Enter submit", async () => {
    const setup = await createTestRenderer({
      width: 42,
      height: 8,
      useThread: false,
      kittyKeyboard: true,
    });
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const changes: string[] = [];
    const submitted: string[] = [];
    const largePastes: string[] = [];
    const textarea = new TextareaRenderable(setup.renderer, {
      ...createOpenTuiComposerOptions(theme),
      id: "composer",
      width: "100%",
      height: 4,
    });
    setup.renderer.root.add(textarea);
    const dispose = bindOpenTuiComposer(textarea, {
      onChanged: (value) => changes.push(value),
      onSubmit: async (value) => submitted.push(value),
      onLargePaste: (paste) => largePastes.push(paste.placeholder ?? ""),
    });
    textarea.focus();
    try {
      await setup.mockInput.typeText("第一行");
      setup.mockInput.pressEnter({ shift: true });
      await setup.mockInput.pasteBracketedText("第二行\r\n第三行\r第四行");
      await setup.flush({ maxPasses: 20 });

      expect(textarea.plainText).toBe("第一行\n第二行\n第三行\n第四行");
      expect(largePastes).toEqual(["[Pasted 3 lines · 11 chars]"]);
      setup.mockInput.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(submitted).toEqual(["第一行\n第二行\n第三行\n第四行"]);
      expect(changes.at(-1)).toBe(textarea.plainText);
    } finally {
      dispose();
      setup.renderer.destroy();
    }
  });
});
