import { access, mkdtemp, rm } from "node:fs/promises";
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
import {
  createApprovalBridge,
  createCodingAgent,
  createCodingToolHost,
} from "@coding-agent/coding";
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

function toolTurn(callId: string) {
  return {
    version: 1 as const,
    content: [
      {
        type: "tool_call" as const,
        callId,
        name: "create_file",
        arguments: { path: "created.txt", content: "created through production path" },
      },
    ],
    finishReason: "tool_calls" as const,
  };
}

describe("M2 CodingAgent approval integration", () => {
  it("respond_permission command 通过 Harness→ToolHost correlation 后继续 Model Turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m2-approval-agent-"));
    temporaryDirectories.push(root);
    const approvals = createApprovalBridge();
    const requests = approvals.requests()[Symbol.asyncIterator]();
    const sessions = new InMemorySessionRepository({
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
    });
    const model = new ScriptedModel([
      { outcome: { status: "completed", response: toolTurn("create-1") } },
      {
        assertRequest(request) {
          expect(request.messages.at(-1)).toMatchObject({
            role: "tool",
            callId: "create-1",
            isError: false,
          });
        },
        outcome: {
          status: "completed",
          response: {
            version: 1,
            content: [{ type: "text", text: "已创建并核验" }],
            finishReason: "stop",
          },
        },
      },
    ]);
    const application = createCodingAgent({
      sessions,
      harness: createAgentHarness({ agent: createAgent() }),
      model,
      tools: createCodingToolHost({
        workspaceRoot: root,
        permissionMode: "safe",
        approvalPort: approvals,
      }),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 2, maxModelAttempts: 2, maxRetries: 0 }),
      configurationRevision: "m2-approval-integration",
      approvals,
    });
    const session = await application.createSession({
      workspace: { root, fingerprint: "fixture" },
    });
    const handle = await session.startRun({ task: "创建文件" });
    const request = await requests.next();
    if (!request.value) throw new Error("permission request 未发布");

    await expect(
      handle.dispatch({
        commandId: "permission-1",
        type: "respond_permission",
        approvalId: request.value.approvalId,
        decision: "allow_once",
        planFingerprint: request.value.plan.fingerprint,
      }),
    ).resolves.toEqual({ commandId: "permission-1", status: "accepted" });
    await expect(handle.finished).resolves.toMatchObject({
      status: "completed",
      finalAnswer: "已创建并核验",
      counts: { modelTurnCount: 2, toolCallCount: 1, settledToolCallCount: 1 },
      permissions: { requested: 1, allowed: 1, denied: 0 },
      changedFiles: [{ path: "created.txt", change: "created" }],
    });
    model.assertConsumed();
    await sessions[Symbol.asyncDispose]();
  });

  it("Harness abort 传播到 pending approval 并结算 cancelled outcome", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m2-approval-abort-"));
    temporaryDirectories.push(root);
    const approvals = createApprovalBridge();
    const requests = approvals.requests()[Symbol.asyncIterator]();
    const sessions = new InMemorySessionRepository({
      clock: new ManualClock(2_000),
      ids: new SequentialIdFactory(),
    });
    const model = new ScriptedModel([
      { outcome: { status: "completed", response: toolTurn("create-abort") } },
    ]);
    const application = createCodingAgent({
      sessions,
      harness: createAgentHarness({ agent: createAgent() }),
      model,
      tools: createCodingToolHost({
        workspaceRoot: root,
        permissionMode: "safe",
        approvalPort: approvals,
      }),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 256 }),
      policies: createFixedRunPolicies({ maxModelTurns: 2, maxModelAttempts: 2, maxRetries: 0 }),
      configurationRevision: "m2-approval-abort",
      approvals,
    });
    const session = await application.createSession({
      workspace: { root, fingerprint: "fixture" },
    });
    const handle = await session.startRun({ task: "创建后取消" });
    await requests.next();
    await expect(
      handle.dispatch({ commandId: "abort-pending-approval", type: "abort" }),
    ).resolves.toMatchObject({ status: "accepted" });

    await expect(handle.finished).resolves.toMatchObject({
      status: "aborted",
      counts: { toolCallCount: 1, settledToolCallCount: 1 },
      permissions: { requested: 1, allowed: 0, denied: 0 },
    });
    await expect(access(path.join(root, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    model.assertConsumed();
    await sessions[Symbol.asyncDispose]();
  });
});
