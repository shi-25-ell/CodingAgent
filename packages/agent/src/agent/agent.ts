import {
  collectModelTurn,
  type Model,
  type ModelFailure,
  type ModelResponse,
} from "@coding-agent/model";
import type { ContextPrepareInput, PreparedContext } from "../context/contracts.js";
import type { RunId } from "../contracts/primitives.js";
import { ReplayEventStream } from "../events/replay-event-stream.js";
import {
  type AgentEvent,
  type AgentProgressEvent,
  type AgentRunResult,
  type AgentSemanticEvent,
  addUsage,
  emptyUsageSummary,
  type RunCounts,
  type RunPolicies,
  type UsageSummary,
} from "../runtime/contracts.js";
import type { ToolExecutor } from "../tools/contracts.js";

export interface AgentHost {
  prepareContext(
    input: Pick<ContextPrepareInput, "runId" | "modelAttemptCount">,
  ): Promise<PreparedContext>;
  commit(event: AgentSemanticEvent): Promise<void>;
  reportProgress(event: AgentProgressEvent): void;
}

export interface AgentRunInput {
  readonly runId: RunId;
  readonly model: Model;
  readonly tools: ToolExecutor;
  readonly policies: RunPolicies;
  readonly signal: AbortSignal;
}

export interface AgentExecution {
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentRunResult>;
}

export interface Agent {
  run(input: AgentRunInput, host: AgentHost): AgentExecution;
}

function initialCounts(): RunCounts {
  return {
    modelTurnCount: 0,
    modelAttemptCount: 0,
    contextDerivationCount: 0,
    toolCallCount: 0,
    settledToolCallCount: 0,
  };
}

