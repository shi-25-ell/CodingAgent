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

export interface CreateCodingSessionInput {
  readonly workspace: WorkspaceBinding;
}

export interface StartCodingRunInput {
  readonly task: string;
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
  readonly timeline: readonly CodingTimelineEntry[];
}

export type CodingEvent = HarnessEvent;
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

  const wrapSession = (session: SessionHandle): CodingSession => ({
    ref: session.ref,
    async inspect() {
      const snapshot = await session.inspect();
      const branch = await session.readBranch({ branchId: snapshot.currentBranchId });
      return {
        ref: snapshot.ref,
        workspace: snapshot.workspace,
        revision: snapshot.revision,
        ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
        currentBranchId: snapshot.currentBranchId,
        timeline: timeline(branch.records),
      };
    },
    async startRun(input) {
      if (input.task.trim().length === 0) throw new TypeError("Coding Task 不能为空");
      const snapshot = await session.inspect();
      const handle: HarnessRunHandle = await options.harness.startRun({
        session,
        branchId: snapshot.currentBranchId,
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
      return {
        runId: handle.runId,
        events: () => handle.events(),
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
      return wrapSession(await options.sessions.create(input));
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
