import { describe, expect, it } from "bun:test";
import {
  ComposerHistory,
  ComposerSubmitGate,
  normalizeComposerPaste,
  prepareComposerPaste,
} from "../../src/modes/interactive/index.js";

describe("run-aware Composer policy", () => {
  it("统一 CRLF/CR，并只把大段 paste 的显示压缩为 placeholder", () => {
    expect(normalizeComposerPaste("a\r\nb\rc")).toBe("a\nb\nc");
    const paste = prepareComposerPaste("first\r\nsecond\rthird");
    expect(paste).toEqual({
      text: "first\nsecond\nthird",
      lineCount: 3,
      characterCount: 18,
      large: true,
      placeholder: "[Pasted 3 lines · 18 chars]",
    });
  });

  it("history 只在首尾 visual row 导航，并可恢复原 draft", () => {
    const history = new ComposerHistory(["first", "second"]);
    const middle = { visualRow: 1, visualLineCount: 3, hasSelection: false };
    const first = { visualRow: 0, visualLineCount: 3, hasSelection: false };
    const last = { visualRow: 2, visualLineCount: 3, hasSelection: false };

    expect(history.navigate("previous", "draft", middle)).toBeUndefined();
    expect(history.navigate("previous", "draft", first)).toBe("second");
    expect(history.navigate("previous", "second", first)).toBe("first");
    expect(history.navigate("next", "first", last)).toBe("second");
    expect(history.navigate("next", "second", last)).toBe("draft");
  });

  it("IME submit double defer 且 pending 期间拒绝重入", async () => {
    const deferred: Array<() => void> = [];
    const submitted: string[] = [];
    let text = "拼";
    const gate = new ComposerSubmitGate({ defer: (callback) => deferred.push(callback) });

    expect(
      gate.trigger(
        () => text,
        async (value) => {
          submitted.push(value);
        },
      ),
    ).toBe(true);
    expect(
      gate.trigger(
        () => text,
        async () => {},
      ),
    ).toBe(false);
    text = "拼音";
    deferred.shift()?.();
    expect(submitted).toEqual([]);
    deferred.shift()?.();
    await Promise.resolve();
    expect(submitted).toEqual(["拼音"]);
  });
});
