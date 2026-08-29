import { describe, expect, it } from "bun:test";
import {
  createOpenTuiInlineDiffOptions,
  createOpenTuiSyntaxStyle,
  resolveInteractiveTheme,
  resolveOpenTuiTheme,
} from "../../src/modes/interactive/index.js";

const evidence = {
  format: "unified" as const,
  text: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  filePath: "src/a.ts",
  filetype: "typescript",
};

describe("OpenTUI content Adapters", () => {
  it("inline mutation diff 启用 syntax、line numbers 与 semantic add/remove styling", () => {
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const syntax = createOpenTuiSyntaxStyle(theme);
    try {
      const options = createOpenTuiInlineDiffOptions(evidence, theme, syntax, {
        availableColumns: 100,
      });
      expect(options).toMatchObject({
        view: "unified",
        filetype: "typescript",
        syntaxStyle: syntax,
        showLineNumbers: true,
        wrapMode: "word",
      });
      expect(options.addedSignColor).toBe(theme.diff.added);
      expect(options.removedSignColor).toBe(theme.diff.removed);
      expect(options.addedBg).toBe(theme.diff.addedBackground);
      expect(options.removedBg).toBe(theme.diff.removedBackground);
    } finally {
      syntax.destroy();
    }
  });

  it("auto view 只在 inline region 自身宽于 120 时 split，stacked 可强制 unified", () => {
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const syntax = createOpenTuiSyntaxStyle(theme);
    try {
      expect(
        createOpenTuiInlineDiffOptions(evidence, theme, syntax, { availableColumns: 121 }).view,
      ).toBe("split");
      expect(
        createOpenTuiInlineDiffOptions(evidence, theme, syntax, {
          availableColumns: 160,
          viewPreference: "stacked",
        }).view,
      ).toBe("unified");
    } finally {
      syntax.destroy();
    }
  });
});
