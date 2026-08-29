import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runId } from "@coding-agent/agent";
import { createCodingToolHost } from "../../src/index.js";
import { createApprovalBridge } from "../../src/permissions/approval-bridge.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ApprovalBridge contract", () => {
  it("只有匹配 run/approval/fingerprint 的一次 response 能启动 mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-approval-bridge-"));
    temporaryDirectories.push(root);
    const bridge = createApprovalBridge();
    const lifecycle: string[] = [];
    bridge.subscribeLifecycle((event) => lifecycle.push(event.type));
    bridge.subscribe(() => {
      throw new Error("injected observer failure");
    });
    const requests = bridge.requests()[Symbol.asyncIterator]();
    const activeRun = runId("approval-run");
    const host = createCodingToolHost({
      workspaceRoot: root,
      permissionMode: "safe",
      approvalPort: bridge,
    });
    const pending = host.execute(
      {
        type: "tool_call",
        callId: "create-approved",
        name: "create_file",
        arguments: { path: "approved.txt", content: "approved" },
      },
      { runId: activeRun, signal: new AbortController().signal },
    ).outcome;
    const event = await requests.next();
    expect(bridge.diagnostics()).toEqual({ listenerFailureCount: 1 });
    expect(event.done).toBe(false);
    if (!event.value) throw new Error("approval request 未发布");

    expect(
      bridge.respond({
        approvalId: "unknown",
        runId: activeRun,
        decision: "allow_once",
        planFingerprint: event.value.plan.fingerprint,
      }),
    ).toMatchObject({ status: "unknown" });
    expect(
      bridge.respond({
        approvalId: event.value.approvalId,
        runId: activeRun,
        decision: "allow_once",
        planFingerprint: "stale",
      }),
    ).toMatchObject({ status: "stale" });
    await expect(access(path.join(root, "approved.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const command = {
      approvalId: event.value.approvalId,
      runId: activeRun,
      decision: "allow_once" as const,
      planFingerprint: event.value.plan.fingerprint,
    };
    expect(bridge.respond(command)).toMatchObject({ status: "accepted" });
    expect(bridge.respond(command)).toMatchObject({ status: "already_applied" });
    await expect(pending).resolves.toMatchObject({ status: "succeeded" });
    bridge.invalidate?.(command.approvalId);
    expect(bridge.respond(command)).toMatchObject({ status: "stale" });
    expect(lifecycle).toEqual(["requested", "resolved", "stale"]);
    await expect(readFile(path.join(root, "approved.txt"), "utf8")).resolves.toBe("approved");
  });

  it("abort 取消 pending approval 且不启动 Adapter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-approval-abort-"));
    temporaryDirectories.push(root);
    const bridge = createApprovalBridge();
    const lifecycle: string[] = [];
    bridge.subscribeLifecycle((item) => lifecycle.push(item.type));
    const requests = bridge.requests()[Symbol.asyncIterator]();
    const controller = new AbortController();
    const activeRun = runId("approval-abort-run");
    const host = createCodingToolHost({
      workspaceRoot: root,
      permissionMode: "safe",
      approvalPort: bridge,
    });
    const pending = host.execute(
      {
        type: "tool_call",
        callId: "create-aborted",
        name: "create_file",
        arguments: { path: "aborted.txt", content: "must-not-exist" },
      },
      { runId: activeRun, signal: controller.signal },
    ).outcome;
    const event = await requests.next();
    if (!event.value) throw new Error("approval request 未发布");
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      effectState: "none",
      abortObserved: true,
    });
    expect(
      bridge.respond({
        approvalId: event.value.approvalId,
        runId: activeRun,
        decision: "allow_once",
        planFingerprint: event.value.plan.fingerprint,
      }),
    ).toMatchObject({ status: "unknown" });
    await expect(access(path.join(root, "aborted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(lifecycle).toEqual(["requested", "withdrawn"]);
  });
});
