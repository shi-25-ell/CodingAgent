import { setTimeout as sleep } from "node:timers/promises";
import type { ModelAdapter, ModelEvent, ModelMessage, ModelRequest } from "./protocol.js";

interface ScriptClock {
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

interface ScriptGate {
  wait(signal: AbortSignal): Promise<void>;
}

export interface ExpectedModelRequest {
  readonly instructions?: string;
  readonly lastUserText?: string;
  readonly messageCount?: number;
  readonly toolChoice?: ModelRequest["toolChoice"];
}

export interface ScriptedEmission {
  readonly event: ModelEvent;
  readonly delayMs?: number;
  readonly gate?: ScriptGate;
}

export interface ScriptedModelStep {
  readonly expectedRequest?: ExpectedModelRequest;
  readonly emissions: readonly ScriptedEmission[];
}

export class ScriptInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ScriptInvariantError";
  }
}

export class ScriptedModelAdapter implements ModelAdapter {
  private nextStep = 0;
  private activeStreams = 0;

  public constructor(
    private readonly steps: readonly ScriptedModelStep[],
    private readonly clock: ScriptClock = new SystemScriptClock(),
  ) {}

  public async *stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelEvent> {
    const step = this.steps[this.nextStep];
    if (step === undefined) {
      throw new ScriptInvariantError(`unexpected Model Attempt ${this.nextStep + 1}`);
    }
    this.nextStep += 1;
    this.activeStreams += 1;

    try {
      assertRequest(request, step.expectedRequest);
      for (const emission of step.emissions) {
        if (options.signal.aborted) {
          yield cancelledEvent();
          return;
        }
        try {
          if (emission.gate !== undefined) {
            await emission.gate.wait(options.signal);
          }
          await this.clock.sleep(emission.delayMs ?? 0, options.signal);
        } catch (error) {
          if (options.signal.aborted || isAbortError(error)) {
            yield cancelledEvent();
            return;
          }
          throw error;
        }
        if (options.signal.aborted) {
          yield cancelledEvent();
          return;
        }
        yield emission.event;
      }
    } finally {
      this.activeStreams -= 1;
    }
  }

  public assertComplete(): void {
    const remaining = this.steps.length - this.nextStep;
    if (remaining !== 0 || this.activeStreams !== 0) {
      throw new ScriptInvariantError(
        `script incomplete: ${remaining} step(s) remain, ${this.activeStreams} stream(s) active`,
      );
    }
  }
}

class SystemScriptClock implements ScriptClock {
  public async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (delayMs === 0) {
      return;
    }
    await sleep(delayMs, undefined, { signal });
  }
}

function assertRequest(request: ModelRequest, expected?: ExpectedModelRequest): void {
  if (expected === undefined) {
    return;
  }
  if (expected.instructions !== undefined && request.instructions !== expected.instructions) {
    throw new ScriptInvariantError(
      `expected instructions ${JSON.stringify(expected.instructions)}`,
    );
  }
  if (expected.messageCount !== undefined && request.messages.length !== expected.messageCount) {
    throw new ScriptInvariantError(`expected ${expected.messageCount} message(s)`);
  }
  if (expected.toolChoice !== undefined && request.toolChoice !== expected.toolChoice) {
    throw new ScriptInvariantError(`expected toolChoice ${expected.toolChoice}`);
  }
  if (expected.lastUserText !== undefined) {
    const userMessage = findLastUserMessage(request.messages);
    if (userMessage?.content !== expected.lastUserText) {
      throw new ScriptInvariantError(
        `expected last user text ${JSON.stringify(expected.lastUserText)}, received ${JSON.stringify(userMessage?.content)}`,
      );
    }
  }
}

function findLastUserMessage(messages: readonly ModelMessage[]) {
  return messages.findLast((message) => message.role === "user");
}

function cancelledEvent(): ModelEvent {
  return {
    type: "turn_failed",
    failure: { category: "cancelled", retryable: false, message: "model attempt cancelled" },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
