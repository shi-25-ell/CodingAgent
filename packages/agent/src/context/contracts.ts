import type { InstructionPart, ModelRequest, ModelToolDefinition } from "@coding-agent/model";
import type { RunId } from "../contracts/primitives.js";
import type { SessionBranchView } from "../session/contracts.js";

export interface ContextPrepareInput {
  readonly runId: RunId;
  readonly modelAttemptCount: number;
  readonly branch: SessionBranchView;
  readonly tools: readonly ModelToolDefinition[];
}

export interface ContextManifest {
  readonly version: 1;
  readonly id: string;
  readonly runId: RunId;
  readonly modelAttemptCount: number;
  readonly selectedRecordIds: readonly string[];
  readonly omitted: readonly { readonly source: string; readonly reason: string }[];
}

export interface TokenMeasurement {
  readonly method: "estimated_chars";
  readonly inputTokens: number;
  readonly outputReserve: number;
}

export interface PreparedContext {
  readonly request: ModelRequest;
  readonly manifest: ContextManifest;
  readonly measurement: TokenMeasurement;
}

export interface ContextManager {
  prepare(input: ContextPrepareInput): Promise<PreparedContext>;
}

export interface TranscriptContextManagerOptions {
  readonly instructions: readonly InstructionPart[];
  readonly maxOutputTokens: number;
}
