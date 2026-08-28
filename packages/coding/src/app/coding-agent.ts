import type {
  AgentHarness,
  BranchId,
  ContextManager,
  HarnessCommand,
  HarnessEvent,
  HarnessRunHandle,
  RunId,
  RunPolicies,
  RunReport,
  SessionHandle,
  SessionRef,
  SessionRepository,
  ToolExecutor,
  WorkspaceBinding,
} from "@coding-agent/agent";
import type { Model, ModelDescriptor } from "@coding-agent/model";
import type { ApprovalBridge } from "../permissions/approval-bridge.js";
import type { ApprovalRequest } from "../tools/coding-tool-host.js";
import {
  sameWorkspaceRoot,
  type WorkspaceService,
  type WorkspaceSnapshot,
} from "../workspace/workspace-service.js";

export interface CreateCodingSessionInput {
  readonly workspace: WorkspaceBinding;
}

export interface StartCodingRunInput {
  readonly task: string;
  /** Exact current fingerprint acknowledgement required after an explicit workspace/branch change. */
  readonly acceptWorkspaceFingerprint?: string;
}

export interface ForkConversationInput {
  readonly fromBranchId: BranchId;
  readonly expectedRevision: number;
}

export interface SelectBranchInput {
  readonly branchId: BranchId;
  readonly expectedRevision: number;
}

export interface CodingSessionSummary {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceBinding;
  readonly revision: number;
  readonly activeRunId?: RunId;
}

export type CodingTimelineEntry =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "assistant"; readonly text: string }
  | {
      readonly type: "terminal";
      readonly status: RunReport["status"];
      readonly terminationReason: RunReport["terminationReason"];
    };

export interface CodingSessionView extends CodingSessionSummary {
  readonly currentBranchId: BranchId;
  readonly branches: Awaited<ReturnType<SessionHandle["inspect"]>>["branches"];
  readonly timeline: readonly CodingTimelineEntry[];
}

export type CodingEvent =
  | HarnessEvent
  | {
      readonly version: 1;
      readonly type: "permission_requested";
      readonly request: ApprovalRequest;
    };
export type CodingRunCommand =
  | HarnessCommand
  | {
      readonly commandId: string;
      readonly type: "respond_permission";
      readonly approvalId: string;
      readonly decision: "allow_once" | "deny";
      readonly planFingerprint: string;
    };

export interface CodingCommandAck {
  readonly commandId: string;
  readonly status: "accepted" | "already_applied" | "not_active" | "unknown" | "stale";
}

export interface CodingRunHandle {
  readonly runId: RunId;
  events(): AsyncIterable<CodingEvent>;
  dispatch(command: CodingRunCommand): Promise<CodingCommandAck>;
  readonly finished: Promise<RunReport>;
}

export interface CodingSession {
  readonly ref: SessionRef;
  inspect(): Promise<CodingSessionView>;
  readRunReport(runId: RunId): Promise<RunReport | undefined>;
  fork(input: ForkConversationInput): Promise<import("@coding-agent/agent").BranchRef>;
  selectBranch(input: SelectBranchInput): Promise<CodingSessionView>;
  startRun(input: StartCodingRunInput): Promise<CodingRunHandle>;
}

export interface ModeDescriptor {
  readonly id: "print";
  readonly displayName: string;
}

export interface CodingDiagnostics {
  readonly sessionRepository: "available";
  readonly model: ModelDescriptor;
  readonly modes: readonly ModeDescriptor[];
}

export interface CodingAgent {
  listSessions(): Promise<readonly CodingSessionSummary[]>;
  createSession(input: CreateCodingSessionInput): Promise<CodingSession>;
  openSession(ref: SessionRef): Promise<CodingSession>;
  listModels(): Promise<readonly ModelDescriptor[]>;
  listModes(): readonly ModeDescriptor[];
  diagnostics(): Promise<CodingDiagnostics>;
}

