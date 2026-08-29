import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ArtifactStore,
  type Clock,
  type ContextManager,
  createAgent,
  createAgentHarness,
  createArtifactPreviewContextSource,
  createCheckpointContextSource,
  createContextManager,
  createCurrentTaskContextSource,
  createFixedRunPolicies,
  createQueueContextSource,
  createRunBoundaryContextSource,
  createSummaryCompactionStrategy,
  createSystemToolContextSource,
  createTranscriptContextSource,
  type IdFactory,
  type SessionRepository,
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
  type AnthropicProfile,
  type AnthropicTransport,
  anthropicProfile,
  createAnthropicProvider,
} from "@coding-agent/model/providers/anthropic";
import {
  createOpenAiCompatibleProvider,
  deepSeekProfile,
  glmProfile,
  type OpenAiCompatibleProfile,
  type OpenAiTransport,
  openAiProfile,
  openRouterProfile,
} from "@coding-agent/model/providers/openai-compatible";
import { createSqlitePersistence } from "@coding-agent/sqlite";
import { createNodeLocalExecutionPorts } from "../adapters/node-local-execution-adapters.js";
import { type CodingAgent, createCodingAgent } from "../app/coding-agent.js";
import { createProjectInstructionsSnapshot } from "../context/project-instructions.js";
import { type ApprovalBridge, createApprovalBridge } from "../permissions/approval-bridge.js";
import {
  createBuiltInSkillSource,
  createProjectSkillSource,
  createSkillRegistry,
  createUserSkillSource,
  type StaticSkillDefinition,
} from "../skills/index.js";
import type { PermissionMode } from "../tools/coding-tool-host.js";
import { createCodingToolHost } from "../tools/coding-tool-host.js";
import {
  createBraveWebSearchProvider,
  createSafeWebFetchPort,
  type WebFetchPort,
  type WebSearchProvider,
  type WebSearchTransport,
} from "../tools/web/index.js";
import { createGitWorkspaceService, WorkspaceError } from "../workspace/workspace-service.js";

interface CommonProviderCodingAgentOptions {
  readonly workspaceRoot: string;
  readonly modelId?: string;
  readonly models?: readonly ModelDescriptor[];
  readonly credentialSources?: readonly CredentialSource[];
  readonly localCredentialPath?: string;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly instructions?: readonly InstructionPart[];
  readonly maxOutputTokens?: number;
  readonly modelContextWindow?: number;
  readonly safetyMarginTokens?: number;
  readonly retainedTailTokens?: number;
  readonly summaryOutputTokens?: number;
  readonly selectedSkillIds?: readonly string[];
  readonly builtInSkills?: readonly StaticSkillDefinition[];
  readonly userSkillDirectory?: string;
  readonly projectSkillDirectory?: string;
  readonly permissionMode?: PermissionMode;
  readonly approvalBridge?: ApprovalBridge;
  readonly webSearchProfile?: "brave" | "disabled";
  readonly webSearchProvider?: WebSearchProvider;
  readonly webSearchTransport?: WebSearchTransport;
  readonly webFetch?: WebFetchPort;
  readonly webTimeoutMs?: number;
  readonly dataDirectory?: string;
  readonly persistence?: {
    readonly sessions: SessionRepository;
    readonly artifacts: ArtifactStore;
  };
}

export interface OpenAiCodingAgentOptions extends CommonProviderCodingAgentOptions {
  readonly transport?: OpenAiTransport;
}

export type OpenRouterCodingAgentOptions = OpenAiCodingAgentOptions;

export type DeepSeekCodingAgentOptions = OpenAiCodingAgentOptions;
export type GlmCodingAgentOptions = OpenAiCodingAgentOptions;

export interface AnthropicCodingAgentOptions extends CommonProviderCodingAgentOptions {
  readonly transport?: AnthropicTransport;
}

export type ProductionProviderId = "openai" | "openrouter" | "deepseek" | "glm" | "anthropic";

export interface ProviderCodingAgentOptions extends CommonProviderCodingAgentOptions {
  readonly provider: ProductionProviderId;
  readonly openAiTransport?: OpenAiTransport;
  readonly anthropicTransport?: AnthropicTransport;
}

