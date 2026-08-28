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
  ModelToolDefinition,
  ModelUsage,
  ToolChoice,
} from "../../api/contracts.js";
import type { CredentialResolver } from "../../auth/contracts.js";
import { ModelRegistryError } from "../../catalog/model-registry.js";
import type {
  OpenAiCompatibleProfile,
  OpenAiCompatibleProvider,
  OpenAiCompatibleProviderOptions,
  OpenAiTransport,
  OpenAiTransportResponse,
} from "./contracts.js";
import { createFetchOpenAiTransport } from "./fetch-transport.js";

class OpenAiWireError extends Error {}

class OpenAiStreamFailure extends Error {
  readonly failure: ModelFailure;

  constructor(failure: ModelFailure) {
    super(failure.message);
    this.name = "OpenAiStreamFailure";
    this.failure = failure;
  }
}

function invalidRequest(message: string): ModelFailure {
  return { category: "invalid_request", retryable: false, message };
}

function validateRequest(
  request: ModelRequest,
  descriptor: ModelDescriptor,
  profile: OpenAiCompatibleProfile,
): ModelFailure | undefined {
  const capabilities = descriptor.capabilities;
  if (request.tools.length > 0 && capabilities.toolCalls === "none") {
    return invalidRequest("所选 model 不支持 tool calls");
  }
  if (request.toolChoice && !capabilities.toolChoice.includes(request.toolChoice.kind)) {
    return invalidRequest(`所选 model 不支持 tool choice: ${request.toolChoice.kind}`);
  }
  const specificChoice = request.toolChoice?.kind === "specific" ? request.toolChoice : undefined;
  if (specificChoice && !request.tools.some((tool) => tool.name === specificChoice.toolName)) {
    return invalidRequest("specific tool choice 未出现在 tools 中");
  }
  if (
    descriptor.capabilities.maxOutputTokens !== undefined &&
    request.output.maxTokens > descriptor.capabilities.maxOutputTokens
  ) {
    return invalidRequest("请求的 output token 上限超过 model capability");
  }
  if (!Number.isSafeInteger(request.output.maxTokens) || request.output.maxTokens <= 0) {
    return invalidRequest("maxTokens 必须是正安全整数");
  }
  const hasReasoningReplay = request.messages.some(
    (message) =>
      message.role === "assistant" && message.content.some((part) => part.type === "reasoning"),
  );
  if (
    hasReasoningReplay &&
    (!capabilities.reasoningReplay || !profile.requestDialect.reasoningReplayField)
  ) {
    return invalidRequest("所选 model/profile 不支持 reasoning replay");
  }
  const names = new Set<string>();
  for (const tool of request.tools) {
    if (names.has(tool.name)) return invalidRequest(`Tool name 重复: ${tool.name}`);
    names.add(tool.name);
    if (tool.inputSchema.type !== "object" || tool.inputSchema.additionalProperties !== false) {
      return invalidRequest(`Tool ${tool.name} 必须使用 strict JSON object schema`);
    }
  }
  return undefined;
}

function toolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice) return undefined;
  if (choice.kind !== "specific") return choice.kind;
  return { type: "function", function: { name: choice.toolName } };
}

function wireTools(tools: readonly ModelToolDefinition[]): readonly unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function assistantWireMessage(
  message: Extract<ModelMessage, { role: "assistant" }>,
  profile: OpenAiCompatibleProfile,
): unknown {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const calls = message.content
    .filter((part) => part.type === "tool_call")
    .map((part) => ({
      id: part.callId,
      type: "function",
      function: { name: part.name, arguments: JSON.stringify(part.arguments) },
    }));
  const reasoning = message.content
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
  return {
    role: "assistant",
    content: text.length > 0 ? text : null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    ...(reasoning.length > 0 && profile.requestDialect.reasoningReplayField
      ? { [profile.requestDialect.reasoningReplayField]: reasoning }
      : {}),
  };
}

