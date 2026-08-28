import type { ContextDerivationRecord, ContextManifest } from "../context/contracts.js";
import type { BranchId, Clock, IdFactory, RunId, SessionId } from "../contracts/primitives.js";
import { branchId, recordId, runId, sessionId } from "../contracts/primitives.js";
import type { RunReport } from "../runtime/contracts.js";
import type {
  BeginRunInput,
  BranchRef,
  CommitReceipt,
  CompactionCheckpointMetadata,
  CreateSessionInput,
  ForkBranchInput,
  LedgerRecord,
  NewLedgerRecord,
  QueueInput,
  QueueItem,
  QueueUpdate,
  RunLease,
  SessionBranchSummary,
  SessionBranchView,
  SessionHandle,
  SessionRef,
  SessionRepository,
  SessionSnapshot,
  SessionSummary,
  TerminalCommit,
  WorkspaceBinding,
} from "./contracts.js";
import { SessionError } from "./errors.js";

interface BranchState {
  readonly id: BranchId;
  readonly parentBranchId?: BranchId;
  readonly recordIds: string[];
}

interface SessionState {
  readonly id: SessionId;
  readonly workspace: WorkspaceBinding;
  readonly branches: Map<BranchId, BranchState>;
  readonly records: Map<string, LedgerRecord>;
  readonly terminalReports: Map<RunId, RunReport>;
  readonly contextManifests: Map<RunId, ContextManifest[]>;
  readonly contextDerivations: Map<RunId, ContextDerivationRecord[]>;
  readonly compactionCheckpoints: Map<string, CompactionCheckpointMetadata>;
  readonly modelTurnCounts: Map<RunId, number>;
  readonly toolCalls: Map<RunId, Map<string, "planned" | "started" | "succeeded" | "failed">>;
  readonly queue: StoredQueueItem[];
  revision: number;
  currentBranchId: BranchId;
  activeRunId: RunId | undefined;
  ledgerSeq: number;
}

interface StoredQueueItem extends QueueItem {
  readonly runId: RunId;
}

function publicQueueItem(item: StoredQueueItem): QueueItem {
  const { runId: _run, ...visible } = item;
  return clone(visible);
}

export interface InMemorySessionRepositoryOptions {
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly beforeAppend?: () => Promise<void>;
  readonly beforeFinish?: () => Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function terminalPersistenceFailure(report: RunReport): RunReport {
  const { finalAnswer: _discardedAnswer, ...reportWithoutAnswer } = report;
  return {
    ...reportWithoutAnswer,
    status: "failed",
    terminationReason: "persistence_failure",
    unfinishedWork: [
      ...report.unfinishedWork,
      "terminal transaction 状态不确定，Session adapter 已持久化恢复终态",
    ],
    error: {
      code: "TERMINAL_COMMIT_FAILURE",
      message: "terminal transaction failed",
    },
  };
}

export class InMemorySessionRepository implements SessionRepository {
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #beforeAppend: (() => Promise<void>) | undefined;
  readonly #beforeFinish: (() => Promise<void>) | undefined;
  readonly #sessions = new Map<SessionId, SessionState>();
  #disposed = false;

  constructor(options: InMemorySessionRepositoryOptions) {
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#beforeAppend = options.beforeAppend;
    this.#beforeFinish = options.beforeFinish;
  }

