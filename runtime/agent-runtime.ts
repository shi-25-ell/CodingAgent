import type {
  AssistantMessage,
  ModelFailure,
  ModelMessage,
  ModelUsage,
} from "../model/protocol.js";
import {
  ModelProtocolError,
  ModelTurnAccumulator,
  type ModelTurnResult,
} from "../model/turn-accumulator.js";
import type {
  AgentRuntimePort,
  RunPhase,
  RuntimeCounts,
  RuntimeEvent,
  RuntimeExecution,
  RuntimeHost,
  RuntimeInput,
  RuntimeOutcome,
  RuntimeReason,
  RuntimeSemanticEvent,
  RuntimeStatus,
} from "./runtime.js";

interface MutableCounts {
  modelTurns: number;
  modelAttempts: number;
  toolCalls: number;
  completedToolCalls: number;
}

interface ExecutionState {
  phase: RunPhase;
  readonly counts: MutableCounts;
  retries: number;
  usage: ModelUsage;
  finalAnswer: string | undefined;
}

export class AgentRuntime implements AgentRuntimePort {
  public run(input: RuntimeInput, host: RuntimeHost): RuntimeExecution {
    const events = new RuntimeEventStream();
    const state: ExecutionState = {
      phase: "starting",
      counts: { modelTurns: 0, modelAttempts: 0, toolCalls: 0, completedToolCalls: 0 },
      retries: 0,
      usage: {},
      finalAnswer: undefined,
    };
    const completion = this.execute(input, host, events, state)
      .catch((error: unknown) => recoverUnexpectedFailure(host, events, state, error))
      .finally(() => events.close());
    return { events, completion };
  }

  private async execute(
    input: RuntimeInput,
    host: RuntimeHost,
    events: RuntimeEventStream,
    state: ExecutionState,
  ): Promise<RuntimeOutcome> {
    await recordAndEmit(host, events, { type: "phase_changed", phase: "starting" });

    if (input.signal.aborted) {
      return finish(host, events, state, "aborted", "user_abort");
    }

    const messages = [...input.messages];
    while (true) {
      await transition(state, "preparing_turn", host, events);
      if (input.signal.aborted) {
        return finish(host, events, state, "aborted", "user_abort");
      }
      state.counts.modelTurns += 1;

      const turnResult = await this.runModelTurn(input, messages, state, host, events);
      if (turnResult.type === "terminal") {
        return finish(
          host,
          events,
          state,
          turnResult.status,
          turnResult.reason,
          turnResult.errorSummary,
        );
      }

      await transition(state, "assistant_committing", host, events);
      await recordAndEmit(host, events, {
        type: "assistant_committed",
        message: turnResult.message,
        usage: turnResult.usage,
        invalidToolCalls: turnResult.invalidToolCalls,
      });
      messages.push(turnResult.message);
      state.usage = addUsage(state.usage, turnResult.usage);
      state.finalAnswer = finalText(turnResult.message);
      const toolCalls = turnResult.message.content.filter((part) => part.type === "tool_call");
      state.counts.toolCalls += toolCalls.length;

      if (turnResult.invalidToolCalls.length > 0 || toolCalls.length > 0) {
        return finish(
          host,
          events,
          state,
          "failed",
          "invalid_output",
          "M0 does not execute tool calls",
        );
      }

      await transition(state, "safe_point", host, events);
      const stop = input.stopPolicy.evaluate({ counts: snapshotCounts(state.counts) });
      if (stop.stop) {
        return finish(
          host,
          events,
          state,
          stop.status,
          stop.reason,
          undefined,
          stop.unfinishedWork,
        );
      }
      if (input.signal.aborted) {
        return finish(host, events, state, "aborted", "user_abort");
      }

      const steering = await host.drainSteering();
      if (steering.length > 0) {
        messages.push(
          ...steering.map((item) => ({ role: "user" as const, content: item.content })),
        );
        continue;
      }

      await transition(state, "completion_candidate", host, events);
      const followUp = await host.takeFollowUp();
      if (followUp !== undefined) {
        messages.push({ role: "user", content: followUp.content });
        continue;
      }
      return finish(host, events, state, "completed", "no_tool_calls");
    }
  }

