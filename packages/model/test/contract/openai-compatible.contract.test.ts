import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialResolver,
  createEnvironmentCredentialSource,
} from "../../src/auth/index.js";
import { collectModelTurn, type ModelRequest, modelId, providerId } from "../../src/index.js";
import {
  createFetchOpenAiTransport,
  createOpenAiCompatibleProvider,
  type OpenAiTransport,
  type OpenAiTransportRequest,
  openAiProfile,
} from "../../src/providers/openai-compatible/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function* fragments(values: readonly string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

const minimalRequest: ModelRequest = {
  version: 1,
  instructions: [],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  output: { maxTokens: 32 },
};

function testDescriptor(toolCalls: "none" | "single" | "multiple" = "multiple") {
  return {
    providerId: providerId("openai"),
    modelId: modelId("gpt-test"),
    displayName: "GPT Test",
    capabilities: {
      toolCalls,
      toolChoice: ["auto", "none", "required", "specific"] as const,
      reasoning: false,
      reasoningReplay: false,
    },
    source: { kind: "built_in" as const, id: "openai", revision: "1" },
  };
}

async function createTestModel(
  transport: OpenAiTransport,
  toolCalls: "none" | "single" | "multiple" = "multiple",
) {
  const provider = createOpenAiCompatibleProvider({
    profile: openAiProfile,
    credentials: createCredentialResolver([
      createEnvironmentCredentialSource({
        id: "environment",
        values: { FAST_OPENAI_API_KEY: `credential-${randomUUID()}` },
        variables: { "openai.default": "FAST_OPENAI_API_KEY" },
      }),
    ]),
    transport,
    models: [testDescriptor(toolCalls)],
  });
  return provider.createModel({ providerId: providerId("openai"), modelId: modelId("gpt-test") });
}

