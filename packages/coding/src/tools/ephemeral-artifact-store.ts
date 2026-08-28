import { createHash } from "node:crypto";
import type {
  ArtifactMetadata,
  ArtifactRef,
  ArtifactStore,
  ArtifactWriteInput,
} from "@coding-agent/agent";

interface StoredArtifact {
  readonly metadata: ArtifactMetadata;
  readonly bytes: Uint8Array;
}

export function createEphemeralArtifactStore(): ArtifactStore {
  const artifacts = new Map<string, StoredArtifact>();
  let disposed = false;
  const assertAvailable = (): void => {
    if (disposed) throw new Error("ephemeral ArtifactStore 已释放");
  };
  return {
    async put(input: ArtifactWriteInput, options) {
      assertAvailable();
      if (options?.signal?.aborted) throw new DOMException("Artifact write 已取消", "AbortError");
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
    async stat(ref: ArtifactRef) {
      assertAvailable();
      const metadata = artifacts.get(ref.id)?.metadata;
      if (!metadata) throw new Error("Artifact 不存在");
      return structuredClone(metadata);
    },
    async *read(ref: ArtifactRef, options) {
      assertAvailable();
      if (options?.signal?.aborted) throw new DOMException("Artifact read 已取消", "AbortError");
      const bytes = artifacts.get(ref.id)?.bytes;
      if (!bytes) throw new Error("Artifact 不存在");
      yield Uint8Array.from(bytes);
    },
    async verify(ref: ArtifactRef) {
      assertAvailable();
      const stored = artifacts.get(ref.id);
      if (!stored) return { status: "missing" as const };
      const expected = `ephemeral-sha256:${createHash("sha256").update(stored.bytes).digest("hex")}`;
      return { status: expected === ref.id ? ("verified" as const) : ("corrupt" as const) };
    },
    async [Symbol.asyncDispose]() {
      disposed = true;
      artifacts.clear();
    },
  };
}
