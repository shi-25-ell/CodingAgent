import type { ModelAdapter } from "../model/protocol.js";
import { BoundedModelRetryPolicy, FixedTurnLimitStopPolicy } from "../runtime/policies.js";
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeHost,
  RuntimeInput,
  RuntimeOutcome,
  RuntimeSemanticEvent,
} from "../runtime/runtime.js";
import type { ToolPort } from "../runtime/tool-port.js";
import type {
  LedgerOperation,
  RunLease,
  SessionLedger,
  SessionSummary,
  SessionView,
  WorkspaceBaseline,
} from "../session/ledger.js";
import type { RunReport } from "../session/run-report.js";
import type {
  ActiveRun,
  CommandAck,
  FastController,
  FastEvent,
  FastSession,
  OpenSessionInput,
  RunCommand,
  SessionFilter,
  StartRunInput,
} from "./contracts.js";
import type { ModelAdapterFactory, ToolPortFactory, WorkspaceInspector } from "./ports.js";

interface ApplicationClock {
  now(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export type RunStartFaultCode =
  | "session_not_found"
  | "workspace_not_clean"
  | "workspace_mismatch"
  | "invalid_configuration"
  | "model_not_available"
  | "tool_host_not_available";

export class RunStartFault extends Error {
  public constructor(
    public readonly code: RunStartFaultCode,
    message: string,
  ) {
    super(message);
    this.name = "RunStartFault";
  }
}

export class FastApplication implements FastController {
  private readonly activeRuns = new Map<string, ActiveRunImplementation>();

  public constructor(
    private readonly ledger: SessionLedger,
    private readonly runtime: AgentRuntimePort,
    private readonly models: ModelAdapterFactory,
    private readonly tools: ToolPortFactory,
    private readonly workspaces: WorkspaceInspector,
    private readonly clock: ApplicationClock,
    private readonly instructions: string,
  ) {}

  public async listSessions(filter?: SessionFilter): Promise<readonly SessionSummary[]> {
    const sessions = await this.ledger.listSessions();
    return filter?.workspacePath === undefined
      ? sessions
      : sessions.filter((session) => session.workspacePath === filter.workspacePath);
  }

  public async openSession(input: OpenSessionInput): Promise<FastSession> {
    if (input.kind === "create") {
      const workspace = await this.workspaces.inspect(input.workspacePath);
      if (!workspace.isClean) {
        throw new RunStartFault(
          "workspace_not_clean",
          "a new Session requires a clean Git workspace",
        );
      }
      const summary = await this.ledger.createSession({
        workspace: withoutClean(workspace),
        defaultProviderProfile: input.defaultProviderProfile,
        defaultModel: input.defaultModel,
      });
      return new FastSessionImplementation(this, summary.id);
    }

    try {
      await this.ledger.inspectSession(input.sessionId);
    } catch {
      throw new RunStartFault("session_not_found", `unknown Session: ${input.sessionId}`);
    }
    return new FastSessionImplementation(this, input.sessionId);
  }

  public inspectSession(sessionId: string): Promise<SessionView> {
    return this.ledger.inspectSession(sessionId);
  }

  public async startRun(sessionId: string, input: StartRunInput): Promise<ActiveRun> {
    validateStartInput(input);
    const session = await this.ledger.inspectSession(sessionId);
    const workspace = await this.workspaces.inspect(session.workspace.rootPath);
    if (
      workspace.rootPath !== session.workspace.rootPath ||
      workspace.fingerprint !== session.workspace.fingerprint
    ) {
      throw new RunStartFault(
        "workspace_mismatch",
        "workspace fingerprint differs from the Session baseline",
      );
    }

    const providerProfile = input.providerProfile ?? session.defaultProviderProfile;
    const modelName = input.model ?? session.defaultModel;
    const maximumModelTurns = input.maximumModelTurns ?? 20;
    const maximumModelAttempts = input.maximumModelAttempts ?? 1;
    let model: ModelAdapter;
    try {
      model = await this.models.create({ providerProfile, model: modelName });
    } catch (error) {
      throw new RunStartFault(
        "model_not_available",
        error instanceof Error ? error.message : "model adapter is unavailable",
      );
    }

    const controller = new AbortController();
    let toolPort: ToolPort;
    try {
      toolPort = this.tools.create({
        workspace: session.workspace,
        permissionMode: input.permissionMode,
        signal: controller.signal,
      });
    } catch (error) {
      throw new RunStartFault(
        "tool_host_not_available",
        error instanceof Error ? error.message : "tool host is unavailable",
      );
    }
    const runtimeMessages = [
      ...session.transcript.map((entry) => entry.message),
      { role: "user" as const, content: input.task },
    ];
    const lease = await this.ledger.beginRun(sessionId, { initialTask: input.task });
    const eventStream = new FastEventStream(sessionId, lease.runId);
    const startTime = this.clock.now();
    const runtimeInput: RuntimeInput = {
      instructions: this.instructions,
      messages: runtimeMessages,
      model,
      tools: toolPort,
      stopPolicy: new FixedTurnLimitStopPolicy(maximumModelTurns),
      retryPolicy: new BoundedModelRetryPolicy(maximumModelAttempts, () => 0),
      clock: this.clock,
      signal: controller.signal,
    };
    const active = new ActiveRunImplementation(lease.runId, eventStream, controller);
    this.activeRuns.set(lease.runId, active);
    active.finished = this.finishEstablishedRun({
      sessionId,
      lease,
      active,
      eventStream,
      runtimeInput,
      initialWorkspace: session.workspace,
      providerProfile,
      modelName,
      permissionMode: input.permissionMode,
      maximumModelTurns,
      maximumModelAttempts,
      startTime,
    });
    return active;
  }

  public assertIdle(): void {
    if (this.activeRuns.size !== 0) {
      throw new Error(`FastApplication has ${this.activeRuns.size} active execution handle(s)`);
    }
  }

  private async finishEstablishedRun(context: {
    sessionId: string;
    lease: RunLease;
    active: ActiveRunImplementation;
    eventStream: FastEventStream;
    runtimeInput: RuntimeInput;
    initialWorkspace: WorkspaceBaseline;
    providerProfile: string;
    modelName: string;
    permissionMode: "safe" | "autonomous";
    maximumModelTurns: number;
    maximumModelAttempts: number;
    startTime: number;
  }): Promise<RunReport> {
    let report = buildFailureReport(
      context,
      "runtime_invariant",
      new Error("Run terminated before Runtime initialization completed"),
    );
    let outcome: RuntimeOutcome | undefined;
    try {
      await launchOnNextEventLoopTurn();
      const host = new LedgerRuntimeHost(context.lease);
      const execution = this.runtime.run(context.runtimeInput, host);
      const pump = pumpRuntimeEvents(execution.events, context.eventStream);
      outcome = await execution.completion;
      await pump;
      let endingWorkspace: WorkspaceBaseline | undefined;
      let endingWorkspaceError: string | undefined;
      try {
        endingWorkspace = withoutClean(
          await this.workspaces.inspect(context.initialWorkspace.rootPath),
        );
      } catch (error) {
        endingWorkspaceError =
          error instanceof Error ? error.message : "ending workspace observation failed";
      }
      report = buildRunReport({
        sessionId: context.sessionId,
        runId: context.lease.runId,
        outcome,
        initialWorkspace: context.initialWorkspace,
        ...(endingWorkspace === undefined ? {} : { endingWorkspace }),
        ...(endingWorkspaceError === undefined ? {} : { endingWorkspaceError }),
        providerProfile: context.providerProfile,
        modelName: context.modelName,
        permissionMode: context.permissionMode,
        maximumModelTurns: context.maximumModelTurns,
        maximumModelAttempts: context.maximumModelAttempts,
        durationMs: this.clock.now() - context.startTime,
      });
      try {
        await context.lease.finish(report);
      } catch (error) {
        try {
          await context.lease.finish(report);
        } catch {
          const persisted = await this.readPersistedReport(context.sessionId, context.lease.runId);
          if (persisted !== undefined) {
            report = persisted;
          } else {
            report = buildFailureReport(
              context,
              "persistence_error",
              error,
              outcome,
              this.clock.now() - context.startTime,
            );
            await bestEffortPersistFailure(context.lease, report);
          }
        }
      }
    } catch (error) {
      report = buildFailureReport(
        context,
        "runtime_invariant",
        error,
        outcome,
        this.clock.now() - context.startTime,
      );
      await bestEffortPersistFailure(context.lease, report);
    } finally {
      context.active.markTerminal();
      try {
        context.eventStream.push({ type: "run_finished", report });
      } finally {
        context.eventStream.close();
        this.activeRuns.delete(context.lease.runId);
      }
    }
    return report;
  }

  private async readPersistedReport(
    sessionId: string,
    runId: string,
  ): Promise<RunReport | undefined> {
    try {
      const session = await this.ledger.inspectSession(sessionId);
      return session.runs.find((run) => run.id === runId)?.report;
    } catch {
      return undefined;
    }
  }
}

class FastSessionImplementation implements FastSession {
  public constructor(
    private readonly application: FastApplication,
    private readonly sessionId: string,
  ) {}

  public inspect(): Promise<SessionView> {
    return this.application.inspectSession(this.sessionId);
  }

  public startRun(input: StartRunInput): Promise<ActiveRun> {
    return this.application.startRun(this.sessionId, input);
  }
}

class ActiveRunImplementation implements ActiveRun {
  public finished!: Promise<RunReport>;
  private terminal = false;

  public constructor(
    public readonly id: string,
    public readonly events: AsyncIterable<FastEvent>,
    private readonly controller: AbortController,
  ) {}

  public async dispatch(command: RunCommand): Promise<CommandAck> {
    if (this.terminal) {
      return { commandId: command.commandId, accepted: false, kind: "already_terminal" };
    }
    this.controller.abort();
    return { commandId: command.commandId, accepted: true, kind: "abort_requested" };
  }

  public markTerminal(): void {
    this.terminal = true;
  }
}

class LedgerRuntimeHost implements RuntimeHost {
  public constructor(private readonly lease: RunLease) {}

  public async record(event: RuntimeSemanticEvent): Promise<void> {
    if (event.type === "assistant_committed") {
      await this.lease.commitAssistant(event.message);
      return;
    }
    await this.lease.recordOperation(toLedgerOperation(event));
  }

  public async drainSteering() {
    return [];
  }

  public async takeFollowUp() {
    return undefined;
  }
}

function toLedgerOperation(
  event: Exclude<RuntimeSemanticEvent, { type: "assistant_committed" }>,
): LedgerOperation {
  switch (event.type) {
    case "phase_changed":
      return { type: "phase_changed", phase: event.phase };
    case "model_attempt_started":
      return { type: "model_attempt_started", attempt: event.attempt };
    case "model_attempt_failed":
      return {
        type: "model_attempt_failed",
        attempt: event.attempt,
        category: event.failure.category,
        retryable: event.failure.retryable,
        message: event.failure.message,
        ...(event.failure.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: event.failure.retryAfterMs }),
        ...(event.failure.httpStatus === undefined ? {} : { httpStatus: event.failure.httpStatus }),
        ...((event.requestId ?? event.failure.requestId) === undefined
          ? {}
          : { requestId: event.requestId ?? event.failure.requestId }),
      };
    case "model_retry_scheduled":
      return { type: "model_retry_scheduled", delayMs: event.delayMs };
    case "terminal":
      return {
        type: "terminal",
        status: event.status,
        reason: event.reason,
        lastPhase: event.lastPhase,
      };
    default:
      event satisfies never;
      throw new Error("unreachable Runtime semantic event");
  }
}

async function pumpRuntimeEvents(
  events: AsyncIterable<RuntimeEvent>,
  destination: FastEventStream,
): Promise<void> {
  for await (const event of events) {
    if (event.type !== "terminal") {
      destination.push(event);
    }
  }
}

function buildRunReport(input: {
  sessionId: string;
  runId: string;
  outcome: RuntimeOutcome;
  initialWorkspace: WorkspaceBaseline;
  endingWorkspace?: WorkspaceBaseline;
  endingWorkspaceError?: string;
  providerProfile: string;
  modelName: string;
  permissionMode: "safe" | "autonomous";
  maximumModelTurns: number;
  maximumModelAttempts: number;
  durationMs: number;
}): RunReport {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    runId: input.runId,
    status: input.outcome.status,
    terminationReason: input.outcome.reason,
    configuration: {
      providerProfile: input.providerProfile,
      model: input.modelName,
      permissionMode: input.permissionMode,
      maximumModelTurns: input.maximumModelTurns,
      maximumModelAttempts: input.maximumModelAttempts,
    },
    counts: { ...input.outcome.counts, contextDerivations: 0 },
    retrySummary: { retries: input.outcome.retries },
    toolSummary: { total: 0, succeeded: 0, errors: 0 },
    permissionSummary: { requested: 0, allowed: 0, denied: 0 },
    usage: input.outcome.usage,
    durationMs: input.durationMs,
    workspace: {
      startingHead: input.initialWorkspace.headSha,
      startingFingerprint: input.initialWorkspace.fingerprint,
      ending:
        input.endingWorkspace === undefined
          ? {
              state: "unavailable",
              errorSummary: input.endingWorkspaceError ?? "ending workspace was not observed",
            }
          : {
              state: "observed",
              head: input.endingWorkspace.headSha,
              fingerprint: input.endingWorkspace.fingerprint,
              changedFiles: input.endingWorkspace.changedFiles,
            },
    },
    commands: [],
    undelivered: { steering: 0, followUps: 0 },
    unfinishedWork: input.outcome.unfinishedWork,
    lastPhase: input.outcome.lastPhase,
    ...(input.outcome.finalAnswer === undefined ? {} : { finalAnswer: input.outcome.finalAnswer }),
    ...(input.outcome.errorSummary === undefined
      ? {}
      : { errorSummary: input.outcome.errorSummary }),
  };
}