  async create(input: CreateSessionInput): Promise<SessionHandle> {
    this.#assertAvailable();
    if (
      input.workspace.root.trim().length === 0 ||
      input.workspace.fingerprint.trim().length === 0
    ) {
      throw new TypeError("workspace root 与 fingerprint 不能为空");
    }
    const id = sessionId(this.#ids.next("session"));
    const initialBranch = branchId(this.#ids.next("branch"));
    const state: SessionState = {
      id,
      workspace: clone(input.workspace),
      branches: new Map([[initialBranch, { id: initialBranch, recordIds: [] }]]),
      records: new Map(),
      terminalReports: new Map(),
      contextManifests: new Map(),
      contextDerivations: new Map(),
      compactionCheckpoints: new Map(),
      modelTurnCounts: new Map(),
      toolCalls: new Map(),
      queue: [],
      revision: 1,
      currentBranchId: initialBranch,
      activeRunId: undefined,
      ledgerSeq: 0,
    };
    this.#sessions.set(id, state);
    return this.#handle(state, false);
  }

  async open(
    ref: SessionRef,
    options?: import("./contracts.js").OpenSessionOptions,
  ): Promise<SessionHandle> {
    this.#assertAvailable();
    const state = this.#sessions.get(ref.sessionId);
    if (!state) throw new SessionError("SESSION_NOT_FOUND", "Session 不存在");
    return this.#handle(state, options?.mode === "read_only");
  }

  async list(): Promise<readonly SessionSummary[]> {
    this.#assertAvailable();
    return [...this.#sessions.values()].map((state) => this.#summary(state));
  }

  async delete(ref: SessionRef): Promise<void> {
    this.#assertAvailable();
    const state = this.#sessions.get(ref.sessionId);
    if (!state) throw new SessionError("SESSION_NOT_FOUND", "Session 不存在");
    if (state.activeRunId)
      throw new SessionError("SESSION_ACTIVE_RUN", "active Run 期间不能删除 Session");
    this.#sessions.delete(ref.sessionId);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposed = true;
    this.#sessions.clear();
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new SessionError("SESSION_DISPOSED", "SessionRepository 已释放");
  }

  #summary(state: SessionState): SessionSummary {
    return clone({
      ref: { sessionId: state.id },
      workspace: state.workspace,
      revision: state.revision,
      ...(state.activeRunId ? { activeRunId: state.activeRunId } : {}),
    });
  }

  #snapshot(state: SessionState): SessionSnapshot {
    const branches: SessionBranchSummary[] = [...state.branches.values()].map((branch) => ({
      branchId: branch.id,
      ...(branch.parentBranchId ? { parentBranchId: branch.parentBranchId } : {}),
      recordCount: branch.recordIds.length,
    }));
    return clone({
      ...this.#summary(state),
      currentBranchId: state.currentBranchId,
      branches,
    });
  }

  #handle(state: SessionState, readOnly: boolean): SessionHandle {
    let disposed = false;
    const assertHandle = (): void => {
      this.#assertAvailable();
      if (disposed) throw new SessionError("SESSION_DISPOSED", "SessionHandle 已释放");
    };
    const ref: SessionRef = { sessionId: state.id };
    const assertWritable = (): void => {
      if (readOnly) throw new SessionError("SESSION_READ_ONLY", "read-only SessionHandle 禁止写入");
    };
    return {
      ref,
      readOnly,
      inspect: async () => {
        assertHandle();
        return this.#snapshot(state);
      },
      readBranch: async (input): Promise<SessionBranchView> => {
        assertHandle();
        const branch = state.branches.get(input.branchId);
        if (!branch)
          throw new SessionError("SESSION_BRANCH_NOT_FOUND", "Conversation Branch 不存在");
        return clone({
          branch: { sessionId: state.id, branchId: branch.id },
          records: branch.recordIds.map((id) => state.records.get(id)).filter(Boolean),
          checkpoints: [...state.compactionCheckpoints.values()].filter(
            (checkpoint) =>
              branch.recordIds.includes(checkpoint.sourceStartRecordId) &&
              branch.recordIds.includes(checkpoint.sourceEndRecordId) &&
              branch.recordIds.includes(checkpoint.branchLeafRecordId),
          ),
        } as SessionBranchView);
      },
      readRunReport: async (id) => {
        assertHandle();
        const report = state.terminalReports.get(id);
        return report ? clone(report) : undefined;
      },
      listQueue: async (requestedRun) => {
        assertHandle();
        return state.queue
          .filter((item) => requestedRun === undefined || item.runId === requestedRun)
          .map(publicQueueItem);
      },
      readContextManifests: async (id) => {
        assertHandle();
        return clone(state.contextManifests.get(id) ?? []);
      },
      readContextDerivations: async (id) => {
        assertHandle();
        return clone(state.contextDerivations.get(id) ?? []);
      },
      selectBranch: async (selected, expectedRevision) => {
        assertHandle();
        assertWritable();
        this.#assertRevision(state, expectedRevision);
        if (!state.branches.has(selected)) {
          throw new SessionError("SESSION_BRANCH_NOT_FOUND", "Conversation Branch 不存在");
        }
        if (state.activeRunId) {
          throw new SessionError(
            "SESSION_ACTIVE_RUN",
            "active Run 期间不能切换 Conversation Branch",
          );
        }
        state.currentBranchId = selected;
        state.revision += 1;
        return this.#snapshot(state);
      },
      forkBranch: async (input) => {
        assertWritable();
        return this.#forkBranch(state, input, assertHandle);
      },
      enqueue: async (input) => {
        assertWritable();
        return this.#enqueue(state, input, assertHandle);
      },
      updateQueue: async (input) => {
        assertWritable();
        return this.#updateQueue(state, input, assertHandle);
      },
      beginRun: async (input) => {
        assertWritable();
        return this.#beginRun(state, input, assertHandle);
      },
      [Symbol.asyncDispose]: async () => {
        disposed = true;
      },
    };
  }