export interface OpenAiCodingAgent {
  readonly agent: CodingAgent;
  readonly model: ModelDescriptor;
  dispose(): Promise<void>;
}

export type OpenRouterCodingAgent = OpenAiCodingAgent;
export type DeepSeekCodingAgent = OpenAiCodingAgent;
export type GlmCodingAgent = OpenAiCodingAgent;
export type AnthropicCodingAgent = OpenAiCodingAgent;
export type ProviderCodingAgent = OpenAiCodingAgent;

export class CodingCompositionError extends Error {
  readonly code:
    | "CREDENTIAL_UNAVAILABLE"
    | "CREDENTIAL_RESOLUTION_FAILED"
    | "UNSUPPORTED_PROVIDER"
    | "CONTEXT_CAPABILITY_UNAVAILABLE"
    | "CONTEXT_CONFIGURATION_INVALID";

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
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
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
      toolCalls: "single",
      toolChoice: ["auto"],
      reasoning: false,
      reasoningReplay: false,
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    },
    source: { kind: "built_in", id: "openrouter", revision: "2026-08-28" },
  },
];

const deepSeekProductionCatalog: readonly ModelDescriptor[] = [
  {
    providerId: providerId("deepseek"),
    modelId: modelId("deepseek-v4-pro"),
    displayName: "DeepSeek V4 Pro",
    capabilities: {
      toolCalls: "multiple",
      toolChoice: ["auto"],
      reasoning: true,
      reasoningReplay: true,
      contextWindow: 128_000,
      maxOutputTokens: 32_768,
    },
    source: { kind: "built_in", id: "deepseek", revision: "2026-08-29" },
  },
];

const glmProductionCatalog: readonly ModelDescriptor[] = [
  {
    providerId: providerId("glm"),
    modelId: modelId("glm-5.2"),
    displayName: "GLM-5.2",
    capabilities: {
      toolCalls: "multiple",
      toolChoice: ["auto"],
      reasoning: true,
      reasoningReplay: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    },
    source: { kind: "built_in", id: "glm", revision: "2026-08-29" },
  },
  {
    providerId: providerId("glm"),
    modelId: modelId("glm-4.5-air"),
    displayName: "GLM-4.5-Air",
    capabilities: {
      toolCalls: "multiple",
      toolChoice: ["auto"],
      reasoning: true,
      reasoningReplay: true,
      contextWindow: 128_000,
      maxOutputTokens: 98_304,
    },
    source: { kind: "built_in", id: "glm", revision: "2026-08-29" },
  },
];

const anthropicProductionCatalog: readonly ModelDescriptor[] = [
  {
    providerId: providerId("anthropic"),
    modelId: modelId("claude-sonnet-4-5-20250929"),
    displayName: "Claude Sonnet 4.5",
    capabilities: {
      toolCalls: "multiple",
      toolChoice: ["auto", "none", "required", "specific"],
      reasoning: true,
      reasoningReplay: true,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    },
    source: { kind: "built_in", id: "anthropic", revision: "2026-08-29" },
  },
];

interface CompositionDefinition {
  readonly kind: "openai-compatible" | "anthropic";
  readonly profile: OpenAiCompatibleProfile | AnthropicProfile;
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
    createEnvironmentCredentialSource({
      id: "project-brave-search-environment",
      variables: { "web.brave": "FAST_BRAVE_SEARCH_API_KEY" },
    }),
    createEnvironmentCredentialSource({
      id: "brave-search-environment",
      variables: { "web.brave": "BRAVE_SEARCH_API_KEY" },
    }),
    createLocalConfigCredentialSource({
      id: "project-local-config",
      path: localCredentialPath ?? path.join(workspaceRoot, ".fast", "credentials.json"),
    }),
  ];
}

