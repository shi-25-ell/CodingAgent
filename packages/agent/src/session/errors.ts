export type SessionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_ACTIVE_RUN"
  | "SESSION_REVISION_CONFLICT"
  | "SESSION_BRANCH_NOT_FOUND"
  | "SESSION_DISPOSED"
  | "SESSION_LEASE_LOST"
  | "SESSION_TERMINAL_CONFLICT";

export class SessionError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionError";
    this.code = code;
  }
}
