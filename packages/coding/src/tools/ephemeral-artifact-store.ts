import { createHash } from "node:crypto";

export interface ToolArtifactWrite {
  readonly bytes: Uint8Array;
  readonly mediaType: "text/plain" | "application/json";
  readonly provenance: string;
}

export interface ToolArtifactMetadata {
  readonly id: string;
  readonly byteLength: number;
  readonly mediaType: ToolArtifactWrite["mediaType"];
  readonly provenance: string;
}

export interface ToolArtifactStore extends AsyncDisposable {
  put(input: ToolArtifactWrite): Promise<{ readonly id: string }>;
  stat(id: string): Promise<ToolArtifactMetadata | undefined>;
  read(id: string): Promise<Uint8Array | undefined>;
}

interface StoredArtifact {
  readonly metadata: ToolArtifactMetadata;
  readonly bytes: Uint8Array;
}

export function createEphemeralArtifactStore(): ToolArtifactStore {
  const artifacts = new Map<string, StoredArtifact>();
  let disposed = false;
  const assertAvailable = (): void => {
    if (disposed) throw new Error("ephemeral ArtifactStore 已释放");
  };
  return {
    async put(input) {
      assertAvailable();
      const bytes = Uint8Array.from(input.bytes);
      const id = `ephemeral-sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      artifacts.set(id, {
        metadata: {
          id,
          byteLength: bytes.byteLength,
          mediaType: input.mediaType,
          provenance: input.provenance,
        },
        bytes,
      });
      return { id };
    },
    async stat(id) {
      assertAvailable();
      return structuredClone(artifacts.get(id)?.metadata);
    },
    async read(id) {
      assertAvailable();
      const bytes = artifacts.get(id)?.bytes;
      return bytes ? Uint8Array.from(bytes) : undefined;
    },
    async [Symbol.asyncDispose]() {
      disposed = true;
      artifacts.clear();
    },
  };
}
