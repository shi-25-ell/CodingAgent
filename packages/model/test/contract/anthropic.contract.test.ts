import { readFile } from "node:fs/promises";
import {
  collectModelTurn,
  type ModelDescriptor,
  type ModelRequest,
  modelId,
  providerId,
} from "@coding-agent/model";
import {
  type CredentialSource,
  createCredentialResolver,
  SecretString,
} from "@coding-agent/model/auth";
import {
  type AnthropicTransport,
  type AnthropicTransportRequest,
  anthropicProfile,
  createAnthropicProvider,
} from "@coding-agent/model/providers/anthropic";
import { describe, expect, it } from "vitest";

const descriptor: ModelDescriptor = {
  providerId: providerId("anthropic"),
  modelId: modelId("claude-sonnet"),
  displayName: "Claude Sonnet",
  capabilities: {
    toolCalls: "multiple",
    toolChoice: ["auto", "none", "required", "specific"],
    reasoning: true,
    reasoningReplay: true,
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
  },
  source: { kind: "built_in", id: "anthropic", revision: "fixture-1" },
};

const request: ModelRequest = {
  version: 1,
  instructions: [{ type: "text", text: "Use tools carefully." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "continue" }] },
    {
      role: "assistant",
      finishReason: "tool_calls",
      content: [
        { type: "reasoning", text: "prior", replayToken: "prior-signature" },
        { type: "tool_call", callId: "old-a", name: "read_file", arguments: { path: "a" } },
        { type: "tool_call", callId: "old-b", name: "search_text", arguments: { query: "b" } },
      ],
    },
    { role: "tool", callId: "old-a", content: "A", isError: false },
    { role: "tool", callId: "old-b", content: "B", isError: true },
  ],
  tools: [
    {
      name: "read_file",
      description: "read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "search_text",
      description: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],
  toolChoice: { kind: "auto" },
  output: { maxTokens: 1_024, reasoning: { enabled: true, budgetTokens: 512 } },
};

function credentials(source?: CredentialSource) {
  return createCredentialResolver([
    source ?? {
      id: "fixture",
      async resolve() {
        return {
          status: "found",
          credential: { kind: "api_key", value: new SecretString("fixture-secret") },
          sourceId: "fixture",
        };
      },
    },
  ]);
}

async function chunks(value: string, widths = [1, 7, 2, 19, 3]): Promise<AsyncIterable<string>> {
  return (async function* () {
    let cursor = 0;
    let width = 0;
    while (cursor < value.length) {
      const size = widths[width % widths.length] ?? 1;
      yield value.slice(cursor, cursor + size);
      cursor += size;
      width += 1;
    }
  })();
}

async function modelFor(transport: AnthropicTransport, source?: CredentialSource) {
  return createAnthropicProvider({
    profile: anthropicProfile,
    credentials: credentials(source),
    models: [descriptor],
    transport,
  }).createModel({ providerId: descriptor.providerId, modelId: descriptor.modelId });
}

