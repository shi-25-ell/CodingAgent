export const supportedBunVersion = "1.4.0";

export interface BunRuntimeDiagnostic {
  readonly runtime: "bun" | "unsupported";
  readonly version: string;
  readonly revision?: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly supported: boolean;
}

interface BunRuntimeShape {
  readonly version?: unknown;
  readonly revision?: unknown;
}

export function detectBunRuntime(): BunRuntimeDiagnostic {
  const candidate = Reflect.get(globalThis, "Bun") as BunRuntimeShape | undefined;
  const version = typeof candidate?.version === "string" ? candidate.version : "unavailable";
  const revision = typeof candidate?.revision === "string" ? candidate.revision : undefined;
  const runtime = version === "unavailable" ? "unsupported" : "bun";
  return {
    runtime,
    version,
    ...(revision ? { revision } : {}),
    platform: process.platform,
    architecture: process.arch,
    supported: runtime === "bun" && version === supportedBunVersion,
  };
}

export function formatBunRuntimeDiagnostic(diagnostic: BunRuntimeDiagnostic): string {
  const revision = diagnostic.revision ? ` revision=${diagnostic.revision}` : "";
  return (
    `runtime=${diagnostic.runtime} version=${diagnostic.version}${revision} ` +
    `platform=${diagnostic.platform} arch=${diagnostic.architecture} ` +
    `supported=${String(diagnostic.supported)}`
  );
}
