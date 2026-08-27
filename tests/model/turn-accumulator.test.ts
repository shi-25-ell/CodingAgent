import { describe, expect, it } from "vitest";
import { ModelTurnAccumulator } from "../../model/turn-accumulator.js";

describe("ModelTurnAccumulator", () => {
  it("produces one complete assistant message from streamed text", () => {
    const accumulator = new ModelTurnAccumulator();

    accumulator.accept({ type: "turn_started", requestId: "req-1" });
    accumulator.accept({ type: "part_started", index: 0, part: { type: "text" } });
    accumulator.accept({ type: "text_delta", index: 0, delta: "hello " });
    accumulator.accept({ type: "text_delta", index: 0, delta: "world" });
    accumulator.accept({ type: "part_completed", index: 0 });
    accumulator.accept({
      type: "turn_completed",
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 2 },
    });

    expect(accumulator.result()).toEqual({
      type: "completed",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello world" }],
        finishReason: "stop",
      },
      usage: { inputTokens: 7, outputTokens: 2 },
      requestId: "req-1",
      invalidToolCalls: [],
    });
  });

  it("keeps invalid tool-call evidence out of executable assistant content", () => {
    const accumulator = new ModelTurnAccumulator();
    accumulator.accept({ type: "turn_started" });
    accumulator.accept({
      type: "part_started",
      index: 0,
      part: { type: "tool_call", callId: "call-1", name: "read_file" },
    });
    accumulator.accept({ type: "tool_call_delta", index: 0, delta: "{not json" });
    accumulator.accept({ type: "part_completed", index: 0 });
    accumulator.accept({ type: "turn_completed", finishReason: "tool_calls", usage: {} });

    expect(accumulator.result()).toEqual({
      type: "completed",
      message: { role: "assistant", content: [], finishReason: "tool_calls" },
      usage: {},
      invalidToolCalls: [
        {
          index: 0,
          callId: "call-1",
          name: "read_file",
          rawArguments: "{not json",
          reason: "invalid_json",
        },
      ],
    });
  });

  it("rejects deltas that do not belong to an open matching part", () => {
    const accumulator = new ModelTurnAccumulator();
    accumulator.accept({ type: "turn_started" });
    accumulator.accept({ type: "part_started", index: 0, part: { type: "text" } });

    expect(() =>
      accumulator.accept({ type: "reasoning_delta", index: 0, delta: "mismatch" }),
    ).toThrow("delta does not match an open reasoning part");
  });

  it("preserves a canonical model failure without inventing usage", () => {
    const accumulator = new ModelTurnAccumulator();
    accumulator.accept({ type: "turn_started", requestId: "req-failed" });
    accumulator.accept({
      type: "turn_failed",
      failure: { category: "authentication", retryable: false, message: "unauthorized" },
    });

    expect(accumulator.result()).toEqual({
      type: "failed",
      requestId: "req-failed",
      failure: { category: "authentication", retryable: false, message: "unauthorized" },
    });
  });

  it("requires one terminal event", () => {
    const accumulator = new ModelTurnAccumulator();
    accumulator.accept({ type: "turn_started" });

    expect(() => accumulator.result()).toThrow("without a terminal event");
  });
});
