import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";
import { completeModelTurns } from "../../src/context/sources.js";
import {
  type ArtifactMetadata,
  type ArtifactRef,
  type ArtifactStore,
  branchId,
  type ContextSource,
  createCheckpointContextSource,
  createContextManager,
  createCurrentTaskContextSource,
  createSummaryCompactionStrategy,
  createSystemToolContextSource,
  createTranscriptContextSource,
  type LedgerRecord,
  recordId,
  runId,
  type SessionBranchView,
  sessionId,
} from "../../src/index.js";
import { SequentialIdFactory } from "../../src/testing/index.js";

const noCompaction = {
  version: "disabled",
  async shouldCompact() {
    return false;
  },
  async compact(): Promise<never> {
    throw new Error("unexpected compaction");
  },
};

type LedgerRecordInput<T> = T extends LedgerRecord
  ? Omit<T, "version" | "recordId" | "ledgerSeq" | "createdAt" | "branchId">
  : never;

function ledgerRecord(sequence: number, record: LedgerRecordInput<LedgerRecord>): LedgerRecord {
  return {
    version: 1,
    recordId: recordId(`record-${sequence}`),
    ledgerSeq: sequence,
    createdAt: sequence,
    branchId: branchId("branch-1"),
    ...record,
  } as LedgerRecord;
}

function branch(
  records: readonly LedgerRecord[],
  checkpoints: SessionBranchView["checkpoints"] = [],
): SessionBranchView {
  return {
    branch: { sessionId: sessionId("session-1"), branchId: branchId("branch-1") },
    records,
    checkpoints,
  };
}

function completedTextTurn(sequence: number, text: string): readonly LedgerRecord[] {
  const previousRun = runId(`previous-${sequence}`);
  return [
    ledgerRecord(sequence, {
      kind: "user_message",
      runId: previousRun,
      origin: "current_task",
      text: `task-${sequence}-${text}`,
    }),
    ledgerRecord(sequence + 1, {
      kind: "assistant_message",
      runId: previousRun,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `answer-${sequence}-${text}` }],
        finishReason: "stop",
      },
    }),
  ];
}

function prepareInput(view: SessionBranchView, attempt = 1) {
  return {
    runId: runId("run-current"),
    modelTurnCount: 1,
    modelAttemptCount: attempt,
    branch: view,
    tools: [],
    signal: new AbortController().signal,
  };
}

class MemoryArtifactStore implements ArtifactStore {
  readonly #entries = new Map<
    string,
    { readonly bytes: Uint8Array; readonly metadata: ArtifactMetadata }
  >();

  async put(input: Parameters<ArtifactStore["put"]>[0]): Promise<ArtifactRef> {
    if (!(input.bytes instanceof Uint8Array)) throw new TypeError("test store requires bytes");
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const ref = { id: `sha256:${digest}` };
    this.#entries.set(ref.id, {
      bytes: input.bytes.slice(),
      metadata: {
        ...ref,
        digest: { algorithm: "sha256", hex: digest },
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
        provenance: input.provenance,
        preview: new TextDecoder().decode(input.bytes).slice(0, 1_024),
      },
    });
    return ref;
  }

  async stat(ref: ArtifactRef): Promise<ArtifactMetadata> {
    const entry = this.#entries.get(ref.id);
    if (!entry) throw new Error("missing");
    return structuredClone(entry.metadata);
  }

  async *read(ref: ArtifactRef): AsyncIterable<Uint8Array> {
    const entry = this.#entries.get(ref.id);
    if (!entry) throw new Error("missing");
    yield entry.bytes.slice();
  }

  async verify(ref: ArtifactRef) {
    return { status: this.#entries.has(ref.id) ? ("verified" as const) : ("missing" as const) };
  }

  clear(): void {
    this.#entries.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#entries.clear();
  }
}

