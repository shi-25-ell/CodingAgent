import type { ModelDescriptor, ModelProvider, ProviderId } from "../../api/contracts.js";
import type { CredentialRequest, CredentialResolver } from "../../auth/contracts.js";

export interface AnthropicProfile {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly baseUrl: URL;
  readonly auth: CredentialRequest;
  readonly version: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
}

export interface AnthropicTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface AnthropicTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<string>;
}

export interface AnthropicTransport {
  send(request: AnthropicTransportRequest): Promise<AnthropicTransportResponse>;
}

export interface AnthropicProviderOptions {
  readonly profile: AnthropicProfile;
  readonly credentials: CredentialResolver;
  readonly models: readonly ModelDescriptor[];
  readonly transport?: AnthropicTransport;
}

export type AnthropicProvider = ModelProvider;
