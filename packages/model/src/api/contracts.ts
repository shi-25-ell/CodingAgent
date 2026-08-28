declare const providerIdBrand: unique symbol;
declare const modelIdBrand: unique symbol;

export type ProviderId = string & { readonly [providerIdBrand]: true };
export type ModelId = string & { readonly [modelIdBrand]: true };

export function providerId(value: string): ProviderId {
  return branded<ProviderId>(value, "ProviderId");
}

export function modelId(value: string): ModelId {
  return branded<ModelId>(value, "ModelId");
}

function branded<T extends string>(value: string, name: string): T {
  if (value.trim().length === 0) throw new TypeError(`${name} 不能为空`);
  return value as T;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface ModelCapabilities {
  readonly toolCalls: "none" | "single" | "multiple";
  readonly toolChoice: readonly ToolChoiceKind[];
  readonly reasoning: boolean;
  readonly reasoningReplay: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export type ToolChoiceKind = "auto" | "none" | "required" | "specific";

export interface ModelDescriptor {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
  readonly source: {
    readonly kind: "built_in" | "provider" | "extension" | "testing";
    readonly id: string;
    readonly revision: string;
  };
}

export interface InstructionPart {
  readonly type: "text";
  readonly text: string;
}

export interface UserTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface AssistantTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface AssistantReasoningPart {
  readonly type: "reasoning";
  readonly text: string;
  /** Provider-neutral opaque material required to replay a verified reasoning block. */
  readonly replayToken?: string;
}

export interface ToolCall {
  readonly type: "tool_call";
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export type UserContentPart = UserTextPart;
export type AssistantContentPart = AssistantTextPart | AssistantReasoningPart | ToolCall;

export interface UserMessage {
  readonly role: "user";
  readonly content: readonly UserContentPart[];
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly AssistantContentPart[];
  readonly finishReason: ModelFinishReason;
  readonly usage?: ModelUsage;
}

export interface ToolResultMessage {
  readonly role: "tool";
  readonly callId: string;
  readonly content: string;
  readonly isError: boolean;
}

export type ModelMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export type ToolChoice =
  | { readonly kind: "auto" | "none" | "required" }
  | { readonly kind: "specific"; readonly toolName: string };

export interface ModelOutputPolicy {
  readonly maxTokens: number;
  readonly reasoning?: {
    readonly enabled: boolean;
    readonly budgetTokens?: number;
  };
}

export interface ModelRequest {
  readonly version: 1;
  readonly instructions: readonly InstructionPart[];
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly output: ModelOutputPolicy;
  readonly metadata?: Readonly<Record<string, string>>;
}

export type ModelFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}

export interface ModelResponse {
  readonly version: 1;
  readonly content: readonly AssistantContentPart[];
  readonly finishReason: ModelFinishReason;
  readonly usage?: ModelUsage;
}

export interface ModelFailure {
  readonly category:
    | "not_configured"
    | "authentication"
    | "permission"
    | "rate_limit"
    | "quota"
    | "timeout"
    | "network"
    | "invalid_request"
    | "invalid_response"
    | "content_filter"
    | "provider_unavailable"
    | "cancelled"
    | "adapter_bug";
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly message: string;
}

export type PartHeader =
  | { readonly type: "text" }
  | { readonly type: "reasoning" }
  | { readonly type: "tool_call"; readonly callId: string; readonly name: string };

export interface ToolCallDelta {
  readonly argumentsDelta: string;
}

export type ModelEvent = { readonly version: 1 } & (
  | { readonly type: "turn_started"; readonly attemptId: string }
  | { readonly type: "part_started"; readonly index: number; readonly part: PartHeader }
  | { readonly type: "text_delta"; readonly index: number; readonly delta: string }
  | {
      readonly type: "reasoning_delta";
      readonly index: number;
      readonly delta: string;
      readonly replayTokenDelta?: string;
    }
  | { readonly type: "tool_call_delta"; readonly index: number; readonly delta: ToolCallDelta }
  | { readonly type: "part_completed"; readonly index: number }
  | { readonly type: "turn_completed"; readonly response: ModelResponse }
  | { readonly type: "turn_failed"; readonly failure: ModelFailure }
);

export interface ModelCallOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

export interface Model {
  readonly descriptor: ModelDescriptor;
  readonly capabilities: ModelCapabilities;
  stream(request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelEvent>;
}

export interface ModelRef {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export interface CreateModelInput extends ModelRef {}

export interface ModelQuery {
  readonly providerId?: ProviderId;
  readonly require?: Partial<ModelCapabilities>;
  readonly signal?: AbortSignal;
}

export interface ProviderSummary {
  readonly id: ProviderId;
}

export interface Registration {
  dispose(): void;
}

export interface ModelProvider {
  readonly id: ProviderId;
  listModels(options?: { readonly signal?: AbortSignal }): Promise<readonly ModelDescriptor[]>;
  createModel(input: CreateModelInput): Promise<Model>;
}

export interface ModelRegistry {
  registerProvider(provider: ModelProvider): Registration;
  unregisterProvider(id: ProviderId): boolean;
  listProviders(): readonly ProviderSummary[];
  listModels(query?: ModelQuery): Promise<readonly ModelDescriptor[]>;
  resolve(ref: ModelRef): Promise<Model>;
}

export type ModelTurnResult =
  | { readonly status: "completed"; readonly response: ModelResponse }
  | {
      readonly status: "failed";
      readonly failure: ModelFailure;
      readonly producedSemanticOutput?: boolean;
    };
