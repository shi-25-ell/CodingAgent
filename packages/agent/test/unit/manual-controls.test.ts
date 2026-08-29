import { describe, expect, it } from "bun:test";
import { ManualClock, ManualGate, SequentialIdFactory } from "../../src/testing/index.js";

describe("deterministic controls", () => {
  it("manual clock 单调推进且拒绝回拨", () => {
    const clock = new ManualClock(10);
    expect(clock.now()).toBe(10);
    clock.advance(5);
    expect(clock.now()).toBe(15);
    expect(() => clock.advance(-1)).toThrowError(/不能为负/);
  });

  it("manual gate 可观察等待点并由 AbortSignal 释放", async () => {
    const gate = new ManualGate();
    const controller = new AbortController();
    const waiting = gate.wait(controller.signal);
    await gate.waitUntilBlocked();

    controller.abort("test abort");

    await expect(waiting).resolves.toBe("aborted");
    expect(gate.blockedCount()).toBe(0);
  });

  it("ID factory 按 scope 独立生成稳定 ID", () => {
    const ids = new SequentialIdFactory();
    expect([ids.next("run"), ids.next("run"), ids.next("session")]).toEqual([
      "run-1",
      "run-2",
      "session-1",
    ]);
  });
});
