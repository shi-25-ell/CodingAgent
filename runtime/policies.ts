import type { ModelFailure } from "../model/protocol.js";
import type { RuntimeCounts, RuntimeReason, RuntimeStatus } from "./runtime.js";

export interface StopPolicySnapshot {
  readonly counts: RuntimeCounts;
}

export type StopPolicyDecision =
  | { readonly stop: false }
  | {
      readonly stop: true;
      readonly status: RuntimeStatus;
      readonly reason: RuntimeReason;
      readonly unfinishedWork: readonly string[];
    };

export interface RunStopPolicy {
  evaluate(snapshot: StopPolicySnapshot): StopPolicyDecision;
}

export class NeverStopPolicy implements RunStopPolicy {
  public evaluate(_snapshot: StopPolicySnapshot): StopPolicyDecision {
    return { stop: false };
  }
}

export class FixedTurnLimitStopPolicy implements RunStopPolicy {
  public constructor(private readonly maximumModelTurns: number) {
    if (!Number.isSafeInteger(maximumModelTurns) || maximumModelTurns < 1) {
      throw new Error("maximumModelTurns must be a positive integer");
    }
  }

  public evaluate(snapshot: StopPolicySnapshot): StopPolicyDecision {
    if (snapshot.counts.modelTurns < this.maximumModelTurns) {
      return { stop: false };
    }
    return {
      stop: true,
      status: "limited",
      reason: "policy_limit",
      unfinishedWork: ["Run stopped by the configured Model Turn limit"],
    };
  }
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
}

export interface ModelRetryPolicy {
  decide(input: { readonly attempt: number; readonly failure: ModelFailure }): RetryDecision;
}

export class BoundedModelRetryPolicy implements ModelRetryPolicy {
  public constructor(
    private readonly maximumAttempts: number,
    private readonly delayForAttempt: (nextAttempt: number, failure: ModelFailure) => number,
  ) {
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
      throw new Error("maximumAttempts must be a positive integer");
    }
  }

  public decide(input: {
    readonly attempt: number;
    readonly failure: ModelFailure;
  }): RetryDecision {
    if (!input.failure.retryable || input.attempt >= this.maximumAttempts) {
      return { retry: false, delayMs: 0 };
    }
    const delayMs = this.delayForAttempt(input.attempt + 1, input.failure);
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error("retry delay must be a non-negative finite number");
    }
    return { retry: true, delayMs };
  }
}
