import type { ModelDescriptor, ModelProvider, ProviderId } from "../../api/contracts.js";
import type { CredentialRequest, CredentialResolver } from "../../auth/contracts.js";

export interface OpenAiCompatibleProfile {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly baseUrl: URL;
  readonly auth: CredentialRequest;
  readonly requestDialect: {
    readonly instructionsRole: "developer" | "system";
    readonly maxTokensField: "max_completion_tokens" | "max_tokens";
    readonly reasoningReplayField?: string;
  };
  readonly responseDialect: {
    readonly reasoningDeltaField?: string;
    readonly terminalUsageRepeatsFinishReason?: boolean;
  };
  readonly defaultHeaders?: Readonly<Record<string, string>>;
}

export interface OpenAiTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface OpenAiTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<string>;
}

export interface OpenAiTransport {
  send(request: OpenAiTransportRequest): Promise<OpenAiTransportResponse>;
}

export interface OpenAiCompatibleProviderOptions {
  readonly profile: OpenAiCompatibleProfile;
  readonly credentials: CredentialResolver;
  readonly models: readonly ModelDescriptor[];
  readonly transport?: OpenAiTransport;
}

export type OpenAiCompatibleProvider = ModelProvider;
