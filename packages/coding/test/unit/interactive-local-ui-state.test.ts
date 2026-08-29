import { describe, expect, it } from "bun:test";
import {
  createInteractiveLocalState,
  observeTranscriptGrowth,
  reduceInteractiveLocalState,
  type UiLocalIntent,
} from "../../src/modes/interactive/index.js";

function intent(value: Omit<UiLocalIntent, "version">): UiLocalIntent {
  return { version: 1, ...value } as UiLocalIntent;
}

describe("interactive local UI state", () => {
  it("只持有 presentation state，并以 composer 作为初始 focus", () => {
    const state = createInteractiveLocalState({ width: 80, height: 24 });

    expect(state).toMatchObject({
      version: 1,
      focusedRegion: "composer",
      composer: { value: "", revision: 0 },
      transcriptViewport: { scrollTop: 0, followTail: true, unseenBlockCount: 0 },
      terminal: { width: 80, height: 24 },
      sidebar: { preference: "auto", open: false },
    });
    expect(state.surfaceStack).toEqual([]);
    expect(state.expandedIds.size).toBe(0);
    expect(() => (state.expandedIds as Set<string>).add("escape")).toThrow();
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("sidebar preference 与 transient open 分别建模", () => {
    const initial = createInteractiveLocalState({ width: 160, height: 30 });
    const hidden = reduceInteractiveLocalState(
      initial,
      intent({ type: "set_sidebar_preference", preference: "hide" }),
    );
    const explicitlyOpen = reduceInteractiveLocalState(
      hidden,
      intent({ type: "set_sidebar_open", open: true }),
    );

    expect(hidden.sidebar).toEqual({ preference: "hide", open: false });
    expect(explicitlyOpen.sidebar).toEqual({ preference: "hide", open: true });
    expect(Object.isFrozen(explicitlyOpen.sidebar)).toBe(true);
  });

  it("composer/focus/expanded update 不写入 durable projection", () => {
    const initial = createInteractiveLocalState({ width: 80, height: 24 });
    const focused = reduceInteractiveLocalState(
      initial,
      intent({ type: "focus_region", region: "transcript" }),
    );
    const edited = reduceInteractiveLocalState(
      focused,
      intent({ type: "composer_changed", value: "检查工作树" }),
    );
    const expanded = reduceInteractiveLocalState(
      edited,
      intent({ type: "set_expanded", id: "tool:1", expanded: true }),
    );

    expect(expanded.focusedRegion).toBe("transcript");
    expect(expanded.composer).toEqual({ value: "检查工作树", revision: 1 });
    expect(expanded.expandedIds.has("tool:1")).toBe(true);
    expect(() => (expanded.expandedIds as Set<string>).delete("tool:1")).toThrow();
    expect(
      reduceInteractiveLocalState(
        expanded,
        intent({ type: "set_expanded", id: "tool:1", expanded: true }),
      ),
    ).toBe(expanded);
  });

  it("surface stack 以 semantic identity 去重并把重新打开项移到顶层", () => {
    let state = createInteractiveLocalState({ width: 120, height: 30 });
    state = reduceInteractiveLocalState(
      state,
      intent({ type: "open_surface", surface: { kind: "context" } }),
    );
    state = reduceInteractiveLocalState(
      state,
      intent({ type: "open_surface", surface: { kind: "diff", file: "src/a.ts" } }),
    );
    state = reduceInteractiveLocalState(
      state,
      intent({ type: "open_surface", surface: { kind: "context" } }),
    );

    expect(state.surfaceStack).toEqual([{ kind: "diff", file: "src/a.ts" }, { kind: "context" }]);
    state = reduceInteractiveLocalState(state, intent({ type: "close_surface" }));
    expect(state.surfaceStack).toEqual([{ kind: "diff", file: "src/a.ts" }]);
  });

  it("用户离开 tail 后累计新 block，重新 follow tail 时清零", () => {
    let state = createInteractiveLocalState({ width: 80, height: 24 });
    state = reduceInteractiveLocalState(
      state,
      intent({
        type: "transcript_viewport_changed",
        scrollTop: 4,
        followTail: false,
        anchorBlockId: "ledger:4",
      }),
    );
    state = observeTranscriptGrowth(state, 3);
    expect(state.transcriptViewport).toEqual({
      scrollTop: 4,
      followTail: false,
      anchorBlockId: "ledger:4",
      unseenBlockCount: 3,
    });

    state = reduceInteractiveLocalState(
      state,
      intent({ type: "transcript_viewport_changed", scrollTop: 9, followTail: true }),
    );
    expect(state.transcriptViewport.unseenBlockCount).toBe(0);
  });

  it("拒绝不可能的 terminal dimensions 与 scroll position", () => {
    expect(() => createInteractiveLocalState({ width: 0, height: 24 })).toThrow(/正整数/);
    const state = createInteractiveLocalState({ width: 80, height: 24 });
    expect(() =>
      reduceInteractiveLocalState(
        state,
        intent({ type: "terminal_resized", width: 80, height: -1 }),
      ),
    ).toThrow(/正整数/);
    expect(() =>
      reduceInteractiveLocalState(
        state,
        intent({ type: "transcript_viewport_changed", scrollTop: Number.NaN, followTail: false }),
      ),
    ).toThrow(/非负有限数/);
  });
});