export interface CodingAgentOptions {
  readonly sessions: SessionRepository;
  readonly harness: AgentHarness;
  readonly model: Model;
  readonly tools: ToolExecutor;
  readonly context: ContextManager;
  readonly policies: RunPolicies;
  readonly configurationRevision: string;
  readonly approvals?: ApprovalBridge;
  readonly workspace: WorkspaceService;
}

export type CodingStartErrorCode =
  | "CODING_WORKSPACE_UNAVAILABLE"
  | "CODING_WORKSPACE_DIRTY"
  | "CODING_WORKSPACE_MISMATCH"
  | "CODING_CONTEXT_CONFIGURATION_MISMATCH"
  | "CODING_SESSION_ACTIVE";

export class CodingStartError extends Error {
  readonly code: CodingStartErrorCode;
  readonly currentWorkspace: WorkspaceBinding | undefined;

  constructor(
    code: CodingStartErrorCode,
    message: string,
    options?: ErrorOptions & { readonly currentWorkspace?: WorkspaceBinding },
  ) {
    super(message, options);
    this.name = "CodingStartError";
    this.code = code;
    this.currentWorkspace = options?.currentWorkspace;
  }
}

class CodingEventStream {
  readonly #events: CodingEvent[] = [];
  readonly #waiters = new Set<() => void>();
  #closed = false;

