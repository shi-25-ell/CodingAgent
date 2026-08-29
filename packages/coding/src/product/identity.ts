import { existsSync } from "node:fs";
import path from "node:path";

export const productIdentity = Object.freeze({
  displayName: "Dex Code",
  executable: "dex",
  environmentPrefix: "DEX_",
  projectDirectoryName: ".dex",
  unixDataDirectoryName: "dex",
  windowsDataDirectoryName: "Dex Code",
  packageScope: "@coding-agent",
  extensionNamespace: "coding-agent",
} as const);

export const productVersion = "0.0.0";

export const productEnvironment = Object.freeze({
  modelProvider: "DEX_MODEL_PROVIDER",
  dataHome: "DEX_DATA_HOME",
  openAiModel: "DEX_OPENAI_MODEL",
  openRouterModel: "DEX_OPENROUTER_MODEL",
  deepSeekModel: "DEX_DEEPSEEK_MODEL",
  glmModel: "DEX_GLM_MODEL",
  anthropicModel: "DEX_ANTHROPIC_MODEL",
  openAiApiKey: "DEX_OPENAI_API_KEY",
  openRouterApiKey: "DEX_OPENROUTER_API_KEY",
  deepSeekApiKey: "DEX_DEEPSEEK_API_KEY",
  glmApiKey: "DEX_GLM_API_KEY",
  anthropicApiKey: "DEX_ANTHROPIC_API_KEY",
  braveSearchApiKey: "DEX_BRAVE_SEARCH_API_KEY",
  permissionMode: "DEX_PERMISSION_MODE",
  maxModelTurns: "DEX_MAX_MODEL_TURNS",
  maxModelAttempts: "DEX_MAX_MODEL_ATTEMPTS",
  maxRetries: "DEX_MAX_RETRIES",
  enabledTools: "DEX_TOOLS",
  enabledExtensions: "DEX_EXTENSIONS",
  selectedSkills: "DEX_SKILLS",
} as const);

const legacyEnvironmentMigrations = Object.freeze({
  FAST_MODEL_PROVIDER: productEnvironment.modelProvider,
  FAST_DATA_HOME: productEnvironment.dataHome,
  FAST_OPENAI_MODEL: productEnvironment.openAiModel,
  FAST_OPENROUTER_MODEL: productEnvironment.openRouterModel,
  FAST_DEEPSEEK_MODEL: productEnvironment.deepSeekModel,
  FAST_GLM_MODEL: productEnvironment.glmModel,
  FAST_ANTHROPIC_MODEL: productEnvironment.anthropicModel,
  FAST_OPENAI_API_KEY: productEnvironment.openAiApiKey,
  FAST_OPENROUTER_API_KEY: productEnvironment.openRouterApiKey,
  FAST_DEEPSEEK_API_KEY: productEnvironment.deepSeekApiKey,
  FAST_GLM_API_KEY: productEnvironment.glmApiKey,
  FAST_ANTHROPIC_API_KEY: productEnvironment.anthropicApiKey,
  FAST_BRAVE_SEARCH_API_KEY: productEnvironment.braveSearchApiKey,
} as const);

export interface ProductMigrationOptions {
  readonly inspectEnvironment?: boolean;
  readonly inspectProjectDirectory?: boolean;
}

export function detectLegacyProductConfiguration(
  workspaceRoot: string,
  options: ProductMigrationOptions = {},
): string | undefined {
  if (options.inspectEnvironment ?? true) {
    for (const [legacy, replacement] of Object.entries(legacyEnvironmentMigrations)) {
      if (process.env[legacy] !== undefined) {
        return `检测到旧工作标识 ${legacy}；请改用 ${replacement}。Dex Code 不会静默读取旧环境变量。`;
      }
    }
  }

  if (options.inspectProjectDirectory ?? true) {
    const legacyDirectory = path.join(workspaceRoot, ".fast");
    const productDirectory = path.join(workspaceRoot, productIdentity.projectDirectoryName);
    if (existsSync(legacyDirectory) && !existsSync(productDirectory)) {
      return `检测到旧项目目录 ${legacyDirectory}；请迁移为 ${productDirectory}。Dex Code 不会静默读取旧目录。`;
    }
  }

  return undefined;
}
