import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactIntegrity,
  ArtifactMetadata,
  ArtifactReadOptions,
  ArtifactRef,
  ArtifactStore,
  ArtifactWriteInput,
  Clock,
} from "@coding-agent/agent";
import type Database from "better-sqlite3";
import type { SqliteDatabase } from "../connection/database.js";

const previewInputBytes = 4_096;
const previewOutputCharacters = 1_024;
const readChunkBytes = 64 * 1_024;
const networkFilesystemTypes = new Set([0x517b, 0x6969, 0x6e667364, 0xff534d42]);

interface ArtifactRow {
  readonly artifact_id: string;
  readonly digest_hex: string;
  readonly byte_length: number;
  readonly media_type: ArtifactWriteInput["mediaType"];
  readonly provenance: string;
  readonly preview: string;
  readonly storage_key: string;
  readonly state: "pending" | "committed";
}

export interface ArtifactFaults {
  afterPending?(): Promise<void> | void;
  afterRename?(): Promise<void> | void;
}

export interface DurableArtifactStoreOptions {
  readonly database: SqliteDatabase;
  readonly directory: string;
  readonly clock: Clock;
  readonly previewRedactor?: (text: string) => string;
  readonly faults?: ArtifactFaults;
}

export class SqliteArtifactError extends Error {
  readonly code:
    | "ARTIFACT_NOT_FOUND"
    | "ARTIFACT_CORRUPT"
    | "ARTIFACT_DISPOSED"
    | "ARTIFACT_CONFIGURATION";

  constructor(code: SqliteArtifactError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteArtifactError";
    this.code = code;
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function sourceChunks(source: ArtifactWriteInput["bytes"]): AsyncIterable<Uint8Array> {
  if (!(source instanceof Uint8Array)) return source;
  return (async function* oneChunk() {
    yield source;
  })();
}

function metadata(row: ArtifactRow): ArtifactMetadata {
  return {
    id: row.artifact_id,
    digest: { algorithm: "sha256", hex: row.digest_hex },
    byteLength: row.byte_length,
    mediaType: row.media_type,
    provenance: row.provenance,
    preview: row.preview,
  };
}

async function assertLocalDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) {
    throw new SqliteArtifactError(
      "ARTIFACT_CONFIGURATION",
      "artifactDirectory 必须是 absolute path",
    );
  }
  if (directory.startsWith("\\\\") || directory.startsWith("//")) {
    throw new SqliteArtifactError(
      "ARTIFACT_CONFIGURATION",
      "不支持 network filesystem 上的 Artifact store",
    );
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await realpath(directory);
  if (resolved.startsWith("\\\\") || resolved.startsWith("//")) {
    throw new SqliteArtifactError(
      "ARTIFACT_CONFIGURATION",
      "不支持 network filesystem 上的 Artifact store",
    );
  }
  const statistics = await statfs(resolved);
  if (networkFilesystemTypes.has(Number(statistics.type))) {
    throw new SqliteArtifactError(
      "ARTIFACT_CONFIGURATION",
      "检测到 network filesystem，拒绝打开 Artifact store",
    );
  }
  return resolved;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = nodeErrorCode(error);
    if (
      process.platform === "win32" &&
      (code === "EPERM" || code === "EISDIR" || code === "EINVAL")
    ) {
      return;
    }
    throw error;
  }
}

async function removeTemp(pathname: string): Promise<void> {
  try {
    await unlink(pathname);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
}

async function writeFully(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) {
      throw new SqliteArtifactError("ARTIFACT_CORRUPT", "Artifact temp write 未取得进展");
    }
    offset += result.bytesWritten;
  }
}

export class DurableArtifactStore implements ArtifactStore {
  readonly #database: SqliteDatabase;
  readonly #raw: Database.Database;
  readonly #directory: string;
  readonly #clock: Clock;
  readonly #previewRedactor: (text: string) => string;
  readonly #faults: ArtifactFaults | undefined;
  #disposed = false;

  private constructor(options: DurableArtifactStoreOptions, directory: string) {
    this.#database = options.database;
    this.#raw = options.database.raw;
    this.#directory = directory;
    this.#clock = options.clock;
    this.#previewRedactor = options.previewRedactor ?? (() => "");
    this.#faults = options.faults;
  }

