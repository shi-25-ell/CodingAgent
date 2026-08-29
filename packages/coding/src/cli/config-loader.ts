import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { productEnvironment, productIdentity } from "../product/index.js";
import type { CliRunOverrides } from "./contracts.js";
import { CliUsageError } from "./contracts.js";

export interface DexRunConfiguration extends Omit<CliRunOverrides, "structured"> {
  readonly structured: boolean;
}

type ConfigFile = Partial<Omit<DexRunConfiguration, "structured">>;

function dataDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environment[productEnvironment.dataHome]?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "win32" && environment.LOCALAPPDATA?.trim()) {
    return path.join(environment.LOCALAPPDATA, productIdentity.windowsDataDirectoryName);
  }
  return environment.XDG_DATA_HOME?.trim()
    ? path.join(environment.XDG_DATA_HOME, productIdentity.unixDataDirectoryName)
    : path.join(os.homedir(), ".local", "share", productIdentity.unixDataDirectoryName);
}

function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliUsageError(`${field} 必须是正整数`);
  return parsed;
}

function stringList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : String(value).split(",");
  if (!values.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new CliUsageError(`${field} 必须是非空 string list`);
  }
  return Object.freeze(values.map((item) => String(item).trim()));
}

function validate(value: unknown, source: string): ConfigFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(`${source} 必须是 JSON object`);
  }
  const input = value as Record<string, unknown>;
  if (
    input.provider !== undefined &&
    (typeof input.provider !== "string" || input.provider.trim().length === 0)
  ) {
    throw new CliUsageError(`${source}.provider 必须是非空 string`);
  }
  if (
    input.model !== undefined &&
    (typeof input.model !== "string" || input.model.trim().length === 0)
  ) {
    throw new CliUsageError(`${source}.model 必须是非空 string`);
  }
  const permissionMode = input.permissionMode;
  if (
    permissionMode !== undefined &&
    permissionMode !== "safe" &&
    permissionMode !== "autonomous"
  ) {
    throw new CliUsageError(`${source}.permissionMode 必须是 safe 或 autonomous`);
  }
  for (const field of Object.keys(input)) {
    if (
      ![
        "provider",
        "model",
        "permissionMode",
        "maxModelTurns",
        "maxModelAttempts",
        "maxRetries",
        "tools",
        "extensions",
        "skills",
      ].includes(field)
    ) {
      throw new CliUsageError(`${source} 包含未知字段: ${field}`);
    }
  }
  const maxModelTurns = positiveInteger(input.maxModelTurns, `${source}.maxModelTurns`);
  const maxModelAttempts = positiveInteger(input.maxModelAttempts, `${source}.maxModelAttempts`);
  const maxRetries = positiveInteger(input.maxRetries, `${source}.maxRetries`);
  const tools = stringList(input.tools, `${source}.tools`);
  const extensions = stringList(input.extensions, `${source}.extensions`);
  const skills = stringList(input.skills, `${source}.skills`);
  return Object.freeze({
    ...(typeof input.provider === "string" ? { provider: input.provider } : {}),
    ...(typeof input.model === "string" ? { model: input.model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(maxModelTurns !== undefined ? { maxModelTurns } : {}),
    ...(maxModelAttempts !== undefined ? { maxModelAttempts } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(tools ? { tools } : {}),
    ...(extensions ? { extensions } : {}),
    ...(skills ? { skills } : {}),
  });
}

async function readConfig(filePath: string): Promise<ConfigFile> {
  try {
    return validate(JSON.parse(await readFile(filePath, "utf8")), filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError(
      `${filePath} 无法读取: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Precedence is defaults < user config < project config < environment < CLI. */
export async function resolveDexRunConfiguration(input: {
  readonly workspaceRoot: string;
  readonly overrides: CliRunOverrides;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<DexRunConfiguration> {
  const environment = input.environment ?? process.env;
  const user = await readConfig(path.join(dataDirectory(environment), "config.json"));
  const project = await readConfig(
    path.join(input.workspaceRoot, productIdentity.projectDirectoryName, "config.json"),
  );
  const provider =
    input.overrides.provider ??
    environment[productEnvironment.modelProvider] ??
    project.provider ??
    user.provider;
  const modelVariable =
    provider === "openrouter"
      ? productEnvironment.openRouterModel
      : provider === "deepseek"
        ? productEnvironment.deepSeekModel
        : provider === "glm"
          ? productEnvironment.glmModel
          : provider === "anthropic"
            ? productEnvironment.anthropicModel
            : productEnvironment.openAiModel;
  const environmentConfig = validate(
    {
      ...(environment[productEnvironment.modelProvider]
        ? { provider: environment[productEnvironment.modelProvider] }
        : {}),
      ...(environment[modelVariable] ? { model: environment[modelVariable] } : {}),
      ...(environment[productEnvironment.permissionMode]
        ? { permissionMode: environment[productEnvironment.permissionMode] }
        : {}),
      ...(environment[productEnvironment.maxModelTurns]
        ? { maxModelTurns: environment[productEnvironment.maxModelTurns] }
        : {}),
      ...(environment[productEnvironment.maxModelAttempts]
        ? { maxModelAttempts: environment[productEnvironment.maxModelAttempts] }
        : {}),
      ...(environment[productEnvironment.maxRetries]
        ? { maxRetries: environment[productEnvironment.maxRetries] }
        : {}),
      ...(environment[productEnvironment.enabledTools]
        ? { tools: environment[productEnvironment.enabledTools] }
        : {}),
      ...(environment[productEnvironment.enabledExtensions]
        ? { extensions: environment[productEnvironment.enabledExtensions] }
        : {}),
      ...(environment[productEnvironment.selectedSkills]
        ? { skills: environment[productEnvironment.selectedSkills] }
        : {}),
    },
    "environment",
  );
  const merged = {
    provider: "openai",
    permissionMode: "autonomous" as const,
    ...user,
    ...project,
    ...environmentConfig,
    ...input.overrides,
  };
  return Object.freeze({ ...merged, structured: input.overrides.structured });
}
