import type {
  AgentHarness,
  BranchId,
  Clock,
  ContextDerivationRecord,
  ContextManager,
  ContextManifest,
  HarnessCommand,
  HarnessEvent,
  HarnessRunHandle,
  QueueItem,
  QueueUpdate,
  RunConfigSnapshot,
  RunId,
  RunPolicies,
  RunReport,
  SessionHandle,
  SessionRef,
  SessionRepository,
  StoredContextManifest,
  TokenMeasurement,
  ToolExecutor,
  WorkspaceBinding,
} from "@coding-agent/agent";
import { SessionError } from "@coding-agent/agent";
import type { Model, ModelDescriptor, ModelRef } from "@coding-agent/model";
import type { ExtensionDiagnostic, LoadedExtension } from "../extensions/contracts.js";
import { createInteractiveInteractionMode } from "../modes/interactive/interactive-entry.js";
import { createPrintInteractionMode } from "../modes/print/print-entry.js";
import {
  type InteractionMode,
  InteractionModeRegistry,
  type ModeDescriptor,
  type ModeRegistry,
} from "../modes/registry.js";
import type { ApprovalBridge, ApprovalLifecycleEvent } from "../permissions/approval-bridge.js";
import type {
  CodingDiffDocument,
  CodingRunProjection,
  CodingSessionSnapshot,
  DiffViewerSource,
} from "../projection/contracts.js";
import { reduceProjection } from "../projection/projection.js";
import type { SkillDescriptor, SkillRegistryDiagnostic } from "../skills/contracts.js";
import type { ApprovalRequest } from "../tools/coding-tool-host.js";
import {
  sameWorkspaceRoot,
  type WorkspaceService,
  type WorkspaceSnapshot,
} from "../workspace/workspace-service.js";
import { CodingEventChannel, type CodingEventCursor } from "./coding-event-channel.js";
import type {
  CodingApprovalSummary,
  CodingEvent,
  CodingProgressPayload,
  CodingSemanticPayload,
  CodingToolPlanSummary,
} from "./coding-events.js";

export interface CreateCodingSessionInput {
  readonly workspace: WorkspaceBinding;
}