describe("Anthropic native adapter", () => {
  it("maps native raw wire reasoning and multiple tool uses into the canonical Model contract", async () => {
    const fixture = await readFile(
      new URL("../../../../test/fixtures/anthropic/reasoning-tools.sse", import.meta.url),
      "utf8",
    );
    let sent: AnthropicTransportRequest | undefined;
    const model = await modelFor({
      async send(value) {
        sent = value;
        return { status: 200, headers: {}, body: await chunks(fixture) };
      },
    });

    const result = await collectModelTurn(
      model.stream(request, { signal: new AbortController().signal }),
    );

    expect(result).toEqual({
      status: "completed",
      response: {
        version: 1,
        content: [
          { type: "reasoning", text: "先检查", replayToken: "opaque-signature" },
          { type: "text", text: "我会读取并搜索。" },
          {
            type: "tool_call",
            callId: "call_read",
            name: "read_file",
            arguments: { path: "src/a.ts" },
          },
          {
            type: "tool_call",
            callId: "call_search",
            name: "search_text",
            arguments: { query: "needle" },
          },
        ],
        finishReason: "tool_calls",
        usage: {
          inputTokens: 20,
          outputTokens: 30,
          totalTokens: 50,
          cachedInputTokens: 4,
          reasoningTokens: 7,
        },
      },
    });
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.headers).toMatchObject({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "fixture-secret",
    });
    const body = JSON.parse(sent?.body ?? "") as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-sonnet",
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 512 },
      tool_choice: { type: "auto" },
    });
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "continue" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "prior", signature: "prior-signature" },
          { type: "tool_use", id: "old-a", name: "read_file", input: { path: "a" } },
          { type: "tool_use", id: "old-b", name: "search_text", input: { query: "b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "old-a", content: "A", is_error: false },
          { type: "tool_result", tool_use_id: "old-b", content: "B", is_error: true },
        ],
      },
    ]);
  });

  it.each([
    [
      "delta before start",
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
    ],
    [
      "out of order block",
      'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    ],
    ["malformed JSON", "event: message_start\ndata: {bad}\n\n"],
    ["truncated SSE", 'event: message_start\ndata: {"type":"message_start"}'],
  ])("maps %s to invalid_response", async (_label, wire) => {
    const model = await modelFor({
      async send() {
        return { status: 200, headers: {}, body: await chunks(wire) };
      },
    });
    const result = await collectModelTurn(
      model.stream({ ...request, messages: [] }, { signal: new AbortController().signal }),
    );
    expect(result).toMatchObject({
      status: "failed",
      failure: { category: "invalid_response", retryable: false },
    });
  });

  it("resolves credentials for every attempt without exposing the secret in failures", async () => {
    let resolutions = 0;
    const source: CredentialSource = {
      id: "rotating",
      async resolve() {
        resolutions += 1;
        return {
          status: "found",
          credential: {
            kind: "api_key",
            value: new SecretString(`rotating-secret-${resolutions}`),
          },
          sourceId: "rotating",
        };
      },
    };
    const model = await modelFor(
      {
        async send() {
          return {
            status: 401,
            headers: { "request-id": "req-redacted" },
            body: await chunks(
              '{"error":{"type":"authentication_error","message":"rotating-secret"}}',
            ),
          };
        },
      },
      source,
    );
    const first = await collectModelTurn(
      model.stream(request, { signal: new AbortController().signal }),
    );
    const second = await collectModelTurn(
      model.stream(request, { signal: new AbortController().signal }),
    );
    expect(resolutions).toBe(2);
    expect(first).toMatchObject({
      status: "failed",
      failure: { category: "authentication", httpStatus: 401, requestId: "req-redacted" },
    });
    expect(JSON.stringify([first, second])).not.toContain("rotating-secret");
  });

  it.each([
    [403, "permission", false, undefined],
    [429, "rate_limit", true, 2_000],
    [529, "provider_unavailable", true, undefined],
  ] as const)(
    "maps HTTP %s without surfacing provider error text",
    async (status, category, retryable, retryAfterMs) => {
      const model = await modelFor({
        async send() {
          return {
            status,
            headers: {
              "request-id": "req-mapped",
              ...(status === 429 ? { "retry-after": "2" } : {}),
            },
            body: await chunks(
              '{"error":{"type":"provider_error","message":"private provider detail"}}',
            ),
          };
        },
      });
      const result = await collectModelTurn(
        model.stream(request, { signal: new AbortController().signal }),
      );
      expect(result).toMatchObject({
        status: "failed",
        failure: {
          category,
          retryable,
          requestId: "req-mapped",
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      });
      expect(JSON.stringify(result)).not.toContain("private provider detail");
    },
  );

  it("distinguishes timeout, caller abort, iterator failure, missing auth and capability rejection", async () => {
    const timeoutModel = await modelFor({
      async send(value) {
        await new Promise<void>((_resolve, reject) => {
          value.signal.addEventListener(
            "abort",
            () => reject(value.signal.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    });
    const timeout = await collectModelTurn(
      timeoutModel.stream(request, { signal: new AbortController().signal, timeoutMs: 5 }),
    );
    expect(timeout).toMatchObject({ status: "failed", failure: { category: "timeout" } });

    const controller = new AbortController();
    controller.abort();
    const aborted = await collectModelTurn(
      timeoutModel.stream(request, { signal: controller.signal }),
    );
    expect(aborted).toMatchObject({ status: "failed", failure: { category: "cancelled" } });

    const iteratorModel = await modelFor({
      async send() {
        return {
          status: 200,
          headers: {},
          body: (async function* () {
            yield* [];
            throw new Error("fixture secret iterator detail");
          })(),
        };
      },
    });
    const iterator = await collectModelTurn(
      iteratorModel.stream(request, { signal: new AbortController().signal }),
    );
    expect(iterator).toMatchObject({ status: "failed", failure: { category: "adapter_bug" } });
    expect(JSON.stringify(iterator)).not.toContain("fixture secret");

    const missing = await modelFor(
      {
        async send() {
          throw new Error("must not send");
        },
      },
      {
        id: "missing",
        async resolve() {
          return { status: "missing" };
        },
      },
    );
    expect(
      await collectModelTurn(missing.stream(request, { signal: new AbortController().signal })),
    ).toMatchObject({
      status: "failed",
      failure: { category: "not_configured" },
    });

    const unsupported = await modelFor({
      async send() {
        throw new Error("must not send");
      },
    });
    expect(
      await collectModelTurn(
        unsupported.stream(
          { ...request, output: { maxTokens: 20_000 } },
          { signal: new AbortController().signal },
        ),
      ),
    ).toMatchObject({ status: "failed", failure: { category: "invalid_request" } });
  });
});
