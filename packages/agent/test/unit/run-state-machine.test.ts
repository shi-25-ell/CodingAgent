import { describe, expect, it } from "bun:test";
import { RunStateMachine } from "../../src/agent/run-state-machine.js";

describe("RunStateMachine", () => {
  it("只接受设计基线定义的 phase transition", () => {
    const state = new RunStateMachine();
    for (const phase of [
      "preparing_context",
      "model_streaming",
      "assistant_committing",
      "tool_batch",
      "safe_point",
      "preparing_context",
      "model_streaming",
      "assistant_committing",
      "completion_candidate",
      "finalizing",
      "terminal",
    ] as const) {
      state.transition(phase);
    }
    expect(state.phase).toBe("terminal");
  });

  it("拒绝非法、重复和 terminal 后 transition", () => {
    const direct = new RunStateMachine();
    expect(() => direct.transition("tool_batch")).toThrowError(/created.*tool_batch/);

    const duplicate = new RunStateMachine();
    duplicate.transition("preparing_context");
    expect(() => duplicate.transition("preparing_context")).toThrowError(
      /preparing_context.*preparing_context/,
    );

    const terminal = new RunStateMachine();
    terminal.transition("finalizing");
    terminal.transition("terminal");
    expect(() => terminal.transition("preparing_context")).toThrowError(
      /terminal.*preparing_context/,
    );
  });
});
