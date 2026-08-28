import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgent,
  createAgentHarness,
  createFixedRunPolicies,
  createTranscriptContextManager,
  InMemorySessionRepository,
} from "@coding-agent/agent";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { createCodingAgent, createCodingToolHost } from "@coding-agent/coding";
import { ScriptedModel } from "@coding-agent/model/testing";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function processTreeCommand(): string {
  const grandchild = `$PID | Set-Content -NoNewline grandchild.pid; Start-Sleep -Seconds 30`;
  const child = `$PID | Set-Content -NoNewline child.pid; $p = Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encodedPowerShell(grandchild)}' -PassThru; $p.WaitForExit()`;
  return `$p = Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encodedPowerShell(child)}' -PassThru; $p.WaitForExit()`;
}

async function waitForPids(root: string): Promise<readonly [number, number]> {
  const names = ["child.pid", "grandchild.pid"];
  const ready = async () => {
    try {
      await Promise.all(names.map((name) => access(path.join(root, name))));
      return true;
    } catch {
      return false;
    }
  };
  if (!(await ready())) {
    await new Promise<void>((resolve, reject) => {
      const watcher = watch(root, () => {
        void ready().then((found) => {
          if (found) {
            watcher.close();
            resolve();
          }
        }, reject);
      });
      watcher.once("error", reject);
    });
  }
  return [
    Number(await readFile(path.join(root, names[0] ?? ""), "utf8")),
    Number(await readFile(path.join(root, names[1] ?? ""), "utf8")),
  ];
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform !== "win32")("M2 Agent process abort integration", () => {
  it("CodingRunHandle abort 等待 process tree cleanup 后产生唯一 aborted RunReport", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-agent-process-abort-"));
    temporaryDirectories.push(root);
    const sessions = new InMemorySessionRepository({
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
    });
    const model = new ScriptedModel([
      {
        outcome: {
          status: "completed",
          response: {
            version: 1,
            content: [
              {
                type: "tool_call",
                callId: "process-tree",
                name: "run_command",
                arguments: { command: processTreeCommand() },
              },
            ],
            finishReason: "tool_calls",
          },
        },
      },
    ]);
    const application = createCodingAgent({
      sessions,
      harness: createAgentHarness({ agent: createAgent() }),
      model,
      tools: createCodingToolHost({ workspaceRoot: root, commandTimeoutMs: 10_000 }),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 2, maxModelAttempts: 2, maxRetries: 0 }),
      configurationRevision: "m2-process-abort",
    });
    const session = await application.createSession({
      workspace: { root, fingerprint: "fixture" },
    });
    const handle = await session.startRun({ task: "启动后取消" });
    const [childPid, grandchildPid] = await waitForPids(root);

    await handle.dispatch({ commandId: "abort-process", type: "abort" });
    const report = await handle.finished;
    const childRunning = isRunning(childPid);
    const grandchildRunning = isRunning(grandchildPid);
    if (childRunning) spawnSync("taskkill.exe", ["/PID", String(childPid), "/T", "/F"]);
    if (grandchildRunning) spawnSync("taskkill.exe", ["/PID", String(grandchildPid), "/T", "/F"]);

    expect(report).toMatchObject({
      status: "aborted",
      terminationReason: "user_abort",
      counts: { toolCallCount: 1, settledToolCallCount: 1 },
      tools: { accepted: 1, settled: 1, succeeded: 0, failed: 1 },
    });
    expect(childRunning).toBe(false);
    expect(grandchildRunning).toBe(false);
    model.assertConsumed();
    await sessions[Symbol.asyncDispose]();
  });
});
