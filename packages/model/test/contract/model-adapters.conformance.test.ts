import { describe, expect, it } from "bun:test";
import {
  collectModelTurn,
  type Model,
  type ModelDescriptor,
  type ModelRequest,
  modelId,
  providerId,
} from "@coding-agent/model";
import { createCredentialResolver, SecretString } from "@coding-agent/model/auth";
import { anthropicProfile, createAnthropicProvider } from "@coding-agent/model/providers/anthropic";
import {
  createOpenAiCompatibleProvider,
  openAiProfile,
} from "@coding-agent/model/providers/openai-compatible";

const request: ModelRequest = {
  version: 1,
  instructions: [{ type: "text", text: "system" }],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  output: { maxTokens: 32 },
};

function credentials() {
  return createCredentialResolver([
    {
      id: "conformance",
      async resolve() {
        return {
          status: "found" as const,
          credential: { kind: "api_key" as const, value: new SecretString("conformance-secret") },
          sourceId: "conformance",
        };
      },
    },
  ]);
}

function descriptor(provider: "openai" | "anthropic"): ModelDescriptor {
  return {
    providerId: providerId(provider),
    modelId: modelId(`${provider}-conformance`),
    displayName: `${provider} conformance`,
    capabilities: {
      toolCalls: "multiple",
      toolChoice: ["auto"],
      reasoning: false,
      reasoningReplay: false,
      maxOutputTokens: 64,
    },
    source: { kind: "testing", id: provider, revision: "conformance-1" },
  };
}

interface AdapterFactory {
  readonly createSuccessful: (sent: { count: number }) => Promise<Model>;
  readonly createPending: (sent: { count: number }) => Promise<Model>;
}

function defineModelConformance(name: string, factory: AdapterFactory): void {
  describe(`${name} Model conformance`, () => {
    it("produces one canonical terminal response", async () => {
      const sent = { count: 0 };
      const model = await factory.createSuccessful(sent);
      const events = [];
      for await (const event of model.stream(request, { signal: new AbortController().signal })) {
        events.push(event);
      }
      expect(sent.count).toBe(1);
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(0);
      expect(
        await collectModelTurn(
          (async function* () {
            yield* events;
          })(),
        ),
      ).toEqual({
        status: "completed",
        response: {
          version: 1,
          content: [{ type: "text", text: "ok" }],
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      });
    });

    it("maps a pre-aborted call to one cancelled terminal without transport I/O", async () => {
      const sent = { count: 0 };
      const model = await factory.createPending(sent);
      const controller = new AbortController();
      controller.abort();
      const result = await collectModelTurn(model.stream(request, { signal: controller.signal }));
      expect(sent.count).toBe(0);
      expect(result).toMatchObject({
        status: "failed",
        failure: { category: "cancelled", retryable: false },
      });
    });
  });
}

defineModelConformance("OpenAI-compatible", {
  async createSuccessful(sent) {
    const model = descriptor("openai");
    return createOpenAiCompatibleProvider({
      profile: openAiProfile,
      credentials: credentials(),
      models: [model],
      transport: {
        async send() {
          sent.count += 1;
          return {
            status: 200,
            headers: {},
            body: (async function* () {
              yield 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n';
              yield "data: [DONE]\n\n";
            })(),
          };
        },
      },
    }).createModel({ providerId: model.providerId, modelId: model.modelId });
  },
  async createPending(sent) {
    const model = descriptor("openai");
    return createOpenAiCompatibleProvider({
      profile: openAiProfile,
      credentials: credentials(),
      models: [model],
      transport: {
        async send() {
          sent.count += 1;
          throw new Error("must not send");
        },
      },
    }).createModel({ providerId: model.providerId, modelId: model.modelId });
  },
});

defineModelConformance("Anthropic", {
  async createSuccessful(sent) {
    const model = descriptor("anthropic");
    return createAnthropicProvider({
      profile: anthropicProfile,
      credentials: credentials(),
      models: [model],
      transport: {
        async send() {
          sent.count += 1;
          return {
            status: 200,
            headers: {},
            body: (async function* () {
              yield 'event: message_start\ndata: {"type":"message_start","message":{"content":[],"usage":{"input_tokens":2,"output_tokens":0}}}\n\n';
              yield 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
              yield 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n';
              yield 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
              yield 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';
              yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
            })(),
          };
        },
      },
    }).createModel({ providerId: model.providerId, modelId: model.modelId });
  },
  async createPending(sent) {
    const model = descriptor("anthropic");
    return createAnthropicProvider({
      profile: anthropicProfile,
      credentials: credentials(),
      models: [model],
      transport: {
        async send() {
          sent.count += 1;
          throw new Error("must not send");
        },
      },
    }).createModel({ providerId: model.providerId, modelId: model.modelId });
  },
});
