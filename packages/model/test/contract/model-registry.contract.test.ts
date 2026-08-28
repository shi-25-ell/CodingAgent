import { describe, expect, it } from "vitest";
import {
  createModelRegistry,
  type Model,
  type ModelDescriptor,
  type ModelProvider,
  modelId,
  providerId,
} from "../../src/index.js";

function provider(id: string, models: readonly ModelDescriptor[] = []): ModelProvider {
  const created = new Map(models.map((descriptor) => [descriptor.modelId, descriptor]));
  return {
    id: providerId(id),
    async listModels() {
      return models;
    },
    async createModel(input): Promise<Model> {
      const descriptor = created.get(input.modelId);
      if (!descriptor) throw new Error("unknown model");
      return {
        descriptor,
        capabilities: descriptor.capabilities,
        stream() {
          throw new Error("此测试不调用 model");
        },
      };
    },
  };
}

function descriptor(source: ModelDescriptor["source"]): ModelDescriptor {
  return {
    providerId: providerId("openai"),
    modelId: modelId("gpt-test"),
    displayName: source.kind,
    capabilities: {
      toolCalls: "multiple",
      toolChoice: ["auto", "none", "required", "specific"],
      reasoning: true,
      reasoningReplay: false,
    },
    source,
  };
}

describe("ModelRegistry", () => {
  it("拒绝重复 provider，并在 registration dispose 后允许重新注册", () => {
    const registry = createModelRegistry();
    const registration = registry.registerProvider(provider("openai"));

    expect(registry.listProviders()).toEqual([{ id: providerId("openai") }]);
    expect(() => registry.registerProvider(provider("openai"))).toThrowError(
      expect.objectContaining({ code: "MODEL_PROVIDER_CONFLICT" }),
    );

    registration.dispose();
    expect(registry.listProviders()).toEqual([]);
    expect(() => registry.registerProvider(provider("openai"))).not.toThrow();
  });

  it("按显式 provenance precedence 合并 catalog，并只通过对应 provider 解析 model", async () => {
    const registry = createModelRegistry();
    registry.registerProvider(
      provider("openai", [
        descriptor({ kind: "built_in", id: "builtin", revision: "1" }),
        descriptor({ kind: "provider", id: "discovery", revision: "2" }),
      ]),
    );

    await expect(registry.listModels()).resolves.toEqual([
      descriptor({ kind: "provider", id: "discovery", revision: "2" }),
    ]);
    await expect(
      registry.resolve({ providerId: providerId("openai"), modelId: modelId("gpt-test") }),
    ).resolves.toMatchObject({ descriptor: { displayName: "provider" } });

    expect(registry.unregisterProvider(providerId("openai"))).toBe(true);
    await expect(
      registry.resolve({ providerId: providerId("openai"), modelId: modelId("gpt-test") }),
    ).rejects.toMatchObject({ code: "MODEL_PROVIDER_NOT_FOUND" });
  });

  it("按 provider 与所需 capability 查询 catalog", async () => {
    const registry = createModelRegistry();
    registry.registerProvider(provider("other", []));
    registry.registerProvider(
      provider("openai", [descriptor({ kind: "built_in", id: "builtin", revision: "1" })]),
    );

    await expect(
      registry.listModels({
        providerId: providerId("openai"),
        require: { toolCalls: "multiple", toolChoice: ["specific"], reasoning: true },
      }),
    ).resolves.toHaveLength(1);
    await expect(
      registry.listModels({ providerId: providerId("openai"), require: { reasoningReplay: true } }),
    ).resolves.toEqual([]);
    await expect(registry.listModels({ providerId: providerId("missing") })).resolves.toEqual([]);
    expect(registry.unregisterProvider(providerId("missing"))).toBe(false);
  });
});
