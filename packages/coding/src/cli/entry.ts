#!/usr/bin/env bun
import {
  CodingCompositionError,
  createProviderCodingAgent,
  type ProductionProviderId,
} from "../composition/openai-composition.js";
import { productEnvironment } from "../product/index.js";
import {
  detectBunRuntime,
  formatBunRuntimeDiagnostic,
  supportedBunVersion,
} from "../runtime/bun-runtime.js";
import { createGitWorkspaceService } from "../workspace/workspace-service.js";

const root = process.cwd();
const supportedProviders = new Set<ProductionProviderId>([
  "openai",
  "openrouter",
  "deepseek",
  "glm",
  "anthropic",
]);

function configuredModel(provider: ProductionProviderId): string | undefined {
  const variables: Record<ProductionProviderId, string> = {
    openai: productEnvironment.openAiModel,
    openrouter: productEnvironment.openRouterModel,
    deepseek: productEnvironment.deepSeekModel,
    glm: productEnvironment.glmModel,
    anthropic: productEnvironment.anthropicModel,
  };
  return process.env[variables[provider]];
}

async function main(): Promise<number> {
  const runtime = detectBunRuntime();
  if (!runtime.supported) {
    process.stderr.write(
      `需要 Bun ${supportedBunVersion}；${formatBunRuntimeDiagnostic(runtime)}\n`,
    );
    return 5;
  }
  if (process.argv[2] === "--runtime-diagnostic") {
    process.stdout.write(`${JSON.stringify(runtime)}\n`);
    return 0;
  }

  let application: Awaited<ReturnType<typeof createProviderCodingAgent>> | undefined;
  try {
    const workspace = (await createGitWorkspaceService().inspect(root)).binding;
    const configuredProvider = process.env[productEnvironment.modelProvider] ?? "openai";
    if (!supportedProviders.has(configuredProvider as ProductionProviderId)) {
      throw new CodingCompositionError(
        "UNSUPPORTED_PROVIDER",
        `不支持的 model provider: ${configuredProvider}`,
      );
    }
    const provider = configuredProvider as ProductionProviderId;
    const selectedModel = configuredModel(provider);
    application = await createProviderCodingAgent({
      workspaceRoot: root,
      provider,
      ...(selectedModel ? { modelId: selectedModel } : {}),
    });
    const argv = process.argv.slice(2);
    const mode = application.agent.resolveMode(argv[0] === "--print" ? "print" : "interactive");
    const result = await mode.run({
      agent: application.agent,
      workspace,
      argv,
      io: {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      },
      signal: new AbortController().signal,
    });
    return result.exitCode;
  } catch (error) {
    if (error instanceof CodingCompositionError) {
      process.stderr.write(`${error.message}\n`);
      return error.code === "UNSUPPORTED_PROVIDER" ? 2 : 3;
    }
    process.stderr.write(
      `当前目录不是可用的 Git workspace，或 production composition 无法启动。${formatBunRuntimeDiagnostic(runtime)}\n`,
    );
    return 4;
  } finally {
    await application?.dispose();
  }
}

process.exitCode = await main();