  private async runModelTurn(
    input: RuntimeInput,
    messages: readonly ModelMessage[],
    state: ExecutionState,
    host: RuntimeHost,
    events: RuntimeEventStream,
  ): Promise<
    | {
        readonly type: "completed";
        readonly message: AssistantMessage;
        readonly usage: ModelUsage;
        readonly invalidToolCalls: readonly import("../model/turn-accumulator.js").InvalidToolCall[];
      }
    | {
        readonly type: "terminal";
        readonly status: RuntimeStatus;
        readonly reason: RuntimeReason;
        readonly errorSummary?: string;
      }
  > {
    let attempt = 0;
    while (true) {
      if (input.signal.aborted) {
        return { type: "terminal", status: "aborted", reason: "user_abort" };
      }
      attempt += 1;
      state.counts.modelAttempts += 1;
      await recordAndEmit(host, events, { type: "model_attempt_started", attempt });
      await transition(state, "model_streaming", host, events);

      const accumulator = new ModelTurnAccumulator();
      let iteratorFailure: ModelFailure | undefined;
      try {
        const definitions = input.tools.definitions();
        for await (const event of input.model.stream(
          {
            instructions: input.instructions,
            messages,
            tools: definitions,
            toolChoice: definitions.length === 0 ? "none" : "auto",
          },
          { signal: input.signal },
        )) {
          accumulator.accept(event);
          if (event.type === "text_delta" || event.type === "reasoning_delta") {
            events.push(event);
          }
        }
      } catch (error) {
        iteratorFailure = {
          category: error instanceof ModelProtocolError ? "provider_protocol" : "adapter_bug",
          retryable: false,
          message: redactError(error),
        };
      }

      if (input.signal.aborted) {
        return { type: "terminal", status: "aborted", reason: "user_abort" };
      }
      if (iteratorFailure !== undefined) {
        await recordAndEmit(host, events, {
          type: "model_attempt_failed",
          attempt,
          failure: iteratorFailure,
          ...(accumulator.diagnosticRequestId === undefined
            ? {}
            : { requestId: accumulator.diagnosticRequestId }),
        });
        return {
          type: "terminal",
          status: "failed",
          reason: "stream_truncated",
          errorSummary: iteratorFailure.message,
        };
      }

      let result: ModelTurnResult;
      try {
        result = accumulator.result();
      } catch (error) {
        const failure: ModelFailure = {
          category: "provider_protocol",
          retryable: false,
          message: redactError(error),
        };
        await recordAndEmit(host, events, {
          type: "model_attempt_failed",
          attempt,
          failure,
          ...(accumulator.diagnosticRequestId === undefined
            ? {}
            : { requestId: accumulator.diagnosticRequestId }),
        });
        return {
          type: "terminal",
          status: "failed",
          reason: "stream_truncated",
          errorSummary: failure.message,
        };
      }
      if (result.type === "completed") {
        return result;
      }

      await recordAndEmit(host, events, {
        type: "model_attempt_failed",
        attempt,
        failure: result.failure,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      });
      if (result.failure.category === "cancelled") {
        return { type: "terminal", status: "aborted", reason: "user_abort" };
      }
      const retry = input.retryPolicy.decide({ attempt, failure: result.failure });
      if (!retry.retry) {
        return {
          type: "terminal",
          status: "failed",
          reason: "model_error",
          errorSummary: result.failure.message,
        };
      }
      state.retries += 1;
      await recordAndEmit(host, events, {
        type: "model_retry_scheduled",
        delayMs: retry.delayMs,
      });
      try {
        await input.clock.sleep(retry.delayMs, input.signal);
      } catch {
        if (input.signal.aborted) {
          return { type: "terminal", status: "aborted", reason: "user_abort" };
        }
        throw new Error("retry clock failed");
      }
    }
  }
}

async function transition(
  state: ExecutionState,
  phase: RunPhase,
  host: RuntimeHost,
  events: RuntimeEventStream,
): Promise<void> {
  if (state.phase === phase) {
    return;
  }
  state.phase = phase;
  await recordAndEmit(host, events, { type: "phase_changed", phase });
}

async function finish(
  host: RuntimeHost,
  events: RuntimeEventStream,
  state: ExecutionState,
  status: RuntimeStatus,
  reason: RuntimeReason,
  errorSummary?: string,
  unfinishedWork: readonly string[] = [],
): Promise<RuntimeOutcome> {
  await recordAndEmit(host, events, {
    type: "terminal",
    status,
    reason,
    lastPhase: state.phase,
  });
  return {
    status,
    reason,
    counts: snapshotCounts(state.counts),
    retries: state.retries,
    usage: state.usage,
    unfinishedWork,
    lastPhase: state.phase,
    ...(state.finalAnswer === undefined ? {} : { finalAnswer: state.finalAnswer }),
    ...(errorSummary === undefined ? {} : { errorSummary }),
  };
}

async function recordAndEmit(
  host: RuntimeHost,
  events: RuntimeEventStream,
  event: RuntimeSemanticEvent,
): Promise<void> {
  try {
    await host.record(event);
  } catch (error) {
    throw new RuntimePersistenceError(redactError(error));
  }
  events.push(event);
}

async function recoverUnexpectedFailure(
  host: RuntimeHost,
  events: RuntimeEventStream,
  state: ExecutionState,
  error: unknown,
): Promise<RuntimeOutcome> {
  const reason: RuntimeReason =
    error instanceof RuntimePersistenceError ? "persistence_error" : "runtime_invariant";
  const terminal: RuntimeSemanticEvent = {
    type: "terminal",
    status: "failed",
    reason,
    lastPhase: state.phase,
  };
  try {
    await host.record(terminal);
  } catch {
    // The public outcome must still settle; durable recovery owns a persistently unavailable Ledger.
  }
  events.push(terminal);
  return {
    status: "failed",
    reason,
    counts: snapshotCounts(state.counts),
    retries: state.retries,
    usage: state.usage,
    unfinishedWork: ["Run stopped before all work could be completed"],
    errorSummary: redactError(error),
    lastPhase: state.phase,
    ...(state.finalAnswer === undefined ? {} : { finalAnswer: state.finalAnswer }),
  };
}

class RuntimePersistenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RuntimePersistenceError";
  }
}

function snapshotCounts(counts: MutableCounts): RuntimeCounts {
  return { ...counts };
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  const inputTokens = addOptional(left.inputTokens, right.inputTokens);
  const outputTokens = addOptional(left.outputTokens, right.outputTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function addOptional(left?: number, right?: number): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function finalText(message: AssistantMessage): string | undefined {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  return text.length === 0 ? undefined : text;
}

function redactError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown model adapter failure";
}

class RuntimeEventStream implements AsyncIterable<RuntimeEvent> {
  private readonly values: RuntimeEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<RuntimeEvent>) => void> = [];
  private closed = false;
  private consumed = false;

  public push(event: RuntimeEvent): void {
    if (this.closed) {
      throw new Error("cannot publish to a closed Runtime event stream");
    }
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(event);
    } else {
      waiter({ done: false, value: event });
    }
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    if (this.consumed) {
      throw new Error("Runtime events support exactly one consumer");
    }
    this.consumed = true;
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return { done: false, value };
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<RuntimeEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
