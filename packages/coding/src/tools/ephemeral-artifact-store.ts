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

async function collectBytes(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return Uint8Array.from(source);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    if (signal?.aborted) throw new DOMException("Artifact write 已取消", "AbortError");
    const copy = Uint8Array.from(chunk);
    chunks.push(copy);
    byteLength += copy.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
      const bytes = await collectBytes(input.bytes, options?.signal);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const id = `ephemeral-sha256:${digest}`;
      artifacts.set(id, {
        metadata: {
          id,
          digest: { algorithm: "sha256", hex: digest },
          byteLength: bytes.byteLength,
          mediaType: input.mediaType,
          provenance: input.provenance,
          preview: "",
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
      if (
        options?.maxBytes !== undefined &&
        (!Number.isInteger(options.maxBytes) || options.maxBytes < 0)
      ) {
        throw new TypeError("Artifact maxBytes 必须是非负整数");
      }
      yield Uint8Array.from(bytes.subarray(0, options?.maxBytes ?? bytes.byteLength));
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
