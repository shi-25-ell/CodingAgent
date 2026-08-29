import { describe, expect, it } from "bun:test";
import { collectModelTurn, type ModelRequest, type ModelResponse } from "../../src/index.js";
import { ScriptedModel } from "../../src/testing/index.js";

const request: ModelRequest = {
  version: 1,
  instructions: [{ type: "text", text: "可靠地回答" }],
  messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
  tools: [],
  output: { maxTokens: 128 },
};

const response: ModelResponse = {
  version: 1,
  content: [{ type: "text", text: "你好。" }],
  finishReason: "stop",
  usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
};

describe("ScriptedModel Model contract", () => {
  it("严格按 FIFO 消费脚本并记录真实 request", async () => {
    const model = new ScriptedModel([
      {
        outcome: { status: "completed", response },
        assertRequest(actual) {
          expect(actual).toEqual(request);
        },
      },
    ]);

    const result = await collectModelTurn(
      model.stream(request, { signal: new AbortController().signal }),
    );

    expect(result).toEqual({ status: "completed", response });
    expect(model.requests()).toEqual([request]);
    expect(() => model.assertConsumed()).not.toThrow();
  });

  it("脚本欠消费和过消费都会显式失败", async () => {
    const model = new ScriptedModel([{ outcome: { status: "completed", response } }]);
    expect(() => model.assertConsumed()).toThrowError(
      expect.objectContaining({ code: "SCRIPT_STEPS_REMAIN" }),
    );

    await collectModelTurn(model.stream(request, { signal: new AbortController().signal }));
    const overConsumed = await collectModelTurn(
      model.stream(request, { signal: new AbortController().signal }),
    );
    expect(overConsumed).toEqual({
      status: "failed",
      failure: {
        category: "adapter_bug",
        retryable: false,
        message: "ScriptedModel 收到超出脚本的 Model Attempt",
      },
    });
  });
});
