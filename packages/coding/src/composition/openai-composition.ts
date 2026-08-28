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
  type CredentialSource,
  createCredentialResolver,
  createEnvironmentCredentialSource,
  createLocalConfigCredentialSource,
} from "@coding-agent/model/auth";
import {
  createOpenAiCompatibleProvider,
  type OpenAiTransport,
  openAiProfile,
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

export interface OpenAiCodingAgent {
  readonly agent: CodingAgent;
  readonly model: ModelDescriptor;
  dispose(): Promise<void>;
}

export class CodingCompositionError extends Error {
  readonly code: "CREDENTIAL_UNAVAILABLE" | "CREDENTIAL_RESOLUTION_FAILED";

  constructor(code: CodingCompositionError["code"], message: string) {
    super(message);
    this.name = "CodingCompositionError";
    this.code = code;
  }
}

const productionCatalog: readonly ModelDescriptor[] = [
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

function defaultSources(
  workspaceRoot: string,
  localCredentialPath?: string,
): readonly CredentialSource[] {
  return [
    createEnvironmentCredentialSource({
      id: "project-environment",
      variables: { "openai.default": "FAST_OPENAI_API_KEY" },
    }),
    createEnvironmentCredentialSource({
      id: "openai-environment",
      variables: { "openai.default": "OPENAI_API_KEY" },
    }),
    createLocalConfigCredentialSource({
      id: "project-local-config",
      path: localCredentialPath ?? path.join(workspaceRoot, ".fast", "credentials.json"),
    }),
  ];
}

export async function createOpenAiCodingAgent(
  options: OpenAiCodingAgentOptions,
): Promise<OpenAiCodingAgent> {
  const credentials = createCredentialResolver(
    options.credentialSources ?? defaultSources(options.workspaceRoot, options.localCredentialPath),
  );
  const preflight = await credentials.resolve(openAiProfile.auth);
  if (preflight.status === "missing") {
    throw new CodingCompositionError("CREDENTIAL_UNAVAILABLE", "OpenAI credential 未配置");
  }
  if (preflight.status === "failed") {
    throw new CodingCompositionError("CREDENTIAL_RESOLUTION_FAILED", "OpenAI credential 无法解析");
  }

  const registry = createModelRegistry();
  registry.registerProvider(
    createOpenAiCompatibleProvider({
      profile: openAiProfile,
      credentials,
      models: options.models ?? productionCatalog,
      ...(options.transport ? { transport: options.transport } : {}),
    }),
  );
  const selectedModelId = modelId(options.modelId ?? "gpt-5");
  const model = await registry.resolve({ providerId: openAiProfile.id, modelId: selectedModelId });
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
      redactValues: [preflight.credential.value.reveal()],
    }),
    context: createTranscriptContextManager({
      instructions: options.instructions ?? [
        { type: "text", text: "你是 Fast coding agent。使用工具核验事实并完成 Coding Task。" },
      ],
      maxOutputTokens: options.maxOutputTokens ?? 4_096,
    }),
    policies: createFixedRunPolicies({ maxModelTurns: 16, maxModelAttempts: 20, maxRetries: 2 }),
    configurationRevision: "m1-openai-1",
  });
  return {
    agent,
    model: model.descriptor,
    async dispose() {
      await sessions[Symbol.asyncDispose]();
    },
  };
}
