import type { ContextDerivationRecord } from "./contracts.js";

export type ContextErrorCode =
  | "CONTEXT_INVALID_CONFIGURATION"
  | "CONTEXT_SOURCE_FAILURE"
  | "CONTEXT_INVALID_CONTRIBUTION"
  | "CONTEXT_OVERFLOW"
  | "CONTEXT_COMPACTION_UNAVAILABLE"
  | "CONTEXT_COMPACTION_FAILED"
  | "CONTEXT_COMPACTION_ABORTED"
  | "CONTEXT_CHECKPOINT_CORRUPT";

export class ContextError extends Error {
  readonly code: ContextErrorCode;
  readonly derivations: readonly ContextDerivationRecord[];

  constructor(
    code: ContextErrorCode,
    message: string,
    options?: ErrorOptions & { readonly derivations?: readonly ContextDerivationRecord[] },
  ) {
    super(message, options);
    this.name = "ContextError";
    this.code = code;
    this.derivations = options?.derivations ?? [];
  }
}
