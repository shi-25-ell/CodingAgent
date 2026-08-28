import type { Model } from "@coding-agent/model";
import type { Agent } from "../agent/agent.js";
import type { ContextManager } from "../context/contracts.js";
import { responseAsAssistantMessage } from "../context/transcript-context.js";
import type { BranchId, RunId } from "../contracts/primitives.js";
import { ReplayEventStream } from "../events/replay-event-stream.js";
import type {
  AgentEvent,
  AgentRunResult,
  AgentSemanticEvent,
  CommandEvidence,
  RunPolicies,
  RunReport,
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

export type HarnessCommand = {
  readonly commandId: string;
  readonly type: "abort";
  readonly reason?: string;
};

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
}

function reportFromResult(run: RunId, result: AgentRunResult): RunReport {
  return {
    version: 1,
    runId: run,
    status: result.status,
    terminationReason: result.terminationReason,
    ...(result.finalAnswer ? { finalAnswer: result.finalAnswer } : {}),
    counts: result.counts,
    usage: result.usage,
    tools: { accepted: 0, settled: 0, succeeded: 0, failed: 0 },
    permissions: { requested: 0, allowed: 0, denied: 0 },
    changedFiles: [],
    commands: [] satisfies readonly CommandEvidence[],
    unfinishedWork: result.unfinishedWork,
    ...(result.error ? { error: result.error } : {}),
    lastPhase: "finalizing",
  };
}

function terminalCommitFailure(report: RunReport): RunReport {
  const { finalAnswer: _omittedFinalAnswer, ...withoutFinalAnswer } = report;
  return {
    ...withoutFinalAnswer,
    status: "failed",
    terminationReason: "persistence_failure",
    unfinishedWork: [...report.unfinishedWork, "terminal commit 首次失败，已执行保守重试"],
    error: {
      code: "SESSION_TERMINAL_COMMIT_FAILURE",
      message: "Terminal commit failed",
    },
  };
}

class DefaultAgentHarness implements AgentHarness {
  readonly #options: AgentHarnessOptions;

  constructor(options: AgentHarnessOptions) {
    this.#options = options;
  }

  async startRun(input: HarnessRunInput): Promise<HarnessRunHandle> {
    const lease = await input.session.beginRun({
      branchId: input.branchId,
      initialMessages: input.initialMessages,
      metadata: input.metadata,
    });
    const stream = new ReplayEventStream<HarnessEvent>();
    const controller = new AbortController();
    let abortApplied = false;
    let terminal = false;
    stream.publish({ version: 1, type: "run_started", runId: lease.runId });

    const commit = async (event: AgentSemanticEvent): Promise<void> => {
      if (event.type === "assistant_message") {
        await lease.append([
          { kind: "assistant_message", message: responseAsAssistantMessage(event.response) },
        ]);
        stream.publish({ version: 1, type: "assistant_committed", runId: lease.runId });
      } else {
        await lease.append([{ kind: "model_failure", failure: event.failure }]);
        stream.publish({ version: 1, type: "model_failure_committed", runId: lease.runId });
      }
    };

    const execution = this.#options.agent.run(
      {
        runId: lease.runId,
        model: input.model,
        tools: input.tools,
        policies: input.policies,
        signal: controller.signal,
      },
      {
        async prepareContext(request) {
          const branch = await input.session.readBranch({ branchId: input.branchId });
          return input.context.prepare({
            ...request,
            branch,
            tools: input.tools.definitions(),
          });
        },
        commit,
        reportProgress(event) {
          stream.publish({ version: 1, type: "progress", event });
        },
      },
    );

    const finished = execution.result
      .then(async (result) => {
        let report = reportFromResult(lease.runId, result);
        try {
          await lease.finish(report);
        } catch (_error) {
          report = terminalCommitFailure(report);
          try {
            await lease.finish(report);
          } catch (_retryError) {
            report = {
              ...report,
              unfinishedWork: [
                ...report.unfinishedWork,
                "terminal 持久化状态未知，需要 persistence recovery",
              ],
              error: {
                code: "SESSION_TERMINAL_STATE_UNKNOWN",
                message: "Terminal persistence state is unknown",
              },
            };
          }
        }
        terminal = true;
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
        if (terminal) return { commandId: command.commandId, status: "not_active" };
        if (abortApplied) return { commandId: command.commandId, status: "already_applied" };
        abortApplied = true;
        controller.abort(command.reason);
        return { commandId: command.commandId, status: "accepted" };
      },
      finished,
    };
  }
}

export function createAgentHarness(options: AgentHarnessOptions): AgentHarness {
  return new DefaultAgentHarness(options);
}