function buildFailureReport(
  context: {
    sessionId: string;
    lease: RunLease;
    initialWorkspace: WorkspaceBaseline;
    providerProfile: string;
    modelName: string;
    permissionMode: "safe" | "autonomous";
    maximumModelTurns: number;
    maximumModelAttempts: number;
    startTime: number;
  },
  reason: "persistence_error" | "runtime_invariant",
  error: unknown,
  prior?: RuntimeOutcome,
  durationMs = 0,
): RunReport {
  const outcome: RuntimeOutcome = {
    status: "failed",
    reason,
    counts: prior?.counts ?? {
      modelTurns: 0,
      modelAttempts: 0,
      toolCalls: 0,
      completedToolCalls: 0,
    },
    retries: prior?.retries ?? 0,
    usage: prior?.usage ?? {},
    unfinishedWork: ["Run stopped before all work could be completed"],
    errorSummary: error instanceof Error ? error.message : "internal application failure",
    lastPhase: prior?.lastPhase ?? "starting",
    ...(prior?.finalAnswer === undefined ? {} : { finalAnswer: prior.finalAnswer }),
  };
  return buildRunReport({
    sessionId: context.sessionId,
    runId: context.lease.runId,
    outcome,
    initialWorkspace: context.initialWorkspace,
    endingWorkspaceError: "Run failed before ending workspace evidence was collected",
    providerProfile: context.providerProfile,
    modelName: context.modelName,
    permissionMode: context.permissionMode,
    maximumModelTurns: context.maximumModelTurns,
    maximumModelAttempts: context.maximumModelAttempts,
    durationMs,
  });
}

