import { describe, expect, it } from "bun:test";
import type { TerminalCapabilities } from "@opentui/core";
import {
  asciiPresentationGlyphs,
  presentationGlyphs,
  resolveTerminalPresentationCapabilities,
  unicodePresentationGlyphs,
} from "../../src/modes/interactive/index.js";

const capabilities = {
  kitty_keyboard: true,
  rgb: true,
  ansi256: true,
  bracketed_paste: true,
  focus_tracking: true,
  hyperlinks: true,
} as TerminalCapabilities;

describe("terminal presentation capability resolver", () => {
  it("TTY capability 优先选择 truecolor/Unicode 与可用 interaction", () => {
    expect(
      resolveTerminalPresentationCapabilities({
        isTty: true,
        term: "xterm-256color",
        capabilities,
      }),
    ).toEqual({
      colorLevel: "truecolor",
      glyphMode: "unicode",
      mouse: true,
      bracketedPaste: true,
      focusTracking: true,
      hyperlinks: true,
    });
  });

  it("NO_COLOR 与 ASCII 是正交 capability，不改变 input support", () => {
    expect(
      resolveTerminalPresentationCapabilities({
        isTty: true,
        noColor: true,
        forceAscii: true,
        capabilities,
      }),
    ).toEqual({
      colorLevel: "none",
      glyphMode: "ascii",
      mouse: true,
      bracketedPaste: true,
      focusTracking: true,
      hyperlinks: true,
    });
  });

  it("redirected/dumb terminal 使用无颜色与 ASCII 安全降级", () => {
    expect(
      resolveTerminalPresentationCapabilities({ isTty: false, term: "dumb", capabilities }),
    ).toEqual({
      colorLevel: "none",
      glyphMode: "ascii",
      mouse: false,
      bracketedPaste: false,
      focusTracking: false,
      hyperlinks: false,
    });
  });

  it("glyph table 不把 semantic meaning 仅编码在 Unicode 字符中", () => {
    expect(presentationGlyphs("unicode")).toBe(unicodePresentationGlyphs);
    expect(presentationGlyphs("ascii")).toBe(asciiPresentationGlyphs);
    expect(asciiPresentationGlyphs).toMatchObject({
      check: "OK",
      failure: "X",
      pending: "...",
      expanded: "v",
      collapsed: ">",
    });
    expect(
      Object.values(asciiPresentationGlyphs).every((glyph) => /^[\x20-\x7e]+$/.test(glyph)),
    ).toBe(true);
  });
});
