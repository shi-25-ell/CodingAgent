import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runId } from "@coding-agent/agent";
import { createCodingToolHost } from "@coding-agent/coding";
import type { ToolCall } from "@coding-agent/model";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
      ),
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

async function waitForFiles(root: string, names: readonly string[]): Promise<void> {
  const ready = async () => {
    try {
      await Promise.all(names.map((name) => access(path.join(root, name))));
      return true;
    } catch {
      return false;
    }
  };
  if (await ready()) return;
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

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform !== "win32")("Windows PowerShell process adapter", () => {
  it("保持 quoting 与 cwd，分离 stdout/stderr 并移除 Secret Registry value", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-process-contract-"));
    temporaryDirectories.push(root);
    const nested = path.join(root, "nested path");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(nested));
    const secret = "registered-secret-value";
    const prior = process.env.APPDATA;
    process.env.APPDATA = secret;
    try {
      const host = createCodingToolHost({
        workspaceRoot: root,
        registeredSecrets: () => [secret],
      });
      const command =
        "[Console]::Out.Write((Get-Location).Path + [Environment]::NewLine); " +
        "[Console]::Out.Write('space \" quote'); " +
        "$v = if ($null -eq $env:APPDATA) { '<missing>' } else { $env:APPDATA }; " +
        "[Console]::Error.Write($v)";
      const result = await host.execute(
        {
          type: "tool_call",
          callId: "process-contract",
          name: "run_command",
          arguments: { command, cwd: "nested path" },
        },
        { runId: runId("process-contract"), signal: new AbortController().signal },
      ).outcome;

      expect(result.status).toBe("succeeded");
      const evidence = JSON.parse(result.modelContent);
      expect(evidence).toEqual({
        exitCode: 0,
        stdout: `${nested}\r\nspace " quote`,
        stderr: "<missing>",
      });
    } finally {
      if (prior === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prior;
    }
  });

  it("stdout/stderr 分别计量，超出 inline budget 时 spill redacted Artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-process-output-"));
    temporaryDirectories.push(root);
    const secret = "sensitive-output-value";
    const host = createCodingToolHost({
      workspaceRoot: root,
      maxOutputBytes: 96,
      redactValues: [secret],
    });
    const result = await host.execute(
      {
        type: "tool_call",
        callId: "process-output",
        name: "run_command",
        arguments: {
          command: `[Console]::Out.Write(('A' * 160) + '${secret}'); [Console]::Error.Write('B' * 192)`,
        },
      },
      { runId: runId("process-output"), signal: new AbortController().signal },
    ).outcome;

    expect(result).toMatchObject({
      status: "output_limit",
      effectState: "unknown",
      evidence: {
        truncated: true,
        stdoutBytes: expect.any(Number),
        stderrBytes: expect.any(Number),
        captureComplete: true,
      },
    });
    expect(result.artifacts).toHaveLength(1);
    const chunks: Uint8Array[] = [];
    for await (const chunk of host.artifacts.read(result.artifacts[0] ?? { id: "missing" })) {
      chunks.push(chunk);
    }
    const artifact = Buffer.concat(chunks).toString("utf8");
    expect(artifact).toContain("A".repeat(160));
    expect(artifact).toContain("B".repeat(192));
    expect(artifact).toContain("[REDACTED]");
    expect(artifact).not.toContain(secret);
  });

  it("abort 在 outcome 前终止 child 与 grandchild process tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-process-tree-"));
    temporaryDirectories.push(root);
    const command = processTreeCommand();
    const host = createCodingToolHost({ workspaceRoot: root, commandTimeoutMs: 10_000 });
    const controller = new AbortController();
    const call: ToolCall = {
      type: "tool_call",
      callId: "tree-abort",
      name: "run_command",
      arguments: { command },
    };
    const pending = host.execute(call, {
      runId: runId("process-abort"),
      signal: controller.signal,
    }).outcome;
    await waitForFiles(root, ["child.pid", "grandchild.pid"]);
    const childPid = Number(await readFile(path.join(root, "child.pid"), "utf8"));
    const grandchildPid = Number(await readFile(path.join(root, "grandchild.pid"), "utf8"));

    controller.abort();
    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      abortObserved: true,
    });
    const childRunning = isRunning(childPid);
    const grandchildRunning = isRunning(grandchildPid);
    if (childRunning) spawnSync("taskkill.exe", ["/PID", String(childPid), "/T", "/F"]);
    if (grandchildRunning) spawnSync("taskkill.exe", ["/PID", String(grandchildPid), "/T", "/F"]);
    expect(childRunning).toBe(false);
    expect(grandchildRunning).toBe(false);
  });

  it("timeout 在 outcome 前终止 child 与 grandchild process tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-process-timeout-"));
    temporaryDirectories.push(root);
    const host = createCodingToolHost({ workspaceRoot: root, commandTimeoutMs: 3_000 });
    const pending = host.execute(
      {
        type: "tool_call",
        callId: "tree-timeout",
        name: "run_command",
        arguments: { command: processTreeCommand() },
      },
      { runId: runId("process-timeout"), signal: new AbortController().signal },
    ).outcome;
    await waitForFiles(root, ["child.pid", "grandchild.pid"]);
    const childPid = Number(await readFile(path.join(root, "child.pid"), "utf8"));
    const grandchildPid = Number(await readFile(path.join(root, "grandchild.pid"), "utf8"));

    await expect(pending).resolves.toMatchObject({ status: "timed_out", effectState: "unknown" });
    expect(isRunning(childPid)).toBe(false);
    expect(isRunning(grandchildPid)).toBe(false);
  });
});
