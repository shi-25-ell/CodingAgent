import type { AssistantMessage } from "../model/protocol.js";
import type {
  IdFactory,
  LedgerOperation,
  OperationRecord,
  RunLease,
  RunView,
  SessionLedger,
  SessionSummary,
  SessionView,
  TranscriptEntry,
  WorkspaceBaseline,
} from "./ledger.js";
import type { RunReport } from "./run-report.js";

interface LedgerClock {
  now(): number;
}

interface StoredRun {
  readonly id: string;
  readonly startedAt: number;
  status: "active" | "terminal";
  terminalLedgerSeq?: number;
  report?: RunReport;
}

interface StoredSession {
  readonly id: string;
  readonly workspace: WorkspaceBaseline;
  readonly defaultProviderProfile: string;
  readonly defaultModel: string;
  readonly currentBranchId: string;
  ledgerSeq: number;
  leafEntryId?: string;
  activeRunId?: string;
  readonly transcript: TranscriptEntry[];
  readonly operations: OperationRecord[];
  readonly runs: StoredRun[];
}

export class MemorySessionLedger implements SessionLedger {
  private readonly sessions = new Map<string, StoredSession>();

  public constructor(
    private readonly ids: IdFactory,
    private readonly clock: LedgerClock,
  ) {}

  public async createSession(input: {
    workspace: WorkspaceBaseline;
    defaultProviderProfile: string;
    defaultModel: string;
  }): Promise<SessionSummary> {
    const id = this.ids.next("session");
    const session: StoredSession = {
      id,
      workspace: clone(input.workspace),
      defaultProviderProfile: input.defaultProviderProfile,
      defaultModel: input.defaultModel,
      currentBranchId: this.ids.next("branch"),
      ledgerSeq: 0,
      transcript: [],
      operations: [],
      runs: [],
    };
    this.sessions.set(id, session);
    return summaryOf(session);
  }

  public async listSessions(): Promise<readonly SessionSummary[]> {
    return [...this.sessions.values()].map(summaryOf);
  }

  public async inspectSession(sessionId: string): Promise<SessionView> {
    const session = this.requireSession(sessionId);
    const view: SessionView = {
      id: session.id,
      workspace: clone(session.workspace),
      defaultProviderProfile: session.defaultProviderProfile,
      defaultModel: session.defaultModel,
      currentBranchId: session.currentBranchId,
      transcript: clone(session.transcript),
      operations: clone(session.operations),
      runs: session.runs.map(runViewOf),
      ...(session.activeRunId === undefined ? {} : { activeRunId: session.activeRunId }),
    };
    return view;
  }

  public async beginRun(sessionId: string, input: { initialTask: string }): Promise<RunLease> {
    const session = this.requireSession(sessionId);
    if (session.activeRunId !== undefined) {
      throw new Error(`Session ${sessionId} already has an active Run`);
    }
    if (input.initialTask.length === 0) {
      throw new Error("initial task must not be empty");
    }

    const run: StoredRun = {
      id: this.ids.next("run"),
      startedAt: this.clock.now(),
      status: "active",
    };
    session.runs.push(run);
    session.activeRunId = run.id;
    this.appendOperation(session, run.id, { type: "run_started" });
    this.appendMessage(session, run.id, { role: "user", content: input.initialTask });
    return new MemoryRunLease(this, session.id, run.id);
  }

  public commitAssistant(sessionId: string, runId: string, message: AssistantMessage): void {
    const session = this.requireActiveRun(sessionId, runId);
    this.appendMessage(session, runId, message);
  }

  public recordOperation(sessionId: string, runId: string, operation: LedgerOperation): void {
    const session = this.requireActiveRun(sessionId, runId);
    if (
      operation.type === "terminal" &&
      session.operations.some(
        (record) => record.runId === runId && record.operation.type === "terminal",
      )
    ) {
      throw new Error(`Run ${runId} already has a terminal operation`);
    }
    this.appendOperation(session, runId, operation);
  }

  public finish(sessionId: string, runId: string, report: RunReport): void {
    const session = this.requireSession(sessionId);
    const run = session.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      throw new Error(`unknown Run: ${runId}`);
    }
    if (run.status === "terminal") {
      throw new Error(`Run ${runId} is already terminal`);
    }
    if (session.activeRunId !== runId) {
      throw new Error(`Run ${runId} does not own the active Run lease`);
    }
    if (report.sessionId !== sessionId || report.runId !== runId) {
      throw new Error("RunReport identity does not match its lease");
    }
    const terminal = session.operations.findLast(
      (record) => record.runId === runId && record.operation.type === "terminal",
    );
    if (terminal?.operation.type !== "terminal") {
      throw new Error(`Run ${runId} cannot finish without one terminal operation`);
    }
    if (
      terminal.operation.status !== report.status ||
      terminal.operation.reason !== report.terminationReason
    ) {
      throw new Error("RunReport terminal state does not match the durable terminal operation");
    }

    run.status = "terminal";
    run.terminalLedgerSeq = terminal.ledgerSeq;
    run.report = clone(report);
    delete session.activeRunId;
  }

  private appendMessage(
    session: StoredSession,
    runId: string,
    message: TranscriptEntry["message"],
  ): void {
    session.ledgerSeq += 1;
    const entry: TranscriptEntry = {
      entryId: this.ids.next("entry"),
      ledgerSeq: session.ledgerSeq,
      branchId: session.currentBranchId,
      runId,
      message: clone(message),
      ...(session.leafEntryId === undefined ? {} : { parentId: session.leafEntryId }),
    };
    session.transcript.push(entry);
    session.leafEntryId = entry.entryId;
  }

  private appendOperation(session: StoredSession, runId: string, operation: LedgerOperation): void {
    session.ledgerSeq += 1;
    session.operations.push({ ledgerSeq: session.ledgerSeq, runId, operation: clone(operation) });
  }

  private requireSession(sessionId: string): StoredSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`unknown Session: ${sessionId}`);
    }
    return session;
  }

  private requireActiveRun(sessionId: string, runId: string): StoredSession {
    const session = this.requireSession(sessionId);
    if (session.activeRunId !== runId) {
      throw new Error(`Run ${runId} does not own the active Run lease`);
    }
    return session;
  }
}

class MemoryRunLease implements RunLease {
  public constructor(
    private readonly ledger: MemorySessionLedger,
    private readonly sessionId: string,
    public readonly runId: string,
  ) {}

  public async commitAssistant(message: AssistantMessage): Promise<void> {
    this.ledger.commitAssistant(this.sessionId, this.runId, message);
  }

  public async recordOperation(operation: LedgerOperation): Promise<void> {
    this.ledger.recordOperation(this.sessionId, this.runId, operation);
  }

  public async finish(report: RunReport): Promise<void> {
    this.ledger.finish(this.sessionId, this.runId, report);
  }
}

function summaryOf(session: StoredSession): SessionSummary {
  return {
    id: session.id,
    workspacePath: session.workspace.rootPath,
    ...(session.activeRunId === undefined ? {} : { activeRunId: session.activeRunId }),
  };
}

function runViewOf(run: StoredRun): RunView {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.terminalLedgerSeq === undefined ? {} : { terminalLedgerSeq: run.terminalLedgerSeq }),
    ...(run.report === undefined ? {} : { report: clone(run.report) }),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