function finalText(response: ModelResponse): string | undefined {
  const text = response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

function modelError(failure: ModelFailure): { readonly code: string; readonly message: string } {
  return { code: `MODEL_${failure.category.toUpperCase()}`, message: failure.message };
}

function aborted(counts: RunCounts, usage: UsageSummary): AgentRunResult {
  return {
    status: "aborted",
    terminationReason: "user_abort",
    counts,
    usage,
    unfinishedWork: ["Run 在完成前被取消"],
  };
}

type DependencyKind = "context" | "persistence" | "policy";

class AgentDependencyFailure extends Error {
  readonly kind: DependencyKind;

  constructor(kind: DependencyKind) {
    super(`${kind} dependency failed`);
    this.name = "AgentDependencyFailure";
    this.kind = kind;
  }
}

async function callDependency<T>(kind: DependencyKind, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (_error) {
    throw new AgentDependencyFailure(kind);
  }
}

function dependencyFailure(
  failure: AgentDependencyFailure,
  counts: RunCounts,
  usage: UsageSummary,
): AgentRunResult {
  const detail = {
    context: {
      terminationReason: "context_unavailable" as const,
      code: "CONTEXT_UNAVAILABLE",
      message: "Model Context unavailable",
    },
    persistence: {
      terminationReason: "persistence_failure" as const,
      code: "SESSION_COMMIT_FAILURE",
      message: "Session commit failed",
    },
    policy: {
      terminationReason: "policy_failure" as const,
      code: "RUN_POLICY_FAILURE",
      message: "Run policy failed",
    },
  }[failure.kind];
  return {
    status: "failed",
    terminationReason: detail.terminationReason,
    counts,
    usage,
    unfinishedWork: ["Agent dependency 未能完成当前 Run"],
    error: { code: detail.code, message: detail.message },
  };
}

class DefaultAgent implements Agent {
  run(input: AgentRunInput, host: AgentHost): AgentExecution {
    const stream = new ReplayEventStream<AgentEvent>();
    const publish = (event: AgentProgressEvent): void => {
      stream.publish(event);
      host.reportProgress(event);
    };
    const result = this.#execute(input, host, publish).finally(() => stream.close());
    return { events: stream.events(), result };
  }

  async #execute(
    input: AgentRunInput,
    host: AgentHost,
    publish: (event: AgentProgressEvent) => void,
  ): Promise<AgentRunResult> {
    let counts = initialCounts();
    let usage = emptyUsageSummary();
    if (input.signal.aborted) return aborted(counts, usage);
    try {
      counts = { ...counts, modelTurnCount: 1 };
      let retriesInTurn = 0;

      while (true) {
        if (input.signal.aborted) return aborted(counts, usage);
        if (counts.modelAttemptCount >= input.policies.budgets.maxModelAttempts) {
          return {
            status: "limited",
            terminationReason: "model_attempt_limit",
            counts,
            usage,
            unfinishedWork: ["Model Attempt 达到 Run 上限"],
          };
        }

        const nextAttemptCount = counts.modelAttemptCount + 1;
        publish({ version: 1, type: "phase_changed", phase: "preparing_context" });
        const prepared = await callDependency("context", () =>
          host.prepareContext({
            runId: input.runId,
            modelAttemptCount: nextAttemptCount,
          }),
        );
        if (input.signal.aborted) return aborted(counts, usage);
        counts = { ...counts, modelAttemptCount: nextAttemptCount };
        publish({
          version: 1,
          type: "model_attempt_started",
          modelTurnCount: counts.modelTurnCount,
          modelAttemptCount: counts.modelAttemptCount,
        });
        publish({ version: 1, type: "phase_changed", phase: "model_streaming" });
        const turn = await collectModelTurn(
          input.model.stream(prepared.request, { signal: input.signal }),
        );

        if (
          input.signal.aborted ||
          (turn.status === "failed" && turn.failure.category === "cancelled")
        ) {
          return aborted(counts, usage);
        }

        if (turn.status === "failed") {
          const decision = await callDependency("policy", () =>
            input.policies.retryPolicy.decide({
              failure: turn.failure,
              modelTurnCount: counts.modelTurnCount,
              modelAttemptCount: counts.modelAttemptCount,
              retriesInTurn,
            }),
          );
          if (input.signal.aborted) return aborted(counts, usage);
          if (decision.action === "retry") {
            retriesInTurn += 1;
            continue;
          }
          await callDependency("persistence", () =>
            host.commit({ version: 1, type: "model_failure", failure: turn.failure }),
          );
          if (input.signal.aborted) return aborted(counts, usage);
          return {
            status: "failed",
            terminationReason:
              turn.failure.category === "invalid_response" ||
              turn.failure.category === "adapter_bug"
                ? "invalid_model_response"
                : "model_failure",
            counts,
            usage,
            unfinishedWork: ["模型未产生可提交的最终回答"],
            error: modelError(turn.failure),
          };
        }

        usage = addUsage(usage, turn.response.usage);
        if (turn.response.content.some((part) => part.type === "tool_call")) {
          const failure: ModelFailure = {
            category: "invalid_response",
            retryable: false,
            message: "未声明工具的 Model Turn 返回了 tool call",
          };
          await callDependency("persistence", () =>
            host.commit({ version: 1, type: "model_failure", failure }),
          );
          if (input.signal.aborted) return aborted(counts, usage);
          return {
            status: "failed",
            terminationReason: "invalid_model_response",
            counts,
            usage,
            unfinishedWork: ["工具调用未执行"],
            error: modelError(failure),
          };
        }

        publish({ version: 1, type: "phase_changed", phase: "assistant_committing" });
        await callDependency("persistence", () =>
          host.commit({ version: 1, type: "assistant_message", response: turn.response }),
        );
        if (input.signal.aborted) return aborted(counts, usage);
        publish({ version: 1, type: "phase_changed", phase: "completion_candidate" });
        const stop = await callDependency("policy", () =>
          input.policies.stopPolicy.evaluate({ response: turn.response, counts }),
        );
        if (input.signal.aborted) return aborted(counts, usage);
        if (stop.action === "limited") {
          const answer = finalText(turn.response);
          return {
            status: "limited",
            terminationReason: stop.reason,
            ...(answer ? { finalAnswer: answer } : {}),
            counts,
            usage,
            unfinishedWork: ["模型输出达到上限，回答可能不完整"],
          };
        }
        const answer = finalText(turn.response);
        return {
          status: "completed",
          terminationReason: "natural_completion",
          ...(answer ? { finalAnswer: answer } : {}),
          counts,
          usage,
          unfinishedWork: [],
        };
      }
    } catch (error) {
      if (input.signal.aborted) return aborted(counts, usage);
      if (error instanceof AgentDependencyFailure) return dependencyFailure(error, counts, usage);
      throw error;
    }
  }
}

export function createAgent(): Agent {
  return new DefaultAgent();
}
