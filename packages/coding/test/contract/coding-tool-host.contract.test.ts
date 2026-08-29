import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runId } from "@coding-agent/agent";
import type { ToolCall } from "@coding-agent/model";
import { type ApprovalRequest, createCodingToolHost } from "../../src/index.js";

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
  return host.execute(call, { runId: runId("tool-host-test"), signal }).outcome;
}

describe("CodingToolHost ToolExecutor contract", () => {
  it("registry 暴露 M5 的本地与 web coding tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-registry-"));
    temporaryDirectories.push(root);
    const host = createCodingToolHost({ workspaceRoot: root });
    expect(host.definitions().map((definition) => definition.name)).toEqual([
      "list_files",
      "read_file",
      "search_text",
      "create_file",
      "apply_patch",
      "replace_file",
      "delete_file",
      "run_command",
      "git_status",
      "git_diff",
      "web_search",
      "web_fetch",
    ]);
  });

  it("create/list/read/replace/delete 共享 workspace safety 与 content precondition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-files-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "src"));
    const host = createCodingToolHost({ workspaceRoot: root });

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "create",
        name: "create_file",
        arguments: { path: "src/a.txt", content: "alpha" },
      }),
    ).resolves.toMatchObject({ status: "succeeded", effectState: "committed" });

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "list",
        name: "list_files",
        arguments: { path: "." },
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      modelContent: expect.stringContaining("src/a.txt"),
    });

    const hash = createHash("sha256").update("alpha").digest("hex");
    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "replace-conflict",
        name: "replace_file",
        arguments: { path: "src/a.txt", expectedHash: "0".repeat(64), content: "wrong" },
      }),
    ).resolves.toMatchObject({ status: "conflict", effectState: "none" });
    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "replace",
        name: "replace_file",
        arguments: { path: "src/a.txt", expectedHash: hash, content: "beta" },
      }),
    ).resolves.toMatchObject({ status: "succeeded", effectState: "committed" });

    const betaHash = createHash("sha256").update("beta").digest("hex");
    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "delete",
        name: "delete_file",
        arguments: { path: "src/a.txt", expectedHash: betaHash },
      }),
    ).resolves.toMatchObject({ status: "succeeded", effectState: "committed" });
    await expect(access(path.join(root, "src", "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("git_status 与 git_diff 通过只读 evidence adapter 返回真实 repository 状态", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-git-"));
    temporaryDirectories.push(root);
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await writeFile(path.join(root, "a.txt"), "before\n", "utf8");
    expect(spawnSync("git", ["add", "a.txt"], { cwd: root }).status).toBe(0);
    expect(
      spawnSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          "fixture",
        ],
        { cwd: root },
      ).status,
    ).toBe(0);
    await writeFile(path.join(root, "a.txt"), "after\n", "utf8");
    const host = createCodingToolHost({ workspaceRoot: root, permissionMode: "safe" });

    await expect(
      outcome(host, { type: "tool_call", callId: "status", name: "git_status", arguments: {} }),
    ).resolves.toMatchObject({
      status: "succeeded",
      modelContent: expect.stringContaining("a.txt"),
    });
    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "diff",
        name: "git_diff",
        arguments: { path: "a.txt" },
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      modelContent: expect.stringContaining("+after"),
    });

    await writeFile(path.join(root, "a.txt"), "changed\n".repeat(2_000), "utf8");
    const limitedHost = createCodingToolHost({ workspaceRoot: root, maxOutputBytes: 64 });
    await expect(
      outcome(limitedHost, {
        type: "tool_call",
        callId: "diff-output-limit",
        name: "git_diff",
        arguments: { path: "a.txt" },
      }),
    ).resolves.toMatchObject({
      status: "output_limit",
      evidence: { truncated: true, captureComplete: false },
      artifacts: [expect.objectContaining({ id: expect.any(String) })],
    });
  });
  it("Safe Mode 自动允许 read，mutation 绑定 immutable ToolPlan fingerprint 审批", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-approval-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "a.txt"), "before", "utf8");
    const requests: ApprovalRequest[] = [];
    const host = createCodingToolHost({
      workspaceRoot: root,
      permissionMode: "safe",
      approvalPort: {
        async request(request) {
          requests.push(request);
          expect(Object.isFrozen(request.plan)).toBe(true);
          expect(Object.isFrozen(request.plan.resources)).toBe(true);
          return { decision: "allow_once", planFingerprint: request.plan.fingerprint };
        },
      },
    });

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "read-safe",
        name: "read_file",
        arguments: { path: "a.txt" },
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(requests).toHaveLength(0);

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "patch-safe",
        name: "apply_patch",
        arguments: { path: "./a.txt", oldText: "before", newText: "after" },
      }),
    ).resolves.toMatchObject({ status: "succeeded", effectState: "committed" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.plan).toMatchObject({
      callId: "patch-safe",
      toolName: "apply_patch",
      normalizedArguments: { path: "a.txt", oldText: "before", newText: "after" },
      effects: ["workspace_mutation"],
      policyVersion: expect.any(String),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const secret = "registered-plan-secret";
    const redactedRequests: ApprovalRequest[] = [];
    const redacted = createCodingToolHost({
      workspaceRoot: root,
      permissionMode: "safe",
      redactValues: [secret],
      approvalPort: {
        async request(request) {
          redactedRequests.push(request);
          return { decision: "deny", planFingerprint: request.plan.fingerprint };
        },
      },
    });
    await outcome(redacted, {
      type: "tool_call",
      callId: "redacted-plan",
      name: "create_file",
      arguments: { path: "secret.txt", content: secret },
    });
    expect(JSON.stringify(redactedRequests)).not.toContain(secret);
    expect(JSON.stringify(redactedRequests)).toContain("[REDACTED]");
  });

  it("deny、wrong fingerprint 与 approval 后 precondition 变化均不启动 mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-approval-"));
    temporaryDirectories.push(root);
    const target = path.join(root, "a.txt");
    await writeFile(target, "before", "utf8");

    const denied = createCodingToolHost({
      workspaceRoot: root,
      permissionMode: "safe",
      approvalPort: {
        async request(request) {
          return { decision: "deny", planFingerprint: request.plan.fingerprint };
        },
      },
    });
    await expect(
      outcome(denied, {
        type: "tool_call",
        callId: "deny",
        name: "apply_patch",
        arguments: { path: "a.txt", oldText: "before", newText: "denied" },
      }),
    ).resolves.toMatchObject({ status: "denied", effectState: "none" });
    await expect(readFile(target, "utf8")).resolves.toBe("before");

    const wrong = createCodingToolHost({
      workspaceRoot: root,
      permissionMode: "safe",
      approvalPort: {
        async request() {
          return { decision: "allow_once", planFingerprint: "wrong" };
        },
      },
    });
    await expect(
      outcome(wrong, {
        type: "tool_call",
        callId: "wrong",
        name: "apply_patch",
        arguments: { path: "a.txt", oldText: "before", newText: "wrong" },
      }),
    ).resolves.toMatchObject({ status: "rejected", effectState: "none" });
    await expect(readFile(target, "utf8")).resolves.toBe("before");

    const racedFingerprints: string[] = [];
    const raced = createCodingToolHost({
      workspaceRoot: root,
      permissionMode: "safe",
      approvalPort: {
        async request(request) {
          racedFingerprints.push(request.plan.fingerprint);
          await writeFile(target, "concurrent", "utf8");
          return { decision: "allow_once", planFingerprint: request.plan.fingerprint };
        },
      },
    });
    await expect(
      outcome(raced, {
        type: "tool_call",
        callId: "race-after-approval",
        name: "apply_patch",
        arguments: { path: "a.txt", oldText: "before", newText: "after" },
      }),
    ).resolves.toMatchObject({ status: "conflict", effectState: "none" });
    expect(racedFingerprints).toHaveLength(2);
    expect(racedFingerprints[1]).not.toBe(racedFingerprints[0]);
    await expect(readFile(target, "utf8")).resolves.toBe("concurrent");
  });

  it("ToolPlan fingerprint 对相同 plan 稳定，并在 volatile precondition 变化后失效", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-fingerprint-"));
    temporaryDirectories.push(root);
    const target = path.join(root, "a.txt");
    await writeFile(target, "before one", "utf8");
    const fingerprints: string[] = [];
    const host = createCodingToolHost({
      workspaceRoot: root,
      permissionMode: "safe",
      approvalPort: {
        async request(request) {
          fingerprints.push(request.plan.fingerprint);
          return { decision: "deny", planFingerprint: request.plan.fingerprint };
        },
      },
    });
    const call = {
      type: "tool_call" as const,
      callId: "stable-plan",
      name: "apply_patch",
      arguments: { path: "a.txt", oldText: "before", newText: "after" },
    };
    await outcome(host, call);
    await outcome(host, call);
    await writeFile(target, "before two", "utf8");
    await outcome(host, call);

    expect(fingerprints).toHaveLength(3);
    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect(fingerprints[2]).not.toBe(fingerprints[0]);
  });
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
      effectState: "unknown",
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

    const limited = await outcome(host, {
      type: "tool_call",
      callId: "limited",
      name: "read_file",
      arguments: { path: "large.txt" },
    });
    expect(limited).toMatchObject({
      status: "output_limit",
      effectState: "none",
      modelContent: expect.any(String),
      evidence: {
        truncated: true,
        originalBytes: expect.any(Number),
        inlineBytes: expect.any(Number),
        budget: "modelContent",
      },
    });
    expect(limited.artifacts).toHaveLength(1);
    const artifactRef = limited.artifacts[0] ?? { id: "missing" };
    await expect(host.artifacts.stat(artifactRef)).resolves.toMatchObject({
      id: artifactRef.id,
      mediaType: "text/plain",
      byteLength: expect.any(Number),
    });
    await expect(host.artifacts.verify(artifactRef)).resolves.toEqual({ status: "verified" });
    const chunks: Uint8Array[] = [];
    for await (const chunk of host.artifacts.read(artifactRef)) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toContain("abcdefghij");

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

  it("Artifact spill failure 仍 resolve exactly-one failed ToolOutcome", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-artifact-failure-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "large.txt"), "content larger than budget", "utf8");
    const host = createCodingToolHost({
      workspaceRoot: root,
      maxOutputBytes: 8,
      artifactStore: {
        async put() {
          throw new Error("private artifact failure");
        },
        async stat() {
          throw new Error("private artifact missing");
        },
        async *read() {},
        async verify() {
          return { status: "missing" as const };
        },
        async [Symbol.asyncDispose]() {},
      },
    });

    const result = await outcome(host, {
      type: "tool_call",
      callId: "artifact-failure",
      name: "read_file",
      arguments: { path: "large.txt" },
    });
    expect(result).toMatchObject({ status: "failed", effectState: "none", artifacts: [] });
    expect(JSON.stringify(result)).not.toContain("private artifact failure");
  });

  it("run_command 在 path preflight 期间收到 abort 时不启动 process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-abort-"));
    temporaryDirectories.push(root);
    const host = createCodingToolHost({ workspaceRoot: root, commandTimeoutMs: 5_000 });
    const controller = new AbortController();
    const command =
      process.platform === "win32"
        ? "Set-Content -LiteralPath marker.txt -Value started"
        : "printf started > marker.txt";

    const pending = outcome(
      host,
      {
        type: "tool_call",
        callId: "abort-during-preflight",
        name: "run_command",
        arguments: { command },
      },
      controller.signal,
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      abortObserved: true,
      effectState: "none",
    });
    await expect(access(path.join(root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("apply_patch 在 atomic replace 前重新校验 content precondition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-race-"));
    temporaryDirectories.push(root);
    const target = path.join(root, "race.txt");
    await writeFile(target, "before", "utf8");
    let changed = false;
    let resolveChange: (() => void) | undefined;
    const changeCommitted = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watch(root, (_event, filename) => {
      if (!changed && filename?.startsWith(".race.txt.") && filename.endsWith(".tmp")) {
        changed = true;
        void writeFile(target, "concurrent", "utf8").then(() => resolveChange?.());
      }
    });
    const host = createCodingToolHost({ workspaceRoot: root });

    const result = await outcome(host, {
      type: "tool_call",
      callId: "patch-race",
      name: "apply_patch",
      arguments: { path: "race.txt", oldText: "before", newText: "after" },
    });
    watcher.close();
    await changeCommitted;

    expect(result).toMatchObject({ status: "conflict", effectState: "none" });
    await expect(readFile(target, "utf8")).resolves.toBe("concurrent");
  });

  it("依赖失败、invalid UTF-8、受保护路径、command non-zero 与 timeout 都有确定 outcome", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-tools-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "binary.bin"), new Uint8Array([0xff, 0xfe]));
    await writeFile(path.join(root, "nul.bin"), new Uint8Array([0x41, 0x00, 0x42]));
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
      { id: "nul", name: "read_file", arguments: { path: "nul.bin" }, status: "rejected" },
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
