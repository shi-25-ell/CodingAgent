import type { AssistantMessage, JsonObject, Model, ModelFailure } from "@coding-agent/model";
import type { Agent } from "../agent/agent.js";
import { RunStateMachine } from "../agent/run-state-machine.js";
import type {
  ContextDerivationRecord,
  ContextManager,
  ContextManifest,
  TokenMeasurement,
} from "../context/contracts.js";
import { ContextError } from "../context/errors.js";
import { responseAsAssistantMessage } from "../context/transcript-context.js";
import type { BranchId, RunId } from "../contracts/primitives.js";
import { ReplayEventStream } from "../events/replay-event-stream.js";
import type {
  AgentProgressEvent,
  AgentRunResult,
  AgentSemanticEvent,
  ChangedFileEvidence,
  CommandEvidence,
  PermissionSummary,
  RunPolicies,
  RunReport,
  ToolSummary,
} from "../runtime/contracts.js";
import type {
  AgentInputMessage,
  CompactionCheckpointMetadata,
  QueueItem,
  RunLease,
  RunMetadata,
  SessionHandle,
} from "../session/contracts.js";
import type { ToolExecutor, ToolOutcome } from "../tools/contracts.js";

export interface HarnessRunInput {
  readonly session: SessionHandle;
  readonly branchId: BranchId;
  readonly expectedSessionRevision?: number;
  readonly initialMessages: readonly AgentInputMessage[];
  readonly model: Model;
  readonly tools: ToolExecutor;
  readonly context: ContextManager;
  readonly policies: RunPolicies;
  readonly metadata: RunMetadata;
}

export type HarnessCommand =
  | { readonly commandId: string; readonly type: "abort"; readonly reason?: string }
  | { readonly commandId: string; readonly type: "steer"; readonly text: string }
  | { readonly commandId: string; readonly type: "follow_up"; readonly text: string };

export interface CommandAck {
  readonly commandId: string;
  readonly status: "accepted" | "already_applied" | "not_active";
}

export type HarnessSemanticEvent = {
  readonly version: 1;
  readonly category: "semantic";
  readonly runId: RunId;
  readonly sequence: number;
} & (
  | { readonly type: "run_started"; readonly metadata: RunMetadata }
  | { readonly type: "user_accepted"; readonly message: AgentInputMessage }
  | {
      readonly type: "assistant_committed";
      readonly message: AssistantMessage;
      readonly ledgerSeq: number;
    }
  | { readonly type: "tool_planned"; readonly callId: string; readonly toolName: string }
  | { readonly type: "tool_started"; readonly callId: string }
  | {
      readonly type: "tool_settled";
      readonly outcome: ToolOutcome;
      readonly ledgerSeq: number;
    }
  | {
      readonly type: "model_failure_committed";
      readonly failure: ModelFailure;
      readonly ledgerSeq: number;
    }
  | { readonly type: "queue_changed" | "queue_delivered"; readonly item: QueueItem }
  | {
      readonly type: "context_prepared";
      readonly manifest: ContextManifest;
      readonly measurement: TokenMeasurement;
      readonly checkpoint?: CompactionCheckpointMetadata;
      readonly derivations: readonly ContextDerivationRecord[];
    }
  | {
      readonly type: "compaction_completed";
      readonly derivation: ContextDerivationRecord;
      readonly checkpoint?: CompactionCheckpointMetadata;
    }
  | { readonly type: "compaction_failed"; readonly derivation: ContextDerivationRecord }
  | { readonly type: "terminal"; readonly report: RunReport }
);

export interface HarnessProgressEvent {
  readonly version: 1;
  readonly category: "progress";
  readonly type: "progress";
  readonly runId: RunId;
  readonly key: string;
  readonly event: AgentProgressEvent;
}

export type HarnessEvent = HarnessSemanticEvent | HarnessProgressEvent;

type HarnessSemanticPayload<T = HarnessSemanticEvent> = T extends HarnessSemanticEvent
  ? Omit<T, "version" | "category" | "runId" | "sequence">
  : never;

