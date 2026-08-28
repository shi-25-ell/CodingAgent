import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolCall } from "@coding-agent/model";
import { afterEach, describe, expect, it } from "vitest";
import { createCodingToolHost } from "../../src/tools/coding-tool-host.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function outcome(
  host: ReturnType<typeof createCodingToolHost>,
  call: ToolCall,
  signal = new AbortController().signal,
) {
  return host.execute(call, { signal }).outcome;
}

describe("CodingToolHost ToolExecutor contract", () => {
  it("四个真实工具共享 strict validation、workspace containment 与明确 ToolOutcome", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "a.txt"), "alpha\nbeta\n", "utf8");
    const host = createCodingToolHost({ workspaceRoot: root, maxOutputBytes: 4_096 });

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "read-1",
        name: "read_file",
        arguments: { path: "a.txt" },
      }),
    ).resolves.toMatchObject({
      callId: "read-1",
      status: "succeeded",
      isError: false,
      effectState: "none",
      modelContent: expect.stringContaining("alpha"),
    });

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "search-1",
        name: "search_text",
        arguments: { query: "beta", path: "." },
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      modelContent: expect.stringContaining("a.txt:2:beta"),
    });
    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "search-file",
        name: "search_text",
        arguments: { query: "absent", path: "a.txt" },
      }),
    ).resolves.toMatchObject({ status: "succeeded", modelContent: "" });

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "patch-1",
        name: "apply_patch",
        arguments: { path: "a.txt", oldText: "beta", newText: "gamma" },
      }),
    ).resolves.toMatchObject({ status: "succeeded", effectState: "committed" });
    await expect(readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe("alpha\ngamma\n");

    const command = process.platform === "win32" ? "Write-Output command-ok" : "printf command-ok";
    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "command-1",
        name: "run_command",
        arguments: { command },
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      effectState: "none",
      modelContent: expect.stringContaining("command-ok"),
    });

    for (const [callId, name, args] of [
      ["escape", "read_file", { path: "../outside.txt" }],
      ["extra", "read_file", { path: "a.txt", unexpected: true }],
      ["conflict", "apply_patch", { path: "a.txt", oldText: "missing", newText: "x" }],
      ["unknown", "unknown_tool", {}],
    ] as const) {
      const result = await outcome(host, {
        type: "tool_call",
        callId,
        name,
        arguments: args,
      });
      expect(["rejected", "conflict"]).toContain(result.status);
      expect(result.effectState).toBe("none");
      expect(result.isError).toBe(true);
    }
  });

  it("预先 abort 不启动工具，输出超限得到 bounded outcome", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "large.txt"), "abcdefghij", "utf8");
    await writeFile(path.join(root, "a"), "你好", "utf8");
    const host = createCodingToolHost({ workspaceRoot: root, maxOutputBytes: 8 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      outcome(
        host,
        {
          type: "tool_call",
          callId: "aborted",
          name: "read_file",
          arguments: { path: "large.txt" },
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({
      status: "cancelled",
      effectState: "none",
      abortObserved: true,
    });

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "limited",
        name: "read_file",
        arguments: { path: "large.txt" },
      }),
    ).resolves.toMatchObject({
      status: "output_limit",
      effectState: "none",
      modelContent: expect.any(String),
    });

    const utf8Host = createCodingToolHost({ workspaceRoot: root, maxOutputBytes: 4 });
    await expect(
      outcome(utf8Host, {
        type: "tool_call",
        callId: "utf8-limited",
        name: "read_file",
        arguments: { path: "a" },
      }),
    ).resolves.toMatchObject({ status: "output_limit", effectState: "none" });
  });

  it("registered secret 在 ToolOutcome 前被脱敏", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-"));
    temporaryDirectories.push(root);
    const secret = `runtime-${Date.now()}-${Math.random()}`;
    await writeFile(path.join(root, "secret.txt"), secret, "utf8");
    const host = createCodingToolHost({
      workspaceRoot: root,
      maxOutputBytes: 4_096,
      redactValues: [secret],
    });

    const result = await outcome(host, {
      type: "tool_call",
      callId: "redact",
      name: "read_file",
      arguments: { path: "secret.txt" },
    });

    expect(result.modelContent).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("依赖失败、invalid UTF-8、受保护路径、command non-zero 与 timeout 都有确定 outcome", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "binary.bin"), new Uint8Array([0xff, 0xfe]));
    await writeFile(path.join(root, "duplicate.txt"), "same same", "utf8");
    await mkdir(path.join(root, ".git"));
    const host = createCodingToolHost({
      workspaceRoot: root,
      maxOutputBytes: 4_096,
      commandTimeoutMs: 5_000,
    });

    for (const scenario of [
      { id: "missing", name: "read_file", arguments: { path: "missing.txt" }, status: "failed" },
      { id: "binary", name: "read_file", arguments: { path: "binary.bin" }, status: "rejected" },
      {
        id: "duplicate",
        name: "apply_patch",
        arguments: { path: "duplicate.txt", oldText: "same", newText: "x" },
        status: "conflict",
      },
      {
        id: "git",
        name: "apply_patch",
        arguments: { path: ".git/config", oldText: "x", newText: "y" },
        status: "rejected",
      },
    ] as const) {
      await expect(
        outcome(host, {
          type: "tool_call",
          callId: scenario.id,
          name: scenario.name,
          arguments: scenario.arguments,
        }),
      ).resolves.toMatchObject({ status: scenario.status, effectState: "none", isError: true });
    }

    const nonZero = process.platform === "win32" ? "exit 7" : "exit 7";
    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "non-zero",
        name: "run_command",
        arguments: { command: nonZero },
      }),
    ).resolves.toMatchObject({ status: "failed", isError: true });

    const slow = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5";
    const timeoutHost = createCodingToolHost({
      workspaceRoot: root,
      maxOutputBytes: 4_096,
      commandTimeoutMs: 100,
    });
    await expect(
      outcome(timeoutHost, {
        type: "tool_call",
        callId: "timeout",
        name: "run_command",
        arguments: { command: slow },
      }),
    ).resolves.toMatchObject({ status: "timed_out", effectState: "unknown", isError: true });

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "cwd-file",
        name: "run_command",
        arguments: { command: "echo unreachable", cwd: "duplicate.txt" },
      }),
    ).resolves.toMatchObject({ status: "rejected", effectState: "none" });

    expect(() => createCodingToolHost({ workspaceRoot: root, maxOutputBytes: 0 })).toThrow(
      "maxOutputBytes",
    );
    expect(() => createCodingToolHost({ workspaceRoot: root, commandTimeoutMs: 0 })).toThrow(
      "commandTimeoutMs",
    );
  });
});
