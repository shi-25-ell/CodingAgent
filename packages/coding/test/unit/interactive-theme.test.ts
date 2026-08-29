import { describe, expect, it } from "bun:test";
import {
  detectTerminalThemeMode,
  interactiveSpacingTokens,
  resolveInteractiveTheme,
  themeContrastRatio,
} from "../../src/modes/interactive/index.js";

describe("interactive theme resolver", () => {
  it("默认 dex theme 使用自有 opaque palette，terminal 只决定 dark/light variant", () => {
    const dark = resolveInteractiveTheme({
      terminal: { defaultBackground: "#050505", palette: ["#ff0000"] },
    });
    const alternateDarkTerminal = resolveInteractiveTheme({
      terminal: { defaultBackground: "#202020", palette: ["#00ff00"] },
    });
    const light = resolveInteractiveTheme({
      terminal: { defaultBackground: "#f8f8f8", palette: ["#ff00ff"] },
    });

    expect(dark).toMatchObject({ id: "dex", mode: "dark", usesTerminalDefaults: false });
    expect(dark.colors.background).not.toBe("none");
    expect(dark.colors.text).not.toBe("none");
    expect(alternateDarkTerminal.colors).toEqual(dark.colors);
    expect(light).toMatchObject({ id: "dex", mode: "light", usesTerminalDefaults: false });
    expect(light.colors).not.toEqual(dark.colors);
  });

  it("dex palette 是 neutral surfaces + blue/green/light-purple semantic identity", () => {
    const theme = resolveInteractiveTheme({ mode: "dark" });

    expect(theme.colors).toMatchObject({
      primary: "#6f9fdd",
      secondary: "#70b88b",
      accent: "#ad96d4",
      background: "#0c0e11",
      backgroundPanel: "#12151a",
      backgroundElement: "#191d23",
    });
    expect(theme.colors.success).toBe(theme.colors.secondary);
    expect(theme.colors.focus).toBe(theme.colors.primary);
    expect(theme.diff.added).toBe(theme.colors.success);
    expect(theme.diff.removed).toBe(theme.colors.error);
    expect(theme.markdown.heading).toBe(theme.colors.accent);
    expect(theme.syntax.string).toBe(theme.colors.secondary);
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme.syntax)).toBe(true);
  });

  it.each(["dark", "light"] as const)("dex %s 正文与选中态满足可读对比", (mode) => {
    const theme = resolveInteractiveTheme({ mode });
    if (
      theme.colors.text === "none" ||
      theme.colors.background === "none" ||
      theme.colors.selectedText === "none" ||
      theme.colors.backgroundSelection === "none"
    ) {
      throw new Error("dex theme 不得使用 terminal default color");
    }

    expect(themeContrastRatio(theme.colors.text, theme.colors.background)).toBeGreaterThanOrEqual(
      7,
    );
    expect(
      themeContrastRatio(theme.colors.selectedText, theme.colors.backgroundSelection),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("system 是显式可选 theme，foreground/background 使用 terminal default", () => {
    const terminal = {
      defaultForeground: "#dedede" as const,
      defaultBackground: "#101010" as const,
      palette: [
        "#101010",
        "#c05050",
        "#50a060",
        "#b09040",
        "#406fa8",
        "#805ca0",
        "#408f9a",
        "#dedede",
        "#606060",
        "#e07070",
        "#70c080",
        "#d0b060",
        "#6090d0",
        "#a080c0",
        "#60b0c0",
      ] as const,
    };
    const system = resolveInteractiveTheme({ themeId: "system", terminal });

    expect(system).toMatchObject({ id: "system", mode: "dark", usesTerminalDefaults: true });
    expect(system.colors.background).toBe("none");
    expect(system.colors.text).toBe("none");
    expect(system.colors.primary).toBe(terminal.palette[12]);
    expect(system.colors.secondary).toBe(terminal.palette[10]);
    expect(system.colors.accent).toBe(terminal.palette[13]);
    expect(system.colors.backgroundPanel).not.toBe("none");
  });

  it("mode detection 缺少 terminal background 时不伪造 capability", () => {
    expect(detectTerminalThemeMode(undefined)).toBeUndefined();
    expect(detectTerminalThemeMode({ defaultBackground: "#000000" })).toBe("dark");
    expect(detectTerminalThemeMode({ defaultBackground: "#ffffff" })).toBe("light");
  });

  it("spacing token 集中且 immutable", () => {
    expect(interactiveSpacingTokens).toEqual({ none: 0, compact: 1, regular: 2, section: 3 });
    expect(Object.isFrozen(interactiveSpacingTokens)).toBe(true);
  });
});
