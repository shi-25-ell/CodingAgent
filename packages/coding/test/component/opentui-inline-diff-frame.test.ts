import { describe, expect, it } from "bun:test";
import { DiffRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  createOpenTuiInlineDiffOptions,
  createOpenTuiSyntaxStyle,
  resolveInteractiveTheme,
  resolveOpenTuiTheme,
} from "../../src/modes/interactive/index.js";

describe("OpenTUI inline diff frame", () => {
  it("mutation evidence 在 Transcript-sized renderable 中显示 line numbers 与 add/remove rows", async () => {
    const setup = await createTestRenderer({ width: 72, height: 10, useThread: false });
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const syntax = createOpenTuiSyntaxStyle(theme);
    try {
      const options = createOpenTuiInlineDiffOptions(
        {
          format: "unified",
          text: [
            "--- a/src/value.ts",
            "+++ b/src/value.ts",
            "@@ -1,2 +1,2 @@",
            "-export const value = 1;",
            "+export const value = 2;",
            " export const stable = true;",
            "",
          ].join("\n"),
          filePath: "src/value.ts",
          filetype: "typescript",
        },
        theme,
        syntax,
        { availableColumns: 72, wrapMode: "word" },
      );
      setup.renderer.root.add(
        new DiffRenderable(setup.renderer, {
          ...options,
          id: "inline-diff",
          width: "100%",
          height: "100%",
        }),
      );

      await setup.renderOnce();
      const text = setup.captureCharFrame();
      expect(text).toContain("export const value = 1;");
      expect(text).toContain("export const value = 2;");
      expect(text).toMatch(/1.*export const value = 1;/);
      expect(text).toMatch(/1.*export const value = 2;/);
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      expect(spans.some((span) => span.bg.equals(theme.diff.addedBackground))).toBe(true);
      expect(spans.some((span) => span.bg.equals(theme.diff.removedBackground))).toBe(true);
    } finally {
      syntax.destroy();
      setup.renderer.destroy();
    }
  });
});