export interface HarnessRunHandle {
  readonly runId: RunId;
  events(): AsyncIterable<HarnessEvent>;
  dispatch(command: HarnessCommand): Promise<CommandAck>;
  readonly finished: Promise<RunReport>;
}

export interface AgentHarness {
  startRun(input: HarnessRunInput): Promise<HarnessRunHandle>;
}

export interface AgentHarnessOptions {
  readonly agent: Agent;
  readonly redact?: (value: string) => string;
}

function redactValue<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, redact)]),
    ) as T;
  }
  return value;
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}

function reportFromResult(
  run: RunId,
  result: AgentRunResult,
  tools: ToolSummary,
  permissions: PermissionSummary,
  changedFiles: readonly ChangedFileEvidence[],
  commands: readonly CommandEvidence[],
): RunReport {
  return {
    version: 1,
    runId: run,
    status: result.status,
    terminationReason: result.terminationReason,
    ...(result.finalAnswer ? { finalAnswer: result.finalAnswer } : {}),
    counts: result.counts,
    usage: result.usage,
    tools,
    permissions,
    changedFiles,
    commands,
    unfinishedWork: result.unfinishedWork,
    ...(result.error ? { error: result.error } : {}),
    lastPhase: "finalizing",
  };
}

function startLeaseHeartbeat(
  lease: RunLease,
  controller: AbortController,
): {
  readonly failure: Promise<never>;
  stop(): Promise<void>;
} {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let rejectFailure: (reason: unknown) => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const schedule = (): void => {
    timer = setTimeout(() => {
      inFlight = lease
        .heartbeat()
        .then(() => {
          if (!stopped) schedule();
        })
        .catch((error: unknown) => {
          controller.abort(error);
          rejectFailure(error);
        });
    }, lease.heartbeatIntervalMs);
  };
  schedule();
  return {
    failure,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}

function progressKey(event: AgentProgressEvent): string {
  switch (event.type) {
    case "phase_changed":
      return "run:phase";
    case "model_attempt_started":
      return "model:attempt";
    case "assistant_delta":
      return `assistant:${event.modelTurnCount}:${event.modelAttemptCount}:${event.channel}:${event.partIndex}`;
    case "tool_update":
      return `tool:${event.callId}`;
  }
}

class DefaultAgentHarness implements AgentHarness {
  readonly #options: AgentHarnessOptions;

  constructor(options: AgentHarnessOptions) {
    this.#options = options;
  }

  async startRun(input: HarnessRunInput): Promise<HarnessRunHandle> {
    const redact = this.#options.redact ?? ((value: string) => value);
    const expectedRevision =
      input.expectedSessionRevision ?? (await input.session.inspect()).revision;
    const lease = await input.session.beginRun({
      branchId: input.branchId,
      expectedRevision,
      initialMessages: redactValue(input.initialMessages, redact),
      metadata: redactValue(input.metadata, redact),
    });
    const stream = new ReplayEventStream<HarnessEvent>({
      coalescingKey: (event) => (event.category === "progress" ? event.key : undefined),
    });
    const state = new RunStateMachine();
    const controller = new AbortController();
    const heartbeat = startLeaseHeartbeat(lease, controller);
    let abortApplied = false;
    const appliedCommands = new Set<string>();
    let toolSummary: ToolSummary = { accepted: 0, settled: 0, succeeded: 0, failed: 0 };
    let permissionSummary: PermissionSummary = { requested: 0, allowed: 0, denied: 0 };
    const changedFiles: ChangedFileEvidence[] = [];
    const commands: CommandEvidence[] = [];
    let semanticSequence = 0;
    let lifecycle: "active" | "finalizing" | "terminal" = "active";
    let acceptsQueueMessages = true;
    const policies: RunPolicies = Object.freeze({
      ...input.policies,
      budgets: Object.freeze({ ...input.policies.budgets }),
    });
    const toolDefinitions = freezeValue(structuredClone(input.tools.definitions()));
    const publishSemantic = (event: HarnessSemanticPayload): void => {
      semanticSequence += 1;
      stream.publish({
        version: 1,
        category: "semantic",
        runId: lease.runId,
        sequence: semanticSequence,
        ...event,
      } as unknown as HarnessSemanticEvent);
    };
    const publishProgress = (event: AgentProgressEvent): void => {
      stream.publish({
        version: 1,
        category: "progress",
        type: "progress",
        runId: lease.runId,
        key: progressKey(event),
        event,
      });
    };
    publishSemantic({ type: "run_started", metadata: redactValue(input.metadata, redact) });
    for (const message of input.initialMessages) {
      publishSemantic({ type: "user_accepted", message: redactValue(message, redact) });
    }

    const commit = async (event: AgentSemanticEvent): Promise<void> => {
      const safeEvent = redactValue(event, redact);
      if (safeEvent.type === "assistant_message") {
        const message = responseAsAssistantMessage(safeEvent.response);
        const receipt = await lease.append([{ kind: "assistant_message", message }]);
        publishSemantic({
          type: "assistant_committed",
          message,
          ledgerSeq: receipt.lastLedgerSeq,
        });
        for (const part of message.content) {
          if (part.type === "tool_call") {
            publishSemantic({ type: "tool_planned", callId: part.callId, toolName: part.name });
          }
        }
      } else if (safeEvent.type === "model_failure") {
        const receipt = await lease.append([{ kind: "model_failure", failure: safeEvent.failure }]);
        publishSemantic({
          type: "model_failure_committed",
          failure: safeEvent.failure,
          ledgerSeq: receipt.lastLedgerSeq,
        });
      } else if (safeEvent.type === "tool_started") {
        await lease.markToolCallStarted(safeEvent.callId);
        publishSemantic({ type: "tool_started", callId: safeEvent.callId });
      } else {
        const receipt = await lease.append([{ kind: "tool_outcome", outcome: safeEvent.outcome }]);
        const evidence = safeEvent.outcome.evidence;
        if (evidence?.permissionRequested === true) {
          const requested =
            typeof evidence.permissionRequestCount === "number"
              ? evidence.permissionRequestCount
              : 1;
          const allowed =
            typeof evidence.permissionAllowedCount === "number"
              ? evidence.permissionAllowedCount
              : evidence.permissionDecision === "allowed"
                ? 1
                : 0;
          const denied =
            typeof evidence.permissionDeniedCount === "number"
              ? evidence.permissionDeniedCount
              : evidence.permissionDecision === "denied"
                ? 1
                : 0;
          permissionSummary = {
            requested: permissionSummary.requested + requested,
            allowed: permissionSummary.allowed + allowed,
            denied: permissionSummary.denied + denied,
          };
        }
        const changedFile = evidence?.changedFile;
        if (
          changedFile !== null &&
          typeof changedFile === "object" &&
          !Array.isArray(changedFile)
        ) {
          const changedFileObject = changedFile as JsonObject;
          if (
            typeof changedFileObject.path === "string" &&
            (changedFileObject.change === "created" ||
              changedFileObject.change === "modified" ||
              changedFileObject.change === "deleted")
          ) {
            changedFiles.push({
              path: changedFileObject.path,
              change: changedFileObject.change,
            });
          }
        }
        if (typeof evidence?.command === "string") {
          commands.push({
            command: evidence.command,
            ...(typeof evidence.exitCode === "number" ? { exitCode: evidence.exitCode } : {}),
          });
        }
        toolSummary = {
          accepted: toolSummary.accepted + 1,
          settled: toolSummary.settled + 1,
          succeeded: toolSummary.succeeded + (safeEvent.outcome.status === "succeeded" ? 1 : 0),
          failed: toolSummary.failed + (safeEvent.outcome.status === "succeeded" ? 0 : 1),
        };
        publishSemantic({
          type: "tool_settled",
          outcome: safeEvent.outcome,
          ledgerSeq: receipt.lastLedgerSeq,
        });
      }
    };

    const execution = this.#options.agent.run(
      {
        runId: lease.runId,
        model: input.model,
        tools: input.tools,
        policies,
        signal: controller.signal,
      },
      {
        async prepareContext(request) {
          await lease.markModelTurnStarted(request.modelTurnCount);
          const branch = await input.session.readBranch({ branchId: input.branchId });
          try {
            const prepared = await input.context.prepare({
              ...request,
              branch,
              tools: toolDefinitions,
            });
            await lease.commitContext(prepared.manifest, prepared.checkpoint, prepared.derivations);
            publishSemantic({
              type: "context_prepared",
              manifest: prepared.manifest,
              measurement: prepared.measurement,
              ...(prepared.checkpoint ? { checkpoint: prepared.checkpoint } : {}),
              derivations: prepared.derivations,
            });
            for (const derivation of prepared.derivations) {
              if (derivation.status === "succeeded") {
                publishSemantic({
                  type: "compaction_completed",
                  derivation,
                  ...(prepared.checkpoint ? { checkpoint: prepared.checkpoint } : {}),
                });
              } else {
                publishSemantic({ type: "compaction_failed", derivation });
              }
            }
            return prepared;
          } catch (error) {
            if (error instanceof ContextError && error.derivations.length > 0) {
              await lease.commitContextFailure(error.derivations);
              for (const derivation of error.derivations) {
                publishSemantic({ type: "compaction_failed", derivation });
              }
            }
            throw error;
          }
        },
        commit,
        async drainSteering() {
          const items = await lease.drainSteering();
          for (const item of items) publishSemantic({ type: "queue_delivered", item });
          return items;
        },
        async takeFollowUp() {
          const item = await lease.takeFollowUp();
          if (item) publishSemantic({ type: "queue_delivered", item });
          return item;
        },
        reportProgress(event) {
          const safeEvent = redactValue(event, redact);
          if (safeEvent.type === "phase_changed") {
            state.transition(safeEvent.phase);
            if (safeEvent.phase === "completion_candidate") acceptsQueueMessages = false;
            if (safeEvent.phase === "preparing_context") acceptsQueueMessages = true;
          }
          publishProgress(safeEvent);
        },
      },
    );

    const finished = Promise.race([execution.result, heartbeat.failure])
      .then(async (result) => {
        await heartbeat.stop();
        lifecycle = "finalizing";
        const arbitratedResult: AgentRunResult = abortApplied
          ? {
              status: "aborted",
              terminationReason: "user_abort",
              counts: result.counts,
              usage: result.usage,
              unfinishedWork: ["Run 在 finalizing 前收到取消请求"],
            }
          : result;
        const requestedReport = redactValue(
          reportFromResult(
            lease.runId,
            arbitratedResult,
            toolSummary,
            permissionSummary,
            changedFiles,
            commands,
          ),
          redact,
        );
        const report = (await lease.finish(requestedReport)).report;
        lifecycle = "terminal";
        state.transition("terminal");
        publishProgress({ version: 1, type: "phase_changed", phase: "terminal" });
        publishSemantic({ type: "terminal", report });
        return report;
      })
      .finally(async () => {
        await heartbeat.stop();
        stream.close();
        await lease[Symbol.asyncDispose]();
      });

    return {
      runId: lease.runId,
      events: () => stream.events(),
      async dispatch(command) {
        if (lifecycle !== "active") return { commandId: command.commandId, status: "not_active" };
        if (appliedCommands.has(command.commandId)) {
          return { commandId: command.commandId, status: "already_applied" };
        }
        appliedCommands.add(command.commandId);
        if (command.type === "abort") {
          if (abortApplied) return { commandId: command.commandId, status: "already_applied" };
          abortApplied = true;
          controller.abort(command.reason);
          return { commandId: command.commandId, status: "accepted" };
        }
        if (!acceptsQueueMessages) {
          return { commandId: command.commandId, status: "not_active" };
        }
        const item = await input.session.enqueue({
          commandId: command.commandId,
          kind: command.type === "steer" ? "steering" : "follow_up",
          text: redact(command.text),
        });
        publishSemantic({ type: "queue_changed", item });
        return { commandId: command.commandId, status: "accepted" };
      },
      finished,
    };
  }
}

export function createAgentHarness(options: AgentHarnessOptions): AgentHarness {
  return new DefaultAgentHarness(options);
}
