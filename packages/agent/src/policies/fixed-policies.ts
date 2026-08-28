import type { RunPolicies } from "../runtime/contracts.js";

export interface FixedRunPolicyOptions {
  readonly maxModelTurns: number;
  readonly maxModelAttempts: number;
  readonly maxRetries: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} 必须是正整数`);
}

export function createFixedRunPolicies(options: FixedRunPolicyOptions): RunPolicies {
  positiveInteger(options.maxModelTurns, "maxModelTurns");
  positiveInteger(options.maxModelAttempts, "maxModelAttempts");
  if (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new TypeError("maxRetries 必须是非负整数");
  }
  return {
    budgets: {
      maxModelTurns: options.maxModelTurns,
      maxModelAttempts: options.maxModelAttempts,
    },
    retryPolicy: {
      async decide(input) {
        return input.failure.retryable &&
          !input.attemptProducedSemanticOutput &&
          input.retriesInTurn < options.maxRetries
          ? { action: "retry" }
          : { action: "fail" };
      },
    },
    stopPolicy: {
      async evaluate(input) {
        return input.response.finishReason === "length"
          ? { action: "limited", reason: "model_output_limit" }
          : { action: "complete" };
      },
    },
  };
}
