import type { ContextSource, ToolDefinition, ToolOutcome } from "@coding-agent/agent";
import type { JsonObject, ModelProvider } from "@coding-agent/model";
import type { CredentialSource } from "@coding-agent/model/auth";
import type { InteractionMode } from "../modes/registry.js";
import type { SkillSource } from "../skills/contracts.js";
import type { ToolEffect, ToolResource } from "../tools/coding-tool-host.js";

export const extensionApiVersion = "1.0.0";
export const extensionManifestFile = "coding-agent.extension.json";

export type ExtensionCapability =
  | "tool"
  | "command"
  | "mode"
  | "skill_source"
  | "context_source"
  | "model_provider"
  | "credential_source"
  | "observation_hook";

export interface ExtensionManifest {
  readonly schemaVersion: 1;
  readonly namespace: "coding-agent";
  readonly id: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly entry: string;
  readonly displayName?: string;
  readonly capabilities: readonly ExtensionCapability[];
}

export type ExtensionSourceKind = "built_in" | "user" | "project" | "explicit";

export interface ExtensionSource {
  readonly kind: ExtensionSourceKind;
  readonly path: string;
}

export interface ExtensionToolPlan {
  readonly resources: readonly ToolResource[];
  readonly effects: readonly ToolEffect[];
  readonly risks: readonly string[];
}

export interface ExtensionToolResult {
  readonly modelContent: string;
  readonly effectState?: ToolOutcome["effectState"];
  readonly evidence?: JsonObject;
}

export interface CodingToolContribution {
  readonly definition: ToolDefinition;
  plan(arguments_: Readonly<JsonObject>): ExtensionToolPlan;
  execute(input: {
    readonly arguments: Readonly<JsonObject>;
    readonly signal: AbortSignal;
  }): Promise<ExtensionToolResult>;
}

export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly kind: "slash" | "cli";
  readonly bindings?: readonly string[];
}

export interface CodingObservationHook {
  readonly id: string;
  readonly timeoutMs?: number;
  onEvent(event: Readonly<unknown>): Promise<void> | void;
}

export interface ExtensionRegistration {
  dispose(): void;
}

export interface ExtensionApi {
  registerTool(tool: CodingToolContribution): ExtensionRegistration;
  registerCommand(command: CommandContribution): ExtensionRegistration;
  registerMode(mode: InteractionMode): ExtensionRegistration;
  registerSkillSource(source: SkillSource): ExtensionRegistration;
  registerContextSource(source: ContextSource): ExtensionRegistration;
  registerModelProvider(provider: ModelProvider): ExtensionRegistration;
  registerCredentialSource(source: CredentialSource): ExtensionRegistration;
  observe(hook: CodingObservationHook): ExtensionRegistration;
}

export type ExtensionInitializer = (api: ExtensionApi) => void | Promise<void>;

export type ExtensionDiagnosticCode =
  | "EXTENSION_MANIFEST_INVALID"
  | "EXTENSION_INCOMPATIBLE"
  | "EXTENSION_DUPLICATE_ID"
  | "EXTENSION_NOT_ENABLED"
  | "EXTENSION_LOAD_FAILED"
  | "EXTENSION_CAPABILITY_MISMATCH"
  | "EXTENSION_REGISTRATION_CONFLICT"
  | "EXTENSION_REGISTRATION_ROLLED_BACK"
  | "EXTENSION_HOOK_TIMEOUT"
  | "EXTENSION_HOOK_FAILED";

export interface ExtensionDiagnostic {
  readonly code: ExtensionDiagnosticCode;
  readonly severity: "info" | "warning" | "error";
  readonly extensionId?: string;
  readonly source: ExtensionSource;
  readonly message: string;
}

export interface LoadedExtension {
  readonly manifest: ExtensionManifest;
  readonly source: ExtensionSource;
  readonly acceptedCapabilities: readonly ExtensionCapability[];
}

export interface ExtensionSnapshot {
  readonly extensions: readonly LoadedExtension[];
  readonly tools: readonly CodingToolContribution[];
  readonly commands: readonly CommandContribution[];
  readonly modes: readonly InteractionMode[];
  readonly skillSources: readonly SkillSource[];
  readonly contextSources: readonly ContextSource[];
  readonly modelProviders: readonly ModelProvider[];
  readonly credentialSources: readonly CredentialSource[];
  readonly hooks: readonly CodingObservationHook[];
}

export interface ExtensionHost extends AsyncDisposable {
  snapshot(): ExtensionSnapshot;
  diagnostics(): readonly ExtensionDiagnostic[];
  observe(event: Readonly<unknown>): Promise<void>;
  disable(id: string): Promise<boolean>;
}
