import type { ToolCallPart, ToolDefinition } from "../model/protocol.js";

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
}

export interface ToolUpdate {
  readonly sequence: number;
  readonly content: string;
}

export interface ToolOutcome {
  readonly callId: string;
  readonly status:
    | "succeeded"
    | "rejected"
    | "denied"
    | "failed"
    | "timed_out"
    | "output_limit"
    | "cancelled"
    | "conflict";
  readonly effectState: "none" | "committed" | "partial" | "unknown";
  readonly abortObserved: boolean;
  readonly content: string;
  readonly isError: boolean;
}

export interface ToolExecution {
  readonly updates: AsyncIterable<ToolUpdate>;
  readonly outcome: Promise<ToolOutcome>;
}

export interface ToolPort {
  definitions(): readonly ToolDefinition[];
  execute(call: ToolCallPart, context: ToolExecutionContext): ToolExecution;
}

export class EmptyToolPort implements ToolPort {
  public definitions(): readonly ToolDefinition[] {
    return [];
  }

  public execute(call: ToolCallPart, _context: ToolExecutionContext): ToolExecution {
    return {
      updates: emptyUpdates(),
      outcome: Promise.resolve({
        callId: call.callId,
        status: "rejected",
        effectState: "none",
        abortObserved: false,
        content: "error_code: unknown_tool\nmessage: no tools are available in this Run",
        isError: true,
      }),
    };
  }
}

async function* emptyUpdates(): AsyncIterable<ToolUpdate> {
  // M0 deliberately has no executable tools.
}
