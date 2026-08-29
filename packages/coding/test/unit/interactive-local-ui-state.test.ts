import { describe, expect, it } from "bun:test";
import {
  createInteractiveLocalState,
  observeTranscriptGrowth,
  reconcilePendingApproval,
  reduceInteractiveLocalState,
  type UiLocalIntent,
} from "../../src/modes/interactive/index.js";

type IntentWithoutVersion = UiLocalIntent extends infer T
  ? T extends UiLocalIntent
    ? Omit<T, "version">
    : never
  : never;

function intent(value: IntentWithoutVersion): UiLocalIntent {
  return { version: 1, ...value } as UiLocalIntent;
}

describe("interactive local UI state", () => {
  it("只持有 presentation state，并以 composer 作为初始 focus", () => {
    const state = createInteractiveLocalState({ width: 80, height: 24 });

    expect(state).toMatchObject({
      version: 1,
      focusedRegion: "composer",
      composer: { value: "", revision: 0, deliveryMode: "steering" },
      transcriptViewport: { scrollTop: 0, followTail: true, unseenBlockCount: 0 },
      terminal: { width: 80, height: 24 },
      sidebar: { preference: "auto", open: false },
      themeId: "dex",
      toolDisplay: { showDetails: true, showGenericOutput: false },
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

  it("theme selection 是 UI-local preference", () => {
    const initial = createInteractiveLocalState({ width: 80, height: 24 });
    const system = reduceInteractiveLocalState(
      initial,
      intent({ type: "select_theme", themeId: "system" }),
    );

    expect(system.themeId).toBe("system");
    expect(
      reduceInteractiveLocalState(system, intent({ type: "select_theme", themeId: "system" })),
    ).toBe(system);
  });

  it("tool detail 与 generic output visibility 是 UI-local preference", () => {
    const initial = createInteractiveLocalState({ width: 80, height: 24 });
    const hidden = reduceInteractiveLocalState(
      initial,
      intent({ type: "set_tool_details_visible", visible: false }),
    );
    const generic = reduceInteractiveLocalState(
      hidden,
      intent({ type: "set_generic_tool_output_visible", visible: true }),
    );

    expect(generic.toolDisplay).toEqual({ showDetails: false, showGenericOutput: true });
    expect(Object.isFrozen(generic.toolDisplay)).toBe(true);
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
    expect(expanded.composer).toEqual({
      value: "检查工作树",
      revision: 1,
      deliveryMode: "steering",
    });
    expect(expanded.expandedIds.has("tool:1")).toBe(true);
    expect(() => (expanded.expandedIds as Set<string>).delete("tool:1")).toThrow();
    expect(
      reduceInteractiveLocalState(
        expanded,
        intent({ type: "set_expanded", id: "tool:1", expanded: true }),
      ),
    ).toBe(expanded);
  });

  it("切换 STEER/FOLLOW-UP 只改变 footer mode，不改变 draft identity", () => {
    const edited = reduceInteractiveLocalState(
      createInteractiveLocalState({ width: 80, height: 24 }),
      intent({ type: "composer_changed", value: "保留 draft" }),
    );
    const followUp = reduceInteractiveLocalState(
      edited,
      intent({ type: "set_composer_delivery", delivery: "follow_up" }),
    );

    expect(followUp.composer).toEqual({
      value: "保留 draft",
      revision: edited.composer.revision,
      deliveryMode: "follow_up",
    });
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

  it("pending approval 临时取得 focus、保留 draft，并按 FIFO identity 恢复", () => {
    let state = createInteractiveLocalState({ width: 80, height: 24 });
    state = reduceInteractiveLocalState(
      state,
      intent({ type: "composer_changed", value: "不要丢失" }),
    );
    const pending = (approvalId: string) => ({
      approvalId,
      callId: `call-${approvalId}`,
      decisions: ["allow_once", "deny"] as const,
      status: "pending" as const,
      plan: {
        callId: `call-${approvalId}`,
        toolName: "shell",
        resources: [],
        effects: ["process"] as const,
        risks: ["process"],
        fingerprint: `fingerprint-${approvalId}`,
      },
    });

    state = reconcilePendingApproval(state, [pending("one"), pending("two")]);
    expect(state).toMatchObject({
      focusedRegion: "approval",
      composer: { value: "不要丢失", revision: 1 },
      approvalPrompt: {
        approvalId: "one",
        selectedDecision: "allow_once",
        fullscreen: false,
        returnFocus: "composer",
      },
      surfaceStack: [{ kind: "approval", id: "one" }],
    });
    expect(
      reduceInteractiveLocalState(state, intent({ type: "composer_changed", value: "leak" })),
    ).toBe(state);
    expect(
      reduceInteractiveLocalState(state, intent({ type: "focus_region", region: "composer" })),
    ).toBe(state);

    state = reduceInteractiveLocalState(
      state,
      intent({ type: "set_approval_selection", approvalId: "one", decision: "deny" }),
    );
    state = reduceInteractiveLocalState(
      state,
      intent({ type: "set_approval_fullscreen", approvalId: "one", fullscreen: true }),
    );
    expect(state.approvalPrompt).toMatchObject({ selectedDecision: "deny", fullscreen: true });

    state = reconcilePendingApproval(state, [pending("two")]);
    expect(state.approvalPrompt).toMatchObject({
      approvalId: "two",
      selectedDecision: "allow_once",
      fullscreen: false,
      returnFocus: "composer",
    });
    state = reconcilePendingApproval(state, []);
    expect(state.focusedRegion).toBe("composer");
    expect(state.approvalPrompt).toBeUndefined();
    expect(state.composer.value).toBe("不要丢失");
    expect(state.surfaceStack).toEqual([]);
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
