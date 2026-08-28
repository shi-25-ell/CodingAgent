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
  it("归约 fragmented reasoning 与 multiple tool calls，允许 missing usage", () => {
    const response: ModelResponse = {
      version: 1,
      content: [
        { type: "reasoning", text: "分析" },
        { type: "tool_call", callId: "one", name: "read_file", arguments: { path: "a" } },
        { type: "tool_call", callId: "two", name: "read_file", arguments: { path: "b" } },
      ],
      finishReason: "tool_calls",
    };
    const accumulator = new ModelTurnAccumulator();
    const events: readonly ModelEvent[] = [
      { version: 1, type: "turn_started", attemptId: "attempt" },
      { version: 1, type: "part_started", index: 0, part: { type: "reasoning" } },
      { version: 1, type: "reasoning_delta", index: 0, delta: "分" },
      { version: 1, type: "reasoning_delta", index: 0, delta: "析" },
      { version: 1, type: "part_completed", index: 0 },
      {
        version: 1,
        type: "part_started",
        index: 1,
        part: { type: "tool_call", callId: "one", name: "read_file" },
      },
      { version: 1, type: "tool_call_delta", index: 1, delta: { argumentsDelta: '{"path":"a"}' } },
      { version: 1, type: "part_completed", index: 1 },
      {
        version: 1,
        type: "part_started",
        index: 2,
        part: { type: "tool_call", callId: "two", name: "read_file" },
      },
      { version: 1, type: "tool_call_delta", index: 2, delta: { argumentsDelta: '{"path":"b"}' } },
      { version: 1, type: "part_completed", index: 2 },
      { version: 1, type: "turn_completed", response },
    ];
    for (const event of events) accumulator.accept(event);
    expect(accumulator.result()).toEqual({ status: "completed", response });
  });

  it("只在完整且有序的事件流结束后产生 canonical response", () => {
    const accumulator = new ModelTurnAccumulator();
    const events: readonly ModelEvent[] = [
      { version: 1, type: "turn_started", attemptId: "attempt-1" },
      { version: 1, type: "part_started", index: 0, part: { type: "text" } },
      { version: 1, type: "text_delta", index: 0, delta: "完" },
      { version: 1, type: "text_delta", index: 0, delta: "成" },
      { version: 1, type: "part_completed", index: 0 },
      {
        version: 1,
        type: "part_started",
        index: 1,
        part: { type: "tool_call", callId: "call-1", name: "read_file" },
      },
      { version: 1, type: "tool_call_delta", index: 1, delta: { argumentsDelta: '{"path":' } },
      { version: 1, type: "tool_call_delta", index: 1, delta: { argumentsDelta: '"a.ts"}' } },
      { version: 1, type: "part_completed", index: 1 },
      { version: 1, type: "turn_completed", response: completedResponse },
    ];

    for (const event of events) accumulator.accept(event);

    expect(accumulator.result()).toEqual({ status: "completed", response: completedResponse });
  });

  it.each([
    {
      name: "part 尚未开始就收到 delta",
      events: [
        { version: 1, type: "turn_started", attemptId: "attempt-1" },
        { version: 1, type: "text_delta", index: 0, delta: "x" },
      ] satisfies readonly ModelEvent[],
      code: "MODEL_EVENT_PART_NOT_ACTIVE",
    },
    {
      name: "tool arguments 在 part 完成时仍不是合法 JSON object",
      events: [
        { version: 1, type: "turn_started", attemptId: "attempt-1" },
        {
          version: 1,
          type: "part_started",
          index: 0,
          part: { type: "tool_call", callId: "call-1", name: "read_file" },
        },
        { version: 1, type: "tool_call_delta", index: 0, delta: { argumentsDelta: "{" } },
        { version: 1, type: "part_completed", index: 0 },
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
    accumulator.accept({ version: 1, type: "turn_started", attemptId: "attempt-1" });
    accumulator.accept({
      version: 1,
      type: "turn_failed",
      failure: { category: "network", retryable: true, message: "连接中断" },
    });

    expect(() =>
      accumulator.accept({
        version: 1,
        type: "turn_failed",
        failure: { category: "adapter_bug", retryable: false, message: "late" },
      }),
    ).toThrowError(expect.objectContaining({ code: "MODEL_EVENT_AFTER_TERMINAL" }));
  });
});
