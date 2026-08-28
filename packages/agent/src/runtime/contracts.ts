import type { ModelFailure, ModelResponse, ModelUsage } from "@coding-agent/model";
import type { RunId } from "../contracts/primitives.js";

export type RunStatus = "completed" | "aborted" | "failed" | "limited";
export type TerminationReason =
  | "natural_completion"
  | "user_abort"
  | "model_failure"
  | "model_output_limit"
  | "model_attempt_limit"
  | "invalid_model_response"
  | "persistence_failure";

export type RunPhase =
  | "created"
  | "preparing_context"
  | "model_streaming"
  | "assistant_committing"
  | "completion_candidate"
  | "finalizing"
  | "terminal";

export interface RunCounts {
  readonly modelTurnCount: number;
  readonly modelAttemptCount: number;
  readonly contextDerivationCount: number;
  readonly toolCallCount: number;
  readonly settledToolCallCount: number;
}

export interface UsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly attemptsWithUnknownUsage: number;
}

export interface ToolSummary {
  readonly accepted: number;
  readonly settled: number;
  readonly succeeded: number;
  readonly failed: number;
}

export interface PermissionSummary {
  readonly requested: number;
  readonly allowed: number;
  readonly denied: number;
}

export interface ChangedFileEvidence {
  readonly path: string;
  readonly change: "created" | "modified" | "deleted";
}

export interface CommandEvidence {
  readonly command: string;
  readonly exitCode?: number;
}

export interface RedactedErrorSummary {
  readonly code: string;
  readonly message: string;
}

export interface RunReport {
  readonly version: 1;
  readonly runId: RunId;
  readonly status: RunStatus;
  readonly terminationReason: TerminationReason;
  readonly finalAnswer?: string;
  readonly counts: RunCounts;
  readonly usage: UsageSummary;
  readonly tools: ToolSummary;
  readonly permissions: PermissionSummary;
  readonly changedFiles: readonly ChangedFileEvidence[];
  readonly commands: readonly CommandEvidence[];
  readonly unfinishedWork: readonly string[];
  readonly error?: RedactedErrorSummary;
  readonly lastPhase: RunPhase;
}

export interface RunBudgets {
  readonly maxModelTurns: number;
  readonly maxModelAttempts: number;
}

export interface RetryPolicyInput {
  readonly failure: ModelFailure;
  readonly modelTurnCount: number;
  readonly modelAttemptCount: number;
  readonly retriesInTurn: number;
}

export type RetryDecision = { readonly action: "retry" } | { readonly action: "fail" };

export interface ModelRetryPolicy {
  decide(input: RetryPolicyInput): Promise<RetryDecision>;
}

export interface StopPolicyInput {
  readonly response: ModelResponse;
  readonly counts: RunCounts;
}

export type StopDecision =
  | { readonly action: "complete" }
  | { readonly action: "limited"; readonly reason: "model_output_limit" };

export interface RunStopPolicy {
  evaluate(input: StopPolicyInput): Promise<StopDecision>;
}

export interface RunPolicies {
  readonly budgets: RunBudgets;
  readonly retryPolicy: ModelRetryPolicy;
  readonly stopPolicy: RunStopPolicy;
}

export interface AgentRunResult {
  readonly status: RunStatus;
  readonly terminationReason: TerminationReason;
  readonly finalAnswer?: string;
  readonly counts: RunCounts;
  readonly usage: UsageSummary;
  readonly unfinishedWork: readonly string[];
  readonly error?: RedactedErrorSummary;
}

export type AgentSemanticEvent =
  | { readonly type: "assistant_message"; readonly response: ModelResponse }
  | { readonly type: "model_failure"; readonly failure: ModelFailure };

export type AgentProgressEvent =
  | { readonly type: "phase_changed"; readonly phase: RunPhase }
  | {
      readonly type: "model_attempt_started";
      readonly modelTurnCount: number;
      readonly modelAttemptCount: number;
    };

export type AgentEvent = AgentProgressEvent | AgentSemanticEvent;

export function emptyUsageSummary(): UsageSummary {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, attemptsWithUnknownUsage: 0 };
}

export function addUsage(summary: UsageSummary, usage: ModelUsage | undefined): UsageSummary {
  if (!usage) return { ...summary, attemptsWithUnknownUsage: summary.attemptsWithUnknownUsage + 1 };
  return {
    inputTokens: summary.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: summary.outputTokens + (usage.outputTokens ?? 0),
    totalTokens: summary.totalTokens + (usage.totalTokens ?? 0),
    attemptsWithUnknownUsage: summary.attemptsWithUnknownUsage,
  };
}
