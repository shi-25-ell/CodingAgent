import type {
  AssistantContentPart,
  JsonObject,
  ModelEvent,
  ModelResponse,
  ModelTurnResult,
  PartHeader,
} from "../api/contracts.js";

export type ModelProtocolErrorCode =
  | "MODEL_EVENT_AFTER_TERMINAL"
  | "MODEL_EVENT_BEFORE_START"
  | "MODEL_EVENT_DUPLICATE_START"
  | "MODEL_EVENT_INVALID_INDEX"
  | "MODEL_EVENT_DUPLICATE_PART"
  | "MODEL_EVENT_PART_NOT_ACTIVE"
  | "MODEL_EVENT_DELTA_TYPE_MISMATCH"
  | "MODEL_EVENT_INCOMPLETE_PARTS"
  | "MODEL_EVENT_RESPONSE_MISMATCH"
  | "MODEL_EVENT_NOT_TERMINAL"
  | "MODEL_TOOL_ARGUMENTS_INVALID";

export class ModelProtocolError extends Error {
  readonly code: ModelProtocolErrorCode;

  constructor(code: ModelProtocolErrorCode, message: string) {
    super(message);
    this.name = "ModelProtocolError";
    this.code = code;
  }
}

interface ActivePart {
  readonly header: PartHeader;
  text: string;
  completed: boolean;
  value?: AssistantContentPart;
}

function parseArguments(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new TypeError("tool arguments 必须是 JSON object");
    }
    return parsed as JsonObject;
  } catch (error) {
    throw new ModelProtocolError(
      "MODEL_TOOL_ARGUMENTS_INVALID",
      error instanceof Error ? error.message : "tool arguments 不是合法 JSON",
    );
  }
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ModelTurnAccumulator {
  readonly #parts = new Map<number, ActivePart>();
  #started = false;
  #terminal?: ModelTurnResult;
  #producedSemanticOutput = false;

  accept(event: ModelEvent): void {
    if (this.#terminal) {
      throw new ModelProtocolError("MODEL_EVENT_AFTER_TERMINAL", "terminal event 之后不得再有事件");
    }

    if (event.type === "turn_started") {
      if (this.#started) {
        throw new ModelProtocolError("MODEL_EVENT_DUPLICATE_START", "turn_started 必须恰好一次");
      }
      this.#started = true;
      return;
    }

    if (!this.#started) {
      throw new ModelProtocolError("MODEL_EVENT_BEFORE_START", "事件流必须以 turn_started 开始");
    }

    switch (event.type) {
      case "part_started": {
        if (!Number.isSafeInteger(event.index) || event.index < 0) {
          throw new ModelProtocolError(
            "MODEL_EVENT_INVALID_INDEX",
            "part index 必须是非负安全整数",
          );
        }
        if (this.#parts.has(event.index)) {
          throw new ModelProtocolError("MODEL_EVENT_DUPLICATE_PART", `part ${event.index} 已存在`);
        }
        this.#parts.set(event.index, { header: event.part, text: "", completed: false });
        return;
      }
      case "text_delta":
        this.#appendDelta(event.index, "text", event.delta);
        return;
      case "reasoning_delta":
        this.#appendDelta(event.index, "reasoning", event.delta);
        return;
      case "tool_call_delta":
        this.#appendDelta(event.index, "tool_call", event.delta.argumentsDelta);
        return;
      case "part_completed":
        this.#completePart(event.index);
        return;
      case "turn_completed":
        this.#completeTurn(event.response);
        return;
      case "turn_failed":
        this.#terminal = {
          status: "failed",
          failure: event.failure,
          ...(this.#producedSemanticOutput ? { producedSemanticOutput: true } : {}),
        };
        return;
    }
  }

  result(): ModelTurnResult {
    if (!this.#terminal) {
      throw new ModelProtocolError("MODEL_EVENT_NOT_TERMINAL", "事件流尚未到达 terminal");
    }
    return this.#terminal;
  }

  producedSemanticOutput(): boolean {
    return this.#producedSemanticOutput;
  }

  #activePart(index: number): ActivePart {
    const part = this.#parts.get(index);
    if (!part || part.completed) {
      throw new ModelProtocolError(
        "MODEL_EVENT_PART_NOT_ACTIVE",
        `part ${index} 尚未开始或已经完成`,
      );
    }
    return part;
  }

  #appendDelta(index: number, expected: PartHeader["type"], delta: string): void {
    const part = this.#activePart(index);
    if (part.header.type !== expected) {
      throw new ModelProtocolError(
        "MODEL_EVENT_DELTA_TYPE_MISMATCH",
        `${expected} delta 不能写入 ${part.header.type} part`,
      );
    }
    part.text += delta;
    if (delta.length > 0) this.#producedSemanticOutput = true;
  }

  #completePart(index: number): void {
    const part = this.#activePart(index);
    switch (part.header.type) {
      case "text":
        part.value = { type: "text", text: part.text };
        break;
      case "reasoning":
        part.value = { type: "reasoning", text: part.text };
        break;
      case "tool_call":
        part.value = {
          type: "tool_call",
          callId: part.header.callId,
          name: part.header.name,
          arguments: parseArguments(part.text),
        };
        break;
    }
    part.completed = true;
  }

  #completeTurn(response: ModelResponse): void {
    const ordered = [...this.#parts.entries()].sort(([left], [right]) => left - right);
    if (ordered.some(([, part]) => !part.completed || !part.value)) {
      throw new ModelProtocolError(
        "MODEL_EVENT_INCOMPLETE_PARTS",
        "turn_completed 前所有 parts 必须完成",
      );
    }
    const content = ordered.map(([, part]) => part.value as AssistantContentPart);
    if (!sameCanonicalValue(content, response.content)) {
      throw new ModelProtocolError(
        "MODEL_EVENT_RESPONSE_MISMATCH",
        "terminal response 与已归约的 parts 不一致",
      );
    }
    this.#terminal = { status: "completed", response };
  }
}

export async function collectModelTurn(
  events: AsyncIterable<ModelEvent>,
): Promise<ModelTurnResult> {
  const accumulator = new ModelTurnAccumulator();
  try {
    for await (const event of events) accumulator.accept(event);
    return accumulator.result();
  } catch (error) {
    return {
      status: "failed",
      failure: {
        category: error instanceof ModelProtocolError ? "invalid_response" : "adapter_bug",
        retryable: false,
        message: error instanceof Error ? error.message : "Model adapter 抛出未知错误",
      },
      ...(accumulator.producedSemanticOutput() ? { producedSemanticOutput: true } : {}),
    };
  }
}
