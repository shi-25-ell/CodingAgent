import type { RunLease, RunReport, SessionRepository, SessionSnapshot } from "@coding-agent/agent";
import { describe, expect, it } from "vitest";

export interface SessionRepositoryConformanceHarness {
  readonly repository: SessionRepository;
  dispose(): Promise<void>;
}

export type SessionRepositoryConformanceFactory = () =>
  | SessionRepositoryConformanceHarness
  | Promise<SessionRepositoryConformanceHarness>;

function completedReport(lease: RunLease, toolCount = 0): RunReport {
  return {
    version: 1,
    runId: lease.runId,
    status: "completed",
    terminationReason: "natural_completion",
    finalAnswer: "done",
    counts: {
      modelTurnCount: toolCount === 0 ? 1 : 2,
      modelAttemptCount: toolCount === 0 ? 1 : 2,
      contextDerivationCount: 0,
      toolCallCount: toolCount,
      settledToolCallCount: toolCount,
    },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, attemptsWithUnknownUsage: 0 },
    tools: { accepted: toolCount, settled: toolCount, succeeded: toolCount, failed: 0 },
    permissions: { requested: 0, allowed: 0, denied: 0 },
    changedFiles: [],
    commands: [],
    unfinishedWork: [],
    lastPhase: "finalizing",
  };
}

async function commitAttempt(lease: RunLease, modelAttemptCount: number): Promise<void> {
  await lease.markModelTurnStarted(modelAttemptCount);
  await lease.commitContext({
    version: 1,
    id: `${lease.runId}:attempt-${modelAttemptCount}`,
    runId: lease.runId,
    modelAttemptCount,
    selectedRecordIds: [],
    omitted: [],
  });
}

async function commitFinalAssistant(lease: RunLease, text: string): Promise<void> {
  await lease.append([
    {
      kind: "assistant_message",
      message: { role: "assistant", content: [{ type: "text", text }], finishReason: "stop" },
    },
  ]);
}

async function createSession(repository: SessionRepository) {
  return repository.create({
    workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
  });
}

export function sessionRepositoryConformance(
  adapterName: string,
  createHarness: SessionRepositoryConformanceFactory,
): void {
  describe(`${adapterName} SessionRepository conformance`, () => {
    it("创建、列出、打开和分支都通过 public Interface 保持 tree 与 revision CAS", async () => {
      const harness = await createHarness();
      try {
        const created = await createSession(harness.repository);
        const initial = await created.inspect();
        expect(initial).toMatchObject({ revision: 1 });
        expect(initial.activeRunId).toBeUndefined();
        expect(initial.branches).toHaveLength(1);
        expect(await harness.repository.list()).toEqual([
          expect.objectContaining({ ref: created.ref, revision: 1 }),
        ]);

        const branch = await created.forkBranch({
          fromBranchId: initial.currentBranchId,
          expectedRevision: initial.revision,
        });
        await expect(created.selectBranch(branch.branchId, initial.revision)).rejects.toMatchObject(
          { code: "SESSION_REVISION_CONFLICT" },
        );
        const selected = await created.selectBranch(branch.branchId, 2);
        expect(selected.currentBranchId).toBe(branch.branchId);
        expect(selected.revision).toBe(3);

        const reopened = await harness.repository.open(created.ref);
        expect(await reopened.inspect()).toEqual(selected);
      } finally {
        await harness.dispose();
      }
    });

    it("同一 Session 只允许一个 active Run，不同 Session 的 writer 能并行", async () => {
      const harness = await createHarness();
      try {
        const firstSession = await createSession(harness.repository);
        const secondSession = await harness.repository.create({
          workspace: { root: "D:/work/other", fingerprint: "head:def" },
        });
        const firstSnapshot = await firstSession.inspect();
        const secondSnapshot = await secondSession.inspect();
        const first = await firstSession.beginRun({
          branchId: firstSnapshot.currentBranchId,
          initialMessages: [{ role: "user", text: "first" }],
          metadata: { task: "first", configurationRevision: "m3" },
        });

        await expect(
          firstSession.beginRun({
            branchId: firstSnapshot.currentBranchId,
            initialMessages: [{ role: "user", text: "competing" }],
            metadata: { task: "competing", configurationRevision: "m3" },
          }),
        ).rejects.toMatchObject({ code: "SESSION_ACTIVE_RUN" });

        const second = await secondSession.beginRun({
          branchId: secondSnapshot.currentBranchId,
          initialMessages: [{ role: "user", text: "parallel" }],
          metadata: { task: "parallel", configurationRevision: "m3" },
        });
        await commitAttempt(first, 1);
        await commitFinalAssistant(first, "first done");
        await commitAttempt(second, 1);
        await commitFinalAssistant(second, "second done");
        await first.finish(completedReport(first));
        await second.finish(completedReport(second));
      } finally {
        await harness.dispose();
      }
    });

    it("Run、ToolCall/Outcome、queue 与 terminal 通过同一 commit path 保持 pairing 和幂等", async () => {
      const harness = await createHarness();
      try {
        const session = await createSession(harness.repository);
        const initial: SessionSnapshot = await session.inspect();
        const lease = await session.beginRun({
          branchId: initial.currentBranchId,
          initialMessages: [{ role: "user", text: "inspect" }],
          metadata: { task: "inspect", configurationRevision: "m3" },
        });
        await commitAttempt(lease, 1);
        await lease.append([
          {
            kind: "assistant_message",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "checking" },
                { type: "tool_call", callId: "call-1", name: "read_file", arguments: {} },
              ],
              finishReason: "tool_calls",
            },
          },
        ]);
        const steering = await session.enqueue({
          commandId: "steer-1",
          kind: "steering",
          text: "also inspect tests",
        });
        await expect(
          session.enqueue({ commandId: "steer-1", kind: "steering", text: "changed" }),
        ).resolves.toEqual(steering);
        const edited = await session.updateQueue({
          commandId: "steer-1",
          expectedRevision: steering.revision,
          text: "also inspect integration tests",
          status: "queued",
        });
        expect(edited).toMatchObject({ revision: 2, text: "also inspect integration tests" });
        await expect(lease.drainSteering()).resolves.toEqual([
          expect.objectContaining({
            commandId: "steer-1",
            status: "delivered",
            revision: 3,
            text: "also inspect integration tests",
          }),
        ]);
        await lease.append([
          {
            kind: "tool_outcome",
            outcome: {
              callId: "call-1",
              status: "succeeded",
              isError: false,
              modelContent: "contents",
              effectState: "none",
              abortObserved: false,
              artifacts: [],
            },
          },
        ]);
        await commitAttempt(lease, 2);
        await commitFinalAssistant(lease, "done");
        const report = completedReport(lease, 1);
        const terminal = await lease.finish(report);
        expect(terminal).toEqual({ committed: true, report });
        await expect(lease.finish(report)).resolves.toEqual({ committed: false, report });

        const reopened = await harness.repository.open(session.ref);
        const snapshot = await reopened.inspect();
        const branch = await reopened.readBranch({ branchId: snapshot.currentBranchId });
        expect(snapshot.activeRunId).toBeUndefined();
        expect(branch.records.map((record) => record.kind)).toEqual([
          "run_started",
          "user_message",
          "assistant_message",
          "user_message",
          "tool_outcome",
          "assistant_message",
          "run_boundary",
          "run_terminal",
        ]);
        expect(branch.records.filter((record) => record.kind === "run_terminal")).toHaveLength(1);
      } finally {
        await harness.dispose();
      }
    });
  });
}