function wireMessages(request: ModelRequest, profile: OpenAiCompatibleProfile): readonly unknown[] {
  const instructions = request.instructions.map((part) => part.text).join("\n\n");
  const messages: unknown[] = instructions
    ? [{ role: profile.requestDialect.instructionsRole, content: instructions }]
    : [];
  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content.map((part) => part.text).join("") });
    } else if (message.role === "assistant") {
      messages.push(assistantWireMessage(message, profile));
    } else {
      messages.push({ role: "tool", tool_call_id: message.callId, content: message.content });
    }
  }
  return messages;
}

function requestBody(
  request: ModelRequest,
  descriptor: ModelDescriptor,
  profile: OpenAiCompatibleProfile,
): string {
  const body: Record<string, unknown> = {
    ...profile.requestDialect.additionalBody,
    model: descriptor.modelId,
    messages: wireMessages(request, profile),
    stream: true,
    [profile.requestDialect.maxTokensField]: request.output.maxTokens,
  };
  if (profile.requestDialect.includeUsageStreamOption) {
    body.stream_options = { include_usage: true };
  }
  if (request.tools.length > 0) {
    body.tools = wireTools(request.tools).map((tool) => {
      if (!profile.requestDialect.strictToolSchema) return tool;
      const value = tool as { readonly function: Record<string, unknown> };
      return { ...value, function: { ...value.function, strict: true } };
    });
    if (profile.requestDialect.parallelToolCallsField) {
      body.parallel_tool_calls = descriptor.capabilities.toolCalls === "multiple";
    }
    Object.assign(body, profile.requestDialect.toolBody);
  }
  const choice = toolChoice(request.toolChoice);
  if (choice !== undefined) body.tool_choice = choice;
  return JSON.stringify(body);
}

async function* sseData(body: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  let dataLines: string[] = [];
  for await (const chunk of body) {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) {
        if (dataLines.length > 0) yield dataLines.join("\n");
        dataLines = [];
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  if (buffer.length > 0 || dataLines.length > 0) {
    throw new OpenAiWireError("SSE stream 在 event 完成前断开");
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new OpenAiWireError(`${label} 必须是 object`);
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new TypeError("tool arguments 必须是 JSON object");
    }
    return parsed as JsonObject;
  } catch (error) {
    throw new OpenAiWireError(error instanceof Error ? error.message : "tool arguments 无效");
  }
}

function finishReason(value: unknown): ModelFinishReason {
  if (
    value === "stop" ||
    value === "tool_calls" ||
    value === "length" ||
    value === "content_filter"
  ) {
    return value;
  }
  if (value === "function_call") return "tool_calls";
  if (typeof value === "string") return "unknown";
  throw new OpenAiWireError("finish_reason 缺失或无效");
}

function usage(value: unknown): ModelUsage {
  const raw = object(value, "usage");
  const mapped: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } = {};
  if (typeof raw.prompt_tokens === "number") mapped.inputTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === "number") mapped.outputTokens = raw.completion_tokens;
  if (typeof raw.total_tokens === "number") mapped.totalTokens = raw.total_tokens;
  return mapped;
}

