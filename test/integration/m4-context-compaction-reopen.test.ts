import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ArtifactStore,
  type ContextManager,
  createAgent,
  createAgentHarness,
  createArtifactPreviewContextSource,
  createCheckpointContextSource,
  createContextManager,
  createCurrentTaskContextSource,
  createDisabledToolExecutor,
  createFixedRunPolicies,
  createQueueContextSource,
  createRunBoundaryContextSource,
  createSummaryCompactionStrategy,
  createSystemToolContextSource,
  createTranscriptContextSource,
} from "@coding-agent/agent";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { createCodingAgent, type WorkspaceService } from "@coding-agent/coding";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";
import { createSqlitePersistence } from "@coding-agent/sqlite";

const binding = { root: "D:/work/m4", fingerprint: "workspace-m4" };

const workspace: WorkspaceService = {
  async inspect() {
    return {
      binding,
      head: "m4",
      branch: "main",
      clean: true,
      changedPaths: [],
    };
  },
};

function context(
  model: ScriptedModel,
  artifacts: ArtifactStore,
  ids: SequentialIdFactory,
): ContextManager {
  return createContextManager({
    sources: [
      createSystemToolContextSource([{ type: "text", text: "system" }]),
      createCurrentTaskContextSource(),
      createQueueContextSource(),
      createTranscriptContextSource(),
      createRunBoundaryContextSource(),
      createCheckpointContextSource(artifacts),
      createArtifactPreviewContextSource(artifacts),
    ],
    compaction: createSummaryCompactionStrategy({
      model,
      artifacts,
      ids,
      summaryOutputTokens: 128,
      triggerRatio: 0.5,
    }),
    modelContextWindow: 1_800,
    requestedOutputReserve: 256,
    safetyMargin: 128,
    retainedTailTokens: 64,
  });
}

describe("M4 Context compaction durable vertical slice", () => {
  it("CodingAgent compaction 独立计数，checkpoint 在 close/reopen 与 fork 后继续适用", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m4-context-"));
    const databasePath = path.join(root, "state.sqlite3");
    const artifactDirectory = path.join(root, "artifacts");
    const clock = new ManualClock(1_000);
    const ids = new SequentialIdFactory();
    const firstModel = new ScriptedModel([
      {
        outcome: {
          status: "completed",
          response: scriptedTextResponse(`old-result-${"x".repeat(3_000)}`),
        },
      },
      {
        assertRequest(request) {
          expect(request.metadata).toMatchObject({ interaction: "context_derivation" });
          expect(request.tools).toEqual([]);
        },
        outcome: {
          status: "completed",
          response: scriptedTextResponse("目标与约束：继续 M4。已验证进展：旧结果已保存。"),
        },
      },
      {
        assertRequest(request) {
          expect(request.instructions.some((part) => part.text.includes("Lossy Compaction"))).toBe(
            true,
          );
        },
        outcome: { status: "completed", response: scriptedTextResponse("second run") },
      },
    ]);
    const firstPersistence = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      lease: { ownerId: "m4-first", durationMs: 30_000 },
      clock,
      ids,
    });
    const firstAgent = createCodingAgent({
      sessions: firstPersistence.sessions,
      harness: createAgentHarness({ agent: createAgent() }),
      model: firstModel,
      tools: createDisabledToolExecutor(),
      context: context(firstModel, firstPersistence.artifacts, ids),
      policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 }),
      configurationRevision: "m4",
      workspace,
    });

    const session = await firstAgent.createSession({ workspace: binding });
    await (await session.startRun({ task: "first" })).finished;
    const second = await (await session.startRun({ task: "second" })).finished;
    expect(second).toMatchObject({
      status: "completed",
      counts: { modelTurnCount: 1, modelAttemptCount: 1, contextDerivationCount: 1 },
    });
    const durable = await firstPersistence.sessions.open(session.ref);
    expect(await durable.readContextDerivations(second.runId)).toEqual([
      expect.objectContaining({ status: "succeeded", checkpointId: "checkpoint-1" }),
    ]);
    const beforeClose = await session.inspect();
    expect(
      (await durable.readBranch({ branchId: beforeClose.currentBranchId })).checkpoints,
    ).toHaveLength(1);
    firstModel.assertConsumed();
    await firstPersistence[Symbol.asyncDispose]();

    const reopenedPersistence = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      lease: { ownerId: "m4-second", durationMs: 30_000 },
      clock,
      ids,
    });
    const reopenedModel = new ScriptedModel([
      {
        assertRequest(request) {
          expect(request.instructions.some((part) => part.text.includes("Lossy Compaction"))).toBe(
            true,
          );
          expect(request.messages.some((message) => message.role === "user")).toBe(true);
        },
        outcome: { status: "completed", response: scriptedTextResponse("continued after reopen") },
      },
    ]);
    const reopenedAgent = createCodingAgent({
      sessions: reopenedPersistence.sessions,
      harness: createAgentHarness({ agent: createAgent() }),
      model: reopenedModel,
      tools: createDisabledToolExecutor(),
      context: context(reopenedModel, reopenedPersistence.artifacts, ids),
      policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 }),
      configurationRevision: "m4",
      workspace,
    });
    const reopened = await reopenedAgent.openSession(session.ref);
    const reopenedView = await reopened.inspect();
    const fork = await reopened.fork({
      fromBranchId: reopenedView.currentBranchId,
      expectedRevision: reopenedView.revision,
    });
    await reopened.selectBranch({
      branchId: fork.branchId,
      expectedRevision: reopenedView.revision + 1,
    });
    const forkedBranch = await reopenedPersistence.sessions.open(session.ref);
    expect((await forkedBranch.readBranch({ branchId: fork.branchId })).checkpoints).toHaveLength(
      1,
    );

    const third = await (await reopened.startRun({ task: "third" })).finished;
    expect(third).toMatchObject({
      status: "completed",
      finalAnswer: "continued after reopen",
      counts: { contextDerivationCount: 0, modelAttemptCount: 1 },
    });
    reopenedModel.assertConsumed();
    await reopenedPersistence[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });
});
