#!/usr/bin/env node
import {
  CodingCompositionError,
  createProviderCodingAgent,
  type ProductionProviderId,
} from "../composition/openai-composition.js";
import { runPrintEntry } from "../modes/print/print-entry.js";
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
    openai: "FAST_OPENAI_MODEL",
    openrouter: "FAST_OPENROUTER_MODEL",
    deepseek: "FAST_DEEPSEEK_MODEL",
    glm: "FAST_GLM_MODEL",
    anthropic: "FAST_ANTHROPIC_MODEL",
  };
  return process.env[variables[provider]];
}

let application: Awaited<ReturnType<typeof createProviderCodingAgent>> | undefined;
try {
  const workspace = (await createGitWorkspaceService().inspect(root)).binding;
  const configuredProvider = process.env.FAST_MODEL_PROVIDER ?? "openai";
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
  const result = await runPrintEntry(process.argv.slice(2), {
    agent: application.agent,
    workspace,
    io: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  });
  process.exitCode = result.exitCode;
} catch (error) {
  if (error instanceof CodingCompositionError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code === "UNSUPPORTED_PROVIDER" ? 2 : 3;
  } else {
    process.stderr.write(
      "当前目录不是可用的 Git workspace，或 production composition 无法启动。\n",
    );
    process.exitCode = 4;
  }
} finally {
  await application?.dispose();
}
