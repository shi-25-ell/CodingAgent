import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgent,
  createAgentHarness,
  createDisabledToolExecutor,
  createFixedRunPolicies,
  createTranscriptContextManager,
} from "@coding-agent/agent";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { createCodingAgent, type WorkspaceService } from "@coding-agent/coding";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";
import { createSqlitePersistence } from "@coding-agent/sqlite";

function workspace(): WorkspaceService {
  return {
    async inspect(root) {
      return {
        binding: { root, fingerprint: "head:abc" },
        head: "abc",
        branch: "main",
        clean: true,
        changedPaths: [],
      };
    },
  };
}

describe("M3 SQLite Run reopen", () => {
  it("CodingAgent 完成 Run 后，reopen 保持 Transcript、current branch 与 RunReport", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-run-reopen-"));
    const databasePath = path.join(root, "state.sqlite3");
    const artifactDirectory = path.join(root, "artifacts");
    const clock = new ManualClock(2_000);
    const ids = new SequentialIdFactory();
    const model = new ScriptedModel([
      { outcome: { status: "completed", response: scriptedTextResponse("durable answer") } },
    ]);
    const firstPersistence = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      lease: { ownerId: "first-process", durationMs: 30_000 },
      clock,
      ids,
    });
    const firstAgent = createCodingAgent({
      sessions: firstPersistence.sessions,
      harness: createAgentHarness({ agent: createAgent() }),
      model,
      tools: createDisabledToolExecutor(),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 1_024 }),
      policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 }),
      configurationRevision: "m3",
      workspace: workspace(),
    });
    const session = await firstAgent.createSession({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const run = await session.startRun({ task: "persist this run" });
    const report = await run.finished;
    const beforeClose = await session.inspect();
    await firstPersistence[Symbol.asyncDispose]();

    const reopenedPersistence = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      lease: { ownerId: "second-process", durationMs: 30_000 },
      clock,
      ids,
    });
    const reopenedAgent = createCodingAgent({
      sessions: reopenedPersistence.sessions,
      harness: createAgentHarness({ agent: createAgent() }),
      model,
      tools: createDisabledToolExecutor(),
      context: createTranscriptContextManager({ instructions: [], maxOutputTokens: 1_024 }),
      policies: createFixedRunPolicies({ maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 }),
      configurationRevision: "m3",
      workspace: workspace(),
    });
    const reopenedSession = await reopenedAgent.openSession(session.ref);
    const afterReopen = await reopenedSession.inspect();
    const repositorySession = await reopenedPersistence.sessions.open(session.ref);

    expect(afterReopen).toEqual(beforeClose);
    expect(afterReopen.timeline).toEqual([
      { type: "user", text: "persist this run" },
      { type: "assistant", text: "durable answer" },
      { type: "terminal", status: "completed", terminationReason: "natural_completion" },
    ]);
    await expect(repositorySession.readRunReport(report.runId)).resolves.toEqual(report);
    await expect(repositorySession.readContextManifests(report.runId)).resolves.toEqual([
      expect.objectContaining({ runId: report.runId, modelAttemptCount: 1 }),
    ]);

    await reopenedPersistence[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });
});