  static async create(options: DurableArtifactStoreOptions): Promise<DurableArtifactStore> {
    return new DurableArtifactStore(options, await assertLocalDirectory(options.directory));
  }

  async put(
    input: ArtifactWriteInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ArtifactRef> {
    this.#assertAvailable();
    if (input.provenance.trim().length === 0) throw new TypeError("Artifact provenance 不能为空");
    const temporaryDirectory = path.join(this.#directory, ".tmp");
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.tmp`);
    const temporary = await open(temporaryPath, "wx", 0o600);
    let temporaryOpen = true;
    const digest = createHash("sha256");
    const previewChunks: Uint8Array[] = [];
    let previewBytes = 0;
    let byteLength = 0;
    let renamed = false;
    try {
      for await (const originalChunk of sourceChunks(input.bytes)) {
        if (options?.signal?.aborted) {
          throw new DOMException("Artifact write 已取消", "AbortError");
        }
        if (!(originalChunk instanceof Uint8Array)) {
          throw new TypeError("Artifact stream 只能产生 Uint8Array");
        }
        const chunk = Uint8Array.from(originalChunk);
        await writeFully(temporary, chunk);
        digest.update(chunk);
        byteLength += chunk.byteLength;
        if (previewBytes < previewInputBytes) {
          const retained = chunk.subarray(0, previewInputBytes - previewBytes);
          previewChunks.push(Uint8Array.from(retained));
          previewBytes += retained.byteLength;
        }
      }
      await temporary.sync();
      await temporary.close();
      temporaryOpen = false;
      const digestHex = digest.digest("hex");
      const id = `sha256:${digestHex}`;
      const storageKey = path.posix.join("sha256", digestHex.slice(0, 2), digestHex);
      const previewSource = Buffer.concat(previewChunks).toString("utf8");
      const preview =
        input.mediaType === "application/octet-stream"
          ? ""
          : this.#previewRedactor(previewSource).slice(0, previewOutputCharacters);
      this.#database.immediate(() => {
        this.#raw
          .prepare(
            `INSERT INTO artifacts(
              artifact_id, digest_algorithm, digest_hex, byte_length, media_type,
              provenance, preview, storage_key, state, created_at, committed_at
            ) VALUES (?, 'sha256', ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
            ON CONFLICT(artifact_id) DO NOTHING`,
          )
          .run(
            id,
            digestHex,
            byteLength,
            input.mediaType,
            input.provenance,
            preview,
            storageKey,
            this.#clock.now(),
          );
      });
      const existing = this.#row({ id });
      if (existing?.state === "committed") {
        const integrity = await this.#verifyRow(existing);
        if (integrity.status !== "verified") {
          throw new SqliteArtifactError("ARTIFACT_CORRUPT", "已提交 Artifact bytes 损坏");
        }
        await removeTemp(temporaryPath);
        return { id };
      }
      await this.#faults?.afterPending?.();
      const target = this.#storagePath(storageKey);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try {
        await rename(temporaryPath, target);
        renamed = true;
      } catch (error) {
        const code = nodeErrorCode(error);
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        await removeTemp(temporaryPath);
      }
      await syncDirectory(path.dirname(target));
      await this.#faults?.afterRename?.();
      const pending = this.#row({ id });
      if (!pending)
        throw new SqliteArtifactError("ARTIFACT_CORRUPT", "pending Artifact metadata 丢失");
      const integrity = await this.#verifyRow(pending);
      if (integrity.status !== "verified") {
        throw new SqliteArtifactError("ARTIFACT_CORRUPT", "Artifact bytes digest 校验失败");
      }
      this.#database.immediate(() => {
        const changed = this.#raw
          .prepare(
            `UPDATE artifacts SET state = 'committed', committed_at = ?
             WHERE artifact_id = ? AND state = 'pending'`,
          )
          .run(this.#clock.now(), id);
        if (changed.changes === 0) {
          const committed = this.#row({ id });
          if (committed?.state !== "committed") {
            throw new SqliteArtifactError("ARTIFACT_CORRUPT", "Artifact metadata commit CAS 失败");
          }
        }
      });
      return { id };
    } catch (error) {
      if (!renamed) await removeTemp(temporaryPath);
      throw error;
    } finally {
      if (temporaryOpen) await temporary.close();
    }
  }

  async stat(ref: ArtifactRef): Promise<ArtifactMetadata> {
    this.#assertAvailable();
    const row = this.#committedRow(ref);
    return metadata(row);
  }

  async *read(ref: ArtifactRef, options?: ArtifactReadOptions): AsyncIterable<Uint8Array> {
    this.#assertAvailable();
    if (
      options?.maxBytes !== undefined &&
      (!Number.isInteger(options.maxBytes) || options.maxBytes < 0)
    ) {
      throw new TypeError("Artifact maxBytes 必须是非负整数");
    }
    if (options?.signal?.aborted) throw new DOMException("Artifact read 已取消", "AbortError");
    const row = this.#committedRow(ref);
    const handle = await open(this.#storagePath(row.storage_key), "r");
    try {
      let position = 0;
      const maximum = Math.min(row.byte_length, options?.maxBytes ?? row.byte_length);
      while (position < maximum) {
        if (options?.signal?.aborted) throw new DOMException("Artifact read 已取消", "AbortError");
        const buffer = Buffer.allocUnsafe(Math.min(readChunkBytes, maximum - position));
        const result = await handle.read(buffer, 0, buffer.byteLength, position);
        if (result.bytesRead === 0) break;
        position += result.bytesRead;
        yield Uint8Array.from(buffer.subarray(0, result.bytesRead));
      }
      if (position < maximum) {
        throw new SqliteArtifactError(
          "ARTIFACT_CORRUPT",
          "Artifact bytes 比 committed metadata 短",
        );
      }
    } finally {
      await handle.close();
    }
  }

  async verify(ref: ArtifactRef): Promise<ArtifactIntegrity> {
    this.#assertAvailable();
    const row = this.#row(ref);
    if (!row || row.state !== "committed") return { status: "missing" };
    return this.#verifyRow(row);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposed = true;
  }

  #assertAvailable(): void {
    if (this.#disposed) {
      throw new SqliteArtifactError("ARTIFACT_DISPOSED", "ArtifactStore 已释放");
    }
  }

  #row(ref: ArtifactRef): ArtifactRow | undefined {
    return this.#raw
      .prepare(
        `SELECT artifact_id, digest_hex, byte_length, media_type,
                provenance, preview, storage_key, state
         FROM artifacts WHERE artifact_id = ?`,
      )
      .get(ref.id) as ArtifactRow | undefined;
  }

  #committedRow(ref: ArtifactRef): ArtifactRow {
    const row = this.#row(ref);
    if (!row || row.state !== "committed") {
      throw new SqliteArtifactError("ARTIFACT_NOT_FOUND", "Artifact 不存在或尚未 committed");
    }
    return row;
  }

  #storagePath(storageKey: string): string {
    const normalized = storageKey.replaceAll("/", path.sep);
    const target = path.resolve(this.#directory, normalized);
    const relative = path.relative(this.#directory, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new SqliteArtifactError("ARTIFACT_CORRUPT", "Artifact storage key 越过 store root");
    }
    return target;
  }

  async #verifyRow(row: ArtifactRow): Promise<ArtifactIntegrity> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.#storagePath(row.storage_key), "r");
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return { status: "missing" };
      throw error;
    }
    try {
      const digest = createHash("sha256");
      let byteLength = 0;
      const buffer = Buffer.allocUnsafe(readChunkBytes);
      while (true) {
        const result = await handle.read(buffer, 0, buffer.byteLength, byteLength);
        if (result.bytesRead === 0) break;
        digest.update(buffer.subarray(0, result.bytesRead));
        byteLength += result.bytesRead;
      }
      return byteLength === row.byte_length && digest.digest("hex") === row.digest_hex
        ? { status: "verified" }
        : { status: "corrupt" };
    } finally {
      await handle.close();
    }
  }
}