describe("OpenAI-compatible Model contract", () => {
  it("default fetch transport 保留 status/headers 并增量解码 body", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode("data: one\n"));
                controller.enqueue(encoder.encode("data: two\n"));
                controller.close();
              },
            }),
            { status: 202, headers: { "X-Request-Id": "fetch-1" } },
          ),
      ),
    );
    const controller = new AbortController();
    const result = await createFetchOpenAiTransport().send({
      url: "https://example.invalid/v1/chat/completions",
      headers: { authorization: "Bearer hidden" },
      body: "{}",
      signal: controller.signal,
    });
    const chunks: string[] = [];
    for await (const chunk of result.body) chunks.push(chunk);

    expect(result).toMatchObject({ status: 202, headers: { "x-request-id": "fetch-1" } });
    expect(chunks.join("")).toBe("data: one\ndata: two\n");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("credential missing 映射为 not_configured，且不发网", async () => {
    let calls = 0;
    const provider = createOpenAiCompatibleProvider({
      profile: openAiProfile,
      credentials: createCredentialResolver([]),
      transport: {
        async send() {
          calls += 1;
          throw new Error("不得发网");
        },
      },
      models: [testDescriptor()],
    });
    const model = await provider.createModel({
      providerId: providerId("openai"),
      modelId: modelId("gpt-test"),
    });

    await expect(
      collectModelTurn(model.stream(minimalRequest, { signal: new AbortController().signal })),
    ).resolves.toEqual({
      status: "failed",
      failure: {
        category: "not_configured",
        retryable: false,
        message: "OpenAI credential 未配置",
      },
    });
    expect(calls).toBe(0);
  });

  it("把 canonical request 映射到 wire，并严格归约 fragmented SSE tool call", async () => {
    const credential = `credential-${randomUUID()}`;
    const requests: OpenAiTransportRequest[] = [];
    const transport: OpenAiTransport = {
      async send(request) {
        requests.push(request);
        return {
          status: 200,
          headers: { "x-request-id": "request-1" },
          body: fragments([
            'data: {"id":"chat-1","choices":[{"index":0,"delta":{"role":"assistant","content":"已"},"finish_reason":null}]}\n',
            '\ndata: {"id":"chat-1","choices":[{"index":0,"delta":{"content":"读取","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
            'data: {"id":"chat-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"src/a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: {"id":"chat-1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\ndata: [DONE]\n\n',
          ]),
        };
      },
    };
    const provider = createOpenAiCompatibleProvider({
      profile: openAiProfile,
      credentials: createCredentialResolver([
        createEnvironmentCredentialSource({
          id: "environment",
          values: { FAST_OPENAI_API_KEY: credential },
          variables: { "openai.default": "FAST_OPENAI_API_KEY" },
        }),
      ]),
      transport,
      models: [
        {
          providerId: providerId("openai"),
          modelId: modelId("gpt-test"),
          displayName: "GPT Test",
          capabilities: {
            toolCalls: "multiple",
            toolChoice: ["auto", "none", "required", "specific"],
            reasoning: false,
            reasoningReplay: false,
          },
          source: { kind: "built_in", id: "openai", revision: "1" },
        },
      ],
    });
    const model = await provider.createModel({
      providerId: providerId("openai"),
      modelId: modelId("gpt-test"),
    });
    const request: ModelRequest = {
      version: 1,
      instructions: [{ type: "text", text: "可靠地完成任务" }],
      messages: [{ role: "user", content: [{ type: "text", text: "读文件" }] }],
      tools: [
        {
          name: "read_file",
          description: "读取 UTF-8 文件",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      toolChoice: { kind: "auto" },
      output: { maxTokens: 128 },
    };

    const result = await collectModelTurn(
      model.stream(request, { signal: new AbortController().signal }),
    );

    expect(result).toEqual({
      status: "completed",
      response: {
        version: 1,
        content: [
          { type: "text", text: "已读取" },
          {
            type: "tool_call",
            callId: "call-1",
            name: "read_file",
            arguments: { path: "src/a.ts" },
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${credential}`);
    expect(JSON.parse(requests[0]?.body ?? "")).toMatchObject({
      model: "gpt-test",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "developer", content: "可靠地完成任务" },
        { role: "user", content: "读文件" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read_file", strict: true },
        },
      ],
    });
  });

  it("capability 不满足时在发网前拒绝，不做静默 downgrade", async () => {
    let calls = 0;
    const model = await createTestModel(
      {
        async send() {
          calls += 1;
          throw new Error("不得调用 transport");
        },
      },
      "none",
    );
    const result = await collectModelTurn(
      model.stream(
        {
          ...minimalRequest,
          tools: [
            {
              name: "read_file",
              description: "read",
              inputSchema: { type: "object", additionalProperties: false },
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    );

    expect(result).toEqual({
      status: "failed",
      failure: {
        category: "invalid_request",
        retryable: false,
        message: "所选 model 不支持 tool calls",
      },
    });
    expect(calls).toBe(0);
  });

  it.each([
    { status: 401, body: "{}", category: "authentication", retryable: false },
    { status: 403, body: "{}", category: "permission", retryable: false },
    { status: 429, body: "{}", category: "rate_limit", retryable: true },
    {
      status: 429,
      body: '{"error":{"code":"insufficient_quota"}}',
      category: "quota",
      retryable: false,
    },
    { status: 408, body: "{}", category: "timeout", retryable: true },
    { status: 400, body: "{}", category: "invalid_request", retryable: false },
    {
      status: 400,
      body: '{"error":{"code":"content_policy_violation"}}',
      category: "content_filter",
      retryable: false,
    },
    { status: 503, body: "{}", category: "provider_unavailable", retryable: true },
  ])("把 HTTP $status 归一化为 $category，且不 retry", async (scenario) => {
    let calls = 0;
    const model = await createTestModel({
      async send() {
        calls += 1;
        return {
          status: scenario.status,
          headers: { "x-request-id": "request-failure", "retry-after": "2" },
          body: fragments([scenario.body]),
        };
      },
    });

    const result = await collectModelTurn(
      model.stream(minimalRequest, { signal: new AbortController().signal }),
    );

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        category: scenario.category,
        retryable: scenario.retryable,
        httpStatus: scenario.status,
        requestId: "request-failure",
      },
    });
    expect(calls).toBe(1);
  });

  it.each([
    { error: new TypeError("socket failed"), category: "network", retryable: true },
    {
      error: Object.assign(new Error("deadline"), { name: "TimeoutError" }),
      category: "timeout",
      retryable: true,
    },
    { error: new Error("unexpected"), category: "adapter_bug", retryable: false },
  ])("归一化 transport throw 为 $category，且不 retry", async (scenario) => {
    let calls = 0;
    const model = await createTestModel({
      async send() {
        calls += 1;
        throw scenario.error;
      },
    });

    const result = await collectModelTurn(
      model.stream(minimalRequest, { signal: new AbortController().signal }),
    );

    expect(result).toMatchObject({
      status: "failed",
      failure: { category: scenario.category, retryable: scenario.retryable },
    });
    expect(calls).toBe(1);
  });

  it("把 malformed/断流映射为 invalid_response，并允许 missing usage", async () => {
    const malformed = await createTestModel({
      async send() {
        return { status: 200, headers: {}, body: fragments(["data: {bad}\n\n"]) };
      },
    });
    await expect(
      collectModelTurn(malformed.stream(minimalRequest, { signal: new AbortController().signal })),
    ).resolves.toMatchObject({ status: "failed", failure: { category: "invalid_response" } });

    const withoutUsage = await createTestModel({
      async send() {
        return {
          status: 200,
          headers: {},
          body: fragments([
            'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      },
    });
    await expect(
      collectModelTurn(
        withoutUsage.stream(minimalRequest, { signal: new AbortController().signal }),
      ),
    ).resolves.toEqual({
      status: "completed",
      response: { version: 1, content: [{ type: "text", text: "ok" }], finishReason: "stop" },
    });
  });

  it.each([
    ['data: {"choices":[{"index":1,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'],
    [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read_file","arguments":"[]"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    ],
    ['data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n'],
    ["data: [DONE]\n\ndata: {}\n\n"],
    ['data: {"choices":"bad"}\n\n'],
  ])("拒绝 raw-wire 协议异常 %#", async (wire) => {
    const model = await createTestModel({
      async send() {
        return { status: 200, headers: {}, body: fragments([wire]) };
      },
    });
    await expect(
      collectModelTurn(model.stream(minimalRequest, { signal: new AbortController().signal })),
    ).resolves.toMatchObject({ status: "failed", failure: { category: "invalid_response" } });
  });

  it.each([
    {
      name: "strict schema",
      request: {
        ...minimalRequest,
        tools: [{ name: "bad", description: "bad", inputSchema: { type: "object" } }],
      },
    },
    {
      name: "specific tool missing",
      request: {
        ...minimalRequest,
        toolChoice: { kind: "specific" as const, toolName: "missing" },
      },
    },
    {
      name: "reasoning replay",
      request: {
        ...minimalRequest,
        messages: [
          {
            role: "assistant" as const,
            content: [{ type: "reasoning" as const, text: "private" }],
            finishReason: "stop" as const,
          },
        ],
      },
    },
  ])("发网前拒绝 capability/request mismatch: $name", async ({ request }) => {
    let calls = 0;
    const model = await createTestModel({
      async send() {
        calls += 1;
        throw new Error("不得发网");
      },
    });
    await expect(
      collectModelTurn(
        model.stream(request as ModelRequest, { signal: new AbortController().signal }),
      ),
    ).resolves.toMatchObject({ status: "failed", failure: { category: "invalid_request" } });
    expect(calls).toBe(0);
  });

  it("abort 前不发网，mid-stream abort 归一化为 cancelled", async () => {
    let calls = 0;
    const model = await createTestModel({
      async send(request) {
        calls += 1;
        request.signal.throwIfAborted();
        return {
          status: 200,
          headers: {},
          body: fragments(['data: {"choices":[{"index":0,"delta":{},"finish_reason":null}]}\n\n']),
        };
      },
    });
    const controller = new AbortController();
    controller.abort();

    const result = await collectModelTurn(
      model.stream(minimalRequest, { signal: controller.signal }),
    );
    expect(result).toMatchObject({ status: "failed", failure: { category: "cancelled" } });
    expect(calls).toBe(0);

    const midStreamController = new AbortController();
    const midStream = await createTestModel({
      async send() {
        return {
          status: 200,
          headers: {},
          body: (async function* () {
            yield 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
            midStreamController.abort();
            throw new DOMException("Aborted", "AbortError");
          })(),
        };
      },
    });
    await expect(
      collectModelTurn(midStream.stream(minimalRequest, { signal: midStreamController.signal })),
    ).resolves.toMatchObject({ status: "failed", failure: { category: "cancelled" } });
  });

  it("provider 在 catalog 边界校验 identity，并支持 abortable listing", async () => {
    const credentials = createCredentialResolver([]);
    expect(() =>
      createOpenAiCompatibleProvider({
        profile: openAiProfile,
        credentials,
        transport: {
          async send() {
            throw new Error("unused");
          },
        },
        models: [{ ...testDescriptor(), providerId: providerId("other") }],
      }),
    ).toThrow("providerId");

    const provider = createOpenAiCompatibleProvider({
      profile: openAiProfile,
      credentials,
      transport: {
        async send() {
          throw new Error("unused");
        },
      },
      models: [testDescriptor()],
    });
    await expect(
      provider.createModel({ providerId: providerId("other"), modelId: modelId("gpt-test") }),
    ).rejects.toMatchObject({ code: "MODEL_PROVIDER_NOT_FOUND" });
    await expect(
      provider.createModel({ providerId: providerId("openai"), modelId: modelId("missing") }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.listModels({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
