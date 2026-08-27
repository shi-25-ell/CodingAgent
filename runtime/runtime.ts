import type {
  AssistantMessage,
  ModelAdapter,
  ModelFailure,
  ModelMessage,
  ModelUsage,
} from "../model/protocol.js";
import type { InvalidToolCall } from "../model/turn-accumulator.js";
import type { ModelRetryPolicy, RunStopPolicy } from "./policies.js";
import type { ToolPort } from "./tool-port.js";

export type RunPhase =
  | "starting"
  | "preparing_turn"
  | "model_streaming"
  | "assistant_committing"
  | "tool_batch"
  | "safe_point"
  | "completion_candidate";

export type RuntimeStatus = "completed" | "aborted" | "failed" | "limited";

export type RuntimeReason =
  | "no_tool_calls"
  | "user_abort"
  | "policy_limit"
  | "model_error"
  | "output_truncated"
  | "stream_truncated"
  | "invalid_output"
  | "tool_host_failure"
  | "persistence_error"
  | "runtime_invariant";

export interface RuntimeCounts {
  readonly modelTurns: number;
  readonly modelAttempts: number;
  readonly toolCalls: number;
  readonly completedToolCalls: number;
}

export type RuntimeSemanticEvent =
  | { readonly type: "phase_changed"; readonly phase: RunPhase }
  | { readonly type: "model_attempt_started"; readonly attempt: number }
  | {
      readonly type: "model_attempt_failed";
      readonly attempt: number;
      readonly failure: ModelFailure;
      readonly requestId?: string;
    }
  | { readonly type: "model_retry_scheduled"; readonly delayMs: number }
  | {
      readonly type: "assistant_committed";
      readonly message: AssistantMessage;
      readonly usage: ModelUsage;
      readonly invalidToolCalls: readonly InvalidToolCall[];
    }
  | {
      readonly type: "terminal";
      readonly status: RuntimeStatus;
      readonly reason: RuntimeReason;
      readonly lastPhase: RunPhase;
    };

export type RuntimeProgressEvent =
  | { readonly type: "text_delta"; readonly index: number; readonly delta: string }
  | { readonly type: "reasoning_delta"; readonly index: number; readonly delta: string };

export type RuntimeEvent = RuntimeSemanticEvent | RuntimeProgressEvent;

export interface Steering {
  readonly content: string;
}

export interface FollowUp {
  readonly content: string;
}

export interface RuntimeHost {
  record(event: RuntimeSemanticEvent): Promise<void>;
  drainSteering(): Promise<readonly Steering[]>;
  takeFollowUp(): Promise<FollowUp | undefined>;
}

export interface RuntimeClock {
  now(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface RuntimeInput {
  readonly instructions: string;
  readonly messages: readonly ModelMessage[];
  readonly model: ModelAdapter;
  readonly tools: ToolPort;
  readonly stopPolicy: RunStopPolicy;
  readonly retryPolicy: ModelRetryPolicy;
  readonly clock: RuntimeClock;
  readonly signal: AbortSignal;
}

export interface RuntimeOutcome {
  readonly status: RuntimeStatus;
  readonly reason: RuntimeReason;
  readonly finalAnswer?: string;
  readonly counts: RuntimeCounts;
  readonly retries: number;
  readonly usage: ModelUsage;
  readonly unfinishedWork: readonly string[];
  readonly errorSummary?: string;
  readonly lastPhase: RunPhase;
}

export interface RuntimeExecution {
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly completion: Promise<RuntimeOutcome>;
}

export interface AgentRuntimePort {
  run(input: RuntimeInput, host: RuntimeHost): RuntimeExecution;
}
