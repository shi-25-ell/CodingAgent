import type { RunPhase } from "../runtime/contracts.js";

const transitions: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
  created: ["preparing_context", "finalizing"],
  preparing_context: ["model_streaming", "finalizing"],
  model_streaming: ["preparing_context", "assistant_committing", "finalizing"],
  assistant_committing: ["tool_batch", "completion_candidate", "finalizing"],
  tool_batch: ["safe_point", "finalizing"],
  safe_point: ["preparing_context", "completion_candidate", "finalizing"],
  completion_candidate: ["preparing_context", "finalizing"],
  finalizing: ["terminal"],
  terminal: [],
};

export class RunStateMachine {
  #phase: RunPhase = "created";

  get phase(): RunPhase {
    return this.#phase;
  }

  transition(next: RunPhase): void {
    if (!transitions[this.#phase].includes(next)) {
      throw new Error(`非法 Run phase transition: ${this.#phase} -> ${next}`);
    }
    this.#phase = next;
  }
}
