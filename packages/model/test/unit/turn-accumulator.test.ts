import { describe, expect, it } from "vitest";
import {
  type ModelEvent,
  type ModelProtocolErrorCode,
  type ModelResponse,
  ModelTurnAccumulator,
} from "../../src/index.js";

const completedResponse: ModelResponse = {
  version: 1,
  content: [
    { type: "text", text: "完成" },
    { type: "tool_call", callId: "call-1", name: "read_file", arguments: { path: "a.ts" } },
  ],
  finishReason: "tool_calls",
  usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
};

describe("ModelTurnAccumulator", () => {
  it("只在完整且有序的事件流结束后产生 canonical response", () => {
    const accumulator = new ModelTurnAccumulator();
    const events: readonly ModelEvent[] = [
      { type: "turn_started", attemptId: "attempt-1" },
      { type: "part_started", index: 0, part: { type: "text" } },
      { type: "text_delta", index: 0, delta: "完" },
      { type: "text_delta", index: 0, delta: "成" },
      { type: "part_completed", index: 0 },
      {
        type: "part_started",
        index: 1,
        part: { type: "tool_call", callId: "call-1", name: "read_file" },
      },
      { type: "tool_call_delta", index: 1, delta: { argumentsDelta: '{"path":' } },
      { type: "tool_call_delta", index: 1, delta: { argumentsDelta: '"a.ts"}' } },
      { type: "part_completed", index: 1 },
      { type: "turn_completed", response: completedResponse },
    ];

    for (const event of events) accumulator.accept(event);

    expect(accumulator.result()).toEqual({ status: "completed", response: completedResponse });
  });

  it.each([
    {
      name: "part 尚未开始就收到 delta",
      events: [
        { type: "turn_started", attemptId: "attempt-1" },
        { type: "text_delta", index: 0, delta: "x" },
      ] satisfies readonly ModelEvent[],
      code: "MODEL_EVENT_PART_NOT_ACTIVE",
    },
    {
      name: "tool arguments 在 part 完成时仍不是合法 JSON object",
      events: [
        { type: "turn_started", attemptId: "attempt-1" },
        {
          type: "part_started",
          index: 0,
          part: { type: "tool_call", callId: "call-1", name: "read_file" },
        },
        { type: "tool_call_delta", index: 0, delta: { argumentsDelta: "{" } },
        { type: "part_completed", index: 0 },
      ] satisfies readonly ModelEvent[],
      code: "MODEL_TOOL_ARGUMENTS_INVALID",
    },
  ])("拒绝非法事件语法：$name", ({ events, code }) => {
    const accumulator = new ModelTurnAccumulator();
    expect(() => {
      for (const event of events) accumulator.accept(event);
    }).toThrowError(expect.objectContaining({ code: code as ModelProtocolErrorCode }));
  });

  it("拒绝第二个 terminal event", () => {
    const accumulator = new ModelTurnAccumulator();
    accumulator.accept({ type: "turn_started", attemptId: "attempt-1" });
    accumulator.accept({
      type: "turn_failed",
      failure: { category: "network", retryable: true, message: "连接中断" },
    });

    expect(() =>
      accumulator.accept({
        type: "turn_failed",
        failure: { category: "adapter_bug", retryable: false, message: "late" },
      }),
    ).toThrowError(expect.objectContaining({ code: "MODEL_EVENT_AFTER_TERMINAL" }));
  });
});
