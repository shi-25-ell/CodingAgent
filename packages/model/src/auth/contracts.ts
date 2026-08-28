declare const credentialRefBrand: unique symbol;

export type CredentialRef = string & { readonly [credentialRefBrand]: true };

export function credentialRef(value: string): CredentialRef {
  if (value.trim().length === 0) throw new TypeError("CredentialRef 不能为空");
  return value as CredentialRef;
}

export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0) throw new TypeError("SecretString 不能为空");
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }
}

export interface CredentialRequest {
  readonly ref: CredentialRef;
  readonly kind: "api_key" | "bearer";
}

export type Credential =
  | { readonly kind: "api_key"; readonly value: SecretString }
  | { readonly kind: "bearer"; readonly value: SecretString; readonly expiresAt?: number };

export interface AuthFailure {
  readonly category: "failed" | "cancelled";
  readonly message: string;
}

export type CredentialResolution =
  | { readonly status: "found"; readonly credential: Credential; readonly sourceId: string }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly failure: AuthFailure };

export interface CredentialSource {
  readonly id: string;
  resolve(
    request: CredentialRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CredentialResolution>;
}

export interface CredentialResolver {
  resolve(
    request: CredentialRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CredentialResolution>;
}