  publish(event: CodingEvent): void {
    if (this.#closed) return;
    this.#events.push(event);
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  close(): void {
    this.#closed = true;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  async *read(): AsyncIterable<CodingEvent> {
    let index = 0;
    while (true) {
      while (index < this.#events.length) {
        const event = this.#events[index];
        index += 1;
        if (event) yield event;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }
}

function assistantText(content: import("@coding-agent/model").AssistantMessage["content"]): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function timeline(
  records: Awaited<ReturnType<SessionHandle["readBranch"]>>["records"],
): readonly CodingTimelineEntry[] {
  return records.flatMap((record): readonly CodingTimelineEntry[] => {
    if (record.kind === "user_message") return [{ type: "user", text: record.text }];
    if (record.kind === "assistant_message") {
      return [{ type: "assistant", text: assistantText(record.message.content) }];
    }
    if (record.kind === "run_terminal") {
      return [
        {
          type: "terminal",
          status: record.report.status,
          terminationReason: record.report.terminationReason,
        },
      ];
    }
    return [];
  });
}

export function createCodingAgent(options: CodingAgentOptions): CodingAgent {
  const modes: readonly ModeDescriptor[] = [{ id: "print", displayName: "Print" }];

  const inspectWorkspace = async (root: string): Promise<WorkspaceSnapshot> => {
    try {
      return await options.workspace.inspect(root);
    } catch (error) {
      throw new CodingStartError("CODING_WORKSPACE_UNAVAILABLE", "workspace preflight 失败", {
        cause: error,
      });
    }
  };

  const projectView = async (session: SessionHandle): Promise<CodingSessionView> => {
    const snapshot = await session.inspect();
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });
    return {
      ref: snapshot.ref,
      workspace: snapshot.workspace,
      revision: snapshot.revision,
      ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
      currentBranchId: snapshot.currentBranchId,
      branches: snapshot.branches,
      timeline: timeline(branch.records),
    };
  };

  const assertBoundWorkspace = async (
    binding: WorkspaceBinding,
    acceptedFingerprint?: string,
  ): Promise<void> => {
    const current = await inspectWorkspace(binding.root);
    if (!sameWorkspaceRoot(binding.root, current.binding.root)) {
      throw new CodingStartError(
        "CODING_WORKSPACE_MISMATCH",
        "Session 绑定的 workspace root 与当前 repository root 不一致",
        { currentWorkspace: current.binding },
      );
    }
    if (binding.fingerprint === current.binding.fingerprint) return;
    if (acceptedFingerprint === current.binding.fingerprint) return;
    throw new CodingStartError(
      "CODING_WORKSPACE_MISMATCH",
      "workspace fingerprint 已变化；显式确认当前 fingerprint 后才能继续",
      { currentWorkspace: current.binding },
    );
  };

  const wrapSession = (session: SessionHandle): CodingSession => ({
    ref: session.ref,
    inspect: () => projectView(session),
    readRunReport: (runId) => session.readRunReport(runId),
    fork: (input) => session.forkBranch(input),
    async selectBranch(input) {
      await session.selectBranch(input.branchId, input.expectedRevision);
      return projectView(session);
    },
    async startRun(input) {
      if (input.task.trim().length === 0) throw new TypeError("Coding Task 不能为空");
      const snapshot = await session.inspect();
      if (snapshot.activeRunId) {
        throw new CodingStartError("CODING_SESSION_ACTIVE", "Session 已有 active Run");
      }
      await assertBoundWorkspace(snapshot.workspace, input.acceptWorkspaceFingerprint);
      const branch = await session.readBranch({ branchId: snapshot.currentBranchId });
      const latestConfigurationRevision = branch.records
        .toReversed()
        .find((record) => record.kind === "run_started")?.metadata.configurationRevision;
      if (
        latestConfigurationRevision !== undefined &&
        latestConfigurationRevision !== options.configurationRevision
      ) {
        throw new CodingStartError(
          "CODING_CONTEXT_CONFIGURATION_MISMATCH",
          "当前 Context/Skill configuration 与 Session 最近一次 Run 不一致",
        );
      }
      const handle: HarnessRunHandle = await options.harness.startRun({
        session,
        branchId: snapshot.currentBranchId,
        expectedSessionRevision: snapshot.revision,
        initialMessages: [{ role: "user", text: input.task }],
        model: options.model,
        tools: options.tools,
        context: options.context,
        policies: options.policies,
        metadata: {
          task: input.task,
          configurationRevision: options.configurationRevision,
        },
      });
      const events = new CodingEventStream();
      let runStarted = false;
      const pendingPermissions: ApprovalRequest[] = [];
      const unsubscribe = options.approvals?.subscribe((request) => {
        if (request.runId === handle.runId) {
          if (runStarted) {
            events.publish({ version: 1, type: "permission_requested", request });
          } else {
            pendingPermissions.push(request);
          }
        }
      });
      void (async () => {
        try {
          for await (const event of handle.events()) {
            events.publish(event);
            if (event.type === "run_started") {
              runStarted = true;
              for (const request of pendingPermissions.splice(0)) {
                events.publish({ version: 1, type: "permission_requested", request });
              }
            }
          }
        } finally {
          unsubscribe?.();
          events.close();
        }
      })();
      return {
        runId: handle.runId,
        events: () => events.read(),
        async dispatch(command) {
          if (command.type !== "respond_permission") return handle.dispatch(command);
          if (!options.approvals) {
            return { commandId: command.commandId, status: "unknown" };
          }
          const ack = options.approvals.respond({
            approvalId: command.approvalId,
            runId: handle.runId,
            decision: command.decision,
            planFingerprint: command.planFingerprint,
          });
          return { commandId: command.commandId, status: ack.status };
        },
        finished: handle.finished,
      };
    },
  });

  return {
    async listSessions() {
      return options.sessions.list();
    },
    async createSession(input) {
      const workspace = await inspectWorkspace(input.workspace.root);
      if (!workspace.clean) {
        throw new CodingStartError("CODING_WORKSPACE_DIRTY", "新 Session 要求 clean workspace");
      }
      if (
        !sameWorkspaceRoot(input.workspace.root, workspace.binding.root) ||
        input.workspace.fingerprint !== workspace.binding.fingerprint
      ) {
        throw new CodingStartError(
          "CODING_WORKSPACE_MISMATCH",
          "workspace binding 与当前 repository 不一致",
          { currentWorkspace: workspace.binding },
        );
      }
      return wrapSession(await options.sessions.create({ workspace: workspace.binding }));
    },
    async openSession(ref) {
      return wrapSession(await options.sessions.open(ref));
    },
    async listModels() {
      return [options.model.descriptor];
    },
    listModes() {
      return modes;
    },
    async diagnostics() {
      return {
        sessionRepository: "available",
        model: options.model.descriptor,
        modes,
      };
    },
  };
}