function streamFailure(
  chunk: Record<string, unknown>,
  profile: OpenAiCompatibleProfile,
): ModelFailure | undefined {
  if (chunk.error === undefined) return undefined;
  const error = object(chunk.error, "stream error");
  const metadata =
    error.metadata === undefined ? undefined : object(error.metadata, "stream error metadata");
  const errorType = typeof metadata?.error_type === "string" ? metadata.error_type : undefined;
  const httpStatus =
    typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code : undefined;
  const common = httpStatus === undefined ? {} : { httpStatus };
  const message = (suffix: string) => `${profile.displayName} ${suffix}`;

  if (errorType === "content_policy_violation" || errorType === "refusal") {
    return {
      ...common,
      category: "content_filter",
      retryable: false,
      message: message("content filter rejected the request"),
    };
  }
  if (errorType === "authentication" || httpStatus === 401) {
    return {
      ...common,
      category: "authentication",
      retryable: false,
      message: message("authentication failed"),
    };
  }
  if (errorType === "permission_denied" || httpStatus === 403) {
    return {
      ...common,
      category: "permission",
      retryable: false,
      message: message("permission denied"),
    };
  }
  if (
    errorType === "payment_required" ||
    errorType === "token_limit_exceeded" ||
    httpStatus === 402
  ) {
    return { ...common, category: "quota", retryable: false, message: message("quota exhausted") };
  }
  if (errorType === "rate_limit_exceeded" || httpStatus === 429) {
    return {
      ...common,
      category: "rate_limit",
      retryable: true,
      message: message("rate limit exceeded"),
    };
  }
  if (errorType === "timeout" || httpStatus === 408) {
    return {
      ...common,
      category: "timeout",
      retryable: true,
      message: message("request timed out"),
    };
  }
  if (
    errorType === "provider_overloaded" ||
    errorType === "provider_unavailable" ||
    errorType === "server" ||
    errorType === "unmapped" ||
    (httpStatus !== undefined && httpStatus >= 500)
  ) {
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

function isUsageOnlyRepeatedTerminal(
  chunk: Record<string, unknown>,
  choice: Record<string, unknown>,
  terminalReason: ModelFinishReason,
  profile: OpenAiCompatibleProfile,
): boolean {
  if (!profile.responseDialect.terminalUsageRepeatsFinishReason || chunk.usage == null) {
    return false;
  }
  if (finishReason(choice.finish_reason) !== terminalReason) return false;
  const delta = object(choice.delta, "choice.delta");
  if (!Object.keys(delta).every((key) => key === "content" || key === "role")) return false;
  if (delta.content !== undefined && delta.content !== null && delta.content !== "") return false;
  return delta.role === undefined || delta.role === "assistant";
}

interface MutableTextPart {
  readonly type: "text";
  text: string;
  readonly index: number;
}

interface MutableReasoningPart {
  readonly type: "reasoning";
  text: string;
  readonly index: number;
}

interface MutableToolPart {
  readonly type: "tool_call";
  readonly index: number;
  readonly wireIndex: number;
  readonly callId: string;
  readonly name: string;
  argumentsText: string;
}

type MutablePart = MutableTextPart | MutableReasoningPart | MutableToolPart;

function canonicalContent(parts: readonly MutablePart[]): readonly AssistantContentPart[] {
  return parts.map((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return { type: part.type, text: part.text };
    }
    return {
      type: "tool_call",
      callId: part.callId,
      name: part.name,
      arguments: parseJsonObject(part.argumentsText),
    };
  });
}

async function* successfulEvents(
  response: OpenAiTransportResponse,
  profile: OpenAiCompatibleProfile,
  descriptor: ModelDescriptor,
): AsyncIterable<ModelEvent> {
  const parts: MutablePart[] = [];
  const tools = new Map<number, MutableToolPart>();
  let textPart: MutableTextPart | undefined;
  let reasoningPart: MutableReasoningPart | undefined;
  let terminalReason: ModelFinishReason | undefined;
  let finalUsage: ModelUsage | undefined;
  let done = false;

  for await (const data of sseData(response.body)) {
    if (done) throw new OpenAiWireError("[DONE] 之后不得再有 SSE event");
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    const chunk = object(JSON.parse(data), "stream chunk");
    const failure = streamFailure(chunk, profile);
    if (failure) throw new OpenAiStreamFailure(failure);
    if (chunk.usage !== null && chunk.usage !== undefined) finalUsage = usage(chunk.usage);
    if (!Array.isArray(chunk.choices)) throw new OpenAiWireError("choices 必须是 array");
    if (chunk.choices.length === 0) continue;
    if (chunk.choices.length !== 1) throw new OpenAiWireError("只支持单一 choice");
    const choice = object(chunk.choices[0], "choice");
    if (choice.index !== 0) throw new OpenAiWireError("choice index 必须为 0");
    if (terminalReason) {
      if (isUsageOnlyRepeatedTerminal(chunk, choice, terminalReason, profile)) continue;
      throw new OpenAiWireError("finish_reason 后不得再有 choice delta");
    }
    const delta = object(choice.delta, "choice.delta");

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!textPart) {
        textPart = { type: "text", text: "", index: parts.length };
        parts.push(textPart);
        yield { version: 1, type: "part_started", index: textPart.index, part: { type: "text" } };
      }
      textPart.text += delta.content;
      yield { version: 1, type: "text_delta", index: textPart.index, delta: delta.content };
    }

    const reasoningField = profile.responseDialect.reasoningDeltaField;
    const reasoning = reasoningField ? delta[reasoningField] : undefined;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      if (!reasoningPart) {
        reasoningPart = { type: "reasoning", text: "", index: parts.length };
        parts.push(reasoningPart);
        yield {
          version: 1,
          type: "part_started",
          index: reasoningPart.index,
          part: { type: "reasoning" },
        };
      }
      reasoningPart.text += reasoning;
      yield {
        version: 1,
        type: "reasoning_delta",
        index: reasoningPart.index,
        delta: reasoning,
      };
    }

    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw new OpenAiWireError("tool_calls 必须是 array");
      for (const rawCall of delta.tool_calls) {
        const call = object(rawCall, "tool call delta");
        if (!Number.isSafeInteger(call.index) || (call.index as number) < 0) {
          throw new OpenAiWireError("tool call index 无效");
        }
        const wireIndex = call.index as number;
        let part = tools.get(wireIndex);
        const fn = object(call.function, "tool call function");
        if (!part) {
          if (descriptor.capabilities.toolCalls === "none") {
            throw new OpenAiWireError("model capability 不允许 tool call response");
          }
          if (descriptor.capabilities.toolCalls === "single" && tools.size > 0) {
            throw new OpenAiWireError("model capability 只允许单一 tool call");
          }
          if (typeof call.id !== "string" || typeof fn.name !== "string") {
            throw new OpenAiWireError("首个 tool call delta 必须包含 id 与 name");
          }
          part = {
            type: "tool_call",
            index: parts.length,
            wireIndex,
            callId: call.id,
            name: fn.name,
            argumentsText: "",
          };
          tools.set(wireIndex, part);
          parts.push(part);
          yield {
            version: 1,
            type: "part_started",
            index: part.index,
            part: { type: "tool_call", callId: part.callId, name: part.name },
          };
        } else if (
          (call.id !== undefined && call.id !== part.callId) ||
          (fn.name !== undefined && fn.name !== part.name)
        ) {
          throw new OpenAiWireError("tool call identity 在分片间发生变化");
        }
        if (fn.arguments !== undefined) {
          if (typeof fn.arguments !== "string") {
            throw new OpenAiWireError("tool arguments delta 必须是 string");
          }
          part.argumentsText += fn.arguments;
          yield {
            version: 1,
            type: "tool_call_delta",
            index: part.index,
            delta: { argumentsDelta: fn.arguments },
          };
        }
      }
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      terminalReason = finishReason(choice.finish_reason);
    }
  }

  if (!done) throw new OpenAiWireError("OpenAI stream 未收到 [DONE]");
  if (!terminalReason) throw new OpenAiWireError("OpenAI stream 缺少 finish_reason");
  for (const part of parts) yield { version: 1, type: "part_completed", index: part.index };
  const content = canonicalContent(parts);
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
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