export interface StartCodingRunInput {
  readonly task: string;
  readonly model?: ModelRef;
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

export interface CodingSessionView extends CodingSessionSnapshot {
  readonly currentBranchId: BranchId;
  readonly branches: Awaited<ReturnType<SessionHandle["inspect"]>>["branches"];
  readonly timeline: readonly CodingTimelineEntry[];
}
export type CodingRunCommand =
  | HarnessCommand
  | {
      readonly commandId: string;
      readonly type: "respond_permission";
      readonly approvalId: string;
      readonly decision: "allow_once" | "deny";
      readonly planFingerprint: string;
    }
  | {
      readonly commandId: string;
      readonly type: "update_queue";
      readonly targetCommandId: string;
      readonly expectedRevision: number;
      readonly text?: string;
      readonly status: "queued" | "draft" | "cancelled";
    };

export interface CodingCommandAck {
  readonly commandId: string;
  readonly status: "accepted" | "already_applied" | "not_active" | "unknown" | "stale" | "conflict";
  readonly queueItem?: QueueItem;
}

export interface CodingRunHandle {
  readonly runId: RunId;
  events(cursor?: CodingEventCursor): AsyncIterable<CodingEvent>;
  snapshot(): Promise<{
    readonly snapshot: CodingSessionSnapshot;
    readonly cursor: CodingEventCursor;
  }>;
  diagnostics(): ReturnType<CodingEventChannel["diagnostics"]>;
  dispatch(command: CodingRunCommand): Promise<CodingCommandAck>;
  readonly finished: Promise<RunReport>;
}

export interface CodingSession {
  readonly ref: SessionRef;
  inspect(): Promise<CodingSessionView>;
  snapshot(): Promise<CodingSessionSnapshot>;
  readRunReport(runId: RunId): Promise<RunReport | undefined>;
  readContextManifests(runId: RunId): Promise<readonly StoredContextManifest[]>;
  readContextDerivations(runId: RunId): Promise<readonly ContextDerivationRecord[]>;
  readDiff(input: {
    readonly source: DiffViewerSource;
    readonly runId?: RunId;
  }): Promise<CodingDiffDocument>;
  listQueue(runId?: RunId): Promise<readonly QueueItem[]>;
  updateQueue(input: QueueUpdate): Promise<QueueItem>;
  activeRun(): CodingRunHandle | undefined;
  fork(input: ForkConversationInput): Promise<import("@coding-agent/agent").BranchRef>;
  selectBranch(input: SelectBranchInput): Promise<CodingSessionView>;
  startRun(input: StartCodingRunInput): Promise<CodingRunHandle>;
  resume(input: StartCodingRunInput): Promise<CodingRunHandle>;
}

export interface CodingDiagnostics {
  readonly sessionRepository: "available";
  readonly model: ModelDescriptor;
  readonly models: readonly ModelDescriptor[];
  readonly modes: readonly ModeDescriptor[];
  readonly skills: readonly SkillDescriptor[];
  readonly skillDiagnostics: readonly SkillRegistryDiagnostic[];
  readonly extensions: readonly LoadedExtension[];
  readonly extensionDiagnostics: readonly ExtensionDiagnostic[];
  readonly credential: {
    readonly status: "present" | "missing" | "failed";
    readonly sourceId?: string;
  };
}

export interface CodingAgent {
  listSessions(): Promise<readonly CodingSessionSummary[]>;
  createSession(input: CreateCodingSessionInput): Promise<CodingSession>;
  openSession(ref: SessionRef): Promise<CodingSession>;
  listModels(): Promise<readonly ModelDescriptor[]>;
  listModes(): readonly ModeDescriptor[];
  resolveMode(id: string): InteractionMode;
  diagnostics(): Promise<CodingDiagnostics>;
}

export interface CodingAgentOptions {
  readonly sessions: SessionRepository;
  readonly harness: AgentHarness;
  readonly model: Model;
  readonly models?: readonly Model[];
  readonly tools: ToolExecutor;
  readonly context: ContextManager;
  readonly policies: RunPolicies;
  readonly configurationRevision: string;
  readonly runConfiguration?: {
    readonly permissionMode?: "safe" | "autonomous";
    readonly searchProfile?: string;
    readonly extensions?: readonly string[];
    readonly skills?: readonly string[];
    readonly policyVersions?: Readonly<Record<string, string>>;
  };
  readonly modes?: readonly InteractionMode[];
  readonly approvals?: ApprovalBridge;
  readonly workspace: WorkspaceService;
  readonly skills?: readonly SkillDescriptor[];
  readonly skillDiagnostics?: readonly SkillRegistryDiagnostic[];
  readonly extensions?: readonly LoadedExtension[];
  readonly extensionDiagnostics?: readonly ExtensionDiagnostic[];
  readonly observe?: (event: Readonly<unknown>) => void | Promise<void>;
  readonly clock?: Clock;
  readonly credentialDiagnostic?: CodingDiagnostics["credential"];
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

function planSummary(request: ApprovalRequest): CodingToolPlanSummary {
  return {
    callId: request.plan.callId,
    toolName: request.plan.toolName,
    resources: request.plan.resources,
    effects: request.plan.effects,
    risks: request.plan.risks,
    fingerprint: request.plan.fingerprint,
  };
}

function approvalSummary(request: ApprovalRequest): CodingApprovalSummary {
  return {
    approvalId: request.approvalId,
    callId: request.plan.callId,
    plan: planSummary(request),
    decisions: ["allow_once", "deny"],
    status: "pending",
  };
}

function emptyRun(runId: RunId): CodingRunProjection {
  return {
    runId,
    phase: "created",
    status: "idle",
    terminal: false,
    tools: {},
    toolOrder: [],
    approvals: {},
    approvalOrder: [],
    compactions: [],
  };
}

function measurementFromManifest(manifest: ContextManifest): TokenMeasurement {
  const selected = manifest.contributions.filter((item) => item.disposition !== "omitted");
  const withoutToolDefinitions = selected.filter(
    (item) => item.provenance.id !== "tool-definitions",
  );
  return {
    method: "estimated_chars",
    inputTokens: withoutToolDefinitions.reduce((sum, item) => sum + item.estimatedTokens, 0),
    outputReserve: manifest.budget.requestedOutputReserve,
    protocolToolSchemaReserve: manifest.budget.protocolToolSchemaReserve,
    safetyMargin: manifest.budget.safetyMargin,
    usableInputBudget: manifest.budget.usableInputBudget,
    requiredTokens: withoutToolDefinitions
      .filter((item) => item.required)
      .reduce((sum, item) => sum + item.estimatedTokens, 0),
    optionalTokens: selected
      .filter((item) => !item.required)
      .reduce((sum, item) => sum + item.estimatedTokens, 0),
  };
}

export function createCodingAgent(options: CodingAgentOptions): CodingAgent {
  const models = [...(options.models ?? []), options.model].filter(
    (model, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.descriptor.providerId === model.descriptor.providerId &&
          candidate.descriptor.modelId === model.descriptor.modelId,
      ) === index,
  );
  const configuredModes = options.modes ?? [];
  const modeRegistry: ModeRegistry = new InteractionModeRegistry([
    ...(configuredModes.some((mode) => mode.descriptor.id === "interactive")
      ? []
      : [createInteractiveInteractionMode()]),
    ...(configuredModes.some((mode) => mode.descriptor.id === "print")
      ? []
      : [createPrintInteractionMode()]),
    ...configuredModes,
  ]);
  const activeRuns = new Map<string, CodingRunHandle>();

  const resolveModel = (ref: ModelRef | undefined): Model => {
    if (!ref) return options.model;
    const model = models.find(
      (candidate) =>
        candidate.descriptor.providerId === ref.providerId &&
        candidate.descriptor.modelId === ref.modelId,
    );
    if (!model) throw new TypeError("选择的 model 不在当前 catalog 中或不可用");
    return model;
  };

  const configFor = (model: Model): RunConfigSnapshot => ({
    version: 1,
    model: {
      providerId: model.descriptor.providerId,
      modelId: model.descriptor.modelId,
      sourceRevision: model.descriptor.source.revision,
    },
    permissionMode: options.runConfiguration?.permissionMode ?? "autonomous",
    budgets: Object.freeze({ ...options.policies.budgets }),
    tools: Object.freeze(options.tools.definitions().map((tool) => tool.name)),
    ...(options.runConfiguration?.searchProfile
      ? { searchProfile: options.runConfiguration.searchProfile }
      : {}),
    extensions: Object.freeze([...(options.runConfiguration?.extensions ?? [])]),
    skills: Object.freeze([...(options.runConfiguration?.skills ?? [])]),
    policyVersions: Object.freeze({
      run: options.configurationRevision,
      ...(options.runConfiguration?.policyVersions ?? {}),
    }),
    configurationRevision: options.configurationRevision,
  });

  const inspectWorkspace = async (root: string): Promise<WorkspaceSnapshot> => {
    try {
      return await options.workspace.inspect(root);
    } catch (error) {
      throw new CodingStartError("CODING_WORKSPACE_UNAVAILABLE", "workspace preflight 失败", {
        cause: error,
      });
    }
  };

  const projectSnapshot = async (session: SessionHandle): Promise<CodingSessionSnapshot> => {
    const sessionSnapshot = await session.inspect();
    const branch = await session.readBranch({ branchId: sessionSnapshot.currentBranchId });
    const queues = await session.listQueue();
    const runs: Record<string, CodingRunProjection> = {};
    const runOrder: RunId[] = [];
    const transcript: CodingSessionSnapshot["transcript"][number][] = [];
    const ensureRun = (runId: RunId): CodingRunProjection => {
      const existing = runs[runId];
      if (existing) return existing;
      const created = emptyRun(runId);
      runs[runId] = created;
      runOrder.push(runId);
      return created;
    };
    const replaceRun = (runId: RunId, run: CodingRunProjection): void => {
      runs[runId] = run;
    };
    for (const record of branch.records) {
      const run = ensureRun(record.runId);
      switch (record.kind) {
        case "run_started":
          replaceRun(record.runId, {
            ...run,
            ...(record.metadata.config
              ? { config: record.metadata.config }
              : record.metadata.configurationRevision === options.configurationRevision
                ? { config: configFor(options.model) }
                : {}),
          });
          break;
        case "user_message":
          transcript.push({
            id: `ledger:${record.ledgerSeq}`,
            runId: record.runId,
            ledgerSeq: record.ledgerSeq,
            kind: "user",
            text: record.text,
          });
          break;
        case "assistant_message": {
          const tools = { ...run.tools };
          const toolOrder = [...run.toolOrder];
          for (const part of record.message.content) {
            if (part.type !== "tool_call") continue;
            tools[part.callId] = {
              callId: part.callId,
              plan: {
                callId: part.callId,
                toolName: part.name,
                resources: [],
                effects: [],
                risks: [],
              },
              status: "planned",
            };
            if (!toolOrder.includes(part.callId)) toolOrder.push(part.callId);
          }
          replaceRun(record.runId, { ...run, tools, toolOrder });
          transcript.push({
            id: `ledger:${record.ledgerSeq}`,
            runId: record.runId,
            ledgerSeq: record.ledgerSeq,
            kind: "assistant",
            assistant: record.message,
          });
          break;
        }
        case "tool_started": {
          const tool = run.tools[record.callId];
          if (tool) {
            replaceRun(record.runId, {
              ...run,
              tools: { ...run.tools, [record.callId]: { ...tool, status: "running" } },
            });
          }
          break;
        }
        case "tool_outcome": {
          const tool = run.tools[record.outcome.callId];
          const fallback = {
            callId: record.outcome.callId,
            toolName: "unknown",
            resources: [],
            effects: [],
            risks: [],
          };
          replaceRun(record.runId, {
            ...run,
            tools: {
              ...run.tools,
              [record.outcome.callId]: {
                callId: record.outcome.callId,
                plan: {
                  ...(tool?.plan ?? fallback),
                  resources: [],
                  effects: Array.isArray(record.outcome.evidence?.effects)
                    ? record.outcome.evidence.effects.filter(
                        (effect): effect is CodingToolPlanSummary["effects"][number] =>
                          effect === "workspace_read" ||
                          effect === "workspace_mutation" ||
                          effect === "process" ||
                          effect === "git_evidence" ||
                          effect === "network",
                      )
                    : [],
                  risks: [],
                  ...(typeof record.outcome.evidence?.planFingerprint === "string"
                    ? { fingerprint: record.outcome.evidence.planFingerprint }
                    : {}),
                },
                status: "settled",
                outcome: record.outcome,
              },
            },
            toolOrder: run.toolOrder.includes(record.outcome.callId)
              ? run.toolOrder
              : [...run.toolOrder, record.outcome.callId],
          });
          transcript.push({
            id: `ledger:${record.ledgerSeq}`,
            runId: record.runId,
            ledgerSeq: record.ledgerSeq,
            kind: "tool",
            outcome: record.outcome,
          });
          break;
        }
        case "model_failure":
          replaceRun(record.runId, { ...run, modelFailure: record.failure });
          transcript.push({
            id: `ledger:${record.ledgerSeq}`,
            runId: record.runId,
            ledgerSeq: record.ledgerSeq,
            kind: "model_failure",
            failure: record.failure,
          });
          break;
        case "recovery": {
          const diagnostic = {
            code: "RUN_INTERRUPTED" as const,
            message: "先前 active Run 在恢复时被保守结算",
            runId: record.runId,
          };
          replaceRun(record.runId, {
            ...run,
            phase: "terminal",
            status: "recovering",
            terminal: true,
            recovery: diagnostic,
          });
          transcript.push({
            id: `recovery:${record.runId}`,
            runId: record.runId,
            ledgerSeq: record.ledgerSeq,
            kind: "recovery",
            recovery: diagnostic,
          });
          break;
        }
        case "run_terminal":
          replaceRun(record.runId, {
            ...run,
            phase: "terminal",
            status: record.report.status,
            terminal: true,
            report: record.report,
          });
          break;
        case "run_boundary":
          break;
      }
    }
    await Promise.all(
      runOrder.map(async (runId) => {
        const [manifests, derivations] = await Promise.all([
          session.readContextManifests(runId),
          session.readContextDerivations(runId),
        ]);
        const manifest = manifests.toReversed().find((item) => item.version === 2);
        const run = runs[runId];
        if (!run || !manifest) return;
        const checkpoint = branch.checkpoints.toReversed().find((item) => item.runId === runId);
        replaceRun(runId, {
          ...run,
          context: {
            manifest,
            measurement: measurementFromManifest(manifest),
            ...(checkpoint ? { checkpoint } : {}),
            derivations,
          },
          compactions: derivations,
        });
      }),
    );
    return {
      version: 1,
      ref: sessionSnapshot.ref,
      workspace: sessionSnapshot.workspace,
      revision: sessionSnapshot.revision,
      ...(sessionSnapshot.activeRunId ? { activeRunId: sessionSnapshot.activeRunId } : {}),
      currentBranchId: sessionSnapshot.currentBranchId,
      branches: sessionSnapshot.branches,
      runOrder,
      runs,
      transcript,
      queues,
    };
  };

  const projectView = async (session: SessionHandle): Promise<CodingSessionView> => {
    const snapshot = await projectSnapshot(session);
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });
    return { ...snapshot, timeline: timeline(branch.records) };
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

