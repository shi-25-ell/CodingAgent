import type { JsonObject, Model } from "@coding-agent/model";
import type { Agent } from "../agent/agent.js";
import { RunStateMachine } from "../agent/run-state-machine.js";
import type { ContextManager } from "../context/contracts.js";
import { responseAsAssistantMessage } from "../context/transcript-context.js";
import type { BranchId, RunId } from "../contracts/primitives.js";
import { ReplayEventStream } from "../events/replay-event-stream.js";
import type {
  AgentEvent,
  AgentRunResult,
  AgentSemanticEvent,
  ChangedFileEvidence,
  CommandEvidence,
  PermissionSummary,
  RunPolicies,
  RunReport,
  ToolSummary,
} from "../runtime/contracts.js";
import type { AgentInputMessage, RunMetadata, SessionHandle } from "../session/contracts.js";
import type { ToolExecutor } from "../tools/contracts.js";

export interface HarnessRunInput {
  readonly session: SessionHandle;
  readonly branchId: BranchId;
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

export type HarnessEvent = { readonly version: 1 } & (
  | { readonly type: "run_started"; readonly runId: RunId }
  | { readonly type: "progress"; readonly event: AgentEvent }
  | { readonly type: "assistant_committed"; readonly runId: RunId }
  | { readonly type: "model_failure_committed"; readonly runId: RunId }
  | { readonly type: "terminal"; readonly report: RunReport }
);

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

class DefaultAgentHarness implements AgentHarness {
  readonly #options: AgentHarnessOptions;

  constructor(options: AgentHarnessOptions) {
    this.#options = options;
  }

  async startRun(input: HarnessRunInput): Promise<HarnessRunHandle> {
    const redact = this.#options.redact ?? ((value: string) => value);
    const lease = await input.session.beginRun({
      branchId: input.branchId,
      initialMessages: redactValue(input.initialMessages, redact),
      metadata: redactValue(input.metadata, redact),
    });
    const stream = new ReplayEventStream<HarnessEvent>();
    const state = new RunStateMachine();
    const controller = new AbortController();
    let abortApplied = false;
    const appliedCommands = new Set<string>();
    let toolSummary: ToolSummary = { accepted: 0, settled: 0, succeeded: 0, failed: 0 };
    let permissionSummary: PermissionSummary = { requested: 0, allowed: 0, denied: 0 };
    const changedFiles: ChangedFileEvidence[] = [];
    const commands: CommandEvidence[] = [];
    let lifecycle: "active" | "finalizing" | "terminal" = "active";
    let acceptsQueueMessages = true;
    const policies: RunPolicies = Object.freeze({
      ...input.policies,
      budgets: Object.freeze({ ...input.policies.budgets }),
    });
    const toolDefinitions = freezeValue(structuredClone(input.tools.definitions()));
    stream.publish({ version: 1, type: "run_started", runId: lease.runId });

    const commit = async (event: AgentSemanticEvent): Promise<void> => {
      const safeEvent = redactValue(event, redact);
      if (safeEvent.type === "assistant_message") {
        await lease.append([
          { kind: "assistant_message", message: responseAsAssistantMessage(safeEvent.response) },
        ]);
        stream.publish({ version: 1, type: "assistant_committed", runId: lease.runId });
      } else if (safeEvent.type === "model_failure") {
        await lease.append([{ kind: "model_failure", failure: safeEvent.failure }]);
        stream.publish({ version: 1, type: "model_failure_committed", runId: lease.runId });
      } else {
        await lease.append([{ kind: "tool_outcome", outcome: safeEvent.outcome }]);
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
          const branch = await input.session.readBranch({ branchId: input.branchId });
          return input.context.prepare({
            ...request,
            branch,
            tools: toolDefinitions,
          });
        },
        commit,
        drainSteering: () => lease.drainSteering(),
        takeFollowUp: () => lease.takeFollowUp(),
        reportProgress(event) {
          if (event.type === "phase_changed") {
            state.transition(event.phase);
            if (event.phase === "completion_candidate") acceptsQueueMessages = false;
            if (event.phase === "preparing_context") acceptsQueueMessages = true;
          }
          stream.publish({ version: 1, type: "progress", event });
        },
      },
    );

    const finished = execution.result
      .then(async (result) => {
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
        stream.publish({
          version: 1,
          type: "progress",
          event: { version: 1, type: "phase_changed", phase: "terminal" },
        });
        stream.publish({ version: 1, type: "terminal", report });
        return report;
      })
      .finally(async () => {
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
        await input.session.enqueue({
          commandId: command.commandId,
          kind: command.type === "steer" ? "steering" : "follow_up",
          text: redact(command.text),
        });
        return { commandId: command.commandId, status: "accepted" };
      },
      finished,
    };
  }
}

export function createAgentHarness(options: AgentHarnessOptions): AgentHarness {
  return new DefaultAgentHarness(options);
}
