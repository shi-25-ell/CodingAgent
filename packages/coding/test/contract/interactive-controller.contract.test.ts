import { describe, expect, it } from "bun:test";
import { branchId, runId, sessionId } from "@coding-agent/agent";
import { ManualGate } from "@coding-agent/agent/testing";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";
import type { CodingRunHandle, CodingSession } from "../../src/app/coding-agent.js";
import type { CodingEvent } from "../../src/app/coding-events.js";
import { createInteractiveController, type TuiViewModel } from "../../src/index.js";
import type { CodingSessionSnapshot } from "../../src/projection/contracts.js";
import { createDeterministicCodingAgent } from "../../src/testing/index.js";

async function waitForView(
  controller: ReturnType<typeof createInteractiveController>,
  predicate: (viewModel: TuiViewModel) => boolean,
): Promise<TuiViewModel> {
  const current = controller.current();
  if (predicate(current)) return current;
  return new Promise<TuiViewModel>((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("等待 TuiViewModel 收敛超时"));
    }, 2_000);
    unsubscribe = controller.subscribe((viewModel) => {
      if (!predicate(viewModel)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(viewModel);
    });
  });
}

describe("InteractiveController contract", () => {
  it("renderer-facing snapshot 组合 immutable projection 与 UI-local state", async () => {
    const application = createDeterministicCodingAgent({ model: new ScriptedModel([]) });
    const session = await application.agent.createSession({
      workspace: { root: "D:/work/interactive-local", fingerprint: "head:abc" },
    });
    const controller = createInteractiveController({ session, width: 100, height: 28 });

    const initial = await controller.start();
    expect(initial).toMatchObject({
      version: 1,
      transcript: [],
      ui: {
        focusedRegion: "composer",
        composer: { value: "", revision: 0, deliveryMode: "steering" },
        terminal: { width: 100, height: 28 },
        sidebar: { preference: "auto", open: false },
        themeId: "dex",
        toolDisplay: { showDetails: true, showGenericOutput: false },
      },
    });
    const sessionBefore = await session.snapshot();
    await controller.dispatch({ version: 1, type: "composer_changed", value: "本地草稿" });
    await controller.dispatch({ version: 1, type: "focus_region", region: "transcript" });
    await controller.dispatch({ version: 1, type: "set_sidebar_preference", preference: "hide" });
    await controller.dispatch({ version: 1, type: "set_sidebar_open", open: true });
    await controller.dispatch({ version: 1, type: "select_theme", themeId: "system" });
    await controller.dispatch({ version: 1, type: "set_tool_details_visible", visible: false });
    await controller.dispatch({
      version: 1,
      type: "set_expanded",
      id: "tool:1",
      expanded: true,
    });

    expect(controller.current().ui).toMatchObject({
      focusedRegion: "transcript",
      composer: { value: "本地草稿", revision: 1, deliveryMode: "steering" },
      sidebar: { preference: "hide", open: true },
      themeId: "system",
      toolDisplay: { showDetails: false, showGenericOutput: false },
    });
    expect(controller.current().ui.expandedIds.has("tool:1")).toBe(true);
    expect(await session.snapshot()).toEqual(sessionBefore);
    expect(Object.isFrozen(controller.current())).toBe(true);

    await controller.dispose();
    await application.dispose();
  });

  it("idle Composer submit 只通过 CodingSession 启动 Run，并在 admission 后清空", async () => {
    const model = new ScriptedModel([
      { outcome: { status: "completed", response: scriptedTextResponse("controller answer") } },
    ]);
    const application = createDeterministicCodingAgent({ model });
    const session = await application.agent.createSession({
      workspace: { root: "D:/work/interactive-submit", fingerprint: "head:abc" },
    });
    const controller = createInteractiveController({ session, width: 80, height: 24 });
    await controller.start();
    await controller.dispatch({ version: 1, type: "composer_changed", value: "检查项目" });
    const terminalView = waitForView(controller, (view) => view.terminalReport !== undefined);

    await expect(
      controller.dispatch({ version: 1, type: "submit_composer", expectedRevision: 1 }),
    ).resolves.toMatchObject({ status: "applied" });
    const completed = await terminalView;

    expect(completed.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "user", text: "检查项目" }),
        expect.objectContaining({ kind: "assistant" }),
      ]),
    );
    expect(completed.terminalReport).toMatchObject({ status: "completed" });
    expect(completed.ui.composer).toMatchObject({ value: "" });
    expect(controller.diagnostics()).toEqual({
      listenerFailureCount: 0,
      projectionResyncCount: 0,
      intentFailureCount: 0,
    });
    model.assertConsumed();

    await controller.dispose();
    await application.dispose();
  });

  it("steering、queue CAS 与 abort 均 dispatch 到 active CodingRunHandle", async () => {
    const gate = new ManualGate();
    const model = new ScriptedModel([
      {
        before: async (signal) => {
          await gate.wait(signal);
        },
        outcome: { status: "completed", response: scriptedTextResponse("not reached") },
      },
    ]);
    const application = createDeterministicCodingAgent({ model });
    const session = await application.agent.createSession({
      workspace: { root: "D:/work/interactive-commands", fingerprint: "head:abc" },
    });
    const run = await session.startRun({ task: "等待 command" });
    await gate.waitUntilBlocked();
    const commandIds = ["steer-1", "follow-1", "edit-1", "stale-1", "abort-1"];
    const controller = createInteractiveController({
      session,
      width: 80,
      height: 24,
      createCommandId: () => commandIds.shift() ?? "unexpected",
    });
    await controller.start();

    await controller.dispatch({ version: 1, type: "composer_changed", value: "先检查测试" });
    await expect(
      controller.dispatch({ version: 1, type: "submit_composer", expectedRevision: 1 }),
    ).resolves.toMatchObject({ status: "applied", commandAck: { commandId: "steer-1" } });
    expect(controller.current().ui.composer).toMatchObject({
      value: "",
      deliveryMode: "steering",
    });
    await controller.dispatch({
      version: 1,
      type: "set_composer_delivery",
      delivery: "follow_up",
    });
    await controller.dispatch({ version: 1, type: "composer_changed", value: "完成后再运行测试" });
    await expect(
      controller.dispatch({ version: 1, type: "submit_composer", expectedRevision: 3 }),
    ).resolves.toMatchObject({ status: "applied", commandAck: { commandId: "follow-1" } });
    const [queued, followUp] = await session.listQueue(run.runId);
    if (!queued) throw new Error("steering queue 未创建");
    expect(followUp).toMatchObject({ kind: "follow_up", status: "queued" });
    await expect(
      controller.dispatch({
        version: 1,
        type: "update_queue",
        targetCommandId: queued.commandId,
        expectedRevision: queued.revision,
        status: "queued",
        text: "先检查 contract tests",
      }),
    ).resolves.toMatchObject({ status: "applied", commandAck: { commandId: "edit-1" } });
    await expect(
      controller.dispatch({
        version: 1,
        type: "update_queue",
        targetCommandId: queued.commandId,
        expectedRevision: queued.revision,
        status: "queued",
        text: "stale edit",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      commandAck: { commandId: "stale-1", status: "conflict" },
    });
    expect(controller.current().diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "QUEUE_REVISION_CONFLICT" })]),
    );
    expect((await session.listQueue(run.runId))[0]?.text).toBe("先检查 contract tests");
    await expect(
      controller.dispatch({ version: 1, type: "abort_run", reason: "contract complete" }),
    ).resolves.toMatchObject({ status: "applied", commandAck: { commandId: "abort-1" } });
    await expect(run.finished).resolves.toMatchObject({ status: "aborted" });
    model.assertConsumed();

    await controller.dispose();
    await application.dispose();
  });

  it("无 active Run 的 command 返回 typed rejection，不越层猜测", async () => {
    const application = createDeterministicCodingAgent({ model: new ScriptedModel([]) });
    const session = await application.agent.createSession({
      workspace: { root: "D:/work/interactive-reject", fingerprint: "head:abc" },
    });
    const controller = createInteractiveController({ session, width: 80, height: 24 });
    await controller.start();

    await expect(
      controller.dispatch({
        version: 1,
        type: "send_run_message",
        delivery: "follow_up",
        text: "继续",
      }),
    ).resolves.toMatchObject({ status: "rejected", message: "当前没有 active Run" });
    expect(controller.current().diagnostics).toEqual([
      expect.objectContaining({ source: "controller", code: "UI_INTENT_FAILED" }),
    ]);
    expect(controller.diagnostics().intentFailureCount).toBe(1);

    await controller.dispose();
    await application.dispose();
  });

  it("pending approval 取得 focus，stale response 保留 prompt 并产生 typed diagnostic", async () => {
    const activeRunId = runId("run-controller-approval");
    const currentBranchId = branchId("branch-controller-approval");
    const ref = { sessionId: sessionId("session-controller-approval") };
    const approval = {
      approvalId: "approval-controller",
      callId: "call-controller",
      decisions: ["allow_once", "deny"] as const,
      status: "pending" as const,
      plan: {
        callId: "call-controller",
        toolName: "shell",
        resources: [{ kind: "command" as const, value: "bun test" }],
        effects: ["process" as const],
        risks: ["启动 foreground process"],
        fingerprint: "fingerprint-controller",
      },
    };
    const snapshot: CodingSessionSnapshot = {
      version: 1,
      ref,
      workspace: { root: "D:/work/interactive-approval", fingerprint: "head:abc" },
      revision: 1,
      currentBranchId,
      activeRunId,
      branches: [{ branchId: currentBranchId, recordCount: 1 }],
      runOrder: [activeRunId],
      runs: {
        [activeRunId]: {
          runId: activeRunId,
          phase: "tool_batch",
          status: "awaiting_approval",
          terminal: false,
          tools: {},
          toolOrder: [],
          approvals: { [approval.approvalId]: approval },
          approvalOrder: [approval.approvalId],
          compactions: [],
        },
      },
      transcript: [],
      queues: [],
      eventCursors: { [activeRunId]: 0 },
    };
    const run = {
      runId: activeRunId,
      snapshot: async () => ({ snapshot, cursor: { semanticSequence: 0 } }),
      events: () => ({
        async *[Symbol.asyncIterator](): AsyncIterator<CodingEvent> {},
      }),
      diagnostics: () => ({}),
      dispatch: async (command: { commandId: string }) => ({
        commandId: command.commandId,
        status: "stale" as const,
      }),
      finished: new Promise(() => {}),
    } as unknown as CodingRunHandle;
    const session = {
      ref,
      activeRun: () => run,
      snapshot: async () => snapshot,
    } as unknown as CodingSession;
    const controller = createInteractiveController({
      session,
      width: 80,
      height: 24,
      createCommandId: () => "approval-response-1",
    });

    const view = await controller.start();
    expect(view.ui).toMatchObject({
      focusedRegion: "approval",
      approvalPrompt: {
        approvalId: approval.approvalId,
        selectedDecision: "allow_once",
      },
      surfaceStack: [{ kind: "approval", id: approval.approvalId }],
    });
    await expect(
      controller.dispatch({
        version: 1,
        type: "respond_approval",
        approvalId: approval.approvalId,
        decision: "allow_once",
        planFingerprint: approval.plan.fingerprint,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      commandAck: { commandId: "approval-response-1", status: "stale" },
    });
    expect(controller.current().ui.approvalPrompt?.approvalId).toBe(approval.approvalId);
    expect(controller.current().diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "APPROVAL_STALE" })]),
    );
    const blockedSubmit = await controller.dispatch({
      version: 1,
      type: "submit_composer",
      expectedRevision: 0,
    });
    expect(blockedSubmit.status).toBe("rejected");
    expect(blockedSubmit.message).toContain("pending approval");

    await controller.dispose();
  });

  it("semantic sequence gap 通过 active handle 的 atomic snapshot/live join 重同步", async () => {
    const activeRunId = runId("run-controller-resync");
    const currentBranchId = branchId("branch-controller-resync");
    const ref = { sessionId: sessionId("session-controller-resync") };
    const snapshot = (revision: number, cursor: number): CodingSessionSnapshot => ({
      version: 1,
      ref,
      workspace: { root: "D:/work/interactive-resync", fingerprint: "head:abc" },
      revision,
      currentBranchId,
      activeRunId,
      branches: [{ branchId: currentBranchId, recordCount: revision }],
      runOrder: [activeRunId],
      runs: {
        [activeRunId]: {
          runId: activeRunId,
          phase: "model_streaming",
          status: "streaming",
          terminal: false,
          tools: {},
          toolOrder: [],
          approvals: {},
          approvalOrder: [],
          compactions: [],
        },
      },
      transcript: [],
      queues: [],
      eventCursors: { [activeRunId]: cursor },
    });
    let snapshotCount = 0;
    let eventSubscriptionCount = 0;
    const run = {
      runId: activeRunId,
      async snapshot() {
        snapshotCount += 1;
        const cursor = snapshotCount === 1 ? 0 : 2;
        return { snapshot: snapshot(snapshotCount, cursor), cursor: { semanticSequence: cursor } };
      },
      events() {
        eventSubscriptionCount += 1;
        const subscription = eventSubscriptionCount;
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<CodingEvent> {
            if (subscription !== 1) return;
            yield {
              version: 1,
              category: "semantic",
              type: "session_updated",
              runId: activeRunId,
              sequence: 2,
              eventId: `${activeRunId}:2`,
              revision: 999,
              currentBranchId,
              activeRunId,
              branches: [{ branchId: currentBranchId, recordCount: 999 }],
            };
          },
        };
      },
      diagnostics: () => ({}),
      dispatch: async () => ({ commandId: "unused", status: "accepted" as const }),
      finished: new Promise(() => {}),
    } as unknown as CodingRunHandle;
    const session = {
      ref,
      activeRun: () => run,
      snapshot: async () => snapshot(0, 0),
    } as unknown as CodingSession;
    const controller = createInteractiveController({ session, width: 80, height: 24 });

    await controller.start();
    const repaired = await waitForView(controller, (view) => view.session.revision === 2);

    expect(repaired.session.revision).toBe(2);
    expect(repaired.diagnostics).toEqual([]);
    expect(controller.diagnostics().projectionResyncCount).toBe(1);
    expect(snapshotCount).toBe(2);
    expect(eventSubscriptionCount).toBe(2);

    await controller.dispose();
  });
});
