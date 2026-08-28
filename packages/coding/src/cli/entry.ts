#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  CodingCompositionError,
  createOpenAiCodingAgent,
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
  application = await createOpenAiCodingAgent({
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
    process.exitCode = 3;
  } else {
    process.stderr.write(
      "当前目录不是可用的 Git workspace，或 production composition 无法启动。\n",
    );
    process.exitCode = 4;
  }
} finally {
  await application?.dispose();
}
