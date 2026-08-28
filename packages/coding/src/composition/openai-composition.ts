import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type Clock,
  createAgent,
  createAgentHarness,
  createFixedRunPolicies,
  createTranscriptContextManager,
  type IdFactory,
  InMemorySessionRepository,
} from "@coding-agent/agent";
import {
  createModelRegistry,
  type InstructionPart,
  type ModelDescriptor,
  modelId,
  providerId,
} from "@coding-agent/model";
import {
  type CredentialResolver,
  type CredentialSource,
  createCredentialResolver,
  createEnvironmentCredentialSource,
  createLocalConfigCredentialSource,
} from "@coding-agent/model/auth";
import {
  createOpenAiCompatibleProvider,
  type OpenAiCompatibleProfile,
  type OpenAiTransport,
  openAiProfile,
  openRouterProfile,
} from "@coding-agent/model/providers/openai-compatible";
import { type CodingAgent, createCodingAgent } from "../app/coding-agent.js";
import { createCodingToolHost } from "../tools/coding-tool-host.js";

export interface OpenAiCodingAgentOptions {
  readonly workspaceRoot: string;
  readonly modelId?: string;
  readonly models?: readonly ModelDescriptor[];
  readonly credentialSources?: readonly CredentialSource[];
  readonly localCredentialPath?: string;
  readonly transport?: OpenAiTransport;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly instructions?: readonly InstructionPart[];
  readonly maxOutputTokens?: number;
}

export type OpenRouterCodingAgentOptions = OpenAiCodingAgentOptions;

export interface OpenAiCodingAgent {
  readonly agent: CodingAgent;
  readonly model: ModelDescriptor;
  dispose(): Promise<void>;
}

export type OpenRouterCodingAgent = OpenAiCodingAgent;

export class CodingCompositionError extends Error {
  readonly code: "CREDENTIAL_UNAVAILABLE" | "CREDENTIAL_RESOLUTION_FAILED";

  constructor(code: CodingCompositionError["code"], message: string) {
    super(message);
    this.name = "CodingCompositionError";
    this.code = code;
  }
}

const openAiProductionCatalog: readonly ModelDescriptor[] = [
  {
    providerId: providerId("openai"),
    modelId: modelId("gpt-5"),
    displayName: "GPT-5",
    capabilities: {
      toolCalls: "multiple",
      toolChoice: ["auto", "none", "required", "specific"],
      reasoning: true,
      reasoningReplay: false,
    },
    source: { kind: "built_in", id: "openai", revision: "2026-08-28" },
  },
];

const openRouterProductionCatalog: readonly ModelDescriptor[] = [
  {
    providerId: providerId("openrouter"),
    modelId: modelId("openrouter/free"),
    displayName: "OpenRouter Free Models Router",
    capabilities: {
      toolCalls: "multiple",
      toolChoice: ["auto", "none", "required", "specific"],
      reasoning: false,
      reasoningReplay: false,
      contextWindow: 200_000,
    },
    source: { kind: "built_in", id: "openrouter", revision: "2026-08-28" },
  },
];

interface CompositionDefinition {
  readonly profile: OpenAiCompatibleProfile;
  readonly catalog: readonly ModelDescriptor[];
  readonly defaultModelId: string;
  readonly environmentVariables: readonly {
    readonly sourceId: string;
    readonly variable: string;
  }[];
  readonly configurationRevision: string;
}

function defaultSources(
  workspaceRoot: string,
  definition: CompositionDefinition,
  localCredentialPath?: string,
): readonly CredentialSource[] {
  return [
    ...definition.environmentVariables.map(({ sourceId, variable }) =>
      createEnvironmentCredentialSource({
        id: sourceId,
        variables: { [definition.profile.auth.ref]: variable },
      }),
    ),
    createLocalConfigCredentialSource({
      id: "project-local-config",
      path: localCredentialPath ?? path.join(workspaceRoot, ".fast", "credentials.json"),
    }),
  ];
}

