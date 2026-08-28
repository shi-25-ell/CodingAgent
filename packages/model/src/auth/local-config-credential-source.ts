import { readFile } from "node:fs/promises";
import { type CredentialSource, SecretString } from "./contracts.js";

export interface LocalConfigCredentialSourceOptions {
  readonly id: string;
  readonly path: string;
}

function cancelled() {
  return {
    status: "failed" as const,
    failure: { category: "cancelled" as const, message: "Credential resolution 已取消" },
  };
}

export function createLocalConfigCredentialSource(
  options: LocalConfigCredentialSourceOptions,
): CredentialSource {
  if (options.id.trim().length === 0) throw new TypeError("CredentialSource id 不能为空");
  return {
    id: options.id,
    async resolve(request, resolveOptions) {
      if (resolveOptions?.signal?.aborted) return cancelled();
      try {
        const text = await readFile(
          options.path,
          resolveOptions?.signal ? { encoding: "utf8", signal: resolveOptions.signal } : "utf8",
        );
        if (resolveOptions?.signal?.aborted) return cancelled();
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
          throw new TypeError("config root 必须是 object");
        }
        const value = (parsed as Record<string, unknown>)[request.ref];
        if (value === undefined) return { status: "missing" };
        if (typeof value !== "string" || value.length === 0) {
          throw new TypeError("credential value 必须是非空 string");
        }
        return {
          status: "found",
          credential: { kind: request.kind, value: new SecretString(value) },
          sourceId: options.id,
        };
      } catch (error) {
        if (
          resolveOptions?.signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return cancelled();
        }
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return { status: "missing" };
        }
        return {
          status: "failed",
          failure: { category: "failed", message: "Local credential config 无效" },
        };
      }
    },
  };
}