  const wrapSession = (session: SessionHandle): CodingSession => {
    const startRun = async (input: StartCodingRunInput): Promise<CodingRunHandle> => {
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
      const model = resolveModel(input.model);
      const config = configFor(model);
      const handle: HarnessRunHandle = await options.harness.startRun({
        session,
        branchId: snapshot.currentBranchId,
        expectedSessionRevision: snapshot.revision,
        initialMessages: [{ role: "user", text: input.task }],
        model,
        tools: options.tools,
        context: options.context,
        policies: options.policies,
        metadata: {
          task: input.task,
          configurationRevision: options.configurationRevision,
          config,
        },
      });
      const channel = new CodingEventChannel(handle.runId, {
        now: () => options.clock?.now() ?? Date.now(),
      });
      let runStarted = false;
      const pendingApprovals: ApprovalLifecycleEvent[] = [];
      const publishSemantic = (payload: CodingSemanticPayload): void => {
        channel.publishSemantic(payload);
        void options.observe?.(payload);
      };
      const publishProgress = (payload: CodingProgressPayload): void => {
        channel.publishProgress(payload);
        void options.observe?.(payload);
      };
      const publishApproval = (event: ApprovalLifecycleEvent): void => {
        if (event.request.runId !== handle.runId) return;
        if (!runStarted) {
          pendingApprovals.push(event);
          return;
        }
        if (event.type === "requested") {
          publishSemantic({
            type: "permission_requested",
            approval: approvalSummary(event.request),
            request: event.request,
          });
        } else {
          publishSemantic({
            type: "permission_resolved",
            approvalId: event.request.approvalId,
            status:
              event.type === "resolved"
                ? event.decision === "allow_once"
                  ? "allowed"
                  : "denied"
                : event.type,
            ...(event.type === "resolved" ? { decision: event.decision } : {}),
          });
        }
      };
      const unsubscribe = options.approvals?.subscribeLifecycle(publishApproval);
      const publishHarness = (event: HarnessEvent): void => {
        if (event.category === "progress") {
          publishProgress({ key: event.key, ...event.event });
          return;
        }
        switch (event.type) {
          case "run_started":
            publishSemantic({
              type: "run_started",
              sessionId: session.ref.sessionId,
              branchId: snapshot.currentBranchId,
              config: event.metadata.config ?? config,
            });
            runStarted = true;
            for (const approval of pendingApprovals.splice(0)) publishApproval(approval);
            break;
          case "user_accepted":
            publishSemantic({ type: "user_accepted", text: event.message.text });
            break;
          case "assistant_committed":
            publishSemantic({
              type: "assistant_committed",
              message: event.message,
              ledgerSeq: event.ledgerSeq,
            });
            break;
          case "tool_planned":
            publishSemantic({
              type: "tool_planned",
              plan: {
                callId: event.callId,
                toolName: event.toolName,
                resources: [],
                effects: [],
                risks: [],
              },
            });
            break;
          case "tool_started":
            publishSemantic({ type: "tool_started", callId: event.callId });
            break;
          case "tool_settled":
            publishSemantic({
              type: "tool_settled",
              outcome: event.outcome,
              ledgerSeq: event.ledgerSeq,
            });
            break;
          case "model_failure_committed":
            publishSemantic({
              type: "model_failure_committed",
              failure: event.failure,
              ledgerSeq: event.ledgerSeq,
            });
            break;
          case "queue_changed":
          case "queue_delivered":
            publishSemantic({ type: event.type, item: event.item });
            break;
          case "context_prepared":
            publishSemantic({
              type: "context_prepared",
              manifest: event.manifest,
              measurement: measurementFromManifest(event.manifest),
              ...(event.checkpoint ? { checkpoint: event.checkpoint } : {}),
              derivations: event.derivations,
            });
            break;
          case "compaction_completed":
            publishSemantic({
              type: "compaction_completed",
              derivation: event.derivation,
              ...(event.checkpoint ? { checkpoint: event.checkpoint } : {}),
            });
            break;
          case "compaction_failed":
            publishSemantic({ type: "compaction_failed", derivation: event.derivation });
            break;
          case "terminal":
            publishSemantic({ type: "terminal_committed", report: event.report });
            break;
        }
      };
      void (async () => {
        try {
          for await (const event of handle.events()) {
            if (event.category === "semantic" && event.type === "terminal") {
              const latest = await session.inspect();
              publishSemantic({
                type: "session_updated",
                revision: latest.revision,
                currentBranchId: latest.currentBranchId,
                ...(latest.activeRunId ? { activeRunId: latest.activeRunId } : {}),
                branches: latest.branches,
              });
            }
            publishHarness(event);
          }
        } finally {
          unsubscribe?.();
          channel.close();
        }
      })();
      const codingHandle: CodingRunHandle = {
        runId: handle.runId,
        events: (cursor) => channel.events(cursor),
        async snapshot() {
          const cursor = channel.cursor();
          const durable = await projectSnapshot(session);
          let projection = reduceProjection(undefined, durable);
          for (const event of channel.checkpointEvents(cursor)) {
            projection = reduceProjection(projection, event);
          }
          return {
            snapshot: {
              version: 1,
              ref: projection.ref,
              workspace: projection.workspace,
              revision: projection.revision,
              ...(projection.activeRunId ? { activeRunId: projection.activeRunId } : {}),
              currentBranchId: projection.currentBranchId,
              branches: projection.branches,
              runOrder: projection.runOrder,
              runs: projection.runs,
              transcript: projection.transcript,
              queues: projection.queues,
              eventCursors: { [handle.runId]: cursor.semanticSequence },
            },
            cursor,
          };
        },
        diagnostics: () => channel.diagnostics(),
        async dispatch(command) {
          if (command.type === "respond_permission") {
            if (!options.approvals) return { commandId: command.commandId, status: "unknown" };
            const ack = options.approvals.respond({
              approvalId: command.approvalId,
              runId: handle.runId,
              decision: command.decision,
              planFingerprint: command.planFingerprint,
            });
            return { commandId: command.commandId, status: ack.status };
          }
          if (command.type === "update_queue") {
            try {
              const item = await session.updateQueue({
                commandId: command.targetCommandId,
                expectedRevision: command.expectedRevision,
                ...(command.text !== undefined ? { text: command.text } : {}),
                status: command.status,
              });
              publishSemantic({ type: "queue_changed", item });
              return { commandId: command.commandId, status: "accepted", queueItem: item };
            } catch (error) {
              if (error instanceof SessionError && error.code === "SESSION_REVISION_CONFLICT") {
                return { commandId: command.commandId, status: "conflict" };
              }
              throw error;
            }
          }
          return handle.dispatch(command);
        },
        finished: handle.finished,
      };
      activeRuns.set(String(session.ref.sessionId), codingHandle);
      void handle.finished.finally(() => {
        if (activeRuns.get(String(session.ref.sessionId)) === codingHandle) {
          activeRuns.delete(String(session.ref.sessionId));
        }
      });
      return codingHandle;
    };

    return {
      ref: session.ref,
      inspect: () => projectView(session),
      snapshot: () => projectSnapshot(session),
      readRunReport: (runId) => session.readRunReport(runId),
      readContextManifests: (runId) => session.readContextManifests(runId),
      readContextDerivations: (runId) => session.readContextDerivations(runId),
      async readDiff(input) {
        if (!options.workspace.readDiff) {
          throw new Error("当前 WorkspaceService 不支持 structured Diff");
        }
        const sessionSnapshot = await projectSnapshot(session);
        let paths: readonly string[] | undefined;
        if (input.source === "last_turn") {
          const runId = input.runId ?? sessionSnapshot.runOrder.at(-1);
          if (runId) {
            const report = await session.readRunReport(runId);
            paths = report?.changedFiles.map((file) => file.path);
          }
        }
        return options.workspace.readDiff({
          root: sessionSnapshot.workspace.root,
          source: input.source,
          ...(paths ? { paths } : {}),
        });
      },
      listQueue: (runId) => session.listQueue(runId),
      updateQueue: (input) => session.updateQueue(input),
      activeRun: () => activeRuns.get(String(session.ref.sessionId)),
      fork: (input) => session.forkBranch(input),
      async selectBranch(input) {
        await session.selectBranch(input.branchId, input.expectedRevision);
        return projectView(session);
      },
      startRun,
      resume: startRun,
    };
  };

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
      return models.map((model) => model.descriptor);
    },
    listModes() {
      return modeRegistry.list();
    },
    resolveMode(id) {
      return modeRegistry.resolve(id);
    },
    async diagnostics() {
      return {
        sessionRepository: "available",
        model: options.model.descriptor,
        models: models.map((model) => model.descriptor),
        modes: modeRegistry.list(),
        skills: Object.freeze([...(options.skills ?? [])]),
        skillDiagnostics: Object.freeze([...(options.skillDiagnostics ?? [])]),
        extensions: Object.freeze([...(options.extensions ?? [])]),
        extensionDiagnostics: Object.freeze([...(options.extensionDiagnostics ?? [])]),
        credential: options.credentialDiagnostic ?? { status: "present" },
      };
    },
  };
}
