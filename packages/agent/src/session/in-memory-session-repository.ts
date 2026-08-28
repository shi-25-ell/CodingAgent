import type { BranchId, Clock, IdFactory, RunId, SessionId } from "../contracts/primitives.js";
import { branchId, recordId, runId, sessionId } from "../contracts/primitives.js";
import type { RunReport } from "../runtime/contracts.js";
import type {
  BeginRunInput,
  BranchRef,
  CommitReceipt,
  CreateSessionInput,
  ForkBranchInput,
  LedgerRecord,
  NewLedgerRecord,
  QueueInput,
  QueueItem,
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
  readonly queue: QueueItem[];
  revision: number;
  currentBranchId: BranchId;
  activeRunId: RunId | undefined;
  ledgerSeq: number;
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
      queue: [],
      revision: 1,
      currentBranchId: initialBranch,
      activeRunId: undefined,
      ledgerSeq: 0,
    };
    this.#sessions.set(id, state);
    return this.#handle(state);
  }

  async open(ref: SessionRef): Promise<SessionHandle> {
    this.#assertAvailable();
    const state = this.#sessions.get(ref.sessionId);
    if (!state) throw new SessionError("SESSION_NOT_FOUND", "Session 不存在");
    return this.#handle(state);
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

  #handle(state: SessionState): SessionHandle {
    let disposed = false;
    const assertHandle = (): void => {
      this.#assertAvailable();
      if (disposed) throw new SessionError("SESSION_DISPOSED", "SessionHandle 已释放");
    };
    const ref: SessionRef = { sessionId: state.id };
    return {
      ref,
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
        } as SessionBranchView);
      },
      readRunReport: async (id) => {
        assertHandle();
        const report = state.terminalReports.get(id);
        return report ? clone(report) : undefined;
      },
      selectBranch: async (selected, expectedRevision) => {
        assertHandle();
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
      forkBranch: async (input) => this.#forkBranch(state, input, assertHandle),
      enqueue: async (input) => this.#enqueue(state, input, assertHandle),
      beginRun: async (input) => this.#beginRun(state, input, assertHandle),
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
    if (existing) return clone(existing);
    const item: QueueItem = {
      ...input,
      ordinal: state.queue.length + 1,
      status: "queued",
    };
    state.queue.push(item);
    return clone(item);
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
    const branch = state.branches.get(input.branchId);
    if (!branch) throw new SessionError("SESSION_BRANCH_NOT_FOUND", "Conversation Branch 不存在");
    if (input.initialMessages.length === 0) throw new TypeError("Run 至少需要一条 initial message");
    const id = runId(this.#ids.next("run"));
    state.queue.splice(0);
    state.activeRunId = id;
    state.revision += 1;
    this.#appendRecord(state, branch, id, { kind: "run_started", metadata: input.metadata });
    for (const message of input.initialMessages) {
      this.#appendRecord(state, branch, id, { kind: "user_message", text: message.text });
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
      append: async (entries): Promise<CommitReceipt> => {
        assertLease();
        if (entries.length === 0) throw new TypeError("append entries 不能为空");
        await this.#beforeAppend?.();
        assertLease();
        const first = state.ledgerSeq + 1;
        for (const entry of entries) this.#appendRecord(state, branch, id, entry);
        return { firstLedgerSeq: first, lastLedgerSeq: state.ledgerSeq };
      },
      drainSteering: async (): Promise<readonly QueueItem[]> => {
        assertLease();
        const items = state.queue.filter(
          (item) => item.kind === "steering" && item.status === "queued",
        );
        for (const item of items) {
          const index = state.queue.indexOf(item);
          const delivered = { ...item, status: "delivered" as const };
          state.queue[index] = delivered;
          this.#appendRecord(state, branch, id, { kind: "user_message", text: item.text });
        }
        return clone(items.map((item) => ({ ...item, status: "delivered" as const })));
      },
      takeFollowUp: async (): Promise<QueueItem | undefined> => {
        assertLease();
        const item = state.queue.find(
          (candidate) => candidate.kind === "follow_up" && candidate.status === "queued",
        );
        if (!item) return undefined;
        const index = state.queue.indexOf(item);
        const delivered = { ...item, status: "delivered" as const };
        state.queue[index] = delivered;
        this.#appendRecord(state, branch, id, { kind: "user_message", text: item.text });
        return clone(delivered);
      },
      finish: async (report): Promise<TerminalCommit> => {
        const existing = state.terminalReports.get(id);
        if (existing) {
          return { committed: false, report: clone(existing) };
        }
        assertLease();
        if (report.runId !== id) throw new TypeError("RunReport runId 与 lease 不一致");
        let durableReport = report;
        try {
          await this.#beforeFinish?.();
        } catch (_error) {
          assertLease();
          durableReport = terminalPersistenceFailure(report);
        }
        assertLease();
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
      | { readonly kind: "user_message"; readonly text: string }
      | NewLedgerRecord
      | { readonly kind: "run_terminal"; readonly report: RunReport },
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
}
