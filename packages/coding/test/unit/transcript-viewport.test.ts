import { describe, expect, it } from "bun:test";
import {
  captureTranscriptViewport,
  restoreTranscriptViewport,
  type TranscriptLayoutMeasurement,
} from "../../src/modes/interactive/index.js";

const beforeResize: TranscriptLayoutMeasurement = {
  viewportRows: 10,
  contentRows: 30,
  blocks: [
    { id: "user:1", startRow: 0, endRow: 8 },
    { id: "tool:1", startRow: 8, endRow: 20 },
    { id: "assistant:1", startRow: 20, endRow: 30 },
  ],
};

describe("Transcript viewport Adapter", () => {
  it("离开 tail 时捕获 semantic block anchor 与 intra-block offset", () => {
    expect(captureTranscriptViewport(13, false, 2, beforeResize)).toEqual({
      scrollTop: 13,
      followTail: false,
      anchorBlockId: "tool:1",
      anchorOffsetRows: 5,
      unseenBlockCount: 2,
    });
  });

  it("resize/reflow 后使用 stable block id 恢复，而非复用旧 absolute row", () => {
    const captured = captureTranscriptViewport(13, false, 2, beforeResize);
    const afterResize: TranscriptLayoutMeasurement = {
      viewportRows: 8,
      contentRows: 45,
      blocks: [
        { id: "user:1", startRow: 0, endRow: 15 },
        { id: "tool:1", startRow: 15, endRow: 33 },
        { id: "assistant:1", startRow: 33, endRow: 45 },
      ],
    };

    expect(restoreTranscriptViewport(captured, afterResize)).toEqual({
      scrollTop: 20,
      followTail: false,
      anchorBlockId: "tool:1",
      anchorOffsetRows: 5,
      unseenBlockCount: 2,
    });
  });

  it("follow-tail 始终解析到最新 bottom，并清除 unseen/anchor", () => {
    const state = captureTranscriptViewport(0, true, 9, beforeResize);
    expect(state).toEqual({ scrollTop: 20, followTail: true, unseenBlockCount: 0 });

    expect(
      restoreTranscriptViewport(state, {
        ...beforeResize,
        contentRows: 40,
        blocks: [...beforeResize.blocks, { id: "tool:2", startRow: 30, endRow: 40 }],
      }),
    ).toEqual({ scrollTop: 30, followTail: true, unseenBlockCount: 0 });
  });

  it("anchor 消失时安全 clamp absolute fallback，不猜测相邻 message identity", () => {
    expect(
      restoreTranscriptViewport(
        {
          scrollTop: 25,
          followTail: false,
          anchorBlockId: "removed",
          anchorOffsetRows: 3,
          unseenBlockCount: 1,
        },
        beforeResize,
      ),
    ).toEqual({ scrollTop: 20, followTail: false, unseenBlockCount: 1 });
  });

  it("拒绝 duplicate/overlapping/out-of-bounds renderer measurement", () => {
    expect(() =>
      captureTranscriptViewport(0, false, 0, {
        viewportRows: 10,
        contentRows: 20,
        blocks: [
          { id: "a", startRow: 0, endRow: 12 },
          { id: "a", startRow: 10, endRow: 21 },
        ],
      }),
    ).toThrow();
  });
});
