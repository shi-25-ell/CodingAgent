import { describe, expect, it } from "bun:test";
import {
  interactiveLayoutBreakpoints,
  resolveInteractiveLayout,
} from "../../src/modes/interactive/index.js";

describe("Transcript-first responsive layout policy", () => {
  it.each([
    [40, "narrow"],
    [71, "narrow"],
    [72, "regular"],
    [80, "regular"],
    [119, "regular"],
    [120, "regular"],
    [121, "wide"],
    [160, "wide"],
  ] as const)("%i columns -> %s transcript root", (width, widthClass) => {
    expect(resolveInteractiveLayout(width, 30)).toMatchObject({
      width,
      widthClass,
      primaryRegion: "transcript",
    });
  });

  it("width classification 不自行创建第二 workspace", () => {
    expect(resolveInteractiveLayout(240, 30)).not.toHaveProperty("contextualPanel");
    expect(resolveInteractiveLayout(240, 30)).not.toHaveProperty("secondaryUiDefault");
  });

  it.each([
    [80, 76],
    [120, 116],
  ] as const)("%i columns 默认保持 stretch Transcript", (width, mainColumns) => {
    expect(resolveInteractiveLayout(width, 30)).toMatchObject({
      horizontalPaddingColumns: 2,
      mainColumns,
      sidebar: {
        visible: false,
        placement: "closed",
        columns: 0,
        preference: "auto",
        explicitlyOpen: false,
      },
    });
  });

  it.each([
    [121, 75],
    [160, 114],
  ] as const)("%i columns 按 V1-A 自动 dock lightweight sidebar", (width, mainColumns) => {
    expect(resolveInteractiveLayout(width, 30)).toMatchObject({
      mainColumns,
      sidebar: {
        visible: true,
        placement: "docked",
        columns: 42,
        preference: "auto",
        explicitlyOpen: false,
      },
    });
  });

  it.each([
    [40, 36, 36],
    [80, 76, 42],
  ] as const)("%i columns 主动打开 sidebar 使用 overlay", (width, mainColumns, sidebarColumns) => {
    expect(resolveInteractiveLayout(width, 30, { preference: "auto", open: true })).toMatchObject({
      mainColumns,
      sidebar: {
        visible: true,
        placement: "overlay",
        columns: sidebarColumns,
        explicitlyOpen: true,
      },
    });
  });

  it("hide 关闭宽屏自动 dock，但不覆盖用户当前的显式打开", () => {
    expect(resolveInteractiveLayout(160, 30, { preference: "hide", open: false })).toMatchObject({
      mainColumns: 156,
      sidebar: { visible: false, placement: "closed", preference: "hide" },
    });
    expect(resolveInteractiveLayout(160, 30, { preference: "hide", open: true })).toMatchObject({
      mainColumns: 114,
      sidebar: {
        visible: true,
        placement: "docked",
        preference: "hide",
        explicitlyOpen: true,
      },
    });
  });

  it.each([
    [8, "constrained", 0, 1, 3],
    [12, "compact", 1, 2, 5],
    [19, "compact", 1, 2, 5],
    [20, "comfortable", 1, 3, 8],
  ] as const)(
    "%i rows -> %s degradation",
    (height, heightClass, statusRows, composerMin, composerMax) => {
      const layout = resolveInteractiveLayout(120, height);
      expect(layout).toMatchObject({
        heightClass,
        statusRows,
        composer: { minRows: composerMin, maxRows: composerMax, footerRows: 1 },
      });
      expect(layout.primaryRegion).toBe("transcript");
    },
  );

  it("breakpoints 是集中式 immutable policy", () => {
    expect(interactiveLayoutBreakpoints).toEqual({
      regularColumns: 72,
      wideColumns: 121,
      compactRows: 20,
      constrainedRows: 12,
      horizontalPaddingColumns: 2,
      sidebarColumns: 42,
    });
    expect(Object.isFrozen(interactiveLayoutBreakpoints)).toBe(true);
    expect(() => resolveInteractiveLayout(0, 10)).toThrow(/正整数/);
  });
});
