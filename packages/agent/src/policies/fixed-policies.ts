import type { RetryWaiter, RunPolicies } from "../runtime/contracts.js";

export interface FixedRunPolicyOptions {
  readonly maxModelTurns: number;
  readonly maxModelAttempts: number;
  readonly maxRetries: number;
  readonly retryDelayMs?: number;
  readonly retryWaiter?: RetryWaiter;
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
  const retryDelayMs = options.retryDelayMs ?? 0;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError("retryDelayMs 必须是非负安全整数");
  }
  const retryWaiter: RetryWaiter = options.retryWaiter ?? {
    wait(delayMs, signal) {
      if (signal.aborted) return Promise.resolve("aborted");
      if (delayMs === 0) return Promise.resolve("elapsed");
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve("elapsed");
        }, delayMs);
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          resolve("aborted");
        };
        signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
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
          ? { action: "retry", delayMs: retryDelayMs }
          : { action: "fail" };
      },
    },
    retryWaiter,
    stopPolicy: {
      async evaluate(input) {
        return input.response.finishReason === "length"
          ? { action: "limited", reason: "model_output_limit" }
          : { action: "complete" };
      },
    },
  };
}