async function createCompatibleCodingAgent(
  options: OpenAiCodingAgentOptions,
  definition: CompositionDefinition,
): Promise<OpenAiCodingAgent> {
  const resolvedSecrets = new Set<string>();
  const baseCredentials = createCredentialResolver(
    options.credentialSources ??
      defaultSources(options.workspaceRoot, definition, options.localCredentialPath),
  );
  const credentials: CredentialResolver = {
    async resolve(request, resolveOptions) {
      const resolution = await baseCredentials.resolve(request, resolveOptions);
      if (resolution.status === "found") {
        resolvedSecrets.add(resolution.credential.value.reveal());
      }
      return resolution;
    },
  };
  const preflight = await credentials.resolve(definition.profile.auth);
  if (preflight.status === "missing") {
    throw new CodingCompositionError(
      "CREDENTIAL_UNAVAILABLE",
      `${definition.profile.displayName} credential 未配置`,
    );
  }
  if (preflight.status === "failed") {
    throw new CodingCompositionError(
      "CREDENTIAL_RESOLUTION_FAILED",
      `${definition.profile.displayName} credential 无法解析`,
    );
  }

  const registry = createModelRegistry();
  registry.registerProvider(
    createOpenAiCompatibleProvider({
      profile: definition.profile,
      credentials,
      models: options.models ?? definition.catalog,
      ...(options.transport ? { transport: options.transport } : {}),
    }),
  );
  const selectedModelId = modelId(options.modelId ?? definition.defaultModelId);
  const model = await registry.resolve({
    providerId: definition.profile.id,
    modelId: selectedModelId,
  });
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const ids: IdFactory =
    options.ids ??
    ({
      next(scope) {
        return `${scope}-${randomUUID()}`;
      },
    } satisfies IdFactory);
  const sessions = new InMemorySessionRepository({ clock, ids });
  const agent = createCodingAgent({
    sessions,
    harness: createAgentHarness({ agent: createAgent() }),
    model,
    tools: createCodingToolHost({
      workspaceRoot: options.workspaceRoot,
      redact: (value) =>
        [...resolvedSecrets].reduce((text, secret) => text.split(secret).join("[REDACTED]"), value),
    }),
    context: createTranscriptContextManager({
      instructions: options.instructions ?? [
        { type: "text", text: "你是 Fast coding agent。使用工具核验事实并完成 Coding Task。" },
      ],
      maxOutputTokens: options.maxOutputTokens ?? 4_096,
    }),
    policies: createFixedRunPolicies({ maxModelTurns: 16, maxModelAttempts: 20, maxRetries: 2 }),
    configurationRevision: definition.configurationRevision,
  });
  return {
    agent,
    model: model.descriptor,
    async dispose() {
      await sessions[Symbol.asyncDispose]();
    },
  };
}

export async function createOpenAiCodingAgent(
  options: OpenAiCodingAgentOptions,
): Promise<OpenAiCodingAgent> {
  return createCompatibleCodingAgent(options, {
    profile: openAiProfile,
    catalog: openAiProductionCatalog,
    defaultModelId: "gpt-5",
    environmentVariables: [
      { sourceId: "project-environment", variable: "FAST_OPENAI_API_KEY" },
      { sourceId: "openai-environment", variable: "OPENAI_API_KEY" },
    ],
    configurationRevision: "m1-openai-1",
  });
}

export async function createOpenRouterCodingAgent(
  options: OpenRouterCodingAgentOptions,
): Promise<OpenRouterCodingAgent> {
  return createCompatibleCodingAgent(options, {
    profile: openRouterProfile,
    catalog: openRouterProductionCatalog,
    defaultModelId: "openrouter/free",
    environmentVariables: [
      { sourceId: "project-openrouter-environment", variable: "FAST_OPENROUTER_API_KEY" },
      { sourceId: "openrouter-environment", variable: "OPENROUTER_API_KEY" },
    ],
    configurationRevision: "m1-openrouter-1",
  });
}
