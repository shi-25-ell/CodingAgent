import type {
  Model,
  ModelCapabilities,
  ModelDescriptor,
  ModelProvider,
  ModelQuery,
  ModelRef,
  ModelRegistry,
  ProviderId,
  ProviderSummary,
  Registration,
} from "../api/contracts.js";

function supports(
  available: ModelCapabilities,
  required: Partial<ModelCapabilities> | undefined,
): boolean {
  if (!required) return true;
  if (required.toolCalls !== undefined && available.toolCalls !== required.toolCalls) return false;
  if (
    required.toolChoice !== undefined &&
    !required.toolChoice.every((choice) => available.toolChoice.includes(choice))
  ) {
    return false;
  }
  if (required.reasoning !== undefined && available.reasoning !== required.reasoning) return false;
  if (
    required.reasoningReplay !== undefined &&
    available.reasoningReplay !== required.reasoningReplay
  ) {
    return false;
  }
  if (
    required.contextWindow !== undefined &&
    (available.contextWindow === undefined || available.contextWindow < required.contextWindow)
  ) {
    return false;
  }
  if (
    required.maxOutputTokens !== undefined &&
    (available.maxOutputTokens === undefined ||
      available.maxOutputTokens < required.maxOutputTokens)
  ) {
    return false;
  }
  return true;
}

export class ModelRegistryError extends Error {
  readonly code: "MODEL_PROVIDER_CONFLICT" | "MODEL_PROVIDER_NOT_FOUND" | "MODEL_NOT_FOUND";

  constructor(code: ModelRegistryError["code"], message: string) {
    super(message);
    this.name = "ModelRegistryError";
    this.code = code;
  }
}

class DefaultModelRegistry implements ModelRegistry {
  readonly #providers = new Map<ProviderId, ModelProvider>();

  registerProvider(provider: ModelProvider): Registration {
    if (this.#providers.has(provider.id)) {
      throw new ModelRegistryError("MODEL_PROVIDER_CONFLICT", `Provider ${provider.id} 已注册`);
    }
    this.#providers.set(provider.id, provider);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        if (this.#providers.get(provider.id) === provider) this.#providers.delete(provider.id);
      },
    };
  }

  unregisterProvider(id: ProviderId): boolean {
    return this.#providers.delete(id);
  }

  listProviders(): readonly ProviderSummary[] {
    return [...this.#providers.keys()].map((id) => ({ id }));
  }

  async listModels(query?: ModelQuery): Promise<readonly ModelDescriptor[]> {
    const providers = query?.providerId
      ? [this.#providers.get(query.providerId)].filter(
          (provider): provider is ModelProvider => provider !== undefined,
        )
      : [...this.#providers.values()];
    const catalogs = await Promise.all(
      providers.map((provider) =>
        provider.listModels(query?.signal ? { signal: query.signal } : undefined),
      ),
    );
    const precedence: Readonly<Record<ModelDescriptor["source"]["kind"], number>> = {
      built_in: 0,
      provider: 1,
      extension: 2,
      testing: 3,
    };
    const merged = new Map<string, ModelDescriptor>();
    for (const descriptor of catalogs.flat()) {
      const key = `${descriptor.providerId}\u0000${descriptor.modelId}`;
      const current = merged.get(key);
      if (!current || precedence[descriptor.source.kind] > precedence[current.source.kind]) {
        merged.set(key, descriptor);
      }
    }
    return [...merged.values()].filter((descriptor) =>
      supports(descriptor.capabilities, query?.require),
    );
  }

  async resolve(ref: ModelRef): Promise<Model> {
    const provider = this.#providers.get(ref.providerId);
    if (!provider) {
      throw new ModelRegistryError("MODEL_PROVIDER_NOT_FOUND", `Provider ${ref.providerId} 未注册`);
    }
    return provider.createModel(ref);
  }
}

export function createModelRegistry(): ModelRegistry {
  return new DefaultModelRegistry();
}