describe("ContextManager contract", () => {
  it("ToolCall 与 ToolOutcome 跨管理记录组成不可拆分的完整 Model Turn", async () => {
    const previousRun = runId("previous");
    const records: LedgerRecord[] = [
      ledgerRecord(1, {
        kind: "user_message",
        runId: previousRun,
        origin: "current_task",
        text: "inspect",
      }),
      ledgerRecord(2, {
        kind: "assistant_message",
        runId: previousRun,
        message: {
          role: "assistant",
          content: [{ type: "tool_call", callId: "call-1", name: "read", arguments: {} }],
          finishReason: "tool_calls",
        },
      }),
      ledgerRecord(3, { kind: "tool_started", runId: previousRun, callId: "call-1" }),
      ledgerRecord(4, {
        kind: "tool_outcome",
        runId: previousRun,
        outcome: {
          callId: "call-1",
          status: "succeeded",
          isError: false,
          modelContent: "done",
          effectState: "none",
          abortObserved: false,
          artifacts: [],
        },
      }),
    ];

    expect(completeModelTurns(records)).toEqual([
      expect.objectContaining({ complete: true, records: [records[0], records[1], records[3]] }),
    ]);
    const contribution = (
      await createTranscriptContextSource().collect(prepareInput(branch(records)))
    )[0];
    expect(contribution).toMatchObject({ completeModelTurn: true, required: false });
    expect(contribution?.content).toMatchObject({
      kind: "messages",
      messages: [{ role: "user" }, { role: "assistant" }, { role: "tool", callId: "call-1" }],
    });
  });

  it("未结算 ToolCall 保持 required 且不会被 budget selection 拆散", async () => {
    const previousRun = runId("unsettled-run");
    const records: LedgerRecord[] = [
      ledgerRecord(1, {
        kind: "user_message",
        runId: previousRun,
        origin: "current_task",
        text: "inspect",
      }),
      ledgerRecord(2, {
        kind: "assistant_message",
        runId: previousRun,
        message: {
          role: "assistant",
          content: [{ type: "tool_call", callId: "unsettled", name: "read", arguments: {} }],
          finishReason: "tool_calls",
        },
      }),
    ];
    const manager = createContextManager({
      sources: [
        createSystemToolContextSource([{ type: "text", text: "system" }]),
        createTranscriptContextSource(),
      ],
      compaction: noCompaction,
      modelContextWindow: 1_000,
      requestedOutputReserve: 128,
      safetyMargin: 64,
      retainedTailTokens: 64,
    });

    const prepared = await manager.prepare(prepareInput(branch(records)));
    expect(prepared.request.messages).toHaveLength(2);
    expect(prepared.manifest.contributions).toContainEqual(
      expect.objectContaining({
        contributionId: "transcript-turn:record-2",
        required: true,
        disposition: "selected",
        reason: "required",
      }),
    );
  });

  it("保留上一 Run 的尾部 user input，并由 current_task source 唯一投影当前任务", async () => {
    const failedRun = runId("failed-run");
    const currentRun = runId("run-current");
    const records: LedgerRecord[] = [
      ledgerRecord(1, {
        kind: "user_message",
        runId: failedRun,
        origin: "current_task",
        text: "修复上一轮失败的问题",
      }),
      ledgerRecord(2, {
        kind: "model_failure",
        runId: failedRun,
        failure: { category: "network", retryable: false, message: "offline" },
      }),
      ledgerRecord(3, {
        kind: "user_message",
        runId: currentRun,
        origin: "current_task",
        text: "继续",
      }),
    ];
    const manager = createContextManager({
      sources: [
        createSystemToolContextSource([{ type: "text", text: "system" }]),
        createTranscriptContextSource(),
        createCurrentTaskContextSource(),
      ],
      compaction: noCompaction,
      modelContextWindow: 1_000,
      requestedOutputReserve: 128,
      safetyMargin: 64,
      retainedTailTokens: 64,
    });

    const prepared = await manager.prepare(prepareInput(branch(records)));
    const userTexts = prepared.request.messages.flatMap((message) =>
      message.role === "user"
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    );

    expect(completeModelTurns(records)).toEqual([
      expect.objectContaining({ complete: false, records: [records[0]] }),
      expect.objectContaining({ complete: false, records: [records[2]] }),
    ]);
    expect(userTexts).toEqual(["修复上一轮失败的问题", "继续"]);
    expect(prepared.manifest.contributions).toContainEqual(
      expect.objectContaining({
        contributionId: "transcript-turn:record-1",
        required: true,
        disposition: "selected",
      }),
    );
  });

  it("按固定公式计算 budget，required 保留且 optional 以 manifest 解释 omission", async () => {
    const optional: ContextSource = {
      id: "optional",
      async collect() {
        return [
          {
            id: "optional-large",
            sourceId: "optional",
            priority: 1,
            required: false,
            orderingGroup: "artifact_previews",
            sequence: 0,
            estimatedTokens: 10_000,
            provenance: { kind: "artifact", id: "artifact-1" },
            sensitivity: "restricted",
            content: { kind: "instructions", parts: [{ type: "text", text: "optional" }] },
          },
        ];
      },
    };
    const manager = createContextManager({
      sources: [createSystemToolContextSource([{ type: "text", text: "system" }]), optional],
      compaction: noCompaction,
      modelContextWindow: 2_000,
      requestedOutputReserve: 400,
      safetyMargin: 200,
      retainedTailTokens: 100,
    });

    const prepared = await manager.prepare(prepareInput(branch([])));
    expect(prepared.manifest.budget).toEqual({
      modelContextWindow: 2_000,
      requestedOutputReserve: 400,
      protocolToolSchemaReserve: 33,
      safetyMargin: 200,
      usableInputBudget: 1_367,
    });
    expect(prepared.request.instructions.map((part) => part.text)).toEqual(["system"]);
    expect(prepared.manifest.contributions).toContainEqual(
      expect.objectContaining({
        contributionId: "optional-large",
        disposition: "omitted",
        reason: "budget_exhausted",
      }),
    );
    expect((await manager.prepare(prepareInput(branch([])))).manifest.requestDigest).toBe(
      prepared.manifest.requestDigest,
    );
  });

  it("最低 required projection 超预算时 fail closed，不以 omission 冒充压缩", async () => {
    const manager = createContextManager({
      sources: [createSystemToolContextSource([{ type: "text", text: "required".repeat(1_000) }])],
      compaction: noCompaction,
      modelContextWindow: 600,
      requestedOutputReserve: 128,
      safetyMargin: 64,
      retainedTailTokens: 64,
    });

    await expect(manager.prepare(prepareInput(branch([])))).rejects.toMatchObject({
      code: "CONTEXT_OVERFLOW",
      derivations: [],
    });
  });

  it("summary derivation 只覆盖完整旧 Turn，并产生可追溯 checkpoint 与 retained tail", async () => {
    const artifacts = new MemoryArtifactStore();
    const model = new ScriptedModel([
      {
        outcome: { status: "completed", response: scriptedTextResponse("目标与约束：继续任务。") },
      },
    ]);
    const records = [
      ...completedTextTurn(1, "a".repeat(480)),
      ...completedTextTurn(3, "b".repeat(480)),
    ];
    const manager = createContextManager({
      sources: [
        createSystemToolContextSource([{ type: "text", text: "system" }]),
        createTranscriptContextSource(),
      ],
      compaction: createSummaryCompactionStrategy({
        model,
        artifacts,
        ids: new SequentialIdFactory(),
        triggerRatio: 0.3,
        summaryOutputTokens: 128,
      }),
      modelContextWindow: 1_500,
      requestedOutputReserve: 256,
      safetyMargin: 128,
      retainedTailTokens: 260,
    });

    const prepared = await manager.prepare(prepareInput(branch(records)));
    expect(prepared.derivations).toEqual([
      expect.objectContaining({ status: "succeeded", checkpointId: "checkpoint-1" }),
    ]);
    expect(prepared.checkpoint).toMatchObject({
      checkpointId: "checkpoint-1",
      sourceStartRecordId: "record-1",
      sourceEndRecordId: "record-2",
      retainedRecordIds: ["record-3", "record-4"],
      branchLeafRecordId: "record-4",
    });
    expect(
      prepared.request.instructions.some((part) => part.text.includes("Lossy Compaction")),
    ).toBe(true);
    expect(prepared.request.messages).toHaveLength(2);
    expect(
      await artifacts.verify(prepared.checkpoint?.summaryArtifact ?? { id: "missing" }),
    ).toEqual({
      status: "verified",
    });

    const reopenedBranch = branch(records, prepared.checkpoint ? [prepared.checkpoint] : []);
    const reopenedManager = createContextManager({
      sources: [
        createSystemToolContextSource([{ type: "text", text: "system" }]),
        createCheckpointContextSource(artifacts),
        createTranscriptContextSource(),
      ],
      compaction: noCompaction,
      modelContextWindow: 1_500,
      requestedOutputReserve: 256,
      safetyMargin: 128,
      retainedTailTokens: 260,
    });
    const firstRestart = await reopenedManager.prepare(prepareInput(reopenedBranch));
    const secondRestart = await reopenedManager.prepare(prepareInput(reopenedBranch));
    expect(firstRestart.manifest.requestDigest).toBe(secondRestart.manifest.requestDigest);
    expect(firstRestart.manifest.selectedCheckpointIds).toEqual(["checkpoint-1"]);
    expect(firstRestart.request.messages).toHaveLength(2);

    artifacts.clear();
    const missing = await reopenedManager.prepare(prepareInput(reopenedBranch));
    expect(missing.manifest.contributions).toContainEqual(
      expect.objectContaining({
        contributionId: "checkpoint:checkpoint-1",
        disposition: "omitted",
        reason: "artifact_missing",
      }),
    );
    expect(missing.request.messages).toHaveLength(4);
  });

  it("summary model failure 返回 durable derivation evidence 且不产生 checkpoint", async () => {
    const artifacts = new MemoryArtifactStore();
    const model = new ScriptedModel([
      {
        outcome: {
          status: "failed",
          failure: {
            category: "provider_unavailable",
            retryable: true,
            message: "unavailable",
          },
        },
      },
    ]);
    const records = [
      ...completedTextTurn(1, "a".repeat(600)),
      ...completedTextTurn(3, "b".repeat(600)),
    ];
    const manager = createContextManager({
      sources: [
        createSystemToolContextSource([{ type: "text", text: "system" }]),
        createTranscriptContextSource(),
      ],
      compaction: createSummaryCompactionStrategy({
        model,
        artifacts,
        ids: new SequentialIdFactory(),
        triggerRatio: 0.3,
        summaryOutputTokens: 128,
      }),
      modelContextWindow: 1_800,
      requestedOutputReserve: 256,
      safetyMargin: 128,
      retainedTailTokens: 300,
    });

    await expect(manager.prepare(prepareInput(branch(records)))).rejects.toMatchObject({
      code: "CONTEXT_COMPACTION_FAILED",
      derivations: [
        expect.objectContaining({
          status: "failed",
          failureCode: "provider_unavailable",
        }),
      ],
    });
    expect(model.requests()).toHaveLength(1);
  });
});
