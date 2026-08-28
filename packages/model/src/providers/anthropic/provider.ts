import type {
  AssistantContentPart,
  JsonObject,
  Model,
  ModelCallOptions,
  ModelDescriptor,
  ModelEvent,
  ModelFailure,
  ModelFinishReason,
  ModelMessage,
  ModelRequest,
  ModelUsage,
  ToolChoice,
} from "../../api/contracts.js";
import type { CredentialResolver } from "../../auth/contracts.js";
import { ModelRegistryError } from "../../catalog/model-registry.js";
import type {
  AnthropicProfile,
  AnthropicProvider,
  AnthropicProviderOptions,
  AnthropicTransport,
  AnthropicTransportResponse,
} from "./contracts.js";
import { createFetchAnthropicTransport } from "./fetch-transport.js";

class AnthropicWireError extends Error {}

class AnthropicStreamFailure extends Error {
  constructor(readonly failure: ModelFailure) {
    super(failure.message);
    this.name = "AnthropicStreamFailure";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new AnthropicWireError(`${label} 必须是 object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new AnthropicWireError(`${label} 必须是 string`);
  return value;
}

function index(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AnthropicWireError(`${label} 必须是非负安全整数`);
  }
  return value as number;
}

function invalidRequest(message: string): ModelFailure {
  return { category: "invalid_request", retryable: false, message };
}

function validateRequest(
  request: ModelRequest,
  descriptor: ModelDescriptor,
): ModelFailure | undefined {
  if (!Number.isSafeInteger(request.output.maxTokens) || request.output.maxTokens <= 0) {
    return invalidRequest("maxTokens 必须是正安全整数");
  }
  if (
    descriptor.capabilities.maxOutputTokens !== undefined &&
    request.output.maxTokens > descriptor.capabilities.maxOutputTokens
  ) {
    return invalidRequest("请求的 output token 上限超过 model capability");
  }
  if (request.tools.length > 0 && descriptor.capabilities.toolCalls === "none") {
    return invalidRequest("所选 model 不支持 tool calls");
  }
  if (request.toolChoice && !descriptor.capabilities.toolChoice.includes(request.toolChoice.kind)) {
    return invalidRequest(`所选 model 不支持 tool choice: ${request.toolChoice.kind}`);
  }
  const specificChoice = request.toolChoice?.kind === "specific" ? request.toolChoice : undefined;
  if (specificChoice && !request.tools.some((tool) => tool.name === specificChoice.toolName)) {
    return invalidRequest("specific tool choice 未出现在 tools 中");
  }
  if (request.output.reasoning?.enabled && !descriptor.capabilities.reasoning) {
    return invalidRequest("所选 model 不支持 reasoning");
  }
  if (request.output.reasoning?.enabled && request.output.maxTokens < 2) {
    return invalidRequest("reasoning request 需要至少两个 output tokens");
  }
  const budget = request.output.reasoning?.budgetTokens;
  if (
    budget !== undefined &&
    (!Number.isSafeInteger(budget) || budget <= 0 || budget >= request.output.maxTokens)
  ) {
    return invalidRequest("reasoning budget 必须是小于 maxTokens 的正安全整数");
  }
  const names = new Set<string>();
  for (const tool of request.tools) {
    if (names.has(tool.name)) return invalidRequest(`Tool name 重复: ${tool.name}`);
    names.add(tool.name);
    if (tool.inputSchema.type !== "object" || tool.inputSchema.additionalProperties !== false) {
      return invalidRequest(`Tool ${tool.name} 必须使用 strict JSON object schema`);
    }
  }
  for (const message of request.messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "reasoning" && !part.replayToken) {
        return invalidRequest("Anthropic reasoning replay 缺少 opaque replay token");
      }
    }
  }
  return undefined;
}

function assistantBlocks(
  message: Extract<ModelMessage, { role: "assistant" }>,
): readonly unknown[] {
  return message.content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "reasoning") {
      if (part.redacted) return { type: "redacted_thinking", data: part.replayToken };
      return { type: "thinking", thinking: part.text, signature: part.replayToken };
    }
    return { type: "tool_use", id: part.callId, name: part.name, input: part.arguments };
  });
}

function wireMessages(messages: readonly ModelMessage[]): readonly unknown[] {
  const result: unknown[] = [];
  for (let cursor = 0; cursor < messages.length; cursor += 1) {
    const message = messages[cursor];
    if (!message) continue;
    if (message.role === "user") {
      result.push({
        role: "user",
        content: message.content.map((part) => ({ type: "text", text: part.text })),
      });
      continue;
    }
    if (message.role === "assistant") {
      result.push({ role: "assistant", content: assistantBlocks(message) });
      continue;
    }
    const content: unknown[] = [];
    let grouped = cursor;
    while (grouped < messages.length) {
      const candidate = messages[grouped];
      if (!candidate || candidate.role !== "tool") break;
      content.push({
        type: "tool_result",
        tool_use_id: candidate.callId,
        content: candidate.content,
        is_error: candidate.isError,
      });
      grouped += 1;
    }
    result.push({ role: "user", content });
    cursor = grouped - 1;
  }
  return result;
}

function toolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice) return undefined;
  if (choice.kind === "required") return { type: "any" };
  if (choice.kind === "specific") return { type: "tool", name: choice.toolName };
  return { type: choice.kind };
}

function requestBody(request: ModelRequest, descriptor: ModelDescriptor): string {
  const body: Record<string, unknown> = {
    model: descriptor.modelId,
    max_tokens: request.output.maxTokens,
    messages: wireMessages(request.messages),
    stream: true,
  };
  if (request.instructions.length > 0) {
    body.system = request.instructions.map((part) => ({ type: "text", text: part.text }));
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
  const choice = toolChoice(request.toolChoice);
  if (choice) body.tool_choice = choice;
  if (request.output.reasoning?.enabled) {
    body.thinking = {
      type: "enabled",
      budget_tokens:
        request.output.reasoning.budgetTokens ?? Math.min(4_096, request.output.maxTokens - 1),
    };
  }
  return JSON.stringify(body);
}

interface ServerSentEvent {
  readonly event?: string;
  readonly data: string;
}

async function* sseEvents(body: AsyncIterable<string>): AsyncIterable<ServerSentEvent> {
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const flush = (): ServerSentEvent | undefined => {
    if (event === undefined && data.length === 0) return undefined;
    const value = { ...(event ? { event } : {}), data: data.join("\n") };
    event = undefined;
    data = [];
    return value;
  };
  for await (const chunk of body) {
    buffer += chunk;
    while (true) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match || match.index === undefined) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line.length === 0) {
        const value = flush();
        if (value) yield value;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        if (field === "data") data.push(value);
      }
    }
  }
  if (buffer.length > 0 || event !== undefined || data.length > 0) {
    throw new AnthropicWireError("SSE stream 在 event 完成前断开");
  }
}

function usage(value: unknown, current: ModelUsage = {}): ModelUsage {
  const raw = object(value, "usage");
  const details =
    raw.output_tokens_details === undefined
      ? undefined
      : object(raw.output_tokens_details, "output token details");
  const inputTokens = typeof raw.input_tokens === "number" ? raw.input_tokens : current.inputTokens;
  const outputTokens =
    typeof raw.output_tokens === "number" ? raw.output_tokens : current.outputTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
    ...(typeof raw.cache_read_input_tokens === "number"
      ? { cachedInputTokens: raw.cache_read_input_tokens }
      : current.cachedInputTokens !== undefined
        ? { cachedInputTokens: current.cachedInputTokens }
        : {}),
    ...(typeof details?.thinking_tokens === "number"
      ? { reasoningTokens: details.thinking_tokens }
      : current.reasoningTokens !== undefined
        ? { reasoningTokens: current.reasoningTokens }
        : {}),
  };
}

function finishReason(value: unknown): ModelFinishReason {
  if (value === "end_turn" || value === "stop_sequence") return "stop";
  if (value === "tool_use") return "tool_calls";
  if (value === "max_tokens") return "length";
  if (value === "refusal") return "content_filter";
  if (typeof value === "string") return "unknown";
  throw new AnthropicWireError("stop_reason 缺失或无效");
}

interface MutablePart {
  readonly wireIndex: number;
  readonly canonicalIndex: number;
  readonly type: "text" | "reasoning" | "tool_call";
  text: string;
  replayToken: string;
  readonly redacted: boolean;
  readonly callId?: string;
  readonly name?: string;
  completed: boolean;
}

function canonicalPart(part: MutablePart): AssistantContentPart {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: part.text,
      ...(part.replayToken ? { replayToken: part.replayToken } : {}),
      ...(part.redacted ? { redacted: true } : {}),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(part.text || "{}");
  } catch {
    throw new AnthropicWireError("tool input 不是合法 JSON");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new AnthropicWireError("tool input 必须是 JSON object");
  }
  return {
    type: "tool_call",
    callId: part.callId as string,
    name: part.name as string,
    arguments: parsed as JsonObject,
  };
}

function streamFailure(raw: Record<string, unknown>, profile: AnthropicProfile): ModelFailure {
  const error = object(raw.error, "stream error");
  const type = typeof error.type === "string" ? error.type : "unknown";
  const message = (suffix: string) => `${profile.displayName} ${suffix}`;
  if (type === "authentication_error") {
    return {
      category: "authentication",
      retryable: false,
      message: message("authentication failed"),
    };
  }
  if (type === "permission_error") {
    return { category: "permission", retryable: false, message: message("permission denied") };
  }
  if (type === "rate_limit_error") {
    return { category: "rate_limit", retryable: true, message: message("rate limit exceeded") };
  }
  if (type === "overloaded_error" || type === "api_error") {
    return { category: "provider_unavailable", retryable: true, message: message("unavailable") };
  }
  return { category: "invalid_response", retryable: false, message: message("stream failed") };
}

async function* successfulEvents(
  response: AnthropicTransportResponse,
  profile: AnthropicProfile,
  descriptor: ModelDescriptor,
): AsyncIterable<ModelEvent> {
  const parts: MutablePart[] = [];
  let messageStarted = false;
  let messageStopped = false;
  let terminalReason: ModelFinishReason | undefined;
  let finalUsage: ModelUsage | undefined;
  for await (const sse of sseEvents(response.body)) {
    let raw: Record<string, unknown>;
    try {
      raw = object(JSON.parse(sse.data), "Anthropic event");
    } catch (error) {
      if (error instanceof AnthropicWireError) throw error;
      throw new AnthropicWireError("Anthropic event JSON 无效");
    }
    const type = string(raw.type, "event.type");
    if (sse.event === "ping" || type === "ping") continue;
    if (sse.event && sse.event !== type) {
      throw new AnthropicWireError("SSE event name 与 payload type 不一致");
    }
    if (type === "error") throw new AnthropicStreamFailure(streamFailure(raw, profile));
    if (messageStopped) throw new AnthropicWireError("message_stop 之后不得再有事件");
    if (type === "message_start") {
      if (messageStarted) throw new AnthropicWireError("message_start 必须恰好一次");
      const message = object(raw.message, "message_start.message");
      if (!Array.isArray(message.content) || message.content.length !== 0) {
        throw new AnthropicWireError("message_start content 必须为空 array");
      }
      if (message.usage !== undefined) finalUsage = usage(message.usage);
      messageStarted = true;
      continue;
    }
    if (!messageStarted) throw new AnthropicWireError("事件发生在 message_start 之前");
    if (type === "content_block_start") {
      const wireIndex = index(raw.index, "content block index");
      if (wireIndex !== parts.length) throw new AnthropicWireError("content block index 必须连续");
      const block = object(raw.content_block, "content block");
      const blockType = string(block.type, "content block type");
      let part: MutablePart;
      if (blockType === "text") {
        part = {
          wireIndex,
          canonicalIndex: parts.length,
          type: "text",
          text: typeof block.text === "string" ? block.text : "",
          replayToken: "",
          redacted: false,
          completed: false,
        };
      } else if (blockType === "thinking" || blockType === "redacted_thinking") {
        part = {
          wireIndex,
          canonicalIndex: parts.length,
          type: "reasoning",
          text:
            blockType === "redacted_thinking"
              ? "[Reasoning redacted]"
              : typeof block.thinking === "string"
                ? block.thinking
                : "",
          replayToken:
            blockType === "redacted_thinking"
              ? string(block.data, "redacted thinking data")
              : typeof block.signature === "string"
                ? block.signature
                : "",
          redacted: blockType === "redacted_thinking",
          completed: false,
        };
      } else if (blockType === "tool_use") {
        if (descriptor.capabilities.toolCalls === "none") {
          throw new AnthropicWireError("model capability 不允许 tool use response");
        }
        if (
          descriptor.capabilities.toolCalls === "single" &&
          parts.some((candidate) => candidate.type === "tool_call")
        ) {
          throw new AnthropicWireError("model capability 只允许单一 tool use");
        }
        const input = object(block.input, "tool use input");
        part = {
          wireIndex,
          canonicalIndex: parts.length,
          type: "tool_call",
          text: Object.keys(input).length === 0 ? "" : JSON.stringify(input),
          replayToken: "",
          redacted: false,
          callId: string(block.id, "tool use id"),
          name: string(block.name, "tool use name"),
          completed: false,
        };
      } else {
        throw new AnthropicWireError(`不支持的 content block: ${blockType}`);
      }
      parts.push(part);
      yield {
        version: 1,
        type: "part_started",
        index: part.canonicalIndex,
        part:
          part.type === "tool_call"
            ? { type: "tool_call", callId: part.callId as string, name: part.name as string }
            : part.type === "reasoning" && part.redacted
              ? { type: "reasoning", redacted: true }
              : { type: part.type },
      };
      if (part.text) {
        yield {
          version: 1,
          type:
            part.type === "text"
              ? "text_delta"
              : part.type === "reasoning"
                ? "reasoning_delta"
                : "tool_call_delta",
          index: part.canonicalIndex,
          ...(part.type === "tool_call"
            ? { delta: { argumentsDelta: part.text } }
            : { delta: part.text }),
        } as ModelEvent;
      }
      if (part.type === "reasoning" && part.replayToken) {
        yield {
          version: 1,
          type: "reasoning_delta",
          index: part.canonicalIndex,
          delta: "",
          replayTokenDelta: part.replayToken,
        };
      }
      continue;
    }
    if (type === "content_block_delta") {
      const wireIndex = index(raw.index, "content block index");
      const part = parts[wireIndex];
      if (!part || part.completed) throw new AnthropicWireError("delta 目标 block 未激活");
      const delta = object(raw.delta, "content block delta");
      const deltaType = string(delta.type, "content block delta type");
      if (deltaType === "text_delta" && part.type === "text") {
        const value = string(delta.text, "text delta");
        part.text += value;
        yield { version: 1, type: "text_delta", index: part.canonicalIndex, delta: value };
      } else if (deltaType === "thinking_delta" && part.type === "reasoning") {
        const value = string(delta.thinking, "thinking delta");
        part.text += value;
        yield { version: 1, type: "reasoning_delta", index: part.canonicalIndex, delta: value };
      } else if (deltaType === "signature_delta" && part.type === "reasoning") {
        const value = string(delta.signature, "signature delta");
        part.replayToken += value;
        yield {
          version: 1,
          type: "reasoning_delta",
          index: part.canonicalIndex,
          delta: "",
          replayTokenDelta: value,
        };
      } else if (deltaType === "input_json_delta" && part.type === "tool_call") {
        const value = string(delta.partial_json, "tool input delta");
        part.text += value;
        yield {
          version: 1,
          type: "tool_call_delta",
          index: part.canonicalIndex,
          delta: { argumentsDelta: value },
        };
      } else {
        throw new AnthropicWireError("content block delta type 不匹配");
      }
      continue;
    }
    if (type === "content_block_stop") {
      const wireIndex = index(raw.index, "content block index");
      const part = parts[wireIndex];
      if (!part || part.completed) throw new AnthropicWireError("stop 目标 block 未激活");
      canonicalPart(part);
      part.completed = true;
      yield { version: 1, type: "part_completed", index: part.canonicalIndex };
      continue;
    }
    if (type === "message_delta") {
      if (parts.some((part) => !part.completed)) {
        throw new AnthropicWireError("message_delta 前所有 content blocks 必须完成");
      }
      const delta = object(raw.delta, "message delta");
      if (delta.stop_reason !== null && delta.stop_reason !== undefined) {
        terminalReason = finishReason(delta.stop_reason);
      }
      if (raw.usage !== undefined) finalUsage = usage(raw.usage, finalUsage);
      continue;
    }
    if (type === "message_stop") {
      if (parts.some((part) => !part.completed)) {
        throw new AnthropicWireError("message_stop 前所有 content blocks 必须完成");
      }
      if (!terminalReason) throw new AnthropicWireError("Anthropic stream 缺少 stop_reason");
      messageStopped = true;
      const content = parts.map(canonicalPart);
      yield {
        version: 1,
        type: "turn_completed",
        response: {
          version: 1,
          content,
          finishReason: terminalReason,
          ...(finalUsage ? { usage: finalUsage } : {}),
        },
      };
    }
    // Unknown future event types are ignored as required by the provider's versioning policy.
  }
  if (!messageStopped) throw new AnthropicWireError("Anthropic stream 未收到 message_stop");
}

async function readErrorBody(body: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of body) {
    text += chunk;
    if (text.length >= 32_768) break;
  }
  return text;
}

function retryAfter(headers: Readonly<Record<string, string | undefined>>): number | undefined {
  const value = headers["retry-after"];
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
}

async function httpFailure(
  response: AnthropicTransportResponse,
  profile: AnthropicProfile,
): Promise<ModelFailure> {
  const body = await readErrorBody(response.body);
  let type: string | undefined;
  try {
    const root = object(JSON.parse(body), "error response");
    const error = object(root.error, "error");
    if (typeof error.type === "string") type = error.type;
  } catch {
    // HTTP status remains authoritative; raw provider text is never surfaced.
  }
  const common = {
    httpStatus: response.status,
    ...(response.headers["request-id"] ? { requestId: response.headers["request-id"] } : {}),
  };
  const message = (suffix: string) => `${profile.displayName} ${suffix}`;
  if (response.status === 401 || type === "authentication_error") {
    return {
      ...common,
      category: "authentication",
      retryable: false,
      message: message("authentication failed"),
    };
  }
  if (response.status === 403 || type === "permission_error") {
    return {
      ...common,
      category: "permission",
      retryable: false,
      message: message("permission denied"),
    };
  }
  if (response.status === 429 || type === "rate_limit_error") {
    const delay = retryAfter(response.headers);
    return {
      ...common,
      category: "rate_limit",
      retryable: true,
      ...(delay !== undefined ? { retryAfterMs: delay } : {}),
      message: message("rate limit exceeded"),
    };
  }
  if (response.status === 408) {
    return {
      ...common,
      category: "timeout",
      retryable: true,
      message: message("request timed out"),
    };
  }
  if (response.status === 529 || response.status >= 500 || type === "overloaded_error") {
    return {
      ...common,
      category: "provider_unavailable",
      retryable: true,
      message: message("unavailable"),
    };
  }
  return {
    ...common,
    category: "invalid_request",
    retryable: false,
    message: message("request rejected"),
  };
}

function thrownFailure(
  error: unknown,
  signal: AbortSignal,
  timeoutSignal: AbortSignal | undefined,
  profile: AnthropicProfile,
): ModelFailure {
  if (error instanceof AnthropicStreamFailure) return error.failure;
  if (!signal.aborted && timeoutSignal?.aborted) {
    return {
      category: "timeout",
      retryable: true,
      message: `${profile.displayName} transport timed out`,
    };
  }
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return { category: "cancelled", retryable: false, message: "Model Attempt 已取消" };
  }
  if (error instanceof AnthropicWireError || error instanceof SyntaxError) {
    return {
      category: "invalid_response",
      retryable: false,
      message: `${profile.displayName} response protocol invalid`,
    };
  }
  if (error instanceof TypeError) {
    return {
      category: "network",
      retryable: true,
      message: `${profile.displayName} network request failed`,
    };
  }
  return {
    category: "adapter_bug",
    retryable: false,
    message: `${profile.displayName} adapter failed`,
  };
}

class AnthropicModel implements Model {
  readonly capabilities: ModelDescriptor["capabilities"];
  readonly descriptor: ModelDescriptor;
  readonly #profile: AnthropicProfile;
  readonly #credentials: CredentialResolver;
  readonly #transport: AnthropicTransport;

  constructor(
    descriptor: ModelDescriptor,
    profile: AnthropicProfile,
    credentials: CredentialResolver,
    transport: AnthropicTransport,
  ) {
    this.descriptor = descriptor;
    this.capabilities = descriptor.capabilities;
    this.#profile = profile;
    this.#credentials = credentials;
    this.#transport = transport;
  }

  async *stream(request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelEvent> {
    yield { version: 1, type: "turn_started", attemptId: crypto.randomUUID() };
    const validation = validateRequest(request, this.descriptor);
    if (validation) {
      yield { version: 1, type: "turn_failed", failure: validation };
      return;
    }
    const timeoutSignal =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    const attemptSignal = timeoutSignal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : options.signal;
    try {
      const resolution = await this.#credentials.resolve(this.#profile.auth, {
        signal: attemptSignal,
      });
      if (resolution.status === "missing") {
        yield {
          version: 1,
          type: "turn_failed",
          failure: {
            category: "not_configured",
            retryable: false,
            message: `${this.#profile.displayName} credential 未配置`,
          },
        };
        return;
      }
      if (resolution.status === "failed") {
        yield {
          version: 1,
          type: "turn_failed",
          failure:
            resolution.failure.category === "cancelled"
              ? { category: "cancelled", retryable: false, message: "Model Attempt 已取消" }
              : {
                  category: "authentication",
                  retryable: false,
                  message: `${this.#profile.displayName} credential 解析失败`,
                },
        };
        return;
      }
      const response = await this.#transport.send({
        url: new URL("v1/messages", this.#profile.baseUrl).toString(),
        headers: {
          "content-type": "application/json",
          "anthropic-version": this.#profile.version,
          ...this.#profile.defaultHeaders,
          "x-api-key": resolution.credential.value.reveal(),
        },
        body: requestBody(request, this.descriptor),
        signal: attemptSignal,
      });
      if (response.status < 200 || response.status >= 300) {
        yield {
          version: 1,
          type: "turn_failed",
          failure: await httpFailure(response, this.#profile),
        };
        return;
      }
      yield* successfulEvents(response, this.#profile, this.descriptor);
    } catch (error) {
      yield {
        version: 1,
        type: "turn_failed",
        failure: thrownFailure(error, options.signal, timeoutSignal, this.#profile),
      };
    }
  }
}

export function createAnthropicProvider(options: AnthropicProviderOptions): AnthropicProvider {
  const transport = options.transport ?? createFetchAnthropicTransport();
  const models = [...options.models];
  if (models.some((descriptor) => descriptor.providerId !== options.profile.id)) {
    throw new TypeError("Catalog descriptor providerId 必须匹配 profile id");
  }
  return {
    id: options.profile.id,
    async listModels(listOptions) {
      if (listOptions?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return models;
    },
    async createModel(input) {
      if (input.providerId !== options.profile.id) {
        throw new ModelRegistryError(
          "MODEL_PROVIDER_NOT_FOUND",
          `Provider ${input.providerId} 不匹配`,
        );
      }
      const descriptor = models.find((candidate) => candidate.modelId === input.modelId);
      if (!descriptor) {
        throw new ModelRegistryError("MODEL_NOT_FOUND", `Model ${input.modelId} 不在 catalog 中`);
      }
      return new AnthropicModel(descriptor, options.profile, options.credentials, transport);
    },
  };
}
