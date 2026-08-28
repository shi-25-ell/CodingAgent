import type {
  AssistantContentPart,
  Model,
  ModelCallOptions,
  ModelDescriptor,
  ModelEvent,
  ModelRequest,
  ModelResponse,
  ModelTurnResult,
} from "../api/contracts.js";
import { modelId, providerId } from "../api/contracts.js";

export type ScriptedModelErrorCode =
  | "SCRIPT_EXHAUSTED"
  | "SCRIPT_STEPS_REMAIN"
  | "SCRIPT_REQUEST_REJECTED";

export class ScriptedModelError extends Error {
  readonly code: ScriptedModelErrorCode;

  constructor(code: ScriptedModelErrorCode, message: string) {
    super(message);
    this.name = "ScriptedModelError";
    this.code = code;
  }
}

export interface ScriptedModelStep {
  readonly outcome: ModelTurnResult;
  readonly assertRequest?: (request: Readonly<ModelRequest>) => void;
  readonly before?: (signal: AbortSignal) => Promise<void>;
}

const descriptor: ModelDescriptor = {
  providerId: providerId("scripted"),
  modelId: modelId("deterministic"),
  displayName: "Deterministic Scripted Model",
  capabilities: {
    toolCalls: "multiple",
    toolChoice: ["auto", "none", "required", "specific"],
    reasoning: true,
    reasoningReplay: true,
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
  },
  source: { kind: "testing", id: "scripted-model", revision: "1" },
};

function partEvents(content: readonly AssistantContentPart[]): readonly ModelEvent[] {
  const events: ModelEvent[] = [];
  content.forEach((part, index) => {
    if (part.type === "text" || part.type === "reasoning") {
      events.push({ type: "part_started", index, part: { type: part.type } });
      events.push(
        part.type === "text"
          ? { type: "text_delta", index, delta: part.text }
          : { type: "reasoning_delta", index, delta: part.text },
      );
    } else {
      events.push({
        type: "part_started",
        index,
        part: { type: "tool_call", callId: part.callId, name: part.name },
      });
      events.push({
        type: "tool_call_delta",
        index,
        delta: { argumentsDelta: JSON.stringify(part.arguments) },
      });
    }
    events.push({ type: "part_completed", index });
  });
  return events;
}

function outcomeEvents(outcome: ModelTurnResult, attemptId: string): readonly ModelEvent[] {
  if (outcome.status === "failed") {
    return [
      { type: "turn_started", attemptId },
      { type: "turn_failed", failure: outcome.failure },
    ];
  }
  return [
    { type: "turn_started", attemptId },
    ...partEvents(outcome.response.content),
    { type: "turn_completed", response: outcome.response },
  ];
}

export class ScriptedModel implements Model {
  readonly descriptor = descriptor;
  readonly capabilities = descriptor.capabilities;
  readonly #steps: ScriptedModelStep[];
  readonly #requests: ModelRequest[] = [];

  constructor(steps: readonly ScriptedModelStep[]) {
    this.#steps = [...steps];
  }

  async *stream(request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelEvent> {
    const step = this.#steps.shift();
    if (!step) {
      throw new ScriptedModelError(
        "SCRIPT_EXHAUSTED",
        "ScriptedModel 收到超出脚本的 Model Attempt",
      );
    }
    this.#requests.push(structuredClone(request));
    try {
      step.assertRequest?.(request);
    } catch (error) {
      throw new ScriptedModelError(
        "SCRIPT_REQUEST_REJECTED",
        error instanceof Error ? error.message : "request assertion 失败",
      );
    }
    await step.before?.(options.signal);
    if (options.signal.aborted) {
      yield { type: "turn_started", attemptId: `scripted-${this.#requests.length}` };
      yield {
        type: "turn_failed",
        failure: { category: "cancelled", retryable: false, message: "Model Attempt 已取消" },
      };
      return;
    }
    yield* outcomeEvents(step.outcome, `scripted-${this.#requests.length}`);
  }

  requests(): readonly ModelRequest[] {
    return structuredClone(this.#requests);
  }

  assertConsumed(): void {
    if (this.#steps.length > 0) {
      throw new ScriptedModelError(
        "SCRIPT_STEPS_REMAIN",
        `ScriptedModel 仍有 ${this.#steps.length} 个未消费 step`,
      );
    }
  }
}

export function scriptedTextResponse(text: string, usage?: ModelResponse["usage"]): ModelResponse {
  return {
    version: 1,
    content: [{ type: "text", text }],
    finishReason: "stop",
    ...(usage ? { usage } : {}),
  };
}
