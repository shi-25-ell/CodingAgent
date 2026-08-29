import { describe, expect, it } from "bun:test";
import {
  createOpenTuiSyntaxStyle,
  resolveInteractiveTheme,
  resolveOpenTuiTheme,
  toOpenTuiColor,
} from "../../src/modes/interactive/index.js";

describe("OpenTUI theme Adapter", () => {
  it("只在 presentation seam 把 token 转为 RGBA", () => {
    const tokens = resolveInteractiveTheme({ mode: "dark" });
    const theme = resolveOpenTuiTheme(tokens);

    expect(theme.colors.primary.toInts()).toEqual([111, 159, 221, 255]);
    expect(theme.colors.background.toInts()).toEqual([12, 14, 17, 255]);
    expect(theme.markdown.heading.equals(theme.colors.accent)).toBe(true);
    expect(theme.diff.added.equals(theme.colors.success)).toBe(true);
    expect(Object.isFrozen(theme.colors)).toBe(true);
  });

  it("system none token 转为透明 default-inheritance color", () => {
    expect(toOpenTuiColor("none").toInts()).toEqual([0, 0, 0, 0]);
    const system = resolveOpenTuiTheme(
      resolveInteractiveTheme({ themeId: "system", mode: "dark" }),
    );
    expect(system.colors.background.a).toBe(0);
    expect(system.colors.text.a).toBe(0);
  });

  it("syntax Adapter 注册稳定 semantic scopes，并明确释放 native resource", () => {
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const syntax = createOpenTuiSyntaxStyle(theme);
    try {
      expect(syntax.getRegisteredNames()).toEqual(
        expect.arrayContaining([
          "comment",
          "keyword",
          "function",
          "string",
          "type",
          "markup.heading",
          "markup.link",
          "diff.plus",
        ]),
      );
      expect(syntax.getStyle("keyword")?.fg?.equals(theme.syntax.keyword)).toBe(true);
      expect(syntax.getStyle("markup.heading")?.fg?.equals(theme.markdown.heading)).toBe(true);
    } finally {
      syntax.destroy();
    }
  });
});
