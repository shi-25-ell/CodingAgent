export type RunStatus = "completed" | "aborted" | "failed" | "limited";

export type TerminationReason =
  | "no_tool_calls"
  | "user_abort"
  | "policy_limit"
  | "model_error"
  | "context_overflow"
  | "output_truncated"
  | "stream_truncated"
  | "invalid_output"
  | "tool_host_failure"
  | "persistence_error"
  | "runtime_invariant";

export type ReportedRunPhase =
  | "starting"
  | "preparing_turn"
  | "model_streaming"
  | "assistant_committing"
  | "tool_batch"
  | "safe_point"
  | "completion_candidate";

export interface RunReport {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly runId: string;
  readonly status: RunStatus;
  readonly terminationReason: TerminationReason;
  readonly configuration: {
    readonly providerProfile: string;
    readonly model: string;
    readonly permissionMode: "safe" | "autonomous";
    readonly maximumModelTurns: number;
    readonly maximumModelAttempts: number;
  };
  readonly finalAnswer?: string;
  readonly partialArtifactRef?: string;
  readonly counts: {
    readonly modelTurns: number;
    readonly modelAttempts: number;
    readonly toolCalls: number;
    readonly completedToolCalls: number;
    readonly contextDerivations: number;
  };
  readonly retrySummary: { readonly retries: number };
  readonly toolSummary: {
    readonly total: number;
    readonly succeeded: number;
    readonly errors: number;
  };
  readonly permissionSummary: {
    readonly requested: number;
    readonly allowed: number;
    readonly denied: number;
  };
  readonly usage: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly durationMs: number;
  readonly workspace: {
    readonly startingHead: string;
    readonly startingFingerprint: string;
    readonly ending:
      | {
          readonly state: "observed";
          readonly head: string;
          readonly fingerprint: string;
          readonly changedFiles: readonly string[];
        }
      | { readonly state: "unavailable"; readonly errorSummary: string };
  };
  readonly commands: readonly {
    readonly command: string;
    readonly cwd: string;
    readonly exitStatus: number | null;
    readonly outputArtifactDigest?: string;
  }[];
  readonly undelivered: { readonly steering: number; readonly followUps: number };
  readonly unfinishedWork: readonly string[];
  readonly errorSummary?: string;
  readonly lastPhase: ReportedRunPhase;
}
