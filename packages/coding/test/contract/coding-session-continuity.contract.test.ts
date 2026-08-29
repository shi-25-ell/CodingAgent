import { describe, expect, it } from "bun:test";
import {
  createAgent,
  createAgentHarness,
  createDisabledToolExecutor,
  createFixedRunPolicies,
  createTranscriptContextManager,
} from "@coding-agent/agent";
import {
  InMemorySessionRepository,
  ManualClock,
  SequentialIdFactory,
} from "@coding-agent/agent/testing";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";
import { type CodingStartError, createCodingAgent } from "../../src/app/coding-agent.js";
import type { WorkspaceService, WorkspaceSnapshot } from "../../src/workspace/workspace-service.js";

const root = "D:/work/demo";

function snapshot(fingerprint: string, clean = true): WorkspaceSnapshot {
  return {
    binding: { root, fingerprint },
    head: "abc123",
    branch: fingerprint,
    clean,
    changedPaths: clean ? [] : ["changed.ts"],
  };
}

function textMessages(
  request: Parameters<
    NonNullable<ConstructorParameters<typeof ScriptedModel>[0][number]["assertRequest"]>
  >[0],
): readonly string[] {
  return request.messages.flatMap((message) => {
    if (message.role === "tool") return [message.content];
    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  });
}

function application(model: ScriptedModel, workspace: WorkspaceService) {
  const sessions = new InMemorySessionRepository({
    clock: new ManualClock(0),
    ids: new SequentialIdFactory(),
  });
  return {
    sessions,
    agent: createCodingAgent({
      sessions,
      harness: createAgentHarness({ agent: createAgent() }),
      model,
      tools: createDisabledToolExecutor(),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 1_024 }),
      policies: createFixedRunPolicies({
        maxModelTurns: 1,
        maxModelAttempts: 1,
        maxRetries: 0,
      }),
      configurationRevision: "continuity-test-1",
      workspace,
    }),
  };
}

describe("CodingSession continuous conversation contract", () => {
  it("同一 Session 的后续 Run 以及 fork branch 都通过 durable Transcript 继续", async () => {
    const workspace = { inspect: async () => snapshot("branch:main") } satisfies WorkspaceService;
    const model = new ScriptedModel([
      { outcome: { status: "completed", response: scriptedTextResponse("first answer") } },
      {
        assertRequest(request) {
          expect(textMessages(request)).toEqual(
            expect.arrayContaining(["first task", "first answer", "second task"]),
          );
        },
        outcome: { status: "completed", response: scriptedTextResponse("second answer") },
      },
      {
        assertRequest(request) {
          expect(textMessages(request)).toEqual(
            expect.arrayContaining(["first task", "second task", "fork task"]),
          );
        },
        outcome: { status: "completed", response: scriptedTextResponse("fork answer") },
      },
    ]);
    const app = application(model, workspace);
    const session = await app.agent.createSession({
      workspace: { root, fingerprint: "branch:main" },
    });

    await (await session.startRun({ task: "first task" })).finished;
    const reopened = await app.agent.openSession(session.ref);
    await (await reopened.startRun({ task: "second task" })).finished;
    const parent = await reopened.inspect();
    const fork = await reopened.fork({
      fromBranchId: parent.currentBranchId,
      expectedRevision: parent.revision,
    });
    const afterFork = await reopened.inspect();
    const selected = await reopened.selectBranch({
      branchId: fork.branchId,
      expectedRevision: afterFork.revision,
    });
    await (await reopened.startRun({ task: "fork task" })).finished;

    expect(selected.currentBranchId).toBe(fork.branchId);
    expect(selected.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branchId: parent.currentBranchId }),
        expect.objectContaining({
          branchId: fork.branchId,
          parentBranchId: parent.currentBranchId,
        }),
      ]),
    );
    model.assertConsumed();
    await app.sessions[Symbol.asyncDispose]();
  });

  it("workspace mismatch 在 durable Run 前 fail closed，并只接受当前 fingerprint 的显式确认", async () => {
    let current = snapshot("branch:main");
    const workspace = { inspect: async () => current } satisfies WorkspaceService;
    const model = new ScriptedModel([
      { outcome: { status: "completed", response: scriptedTextResponse("continued") } },
    ]);
    const app = application(model, workspace);
    const session = await app.agent.createSession({
      workspace: { root, fingerprint: "branch:main" },
    });
    current = snapshot("branch:alternate");

    await expect(session.startRun({ task: "continue" })).rejects.toMatchObject({
      code: "CODING_WORKSPACE_MISMATCH",
      currentWorkspace: { root, fingerprint: "branch:alternate" },
    } satisfies Partial<CodingStartError>);
    expect((await session.inspect()).activeRunId).toBeUndefined();
    await expect(
      session.startRun({ task: "continue", acceptWorkspaceFingerprint: "branch:stale" }),
    ).rejects.toMatchObject({
      code: "CODING_WORKSPACE_MISMATCH",
    } satisfies Partial<CodingStartError>);

    const run = await session.startRun({
      task: "continue",
      acceptWorkspaceFingerprint: "branch:alternate",
    });
    expect((await run.finished).status).toBe("completed");
    model.assertConsumed();
    await app.sessions[Symbol.asyncDispose]();
  });

  it("dirty workspace 在 Session 创建前被拒绝且不留下半 Session", async () => {
    const model = new ScriptedModel([]);
    const app = application(model, {
      inspect: async () => snapshot("branch:main", false),
    });

    await expect(
      app.agent.createSession({ workspace: { root, fingerprint: "branch:main" } }),
    ).rejects.toMatchObject({
      code: "CODING_WORKSPACE_DIRTY",
    } satisfies Partial<CodingStartError>);
    expect(await app.agent.listSessions()).toEqual([]);
    await app.sessions[Symbol.asyncDispose]();
  });

  it("preflight 期间发生 branch selection 时 revision CAS 阻止 Run 落到旧 branch", async () => {
    let duringNextInspection: (() => Promise<void>) | undefined;
    const workspace = {
      async inspect() {
        const action = duringNextInspection;
        duringNextInspection = undefined;
        await action?.();
        return snapshot("branch:main");
      },
    } satisfies WorkspaceService;
    const model = new ScriptedModel([]);
    const app = application(model, workspace);
    const session = await app.agent.createSession({
      workspace: { root, fingerprint: "branch:main" },
    });
    const initial = await session.inspect();
    const fork = await session.fork({
      fromBranchId: initial.currentBranchId,
      expectedRevision: initial.revision,
    });
    const afterFork = await session.inspect();
    duringNextInspection = async () => {
      await session.selectBranch({
        branchId: fork.branchId,
        expectedRevision: afterFork.revision,
      });
    };

    await expect(
      session.startRun({ task: "must not start on stale branch" }),
    ).rejects.toMatchObject({ code: "SESSION_REVISION_CONFLICT" });
    const final = await session.inspect();
    expect(final.currentBranchId).toBe(fork.branchId);
    expect(final.activeRunId).toBeUndefined();
    expect(model.requests()).toEqual([]);
    await app.sessions[Symbol.asyncDispose]();
  });
});
