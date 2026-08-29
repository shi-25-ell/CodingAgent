#!/usr/bin/env bun
import { branchId, sessionId } from "@coding-agent/agent";
import {
  CodingCompositionError,
  createProviderCodingAgent,
  type ProductionProviderId,
} from "../composition/openai-composition.js";
import { inspectInteractiveTerminal } from "../modes/interactive/terminal-presentation.js";
import { productEnvironment, productIdentity, productVersion } from "../product/index.js";
import {
  detectBunRuntime,
  formatBunRuntimeDiagnostic,
  supportedBunVersion,
} from "../runtime/bun-runtime.js";
import { createGitWorkspaceService } from "../workspace/workspace-service.js";
import { type CliCommand, type CliRunOverrides, CliUsageError, cliExitCode } from "./contracts.js";
import { parseCli } from "./parser.js";

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

function usage(): string {
  return `${productIdentity.displayName} ${productVersion}

用法:
  dex                                  启动 interactive TUI
  dex --print [task] [options]         non-interactive；缺省 task 时读取 stdin
  dex session list|new
  dex session open|resume <session-id>
  dex session branch <session-id> [branch-id]
  dex models list | skills list
  dex extensions list|diagnose
  dex doctor

Run options:
  --provider <id>  --model <id>  --permission <safe|autonomous>
  --max-model-turns <n>  --max-model-attempts <n>  --max-retries <n>
  --tools <id,...>  --extension <id-or-path>  --skill <id>  --json
`;
}

