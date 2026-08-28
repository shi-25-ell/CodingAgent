import type { JsonObject, ModelToolDefinition, ToolCall } from "@coding-agent/model";
import type { RunId } from "../contracts/primitives.js";

export type ToolDefinition = ModelToolDefinition;

export interface ArtifactRef {
  readonly id: string;
}

export interface ArtifactWriteInput {
  readonly bytes: Uint8Array;
  readonly mediaType: "text/plain" | "application/json";
  readonly provenance: string;
}

export interface ArtifactMetadata extends ArtifactRef {
  readonly byteLength: number;
  readonly mediaType: ArtifactWriteInput["mediaType"];
  readonly provenance: string;
}

export interface ArtifactIntegrity {
  readonly status: "verified" | "missing" | "corrupt";
}

export interface ArtifactReadOptions {
  readonly signal?: AbortSignal;
}

export interface ArtifactStore extends AsyncDisposable {
  put(input: ArtifactWriteInput, options?: { readonly signal?: AbortSignal }): Promise<ArtifactRef>;
  stat(ref: ArtifactRef): Promise<ArtifactMetadata>;
  read(ref: ArtifactRef, options?: ArtifactReadOptions): AsyncIterable<Uint8Array>;
  verify(ref: ArtifactRef): Promise<ArtifactIntegrity>;
}

export interface ToolExecutionContext {
  readonly runId: RunId;
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
  readonly artifacts: readonly ArtifactRef[];
  readonly infrastructureFailure?: {
    readonly code: string;
    readonly message: string;
  };
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
