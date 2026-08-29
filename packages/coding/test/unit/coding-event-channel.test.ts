import { describe, expect, it } from "bun:test";
import { runId } from "@coding-agent/agent";
import { CodingEventChannel } from "../../src/app/coding-event-channel.js";

async function collect<T>(values: AsyncIterable<T>): Promise<readonly T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe("CodingEventChannel", () => {
  it("semantic 可重复订阅且不丢失，progress 按 key 有界合并", async () => {
    const channel = new CodingEventChannel(runId("run-stream"), { maximumProgressKeys: 2 });
    const first = channel.events();
    const second = channel.events({ semanticSequence: 1 });
    channel.publishSemantic({ type: "user_accepted", text: "one" });
    channel.publishProgress({ key: "phase", type: "phase_changed", phase: "preparing_context" });
    channel.publishProgress({ key: "phase", type: "phase_changed", phase: "model_streaming" });
    channel.publishProgress({
      key: "assistant:1",
      type: "assistant_delta",
      modelTurnCount: 1,
      modelAttemptCount: 1,
      partIndex: 0,
      channel: "text",
      delta: "latest",
    });
    channel.publishProgress({
      key: "tool:1",
      type: "tool_update",
      callId: "call-1",
      update: { version: 1, type: "progress", message: "running" },
    });
    channel.publishSemantic({ type: "user_accepted", text: "two" });
    channel.close();

    const [left, right] = await Promise.all([collect(first), collect(second)]);
    expect(
      left.filter((event) => event.category === "semantic").map((event) => event.sequence),
    ).toEqual([1, 2]);
    expect(
      right.filter((event) => event.category === "semantic").map((event) => event.sequence),
    ).toEqual([2]);
    expect(left.filter((event) => event.category === "progress")).toHaveLength(2);
    expect(channel.diagnostics()).toMatchObject({
      pendingProgressCount: 2,
      evictedProgressCount: 1,
      subscriberCount: 0,
      closed: true,
    });
  });

  it("pending subscriber 可 dispose，不需要 publish、sleep 或关闭 channel", async () => {
    const channel = new CodingEventChannel(runId("run-dispose"));
    const iterator = channel.events()[Symbol.asyncIterator]();
    const pending = iterator.next();
    expect(channel.diagnostics().subscriberCount).toBe(1);
    await iterator.return?.();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(channel.diagnostics().subscriberCount).toBe(0);
  });
});