async function bestEffortPersistFailure(lease: RunLease, report: RunReport): Promise<void> {
  try {
    await lease.recordOperation({
      type: "terminal",
      status: report.status,
      reason: report.terminationReason,
      lastPhase: report.lastPhase,
    });
  } catch {
    // The original terminal may already be durable, or persistence may remain unavailable.
  }
  try {
    await lease.finish(report);
  } catch {
    // ActiveRun still resolves; durable recovery handles a persistently unavailable Ledger.
  }
}

function validateStartInput(input: StartRunInput): void {
  if (input.task.length === 0) {
    throw new RunStartFault("invalid_configuration", "initial task must not be empty");
  }
  for (const [name, value] of [
    ["maximumModelTurns", input.maximumModelTurns ?? 20],
    ["maximumModelAttempts", input.maximumModelAttempts ?? 1],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RunStartFault("invalid_configuration", `${name} must be a positive integer`);
    }
  }
}

function withoutClean(
  workspace: WorkspaceBaseline & { readonly isClean: boolean },
): WorkspaceBaseline {
  return {
    rootPath: workspace.rootPath,
    headSha: workspace.headSha,
    fingerprint: workspace.fingerprint,
    changedFiles: workspace.changedFiles,
  };
}

function launchOnNextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FastEventStream implements AsyncIterable<FastEvent> {
  private readonly values: FastEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<FastEvent>) => void> = [];
  private closed = false;
  private consumed = false;
  private sequence = 0;

  public constructor(
    private readonly sessionId: string,
    private readonly runId: string,
  ) {}

  public push(
    event: RuntimeEvent | { readonly type: "run_finished"; readonly report: RunReport },
  ): void {
    if (this.closed) {
      throw new Error("cannot publish to a closed Fast event stream");
    }
    this.sequence += 1;
    const enriched = {
      ...event,
      sessionId: this.sessionId,
      runId: this.runId,
      sequence: this.sequence,
    } as FastEvent;
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(enriched);
    } else {
      waiter({ done: false, value: enriched });
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterator<FastEvent> {
    if (this.consumed) throw new Error("Fast events support exactly one consumer");
    this.consumed = true;
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<FastEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
