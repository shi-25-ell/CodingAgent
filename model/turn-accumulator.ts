import type {
  AssistantMessage,
  ModelEvent,
  ModelFailure,
  ModelUsage,
  ReasoningPart,
  TextPart,
  ToolCallPart,
} from "./protocol.js";

interface TextPartState {
  readonly type: "text";
  text: string;
  completed: boolean;
}

interface ReasoningPartState {
  readonly type: "reasoning";
  text: string;
  completed: boolean;
  replayToken?: string;
}

interface ToolCallPartState {
  readonly type: "tool_call";
  readonly callId: string;
  readonly name: string;
  rawArguments: string;
  completed: boolean;
}

type PartState = TextPartState | ReasoningPartState | ToolCallPartState;

export interface InvalidToolCall {
  readonly index: number;
  readonly callId: string;
  readonly name: string;
  readonly rawArguments: string;
  readonly reason: "invalid_json" | "arguments_not_object";
}

export type ModelTurnResult =
  | {
      readonly type: "completed";
      readonly message: AssistantMessage;
      readonly usage: ModelUsage;
      readonly requestId?: string;
      readonly invalidToolCalls: readonly InvalidToolCall[];
    }
  | {
      readonly type: "failed";
      readonly failure: ModelFailure;
      readonly requestId?: string;
    };

export class ModelProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModelProtocolError";
  }
}

export class ModelTurnAccumulator {
  private started = false;
  private requestId: string | undefined;
  private readonly parts = new Map<number, PartState>();
  private terminalResult: ModelTurnResult | undefined;

  public get diagnosticRequestId(): string | undefined {
    return this.requestId;
  }

  public accept(event: ModelEvent): void {
    if (this.terminalResult !== undefined) {
      throw new ModelProtocolError("received an event after the terminal model event");
    }

    if (event.type === "turn_started") {
      if (this.started) {
        throw new ModelProtocolError("turn_started must occur exactly once");
      }
      this.started = true;
      this.requestId = event.requestId;
      return;
    }

    this.requireStarted();

    switch (event.type) {
      case "part_started":
        this.startPart(event.index, event.part);
        return;
      case "text_delta":
        this.appendDelta(event.index, "text", event.delta);
        return;
      case "reasoning_delta":
        this.appendDelta(event.index, "reasoning", event.delta);
        return;
      case "tool_call_delta":
        this.appendDelta(event.index, "tool_call", event.delta);
        return;
      case "part_completed":
        this.completePart(event.index, event.replayToken);
        return;
      case "turn_completed":
        this.completeTurn(event.finishReason, event.usage);
        return;
      case "turn_failed":
        this.terminalResult = this.withRequestId({ type: "failed", failure: event.failure });
        return;
      default:
        event satisfies never;
    }
  }

  public result(): ModelTurnResult {
    if (this.terminalResult === undefined) {
      throw new ModelProtocolError("model stream ended without a terminal event");
    }
    return this.terminalResult;
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new ModelProtocolError("turn_started must be the first model event");
    }
  }

  private startPart(
    index: number,
    descriptor:
      | { readonly type: "text" }
      | { readonly type: "reasoning" }
      | { readonly type: "tool_call"; readonly callId: string; readonly name: string },
  ): void {
    if (!Number.isSafeInteger(index) || index < 0 || this.parts.has(index)) {
      throw new ModelProtocolError(`invalid or duplicate part index: ${index}`);
    }

    if (descriptor.type === "tool_call") {
      if (descriptor.callId.length === 0 || descriptor.name.length === 0) {
        throw new ModelProtocolError("tool call identity must not be empty");
      }
      this.parts.set(index, {
        type: "tool_call",
        callId: descriptor.callId,
        name: descriptor.name,
        rawArguments: "",
        completed: false,
      });
      return;
    }

    this.parts.set(index, { type: descriptor.type, text: "", completed: false });
  }

  private appendDelta(index: number, expected: PartState["type"], delta: string): void {
    const part = this.parts.get(index);
    if (part === undefined || part.type !== expected || part.completed) {
      throw new ModelProtocolError(
        `delta does not match an open ${expected} part at index ${index}`,
      );
    }

    if (part.type === "tool_call") {
      part.rawArguments += delta;
    } else {
      part.text += delta;
    }
  }

  private completePart(index: number, replayToken?: string): void {
    const part = this.parts.get(index);
    if (part === undefined || part.completed) {
      throw new ModelProtocolError(`cannot complete part at index ${index}`);
    }
    if (replayToken !== undefined && part.type !== "reasoning") {
      throw new ModelProtocolError("only reasoning parts can carry replay tokens");
    }
    if (part.type === "reasoning" && replayToken !== undefined) {
      part.replayToken = replayToken;
    }
    part.completed = true;
  }

  private completeTurn(finishReason: AssistantMessage["finishReason"], usage: ModelUsage): void {
    const ordered = [...this.parts.entries()].sort(([left], [right]) => left - right);
    if (ordered.some(([, part]) => !part.completed)) {
      throw new ModelProtocolError("turn_completed received while a content part is still open");
    }

    const content: (TextPart | ReasoningPart | ToolCallPart)[] = [];
    const invalidToolCalls: InvalidToolCall[] = [];
    for (const [index, part] of ordered) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning") {
        content.push(
          part.replayToken === undefined
            ? { type: "reasoning", text: part.text }
            : { type: "reasoning", text: part.text, replayToken: part.replayToken },
        );
      } else {
        const parsed = parseToolArguments(part.rawArguments);
        if (parsed.ok) {
          content.push({
            type: "tool_call",
            callId: part.callId,
            name: part.name,
            arguments: parsed.value,
            rawArguments: part.rawArguments,
          });
        } else {
          invalidToolCalls.push({
            index,
            callId: part.callId,
            name: part.name,
            rawArguments: part.rawArguments,
            reason: parsed.reason,
          });
        }
      }
    }

    const message: AssistantMessage = { role: "assistant", content, finishReason };
    this.terminalResult = this.withRequestId({
      type: "completed",
      message,
      usage,
      invalidToolCalls,
    });
  }

  private withRequestId<T extends { readonly type: "completed" | "failed" }>(
    result: T,
  ): T & { readonly requestId?: string } {
    return this.requestId === undefined ? result : { ...result, requestId: this.requestId };
  }
}

type ParsedToolArguments =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: InvalidToolCall["reason"] };

function parseToolArguments(raw: string): ParsedToolArguments {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "arguments_not_object" };
  }
  return { ok: true, value: value as Readonly<Record<string, unknown>> };
}
