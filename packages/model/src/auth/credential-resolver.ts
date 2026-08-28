import type { CredentialResolution, CredentialResolver, CredentialSource } from "./contracts.js";

function cancelled(): CredentialResolution {
  return {
    status: "failed",
    failure: { category: "cancelled", message: "Credential resolution 已取消" },
  };
}

export function createCredentialResolver(sources: readonly CredentialSource[]): CredentialResolver {
  const ordered = [...sources];
  return {
    async resolve(request, options): Promise<CredentialResolution> {
      if (options?.signal?.aborted) return cancelled();
      for (const source of ordered) {
        const result = await source.resolve(request, options);
        if (options?.signal?.aborted) return cancelled();
        if (result.status !== "missing") return result;
      }
      return { status: "missing" };
    },
  };
}