  #enqueue(state: SessionState, input: QueueInput, assertHandle: () => void): QueueItem {
    assertHandle();
    if (!state.activeRunId) {
      throw new SessionError("SESSION_LEASE_LOST", "没有 active Run 可接收 queue message");
    }
    if (input.commandId.trim().length === 0 || input.text.trim().length === 0) {
      throw new TypeError("queue commandId 与 text 不能为空");
    }
    const existing = state.queue.find((item) => item.commandId === input.commandId);
    if (existing) return publicQueueItem(existing);
    const ordinal =
      Math.max(
        0,
        ...state.queue
          .filter((candidate) => candidate.runId === state.activeRunId)
          .map((candidate) => candidate.ordinal),
      ) + 1;
    const item: StoredQueueItem = {
      ...input,
      runId: state.activeRunId,
      ordinal,
      status: "queued",
      revision: 1,
    };
    state.queue.push(item);
    return publicQueueItem(item);
  }

  #updateQueue(state: SessionState, input: QueueUpdate, assertHandle: () => void): QueueItem {
    assertHandle();
    const index = state.queue.findIndex((item) => item.commandId === input.commandId);
    const existing = state.queue[index];
    if (!existing) throw new SessionError("SESSION_LEASE_LOST", "queue item 不存在");
    if (existing.revision !== input.expectedRevision) {
      throw new SessionError("SESSION_REVISION_CONFLICT", "queue item revision CAS 冲突");
    }
    if (existing.status === "delivered" || existing.status === "cancelled") {
      throw new SessionError("SESSION_REVISION_CONFLICT", "queue item 已进入不可编辑状态");
    }
    if (input.status === "queued" && state.activeRunId !== existing.runId) {
      throw new SessionError("SESSION_LEASE_LOST", "只能为 active Run 保持 queued 状态");
    }
    const text = input.text ?? existing.text;
    if (text.trim().length === 0) throw new TypeError("queue text 不能为空");
    const updated: StoredQueueItem = {
      ...existing,
      text,
      status: input.status,
      revision: existing.revision + 1,
    };
    state.queue[index] = updated;
    return publicQueueItem(updated);
  }

  #assertRevision(state: SessionState, expected: number): void {
    if (state.revision !== expected) {
      throw new SessionError(
        "SESSION_REVISION_CONFLICT",
        `Session revision 已从 ${expected} 变为 ${state.revision}`,
      );
    }
  }

  async #forkBranch(
    state: SessionState,
    input: ForkBranchInput,
    assertHandle: () => void,
  ): Promise<BranchRef> {
    assertHandle();
    this.#assertRevision(state, input.expectedRevision);
    if (state.activeRunId) {
      throw new SessionError("SESSION_ACTIVE_RUN", "active Run 期间不能 fork Conversation Branch");
    }
    const source = state.branches.get(input.fromBranchId);
    if (!source) throw new SessionError("SESSION_BRANCH_NOT_FOUND", "Conversation Branch 不存在");
    const id = branchId(this.#ids.next("branch"));
    state.branches.set(id, {
      id,
      parentBranchId: source.id,
      recordIds: [...source.recordIds],
    });
    state.revision += 1;
    return { sessionId: state.id, branchId: id };
  }

  async #beginRun(
    state: SessionState,
    input: BeginRunInput,
    assertHandle: () => void,
  ): Promise<RunLease> {
    assertHandle();
    if (state.activeRunId) throw new SessionError("SESSION_ACTIVE_RUN", "Session 已有 active Run");
    this.#assertRevision(state, input.expectedRevision);
    const branch = state.branches.get(input.branchId);
    if (!branch) throw new SessionError("SESSION_BRANCH_NOT_FOUND", "Conversation Branch 不存在");
    if (input.branchId !== state.currentBranchId) {
      throw new SessionError(
        "SESSION_REVISION_CONFLICT",
        "Run 只能从当前 Conversation Branch 启动",
      );
    }
    if (input.initialMessages.length === 0) throw new TypeError("Run 至少需要一条 initial message");
    const id = runId(this.#ids.next("run"));
    state.queue.splice(0);
    state.activeRunId = id;
    state.toolCalls.set(id, new Map());
    state.contextManifests.set(id, []);
    state.contextDerivations.set(id, []);
    state.modelTurnCounts.set(id, 0);
    state.revision += 1;
    this.#appendRecord(state, branch, id, { kind: "run_started", metadata: input.metadata });
    for (const message of input.initialMessages) {
      this.#appendRecord(state, branch, id, {
        kind: "user_message",
        text: message.text,
        origin: "current_task",
      });
    }
    let leaseDisposed = false;
    const assertLease = (): void => {
      assertHandle();
      if (leaseDisposed || state.activeRunId !== id) {
        throw new SessionError("SESSION_LEASE_LOST", "RunLease 已释放或失效");
      }
    };
    return {
      runId: id,
      sessionId: state.id,
      branchId: branch.id,
      heartbeatIntervalMs: 10_000,
      heartbeat: async () => {
        assertLease();
      },
      markModelTurnStarted: async (modelTurnCount) => {
        assertLease();
        if (!Number.isInteger(modelTurnCount) || modelTurnCount <= 0) {
          throw new TypeError("modelTurnCount 必须是正整数");
        }
        const current = state.modelTurnCounts.get(id) ?? 0;
        if (modelTurnCount < current || modelTurnCount > current + 1) {
          throw new SessionError(
            "SESSION_TERMINAL_CONFLICT",
            "modelTurnCount durable transition 非连续",
          );
        }
        state.modelTurnCounts.set(id, modelTurnCount);
      },
      append: async (entries): Promise<CommitReceipt> => {
        assertLease();
        if (entries.length === 0) throw new TypeError("append entries 不能为空");
        await this.#beforeAppend?.();
        assertLease();
        const first = state.ledgerSeq + 1;
        for (const entry of entries) {
          this.#trackToolFacts(state, id, entry);
          this.#appendRecord(state, branch, id, entry);
        }
        return { firstLedgerSeq: first, lastLedgerSeq: state.ledgerSeq };
      },
      markToolCallStarted: async (callId) => {
        assertLease();
        const calls = state.toolCalls.get(id);
        if (calls?.get(callId) !== "planned") {
          throw new SessionError(
            "SESSION_TERMINAL_CONFLICT",
            "ToolCall start 没有唯一对应的 planned call",
          );
        }
        calls.set(callId, "started");
        this.#appendRecord(state, branch, id, { kind: "tool_started", callId });
      },
      drainSteering: async (): Promise<readonly QueueItem[]> => {
        assertLease();
        const items = state.queue.filter(
          (item) => item.kind === "steering" && item.status === "queued",
        );
        for (const item of items) {
          const index = state.queue.indexOf(item);
          const delivered = {
            ...item,
            status: "delivered" as const,
            revision: item.revision + 1,
          };
          state.queue[index] = delivered;
          this.#appendRecord(state, branch, id, {
            kind: "user_message",
            text: item.text,
            origin: "steering",
          });
        }
        return items.map((item) =>
          publicQueueItem({
            ...item,
            status: "delivered",
            revision: item.revision + 1,
          }),
        );
      },
      takeFollowUp: async (): Promise<QueueItem | undefined> => {
        assertLease();
        const item = state.queue.find(
          (candidate) => candidate.kind === "follow_up" && candidate.status === "queued",
        );
        if (!item) return undefined;
        const index = state.queue.indexOf(item);
        const delivered = {
          ...item,
          status: "delivered" as const,
          revision: item.revision + 1,
        };
        state.queue[index] = delivered;
        this.#appendRecord(state, branch, id, {
          kind: "user_message",
          text: item.text,
          origin: "follow_up",
        });
        return publicQueueItem(delivered);
      },
      commitContext: async (manifest, checkpoint, derivations = []) => {
        assertLease();
        if (manifest.runId !== id) throw new TypeError("Context Manifest runId 与 lease 不一致");
        if (manifest.selectedRecordIds.some((selected) => !branch.recordIds.includes(selected))) {
          throw new SessionError(
            "SESSION_CORRUPT",
            "Context Manifest 引用了当前 Conversation Branch 之外的 Transcript record",
          );
        }
        const manifests = state.contextManifests.get(id);
        if (!manifests) throw new SessionError("SESSION_LEASE_LOST", "Run context state 不存在");
        const existingManifest = manifests.find(
          (candidate) => candidate.modelAttemptCount === manifest.modelAttemptCount,
        );
        if (existingManifest && JSON.stringify(existingManifest) !== JSON.stringify(manifest)) {
          throw new SessionError("SESSION_TERMINAL_CONFLICT", "Context Manifest CAS 冲突");
        }
        const storedDerivations = state.contextDerivations.get(id);
        if (!storedDerivations) {
          throw new SessionError("SESSION_LEASE_LOST", "Run derivation state 不存在");
        }
        for (const derivation of derivations) {
          if (derivation.runId !== id) {
            throw new TypeError("Context Derivation runId 与 lease 不一致");
          }
          const existingDerivation = storedDerivations.find(
            (candidate) => candidate.derivationId === derivation.derivationId,
          );
          if (
            existingDerivation &&
            JSON.stringify(existingDerivation) !== JSON.stringify(derivation)
          ) {
            throw new SessionError("SESSION_TERMINAL_CONFLICT", "Context Derivation CAS 冲突");
          }
        }
        if (checkpoint) {
          if (checkpoint.runId !== id) {
            throw new TypeError("Compaction Checkpoint runId 与 lease 不一致");
          }
          if (checkpoint.branchId !== branch.id) {
            throw new TypeError("Compaction Checkpoint branchId 与 lease 不一致");
          }
          if (
            !branch.recordIds.includes(checkpoint.sourceStartRecordId) ||
            !branch.recordIds.includes(checkpoint.sourceEndRecordId) ||
            !branch.recordIds.includes(checkpoint.branchLeafRecordId)
          ) {
            throw new SessionError(
              "SESSION_CORRUPT",
              "Compaction Checkpoint source range 不属于当前 Conversation Branch",
            );
          }
          const existingCheckpoint = state.compactionCheckpoints.get(checkpoint.checkpointId);
          if (
            existingCheckpoint &&
            JSON.stringify(existingCheckpoint) !== JSON.stringify(checkpoint)
          ) {
            throw new SessionError("SESSION_TERMINAL_CONFLICT", "Compaction Checkpoint CAS 冲突");
          }
        }
        const availableCheckpointIds = new Set([
          ...[...state.compactionCheckpoints.values()]
            .filter(
              (candidate) =>
                branch.recordIds.includes(candidate.sourceStartRecordId) &&
                branch.recordIds.includes(candidate.sourceEndRecordId) &&
                branch.recordIds.includes(candidate.branchLeafRecordId),
            )
            .map((candidate) => candidate.checkpointId),
          ...(checkpoint ? [checkpoint.checkpointId] : []),
        ]);
        if (
          manifest.selectedCheckpointIds.some(
            (selectedCheckpointId) => !availableCheckpointIds.has(selectedCheckpointId),
          )
        ) {
          throw new SessionError(
            "SESSION_CORRUPT",
            "Context Manifest 引用了不存在的 Compaction Checkpoint",
          );
        }

        if (!existingManifest) manifests.push(clone(manifest));
        for (const derivation of derivations) {
          if (
            !storedDerivations.some(
              (candidate) => candidate.derivationId === derivation.derivationId,
            )
          ) {
            storedDerivations.push(clone(derivation));
          }
        }
        if (checkpoint) {
          state.compactionCheckpoints.set(checkpoint.checkpointId, clone(checkpoint));
        }
      },
      commitContextFailure: async (derivations) => {
        assertLease();
        if (derivations.some((derivation) => derivation.status === "succeeded")) {
          throw new TypeError("commitContextFailure 只能提交 failed 或 aborted derivation");
        }
        const stored = state.contextDerivations.get(id);
        if (!stored) throw new SessionError("SESSION_LEASE_LOST", "Run derivation state 不存在");
        for (const derivation of derivations) {
          if (derivation.runId !== id) {
            throw new TypeError("Context Derivation runId 与 lease 不一致");
          }
          const existing = stored.find(
            (candidate) => candidate.derivationId === derivation.derivationId,
          );
          if (existing && JSON.stringify(existing) !== JSON.stringify(derivation)) {
            throw new SessionError("SESSION_TERMINAL_CONFLICT", "Context Derivation CAS 冲突");
          }
        }
        for (const derivation of derivations) {
          if (!stored.some((candidate) => candidate.derivationId === derivation.derivationId)) {
            stored.push(clone(derivation));
          }
        }
      },
      finish: async (report): Promise<TerminalCommit> => {
        const existing = state.terminalReports.get(id);
        if (existing) {
          return { committed: false, report: clone(existing) };
        }
        assertLease();
        if (report.runId !== id) throw new TypeError("RunReport runId 与 lease 不一致");
        const calls = state.toolCalls.get(id) ?? new Map();
        const succeeded = [...calls.values()].filter((value) => value === "succeeded").length;
        const failed = [...calls.values()].filter((value) => value === "failed").length;
        const settled = succeeded + failed;
        const modelTurns = state.modelTurnCounts.get(id) ?? 0;
        const modelAttempts = state.contextManifests.get(id)?.length ?? 0;
        const contextDerivations = state.contextDerivations.get(id)?.length ?? 0;
        if (calls.size !== settled) {
          throw new SessionError(
            "SESSION_TERMINAL_CONFLICT",
            "Run 仍有未结算的 accepted ToolCall，不能 finish",
          );
        }
        if (
          report.counts.modelTurnCount !== modelTurns ||
          report.counts.modelAttemptCount !== modelAttempts ||
          report.counts.contextDerivationCount !== contextDerivations ||
          report.counts.toolCallCount !== calls.size ||
          report.counts.settledToolCallCount !== settled ||
          report.tools.accepted !== calls.size ||
          report.tools.settled !== settled ||
          report.tools.succeeded !== succeeded ||
          report.tools.failed !== failed
        ) {
          throw new SessionError(
            "SESSION_TERMINAL_CONFLICT",
            "RunReport counts 与 durable facts 不一致",
          );
        }
        let durableReport = report;
        try {
          await this.#beforeFinish?.();
        } catch (_error) {
          assertLease();
          durableReport = terminalPersistenceFailure(report);
        }
        assertLease();
        this.#appendRecord(state, branch, id, { kind: "run_boundary", report: durableReport });
        this.#appendRecord(state, branch, id, { kind: "run_terminal", report: durableReport });
        state.terminalReports.set(id, clone(durableReport));
        state.activeRunId = undefined;
        state.revision += 1;
        return { committed: true, report: clone(durableReport) };
      },
      [Symbol.asyncDispose]: async () => {
        leaseDisposed = true;
      },
    };
  }

  #appendRecord(
    state: SessionState,
    branch: BranchState,
    activeRun: RunId,
    record:
      | { readonly kind: "run_started"; readonly metadata: BeginRunInput["metadata"] }
      | {
          readonly kind: "user_message";
          readonly text: string;
          readonly origin: "current_task" | "steering" | "follow_up";
        }
      | NewLedgerRecord
      | { readonly kind: "tool_started"; readonly callId: string }
      | { readonly kind: "run_terminal" | "run_boundary"; readonly report: RunReport },
  ): void {
    state.ledgerSeq += 1;
    const id = recordId(this.#ids.next("record"));
    const full = {
      version: 1,
      recordId: id,
      ledgerSeq: state.ledgerSeq,
      runId: activeRun,
      branchId: branch.id,
      createdAt: this.#clock.now(),
      ...record,
    } as LedgerRecord;
    state.records.set(id, full);
    branch.recordIds.push(id);
  }

  #trackToolFacts(state: SessionState, activeRun: RunId, entry: NewLedgerRecord): void {
    const calls = state.toolCalls.get(activeRun);
    if (!calls) throw new SessionError("SESSION_LEASE_LOST", "Run tool state 不存在");
    if (entry.kind === "assistant_message") {
      for (const part of entry.message.content) {
        if (part.type !== "tool_call") continue;
        if (calls.has(part.callId)) {
          throw new SessionError("SESSION_TERMINAL_CONFLICT", "accepted ToolCall callId 重复");
        }
        calls.set(part.callId, "planned");
      }
      return;
    }
    if (entry.kind !== "tool_outcome") return;
    const stateBeforeOutcome = calls.get(entry.outcome.callId);
    if (stateBeforeOutcome !== "planned" && stateBeforeOutcome !== "started") {
      throw new SessionError(
        "SESSION_TERMINAL_CONFLICT",
        "ToolOutcome 没有唯一对应的 accepted ToolCall",
      );
    }
    calls.set(entry.outcome.callId, entry.outcome.status === "succeeded" ? "succeeded" : "failed");
  }
}
