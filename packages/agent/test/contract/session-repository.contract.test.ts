import { describe, expect, it } from "bun:test";
import { sessionRepositoryConformance } from "../../../../test/contract/session-repository.conformance.js";
import {
  InMemorySessionRepository,
  ManualClock,
  SequentialIdFactory,
} from "../../src/testing/index.js";

sessionRepositoryConformance("InMemory", () => {
  const repository = new InMemorySessionRepository({
    clock: new ManualClock(1_000),
    ids: new SequentialIdFactory(),
  });
  return {
    repository,
    dispose: () => repository[Symbol.asyncDispose](),
  };
});

describe("InMemorySessionRepository storage uncertainty", () => {
  it("finish 在 Adapter 内将 expected storage uncertainty 结算为 durable failed report", async () => {
    const repository = new InMemorySessionRepository({
      clock: new ManualClock(),
      ids: new SequentialIdFactory(),
      beforeFinish: async () => {
        throw new Error("injected storage uncertainty");
      },
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const lease = await session.beginRun({
      branchId: snapshot.currentBranchId,
      expectedRevision: snapshot.revision,
      initialMessages: [{ role: "user", text: "first" }],
      metadata: { task: "first", configurationRevision: "m2" },
    });
    await lease.markModelTurnStarted(1);
    await lease.commitContext({
      version: 2,
      id: `${lease.runId}:attempt-1`,
      runId: lease.runId,
      modelAttemptCount: 1,
      budget: {
        modelContextWindow: 32_768,
        requestedOutputReserve: 8_192,
        protocolToolSchemaReserve: 32,
        safetyMargin: 512,
        usableInputBudget: 24_032,
      },
      contributions: [],
      selectedRecordIds: [],
      selectedCheckpointIds: [],
      selectedArtifactIds: [],
      omitted: [],
      requestDigest: "request-1",
    });
    await lease.append([
      {
        kind: "assistant_message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "not durable" }],
          finishReason: "stop",
        },
      },
    ]);

    const requestedReport = {
      version: 1 as const,
      runId: lease.runId,
      status: "completed" as const,
      terminationReason: "natural_completion" as const,
      finalAnswer: "not durable",
      counts: {
        modelTurnCount: 1,
        modelAttemptCount: 1,
        contextDerivationCount: 0,
        toolCallCount: 0,
        settledToolCallCount: 0,
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, attemptsWithUnknownUsage: 0 },
      tools: { accepted: 0, settled: 0, succeeded: 0, failed: 0 },
      permissions: { requested: 0, allowed: 0, denied: 0 },
      changedFiles: [],
      commands: [],
      unfinishedWork: [],
      lastPhase: "finalizing" as const,
    };
    const terminal = await lease.finish(requestedReport);
    expect(terminal).toMatchObject({
      committed: true,
      report: {
        status: "failed",
        terminationReason: "persistence_failure",
        error: { code: "TERMINAL_COMMIT_FAILURE" },
      },
    });
    await expect(lease.finish(requestedReport)).resolves.toEqual({
      committed: false,
      report: terminal.report,
    });
    expect((await session.inspect()).activeRunId).toBeUndefined();
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });
    expect(branch.records.filter((record) => record.kind === "run_terminal")).toHaveLength(1);
    await repository[Symbol.asyncDispose]();
  });
});
