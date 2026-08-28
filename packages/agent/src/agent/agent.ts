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
  reportProgress(event: AgentEvent): void;
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

class DefaultAgent implements Agent {
  run(input: AgentRunInput, host: AgentHost): AgentExecution {
    const stream = new ReplayEventStream<AgentEvent>();
    const publish = (event: AgentEvent): void => {
      stream.publish(event);
      host.reportProgress(event);
    };
    const result = this.#execute(input, host, publish).finally(() => stream.close());
    return { events: stream.events(), result };
  }

  async #execute(
    input: AgentRunInput,
    host: AgentHost,
    publish: (event: AgentEvent) => void,
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

        counts = { ...counts, modelAttemptCount: counts.modelAttemptCount + 1 };
        publish({ type: "phase_changed", phase: "preparing_context" });
        const prepared = await host.prepareContext({
          runId: input.runId,
          modelAttemptCount: counts.modelAttemptCount,
        });
        publish({
          type: "model_attempt_started",
          modelTurnCount: counts.modelTurnCount,
          modelAttemptCount: counts.modelAttemptCount,
        });
        publish({ type: "phase_changed", phase: "model_streaming" });
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
          const decision = await input.policies.retryPolicy.decide({
            failure: turn.failure,
            modelTurnCount: counts.modelTurnCount,
            modelAttemptCount: counts.modelAttemptCount,
            retriesInTurn,
          });
          if (decision.action === "retry") {
            retriesInTurn += 1;
            continue;
          }
          await host.commit({ type: "model_failure", failure: turn.failure });
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
          await host.commit({ type: "model_failure", failure });
          return {
            status: "failed",
            terminationReason: "invalid_model_response",
            counts,
            usage,
            unfinishedWork: ["工具调用未执行"],
            error: modelError(failure),
          };
        }

        publish({ type: "phase_changed", phase: "assistant_committing" });
        await host.commit({ type: "assistant_message", response: turn.response });
        publish({ type: "phase_changed", phase: "completion_candidate" });
        const stop = await input.policies.stopPolicy.evaluate({ response: turn.response, counts });
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
    } catch (_error) {
      if (input.signal.aborted) return aborted(counts, usage);
      return {
        status: "failed",
        terminationReason: "persistence_failure",
        counts,
        usage,
        unfinishedWork: ["Agent dependency 未能完成当前 Run"],
        error: { code: "AGENT_DEPENDENCY_FAILURE", message: "Agent dependency failed" },
      };
    }
  }
}

export function createAgent(): Agent {
  return new DefaultAgent();
}
