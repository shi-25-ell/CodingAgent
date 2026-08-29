import { describe, expect, it } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { resolveInteractiveTheme, resolveOpenTuiTheme } from "../../src/modes/interactive/index.js";

describe("OpenTUI themed frame", () => {
  it("真实 in-memory renderer 保留 frame text、surface 与 primary token", async () => {
    const setup = await createTestRenderer({ width: 32, height: 6, useThread: false });
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    try {
      const root = new BoxRenderable(setup.renderer, {
        id: "theme-frame-root",
        width: "100%",
        height: "100%",
        backgroundColor: theme.colors.background,
      });
      const panel = new BoxRenderable(setup.renderer, {
        id: "theme-frame-panel",
        width: "100%",
        height: 3,
        paddingLeft: 2,
        backgroundColor: theme.colors.backgroundPanel,
      });
      panel.add(
        new TextRenderable(setup.renderer, {
          id: "theme-frame-title",
          content: "Dex Code · ready",
          fg: theme.colors.primary,
          bg: theme.colors.backgroundPanel,
        }),
      );
      root.add(panel);
      setup.renderer.root.add(root);

      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("  Dex Code · ready");
      const frame = setup.captureSpans();
      const title = frame.lines
        .flatMap((line) => line.spans)
        .find((span) => span.text.includes("Dex Code"));
      expect(title?.fg.equals(theme.colors.primary)).toBe(true);
      expect(title?.bg.equals(theme.colors.backgroundPanel)).toBe(true);

      setup.resize(48, 8);
      await setup.renderOnce();
      expect(setup.captureSpans()).toMatchObject({ cols: 48, rows: 8 });
      expect(setup.captureCharFrame()).toContain("  Dex Code · ready");
    } finally {
      setup.renderer.destroy();
    }
  });
});