function writeValue(value: unknown, structured: boolean): void {
  if (structured) process.stdout.write(`${JSON.stringify({ version: 1, data: value })}\n`);
  else if (Array.isArray(value)) {
    for (const item of value) process.stdout.write(`${JSON.stringify(item)}\n`);
  } else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function providerFrom(overrides: CliRunOverrides): ProductionProviderId {
  const value = overrides.provider ?? process.env[productEnvironment.modelProvider] ?? "openai";
  if (!supportedProviders.has(value as ProductionProviderId)) {
    throw new CodingCompositionError("UNSUPPORTED_PROVIDER", `不支持的 model provider: ${value}`);
  }
  return value as ProductionProviderId;
}

async function stdinTask(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() || undefined;
}

function requiresInteractiveTerminal(command: CliCommand): boolean {
  return ["interactive", "session_new", "session_resume", "session_branch"].includes(command.type);
}

function isAdministrative(command: CliCommand): boolean {
  return [
    "doctor",
    "models_list",
    "skills_list",
    "extensions_list",
    "extensions_diagnose",
    "session_list",
  ].includes(command.type);
}

async function main(): Promise<number> {
  const runtime = detectBunRuntime();
  if (!runtime.supported) {
    process.stderr.write(
      `需要 Bun ${supportedBunVersion}；${formatBunRuntimeDiagnostic(runtime)}\n`,
    );
    return cliExitCode.runtime;
  }

  let command: CliCommand;
  try {
    command = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}`);
    return cliExitCode.usage;
  }
  if (command.type === "help") {
    process.stdout.write(usage());
    return cliExitCode.success;
  }
  if (command.type === "version") {
    process.stdout.write(`${productIdentity.displayName} ${productVersion}\n`);
    return cliExitCode.success;
  }
  if (command.type === "runtime_diagnostic") {
    process.stdout.write(`${JSON.stringify(runtime)}\n`);
    return cliExitCode.success;
  }
  if (requiresInteractiveTerminal(command)) {
    const terminal = inspectInteractiveTerminal({
      stdinIsTty: process.stdin.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
      stdinSupportsRawMode: typeof process.stdin.setRawMode === "function",
    });
    if (!terminal.ready) {
      process.stderr.write(`${terminal.diagnostic?.message ?? "interactive terminal 不可用"}\n`);
      return cliExitCode.usage;
    }
  }

  const root = process.cwd();
  let application: Awaited<ReturnType<typeof createProviderCodingAgent>> | undefined;
  try {
    const workspace = (await createGitWorkspaceService().inspect(root)).binding;
    const overrides = "overrides" in command ? command.overrides : undefined;
    const provider = providerFrom(overrides ?? { structured: false });
    const selectedModel = overrides?.model ?? configuredModel(provider);
    application = await createProviderCodingAgent({
      workspaceRoot: root,
      provider,
      ...(selectedModel ? { modelId: selectedModel } : {}),
      ...(overrides?.permissionMode ? { permissionMode: overrides.permissionMode } : {}),
      ...(overrides?.maxModelTurns ? { maxModelTurns: overrides.maxModelTurns } : {}),
      ...(overrides?.maxModelAttempts ? { maxModelAttempts: overrides.maxModelAttempts } : {}),
      ...(overrides?.maxRetries ? { maxRetries: overrides.maxRetries } : {}),
      ...(overrides?.tools?.length ? { enabledTools: overrides.tools } : {}),
      ...(overrides?.extensions?.length ? { enabledExtensionIds: overrides.extensions } : {}),
      ...(overrides?.skills?.length ? { selectedSkillIds: overrides.skills } : {}),
      ...(isAdministrative(command) ? { credentialRequirement: "diagnostic" as const } : {}),
    });

    if (command.type === "doctor") {
      writeValue(
        { runtime, application: await application.agent.diagnostics() },
        command.structured,
      );
      return cliExitCode.success;
    }
    if (command.type === "models_list") {
      writeValue(await application.agent.listModels(), command.structured);
      return cliExitCode.success;
    }
    if (command.type === "session_list") {
      writeValue(await application.agent.listSessions(), command.structured);
      return cliExitCode.success;
    }
    if (command.type === "skills_list") {
      const diagnostics = await application.agent.diagnostics();
      writeValue(diagnostics.skills, command.structured);
      return cliExitCode.success;
    }
    if (command.type === "extensions_list" || command.type === "extensions_diagnose") {
      const diagnostics = await application.agent.diagnostics();
      writeValue(
        command.type === "extensions_list"
          ? diagnostics.extensions
          : diagnostics.extensionDiagnostics,
        command.structured,
      );
      return diagnostics.extensionDiagnostics.some((diagnostic) => diagnostic.severity === "error")
        ? cliExitCode.productFailure
        : cliExitCode.success;
    }

    let selectedSession: Awaited<ReturnType<typeof application.agent.openSession>> | undefined;
    if (command.type === "session_resume" || command.type === "session_branch") {
      selectedSession = await application.agent.openSession({
        sessionId: sessionId(command.sessionId),
      });
      if (command.type === "session_branch") {
        const view = await selectedSession.inspect();
        const forked = await selectedSession.fork({
          fromBranchId: command.fromBranchId
            ? branchId(command.fromBranchId)
            : view.currentBranchId,
          expectedRevision: view.revision,
        });
        const afterFork = await selectedSession.inspect();
        await selectedSession.selectBranch({
          branchId: forked.branchId,
          expectedRevision: afterFork.revision,
        });
      }
    } else if (command.type === "session_new") {
      selectedSession = await application.agent.createSession({ workspace });
    }

    if (command.type === "print") {
      const task = command.task ?? (await stdinTask());
      if (!task) throw new CliUsageError("--print 需要 Coding Task 或 redirected stdin");
      const result = await application.agent.resolveMode("print").run({
        agent: application.agent,
        workspace,
        argv: ["--print", task],
        io: {
          stdout: (text) => process.stdout.write(text),
          stderr: (text) => process.stderr.write(text),
        },
        structuredOutput: command.overrides.structured,
        signal: new AbortController().signal,
      });
      return result.exitCode;
    }

    const result = await application.agent.resolveMode("interactive").run({
      agent: application.agent,
      ...(selectedSession ? { session: selectedSession } : {}),
      workspace,
      argv: [],
      io: {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      },
      signal: new AbortController().signal,
    });
    return result.exitCode;
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n${usage()}`);
      return cliExitCode.usage;
    }
    if (error instanceof CodingCompositionError) {
      process.stderr.write(`${error.message}\n`);
      return error.code === "UNSUPPORTED_PROVIDER" ? cliExitCode.usage : cliExitCode.unavailable;
    }
    process.stderr.write(
      `当前目录不是可用的 Git workspace，或 production composition 无法启动：${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return cliExitCode.refused;
  } finally {
    await application?.dispose();
  }
}

process.exitCode = await main();