async function httpFailure(
  response: OpenAiTransportResponse,
  profile: OpenAiCompatibleProfile,
): Promise<ModelFailure> {
  const body = await readErrorBody(response.body);
  let errorCode: string | undefined;
  try {
    const root = object(JSON.parse(body), "error response");
    const error = object(root.error, "error");
    if (typeof error.code === "string") errorCode = error.code;
  } catch (_error) {
    // Error payload is optional diagnostic input; status remains authoritative.
  }
  const common = {
    httpStatus: response.status,
    ...(response.headers["x-request-id"] ? { requestId: response.headers["x-request-id"] } : {}),
  };
  const message = (suffix: string) => `${profile.displayName} ${suffix}`;
  if (response.status === 401) {
    return {
      ...common,
      category: "authentication",
      retryable: false,
      message: message("authentication failed"),
    };
  }
  if (response.status === 403) {
    return {
      ...common,
      category: "permission",
      retryable: false,
      message: message("permission denied"),
    };
  }
  if (response.status === 402) {
    return { ...common, category: "quota", retryable: false, message: message("quota exhausted") };
  }
  if (response.status === 429 && errorCode === "insufficient_quota") {
    return { ...common, category: "quota", retryable: false, message: message("quota exhausted") };
  }
  if (response.status === 429) {
    const delay = retryAfter(response.headers);
    return {
      ...common,
      category: "rate_limit",
      retryable: true,
      ...(delay !== undefined ? { retryAfterMs: delay } : {}),
      message: message("rate limit exceeded"),
    };
  }
  if (response.status === 400 && errorCode === "content_policy_violation") {
    return {
      ...common,
      category: "content_filter",
      retryable: false,
      message: message("content filter rejected the request"),
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
  if (response.status >= 500) {
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
  profile: OpenAiCompatibleProfile,
): ModelFailure {
  if (error instanceof OpenAiStreamFailure) return error.failure;
  const message = (suffix: string) => `${profile.displayName} ${suffix}`;
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return { category: "cancelled", retryable: false, message: "Model Attempt 已取消" };
  }
  if (error instanceof OpenAiWireError || error instanceof SyntaxError) {
    return {
      category: "invalid_response",
      retryable: false,
      message: message("response protocol invalid"),
    };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { category: "timeout", retryable: true, message: message("transport timed out") };
  }
  if (error instanceof TypeError) {
    return { category: "network", retryable: true, message: message("network request failed") };
  }
  return { category: "adapter_bug", retryable: false, message: message("adapter failed") };
}

class OpenAiCompatibleModel implements Model {
  readonly descriptor: ModelDescriptor;
  readonly capabilities: ModelDescriptor["capabilities"];
  readonly #profile: OpenAiCompatibleProfile;
  readonly #credentials: CredentialResolver;
  readonly #transport: OpenAiTransport;

  constructor(
    descriptor: ModelDescriptor,
    profile: OpenAiCompatibleProfile,
    credentials: CredentialResolver,
    transport: OpenAiTransport,
  ) {
    this.descriptor = descriptor;
    this.capabilities = descriptor.capabilities;
    this.#profile = profile;
    this.#credentials = credentials;
    this.#transport = transport;
  }

  async *stream(request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelEvent> {
    yield { version: 1, type: "turn_started", attemptId: crypto.randomUUID() };
    const validation = validateRequest(request, this.descriptor, this.#profile);
    if (validation) {
      yield { version: 1, type: "turn_failed", failure: validation };
      return;
    }
    const timeoutSignal =
      options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    try {
      const signal = timeoutSignal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : options.signal;
      const resolution = await this.#credentials.resolve(this.#profile.auth, {
        signal,
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
        url: new URL("chat/completions", this.#profile.baseUrl).toString(),
        headers: {
          "content-type": "application/json",
          ...this.#profile.defaultHeaders,
          authorization: `Bearer ${resolution.credential.value.reveal()}`,
        },
        body: requestBody(request, this.descriptor, this.#profile),
        signal,
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
        failure:
          !options.signal.aborted && timeoutSignal?.aborted
            ? {
                category: "timeout",
                retryable: true,
                message: `${this.#profile.displayName} transport timed out`,
              }
            : thrownFailure(error, options.signal, this.#profile),
      };
    }
  }
}

export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleProviderOptions,
): OpenAiCompatibleProvider {
  const transport = options.transport ?? createFetchOpenAiTransport();
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
      return new OpenAiCompatibleModel(descriptor, options.profile, options.credentials, transport);
    },
  };
}
