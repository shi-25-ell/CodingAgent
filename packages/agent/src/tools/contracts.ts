import type { JsonObject, ModelToolDefinition, ToolCall } from "@coding-agent/model";

export type ToolDefinition = ModelToolDefinition;

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
}

export interface ToolUpdate {
  readonly version: 1;
  readonly type: "progress";
  readonly message: string;
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
  readonly isError: boolean;
  readonly modelContent: string;
  readonly effectState: "none" | "committed" | "partial" | "unknown";
  readonly abortObserved: boolean;
  readonly artifacts: readonly { readonly id: string }[];
  readonly evidence?: JsonObject;
}

export interface ToolExecution {
  readonly updates: AsyncIterable<ToolUpdate>;
  readonly outcome: Promise<ToolOutcome>;
}

export interface ToolExecutor {
  definitions(): readonly ToolDefinition[];
  execute(call: ToolCall, context: ToolExecutionContext): ToolExecution;
}

async function* noUpdates(): AsyncIterable<ToolUpdate> {}

export function createDisabledToolExecutor(): ToolExecutor {
  return {
    definitions: () => [],
    execute(call, context) {
      return {
        updates: noUpdates(),
        outcome: Promise.resolve({
          callId: call.callId,
          status: context.signal.aborted ? "cancelled" : "rejected",
          isError: true,
          modelContent: "本次 Run 未启用工具",
          effectState: "none",
          abortObserved: context.signal.aborted,
          artifacts: [],
        }),
      };
    },
  };
}
