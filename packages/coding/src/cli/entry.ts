#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  CodingCompositionError,
  createOpenAiCodingAgent,
  createOpenRouterCodingAgent,
} from "../composition/openai-composition.js";
import { runPrintEntry } from "../modes/print/print-entry.js";

function workspaceFingerprint(root: string): string {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return createHash("sha256").update(head).update("\0").update(status).digest("hex");
}

const root = process.cwd();
let application: Awaited<ReturnType<typeof createOpenAiCodingAgent>> | undefined;
try {
  const fingerprint = workspaceFingerprint(root);
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
    workspace: { root, fingerprint },
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
