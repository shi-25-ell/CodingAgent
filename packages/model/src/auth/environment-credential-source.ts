import { type CredentialSource, SecretString } from "./contracts.js";

export interface EnvironmentCredentialSourceOptions {
  readonly id: string;
  readonly values?: Readonly<Record<string, string | undefined>>;
  readonly variables: Readonly<Record<string, string>>;
}

export function createEnvironmentCredentialSource(
  options: EnvironmentCredentialSourceOptions,
): CredentialSource {
  if (options.id.trim().length === 0) throw new TypeError("CredentialSource id 不能为空");
  return {
    id: options.id,
    async resolve(request, resolveOptions) {
      if (resolveOptions?.signal?.aborted) {
        return {
          status: "failed",
          failure: { category: "cancelled", message: "Credential resolution 已取消" },
        };
      }
      const variable = options.variables[request.ref];
      if (!variable) return { status: "missing" };
      const value = (options.values ?? process.env)[variable];
      if (!value) return { status: "missing" };
      return {
        status: "found",
        credential: { kind: request.kind, value: new SecretString(value) },
        sourceId: options.id,
      };
    },
  };
}
