import { describe, expect, it } from "bun:test";
import { MarkdownRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  createOpenTuiMarkdownOptions,
  createOpenTuiSyntaxStyle,
  resolveInteractiveTheme,
  resolveOpenTuiTheme,
} from "../../src/modes/interactive/index.js";

describe("OpenTUI Markdown Unicode frame", () => {
  it("streaming update 与 resize 保留 CJK、emoji 和 combining text", async () => {
    const setup = await createTestRenderer({ width: 38, height: 12, useThread: false });
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const syntax = createOpenTuiSyntaxStyle(theme);
    try {
      const markdown = new MarkdownRenderable(setup.renderer, {
        ...createOpenTuiMarkdownOptions(theme, syntax, {
          content: "# 执行结果\n\n中文🙂 cafe\u0301",
          streaming: true,
        }),
        id: "assistant-markdown",
        width: "100%",
        height: "100%",
      });
      setup.renderer.root.add(markdown);

      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("执行结果");
      expect(setup.captureCharFrame()).toContain("中文🙂 café");
      markdown.content = "# 执行结果\n\n中文🙂 cafe\u0301\n\n**完成** 测试";
      await setup.flush({ maxPasses: 20 });
      expect(setup.captureCharFrame()).toContain("完成");
      expect(setup.captureCharFrame()).toContain("测试");

      setup.resize(24, 14);
      await setup.flush({ maxPasses: 20 });
      const resized = setup.captureCharFrame();
      expect(resized).toContain("中文🙂 café");
      expect(resized).not.toContain("�");
    } finally {
      syntax.destroy();
      setup.renderer.destroy();
    }
  });
});