function defaultDataDirectory(): string {
  const configured = process.env.FAST_DATA_HOME?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "Fast");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  return xdgDataHome
    ? path.join(xdgDataHome, "fast")
    : path.join(os.homedir(), ".local", "share", "fast");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contextConfigurationRevision(value: unknown): string {
  return `m4-context-sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

async function canonicalCompositionRoot(root: string): Promise<string> {
  const workspace = createGitWorkspaceService();
  try {
    return (await workspace.inspect(root)).binding.root;
  } catch (error) {
    // Composition-only diagnostics can be created before a Session. A successful Session will still
    // require Git preflight; realpath keeps this non-Session path canonical without inventing a root.
    if (error instanceof WorkspaceError && error.code === "WORKSPACE_NOT_REPOSITORY") {
      return realpath(root);
    }
    throw error;
  }
}

async function createCompatibleCodingAgent(
  options: CommonProviderCodingAgentOptions & {
    readonly openAiTransport?: OpenAiTransport;
    readonly anthropicTransport?: AnthropicTransport;
  },
  definition: CompositionDefinition,
): Promise<OpenAiCodingAgent> {
  const workspaceRoot = await canonicalCompositionRoot(options.workspaceRoot);
  const resolvedSecrets = new Set<string>();
  const baseCredentials = createCredentialResolver(
    options.credentialSources ??
      defaultSources(workspaceRoot, definition, options.localCredentialPath),
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
    definition.kind === "anthropic"
      ? createAnthropicProvider({
          profile: definition.profile as AnthropicProfile,
          credentials,
          models: options.models ?? definition.catalog,
          ...(options.anthropicTransport ? { transport: options.anthropicTransport } : {}),
        })
      : createOpenAiCompatibleProvider({
          profile: definition.profile as OpenAiCompatibleProfile,
          credentials,
          models: options.models ?? definition.catalog,
          ...(options.openAiTransport ? { transport: options.openAiTransport } : {}),
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
  const approvals = options.approvalBridge ?? createApprovalBridge();
  const redact = (value: string): string =>
    [...resolvedSecrets].reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const modelContextWindow = options.modelContextWindow ?? model.capabilities.contextWindow;
  if (!modelContextWindow) {
    throw new CodingCompositionError(
      "CONTEXT_CAPABILITY_UNAVAILABLE",
      `${model.descriptor.displayName} 未声明 context window，必须显式配置 modelContextWindow`,
    );
  }
  const requestedOutputTokens = options.maxOutputTokens ?? 4_096;
  if (
    (model.capabilities.contextWindow !== undefined &&
      modelContextWindow > model.capabilities.contextWindow) ||
    (model.capabilities.maxOutputTokens !== undefined &&
      requestedOutputTokens > model.capabilities.maxOutputTokens) ||
    (options.summaryOutputTokens !== undefined &&
      model.capabilities.maxOutputTokens !== undefined &&
      options.summaryOutputTokens > model.capabilities.maxOutputTokens)
  ) {
    throw new CodingCompositionError(
      "CONTEXT_CONFIGURATION_INVALID",
      "Context window 或 output reserve 超过 active model 声明的 capability",
    );
  }
  const skillRegistry = await createSkillRegistry(
    [
      createBuiltInSkillSource(options.builtInSkills ?? []),
      createUserSkillSource(options.userSkillDirectory ?? path.join(dataDirectory, "skills")),
      createProjectSkillSource(
        options.projectSkillDirectory ?? path.join(workspaceRoot, ".fast", "skills"),
      ),
    ],
    { workspaceRoot },
  );
  const selectedSkills = skillRegistry.select({ ids: options.selectedSkillIds ?? [] });
  const projectInstructions = await createProjectInstructionsSnapshot({ workspaceRoot });
  const contextRevision = contextConfigurationRevision({
    version: 1,
    baseRevision: definition.configurationRevision,
    workspaceRoot,
    model: {
      providerId: model.descriptor.providerId,
      modelId: model.descriptor.modelId,
      sourceRevision: model.descriptor.source.revision,
    },
    permissionMode: options.permissionMode ?? "autonomous",
    webSearchProfile: options.webSearchProvider?.id ?? options.webSearchProfile ?? "brave",
    instructions: options.instructions ?? [
      { type: "text", text: "你是 Fast coding agent。使用工具核验事实并完成 Coding Task。" },
    ],
    budget: {
      modelContextWindow,
      requestedOutputTokens,
      safetyMarginTokens: options.safetyMarginTokens ?? 1_024,
      retainedTailTokens: options.retainedTailTokens ?? 8_192,
      summaryOutputTokens:
        options.summaryOutputTokens ??
        Math.min(2_048, model.capabilities.maxOutputTokens ?? requestedOutputTokens),
    },
    selectedSkills,
    projectInstructions: projectInstructions.refs,
  });
  const sqlite = options.persistence
    ? undefined
    : await createSqlitePersistence({
        databasePath: path.join(dataDirectory, "state.sqlite3"),
        artifactDirectory: path.join(dataDirectory, "artifacts"),
        busyTimeoutMs: 2_000,
        lease: {
          ownerId: `coding-agent-${process.pid}-${randomUUID()}`,
          durationMs: 30_000,
        },
        clock,
        ids,
        previewRedactor: redact,
      });
  const persistence = options.persistence ?? sqlite;
  if (!persistence) throw new Error("SQLite persistence initialization 未返回 Adapter");
  let context: ContextManager;
  try {
    context = createContextManager({
      sources: [
        createSystemToolContextSource(
          options.instructions ?? [
            { type: "text", text: "你是 Fast coding agent。使用工具核验事实并完成 Coding Task。" },
          ],
        ),
        projectInstructions.source,
        skillRegistry.contextSource(selectedSkills),
        createCurrentTaskContextSource(),
        createQueueContextSource(),
        createTranscriptContextSource(),
        createRunBoundaryContextSource(),
        createCheckpointContextSource(persistence.artifacts),
        createArtifactPreviewContextSource(persistence.artifacts),
      ],
      compaction: createSummaryCompactionStrategy({
        model,
        artifacts: persistence.artifacts,
        ids,
        summaryOutputTokens:
          options.summaryOutputTokens ??
          Math.min(2_048, model.capabilities.maxOutputTokens ?? requestedOutputTokens),
      }),
      modelContextWindow,
      requestedOutputReserve: requestedOutputTokens,
      safetyMargin: options.safetyMarginTokens ?? 1_024,
      retainedTailTokens: options.retainedTailTokens ?? 8_192,
    });
  } catch (error) {
    await sqlite?.[Symbol.asyncDispose]();
    throw error;
  }
  let tools: ReturnType<typeof createCodingToolHost>;
  try {
    const webSearchProvider =
      options.webSearchProvider ??
      (options.webSearchProfile === "disabled"
        ? undefined
        : createBraveWebSearchProvider({
            credentials,
            ...(options.webSearchTransport ? { transport: options.webSearchTransport } : {}),
          }));
    tools = createCodingToolHost(
      {
        workspaceRoot,
        permissionMode: options.permissionMode ?? "autonomous",
        approvalPort: approvals,
        redact,
        registeredSecrets: () => [...resolvedSecrets],
        artifactStore: persistence.artifacts,
        ...(webSearchProvider ? { webSearchProvider } : {}),
        webFetch: options.webFetch ?? createSafeWebFetchPort(),
        ...(options.webTimeoutMs !== undefined ? { webTimeoutMs: options.webTimeoutMs } : {}),
      },
      createNodeLocalExecutionPorts(),
    );
  } catch (error) {
    await sqlite?.[Symbol.asyncDispose]();
    throw error;
  }
  const agent = createCodingAgent({
    sessions: persistence.sessions,
    harness: createAgentHarness({ agent: createAgent(), redact }),
    model,
    tools,
    context,
    policies: createFixedRunPolicies({ maxModelTurns: 16, maxModelAttempts: 20, maxRetries: 2 }),
    configurationRevision: contextRevision,
    approvals,
    workspace: createGitWorkspaceService(),
  });
  return {
    agent,
    model: model.descriptor,
    async dispose() {
      await tools[Symbol.asyncDispose]();
      await sqlite?.[Symbol.asyncDispose]();
    },
  };
}

export async function createOpenAiCodingAgent(
  options: OpenAiCodingAgentOptions,
): Promise<OpenAiCodingAgent> {
  return createCompatibleCodingAgent(
    {
      ...options,
      ...(options.transport ? { openAiTransport: options.transport } : {}),
    },
    {
      kind: "openai-compatible",
      profile: openAiProfile,
      catalog: openAiProductionCatalog,
      defaultModelId: "gpt-5",
      environmentVariables: [
        { sourceId: "project-environment", variable: "FAST_OPENAI_API_KEY" },
        { sourceId: "openai-environment", variable: "OPENAI_API_KEY" },
      ],
      configurationRevision: "m1-openai-1",
    },
  );
}

export async function createOpenRouterCodingAgent(
  options: OpenRouterCodingAgentOptions,
): Promise<OpenRouterCodingAgent> {
  return createCompatibleCodingAgent(
    {
      ...options,
      ...(options.transport ? { openAiTransport: options.transport } : {}),
    },
    {
      kind: "openai-compatible",
      profile: openRouterProfile,
      catalog: openRouterProductionCatalog,
      defaultModelId: "openrouter/free",
      environmentVariables: [
        { sourceId: "project-openrouter-environment", variable: "FAST_OPENROUTER_API_KEY" },
        { sourceId: "openrouter-environment", variable: "OPENROUTER_API_KEY" },
      ],
      configurationRevision: "m1-openrouter-1",
    },
  );
}

export async function createDeepSeekCodingAgent(
  options: DeepSeekCodingAgentOptions,
): Promise<DeepSeekCodingAgent> {
  return createCompatibleCodingAgent(
    {
      ...options,
      ...(options.transport ? { openAiTransport: options.transport } : {}),
    },
    {
      kind: "openai-compatible",
      profile: deepSeekProfile,
      catalog: deepSeekProductionCatalog,
      defaultModelId: "deepseek-v4-pro",
      environmentVariables: [
        { sourceId: "project-deepseek-environment", variable: "FAST_DEEPSEEK_API_KEY" },
        { sourceId: "deepseek-environment", variable: "DEEPSEEK_API_KEY" },
      ],
      configurationRevision: "m5-deepseek-1",
    },
  );
}

export async function createGlmCodingAgent(
  options: GlmCodingAgentOptions,
): Promise<GlmCodingAgent> {
  return createCompatibleCodingAgent(
    {
      ...options,
      ...(options.transport ? { openAiTransport: options.transport } : {}),
    },
    {
      kind: "openai-compatible",
      profile: glmProfile,
      catalog: glmProductionCatalog,
      defaultModelId: "glm-5.2",
      environmentVariables: [
        { sourceId: "project-glm-environment", variable: "FAST_GLM_API_KEY" },
        { sourceId: "glm-environment", variable: "ZAI_API_KEY" },
      ],
      configurationRevision: "m5-glm-1",
    },
  );
}

export async function createAnthropicCodingAgent(
  options: AnthropicCodingAgentOptions,
): Promise<AnthropicCodingAgent> {
  return createCompatibleCodingAgent(
    {
      ...options,
      ...(options.transport ? { anthropicTransport: options.transport } : {}),
    },
    {
      kind: "anthropic",
      profile: anthropicProfile,
      catalog: anthropicProductionCatalog,
      defaultModelId: "claude-sonnet-4-5-20250929",
      environmentVariables: [
        { sourceId: "project-anthropic-environment", variable: "FAST_ANTHROPIC_API_KEY" },
        { sourceId: "anthropic-environment", variable: "ANTHROPIC_API_KEY" },
      ],
      configurationRevision: "m5-anthropic-1",
    },
  );
}

export async function createProviderCodingAgent(
  options: ProviderCodingAgentOptions,
): Promise<ProviderCodingAgent> {
  switch (options.provider) {
    case "openai":
      return createOpenAiCodingAgent({
        ...options,
        ...(options.openAiTransport ? { transport: options.openAiTransport } : {}),
      });
    case "openrouter":
      return createOpenRouterCodingAgent({
        ...options,
        ...(options.openAiTransport ? { transport: options.openAiTransport } : {}),
      });
    case "deepseek":
      return createDeepSeekCodingAgent({
        ...options,
        ...(options.openAiTransport ? { transport: options.openAiTransport } : {}),
      });
    case "glm":
      return createGlmCodingAgent({
        ...options,
        ...(options.openAiTransport ? { transport: options.openAiTransport } : {}),
      });
    case "anthropic":
      return createAnthropicCodingAgent({
        ...options,
        ...(options.anthropicTransport ? { transport: options.anthropicTransport } : {}),
      });
  }
}
