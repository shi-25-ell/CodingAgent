import type { ModelAdapter } from "../model/protocol.js";
import type { ToolPort } from "../runtime/tool-port.js";
import type { WorkspaceBaseline } from "../session/ledger.js";

export interface WorkspaceState extends WorkspaceBaseline {
  readonly isClean: boolean;
}

export interface WorkspaceInspector {
  inspect(workspacePath: string): Promise<WorkspaceState>;
}

export interface ModelAdapterFactory {
  create(input: {
    readonly providerProfile: string;
    readonly model: string;
  }): Promise<ModelAdapter>;
}

export interface ToolPortFactory {
  create(input: {
    readonly workspace: WorkspaceBaseline;
    readonly permissionMode: "safe" | "autonomous";
    readonly signal: AbortSignal;
  }): ToolPort;
}
