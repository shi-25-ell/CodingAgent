import type { PermissionMode } from "../tools/coding-tool-host.js";

export const cliExitCode = Object.freeze({
  success: 0,
  productFailure: 1,
  usage: 2,
  unavailable: 3,
  refused: 4,
  runtime: 5,
  interrupted: 130,
});

export interface CliRunOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly permissionMode?: PermissionMode;
  readonly maxModelTurns?: number;
  readonly maxModelAttempts?: number;
  readonly maxRetries?: number;
  readonly tools?: readonly string[];
  readonly extensions?: readonly string[];
  readonly skills?: readonly string[];
  readonly structured: boolean;
}

export type CliCommand =
  | { readonly type: "help" }
  | { readonly type: "version" }
  | { readonly type: "runtime_diagnostic" }
  | { readonly type: "doctor"; readonly structured: boolean }
  | {
      readonly type: "interactive";
      readonly sessionId?: string;
      readonly overrides: CliRunOverrides;
    }
  | { readonly type: "print"; readonly task?: string; readonly overrides: CliRunOverrides }
  | { readonly type: "session_list"; readonly structured: boolean }
  | { readonly type: "session_new"; readonly overrides: CliRunOverrides }
  | {
      readonly type: "session_resume";
      readonly sessionId: string;
      readonly overrides: CliRunOverrides;
    }
  | {
      readonly type: "session_branch";
      readonly sessionId: string;
      readonly fromBranchId?: string;
      readonly overrides: CliRunOverrides;
    }
  | { readonly type: "models_list"; readonly structured: boolean }
  | { readonly type: "skills_list"; readonly structured: boolean }
  | { readonly type: "extensions_list" | "extensions_diagnose"; readonly structured: boolean };

export class CliUsageError extends Error {
  readonly code = "CLI_USAGE";

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
