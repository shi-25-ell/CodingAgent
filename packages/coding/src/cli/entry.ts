#!/usr/bin/env node
import {
  CodingCompositionError,
  createOpenAiCodingAgent,
  createOpenRouterCodingAgent,
} from "../composition/openai-composition.js";
import { runPrintEntry } from "../modes/print/print-entry.js";
import { createGitWorkspaceService } from "../workspace/workspace-service.js";

const root = process.cwd();
let application: Awaited<ReturnType<typeof createOpenAiCodingAgent>> | undefined;
try {
  const workspace = (await createGitWorkspaceService().inspect(root)).binding;
  const configuredProvider = process.env.FAST_MODEL_PROVIDER ?? "openai";
  if (configuredProvider !== "openai" && configuredProvider !== "openrouter") {
    throw new CodingCompositionError(
      "UNSUPPORTED_PROVIDER",
      `不支持的 model provider: ${configuredProvider}`,
    );
  }
  application =
    configuredProvider === "openrouter"
      ? await createOpenRouterCodingAgent({
          workspaceRoot: root,
          ...(process.env.FAST_OPENROUTER_MODEL
            ? { modelId: process.env.FAST_OPENROUTER_MODEL }
            : {}),
        })
      : await createOpenAiCodingAgent({
          workspaceRoot: root,
          ...(process.env.FAST_OPENAI_MODEL ? { modelId: process.env.FAST_OPENAI_MODEL } : {}),
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
