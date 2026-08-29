import { describe, expect, it } from "bun:test";
import {
  createOpenTuiCodeOptions,
  createOpenTuiDiffViewerOptions,
  createOpenTuiInlineDiffOptions,
  createOpenTuiMarkdownOptions,
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
  it("Markdown Adapter 使用 top-level streaming blocks 与完整 theme seam", () => {
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const syntax = createOpenTuiSyntaxStyle(theme);
    try {
      expect(
        createOpenTuiMarkdownOptions(theme, syntax, {
          content: "# 结果\n\n中文🙂 **完成**",
          streaming: true,
        }),
      ).toMatchObject({
        syntaxStyle: syntax,
        streaming: true,
        conceal: true,
        concealCode: true,
        internalBlockMode: "top-level",
        tableOptions: { style: "grid" },
      });
    } finally {
      syntax.destroy();
    }
  });

  it("Code Adapter 保留 filetype、streaming 与 wrap policy", () => {
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const syntax = createOpenTuiSyntaxStyle(theme);
    try {
      expect(
        createOpenTuiCodeOptions(theme, syntax, {
          content: "const value = '中文';",
          filetype: "typescript",
          streaming: false,
          wrapMode: "none",
        }),
      ).toMatchObject({
        syntaxStyle: syntax,
        filetype: "typescript",
        streaming: false,
        wrapMode: "none",
        drawUnstyledText: true,
      });
    } finally {
      syntax.destroy();
    }
  });

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

  it("dedicated Diff Adapter 使用 route layout、char wrap 与 reviewed semantic styling", () => {
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const syntax = createOpenTuiSyntaxStyle(theme);
    try {
      const options = createOpenTuiDiffViewerOptions(
        {
          path: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: evidence.text,
          filetype: "typescript",
        },
        theme,
        syntax,
        {
          layout: {
            fileTreeColumns: 32,
            patchColumns: 100,
            splitAvailable: true,
            view: "split",
          },
          reviewed: true,
        },
      );
      expect(options).toMatchObject({
        view: "split",
        filetype: "typescript",
        syntaxStyle: syntax,
        showLineNumbers: true,
        wrapMode: "char",
      });
      expect(options.addedBg).toBe(theme.colors.backgroundElement);
      expect(options.removedBg).toBe(theme.colors.backgroundElement);
      expect(options.addedSignColor).toBe(theme.colors.textMuted);
    } finally {
      syntax.destroy();
    }
  });
});
