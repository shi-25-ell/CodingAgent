import { describe, expect, it } from "bun:test";
import {
  collectModelTurn,
  type ModelDescriptor,
  type ModelRequest,
  modelId,
} from "@coding-agent/model";
import { createCredentialResolver, SecretString } from "@coding-agent/model/auth";
import {
  createOpenAiCompatibleProvider,
  deepSeekProfile,
  glmProfile,
  type OpenAiCompatibleProfile,
  type OpenAiTransportRequest,
} from "@coding-agent/model/providers/openai-compatible";

const request: ModelRequest = {
  version: 1,
  instructions: [{ type: "text", text: "system" }],
  messages: [
    { role: "user", content: [{ type: "text", text: "task" }] },
    {
      role: "assistant",
      finishReason: "tool_calls",
      content: [
        { type: "reasoning", text: "retain this reasoning" },
        { type: "tool_call", callId: "old", name: "read_file", arguments: { path: "a" } },
      ],
    },
    { role: "tool", callId: "old", content: "ok", isError: false },
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
  ],
  output: { maxTokens: 2_048 },
};

async function exercise(profile: OpenAiCompatibleProfile): Promise<OpenAiTransportRequest> {
  const descriptor: ModelDescriptor = {
    providerId: profile.id,
    modelId: modelId(profile.id === deepSeekProfile.id ? "deepseek-v4-pro" : "glm-5.2"),
    displayName: profile.displayName,
    capabilities: {
      toolCalls: "multiple",
      toolChoice: ["auto"],
      reasoning: true,
      reasoningReplay: true,
      contextWindow: 200_000,
      maxOutputTokens: 131_072,
    },
    source: { kind: "built_in", id: profile.id, revision: "profile-fixture" },
  };
  let sent: OpenAiTransportRequest | undefined;
  const provider = createOpenAiCompatibleProvider({
    profile,
    models: [descriptor],
    credentials: createCredentialResolver([
      {
        id: "fixture",
        async resolve(credentialRequest) {
          expect(String(credentialRequest.ref)).toBe(
            profile.id === deepSeekProfile.id ? "deepseek.default" : "glm.default",
          );
          return {
            status: "found",
            credential: { kind: "bearer", value: new SecretString("profile-secret") },
            sourceId: "fixture",
          };
        },
      },
    ]),
    transport: {
      async send(value) {
        sent = value;
        return {
          status: 200,
          headers: {},
          body: (async function* () {
            yield 'data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"think","content":"done"},"finish_reason":"stop"}]}\n\n';
            yield 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n';
            yield "data: [DONE]\n\n";
          })(),
        };
      },
    },
  });
  const model = await provider.createModel({
    providerId: descriptor.providerId,
    modelId: descriptor.modelId,
  });
  expect(
    await collectModelTurn(model.stream(request, { signal: new AbortController().signal })),
  ).toMatchObject({
    status: "completed",
    response: {
      content: [
        { type: "text", text: "done" },
        { type: "reasoning", text: "think" },
      ],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    },
  });
  if (!sent) throw new Error("transport 未收到 request");
  return sent;
}

describe("OpenAI-compatible production profiles", () => {
  it("encodes the explicit DeepSeek endpoint, auth and reasoning replay dialect", async () => {
    const sent = await exercise(deepSeekProfile);
    expect(sent.url).toBe("https://api.deepseek.com/chat/completions");
    expect(sent.headers.authorization).toBe("Bearer profile-secret");
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      max_tokens: 2048,
      stream_options: { include_usage: true },
      thinking: { type: "enabled" },
    });
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", reasoning_content: "retain this reasoning" }),
    );
    expect(body.tools).toEqual([
      {
        type: "function",
        function: expect.not.objectContaining({ strict: expect.anything() }),
      },
    ]);
  });

  it("encodes the explicit GLM endpoint and tool-stream dialect without OpenAI stream_options", async () => {
    const sent = await exercise(glmProfile);
    expect(sent.url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(sent.headers.authorization).toBe("Bearer profile-secret");
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "glm-5.2",
      max_tokens: 2048,
      thinking: { type: "enabled" },
      tool_stream: true,
    });
    expect(body).not.toHaveProperty("stream_options");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });
});
