export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "refusal"
  | "other";

export type ModelFailureCategory =
  | "network"
  | "rate_limit"
  | "authentication"
  | "invalid_model"
  | "context_overflow"
  | "provider_protocol"
  | "adapter_bug"
  | "cancelled";

export interface ModelFailure {
  readonly category: ModelFailureCategory;
  readonly retryable: boolean;
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly requestId?: string;
}

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ReasoningPart {
  readonly type: "reasoning";
  readonly text: string;
  readonly replayToken?: string;
}

export interface ToolCallPart {
  readonly type: "tool_call";
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly rawArguments: string;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly (TextPart | ReasoningPart | ToolCallPart)[];
  readonly finishReason: FinishReason;
}

export interface ToolResultMessage {
  readonly role: "tool";
  readonly callId: string;
  readonly content: string;
  readonly isError: boolean;
}

export type ModelMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  readonly instructions: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly toolChoice: "none" | "auto" | "required";
}

export interface ProviderCapabilities {
  readonly toolChoice: boolean;
  readonly reasoning: boolean;
  readonly reasoningReplay: boolean;
  readonly multipleToolCalls: boolean;
}

export type ModelEvent =
  | { readonly type: "turn_started"; readonly requestId?: string }
  | {
      readonly type: "part_started";
      readonly index: number;
      readonly part:
        | { readonly type: "text" }
        | { readonly type: "reasoning" }
        | { readonly type: "tool_call"; readonly callId: string; readonly name: string };
    }
  | { readonly type: "text_delta"; readonly index: number; readonly delta: string }
  | { readonly type: "reasoning_delta"; readonly index: number; readonly delta: string }
  | { readonly type: "tool_call_delta"; readonly index: number; readonly delta: string }
  | { readonly type: "part_completed"; readonly index: number; readonly replayToken?: string }
  | {
      readonly type: "turn_completed";
      readonly finishReason: FinishReason;
      readonly usage: ModelUsage;
    }
  | { readonly type: "turn_failed"; readonly failure: ModelFailure };

export interface ModelAdapter {
  stream(request: ModelRequest, options: { signal: AbortSignal }): AsyncIterable<ModelEvent>;
}
