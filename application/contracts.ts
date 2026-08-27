import type { RuntimeEvent } from "../runtime/runtime.js";
import type { SessionSummary, SessionView } from "../session/ledger.js";
import type { RunReport } from "../session/run-report.js";

export interface SessionFilter {
  readonly workspacePath?: string;
}

export type OpenSessionInput =
  | {
      readonly kind: "create";
      readonly workspacePath: string;
      readonly defaultProviderProfile: string;
      readonly defaultModel: string;
    }
  | { readonly kind: "resume"; readonly sessionId: string };

export interface StartRunInput {
  readonly task: string;
  readonly providerProfile?: string;
  readonly model?: string;
  readonly permissionMode: "safe" | "autonomous";
  readonly maximumModelTurns?: number;
  readonly maximumModelAttempts?: number;
}

export type RunCommand = { readonly type: "abort"; readonly commandId: string };

export interface CommandAck {
  readonly commandId: string;
  readonly accepted: boolean;
  readonly kind: "abort_requested" | "already_terminal";
}

export type FastEvent = {
  readonly sessionId: string;
  readonly runId: string;
  readonly sequence: number;
} & (RuntimeEvent | { readonly type: "run_finished"; readonly report: RunReport });

export interface FastController {
  listSessions(filter?: SessionFilter): Promise<readonly SessionSummary[]>;
  openSession(input: OpenSessionInput): Promise<FastSession>;
}

export interface FastSession {
  inspect(): Promise<SessionView>;
  startRun(input: StartRunInput): Promise<ActiveRun>;
}

export interface ActiveRun {
  readonly id: string;
  readonly events: AsyncIterable<FastEvent>;
  dispatch(command: RunCommand): Promise<CommandAck>;
  readonly finished: Promise<RunReport>;
}
