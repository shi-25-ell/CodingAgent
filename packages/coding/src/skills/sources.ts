import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  compareSkillText,
  skillContentDigest,
  validateRelativeFile,
  validateSkillIdentity,
  validateSkillMetadata,
  validateSourceId,
} from "./content.js";
import type {
  SkillContent,
  SkillDescriptor,
  SkillDiscoveryContext,
  SkillRef,
  SkillResource,
  SkillSource,
  SkillSourceKind,
  StaticSkillDefinition,
} from "./contracts.js";
import { SkillValidationError } from "./contracts.js";

const manifestMaxBytes = 64 * 1024;
const contentFileMaxBytes = 512 * 1024;
const bundleMaxBytes = 2 * 1024 * 1024;

interface LoadedBundle {
  readonly descriptor: SkillDescriptor;
  readonly content: SkillContent;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Skill discovery 已取消", "AbortError");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function readBoundedUtf8(path: string, maxBytes: number, label: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new SkillValidationError(`${label} 必须是普通文件`);
  if (metadata.size > maxBytes) {
    throw new SkillValidationError(`${label} 超过 ${maxBytes} bytes 限制`);
  }
  const bytes = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SkillValidationError(`${label} 必须是有效 UTF-8`, { cause: error });
  }
}

async function resolveBundleFile(
  bundleRoot: string,
  bundleRootReal: string,
  relativePath: string,
): Promise<string> {
  const candidate = resolve(bundleRoot, ...relativePath.split("/"));
  if (!within(bundleRoot, candidate)) {
    throw new SkillValidationError(`Skill 文件越过 bundle 边界: ${relativePath}`);
  }
  const actual = await realpath(candidate);
  if (!within(bundleRootReal, actual)) {
    throw new SkillValidationError(`Skill 文件 symlink 越过 bundle 边界: ${relativePath}`);
  }
  return actual;
}

async function loadDirectoryBundle(
  sourceId: string,
  sourceKind: SkillSourceKind,
  bundleRoot: string,
  signal?: AbortSignal,
): Promise<LoadedBundle> {
  throwIfAborted(signal);
  const bundleRootReal = await realpath(bundleRoot);
  const manifestPath = await resolveBundleFile(bundleRoot, bundleRootReal, "skill.json");
  const manifestText = await readBoundedUtf8(manifestPath, manifestMaxBytes, "skill.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText) as unknown;
  } catch (error) {
    throw new SkillValidationError(`Skill bundle ${bundleRoot} 的 skill.json 不是有效 JSON`, {
      cause: error,
    });
  }
  const metadata = validateSkillMetadata(parsed);
  const instructionPath = await resolveBundleFile(
    bundleRoot,
    bundleRootReal,
    metadata.instructions,
  );
  const instructions = await readBoundedUtf8(
    instructionPath,
    contentFileMaxBytes,
    `Skill ${metadata.id} instructions`,
  );
  if (instructions.trim().length === 0) {
    throw new SkillValidationError(`Skill ${metadata.id} instructions 不能为空`);
  }
  const resources: SkillResource[] = [];
  let totalBytes = new TextEncoder().encode(instructions).byteLength;
  for (const resourcePath of metadata.resources) {
    throwIfAborted(signal);
    const actual = await resolveBundleFile(bundleRoot, bundleRootReal, resourcePath);
    const content = await readBoundedUtf8(
      actual,
      contentFileMaxBytes,
      `Skill ${metadata.id} resource ${resourcePath}`,
    );
    totalBytes += new TextEncoder().encode(content).byteLength;
    if (totalBytes > bundleMaxBytes) {
      throw new SkillValidationError(
        `Skill ${metadata.id} bundle 超过 ${bundleMaxBytes} bytes 限制`,
      );
    }
    resources.push(Object.freeze({ path: resourcePath, content }));
  }
  const digest = skillContentDigest({
    id: metadata.id,
    version: metadata.version,
    description: metadata.description,
    instructions,
    resources,
  });
  const provenance = Object.freeze({
    sourceId,
    sourceKind,
    location: bundleRootReal,
  });
  return {
    descriptor: Object.freeze({
      id: metadata.id,
      version: metadata.version,
      description: metadata.description,
      digest,
      provenance,
    }),
    content: Object.freeze({
      instructions,
      resources: Object.freeze(resources),
      digest,
    }),
  };
}

function refKey(ref: SkillRef): string {
  return `${ref.id}\0${ref.version}\0${ref.digest}`;
}

export interface DirectorySkillSourceOptions {
  readonly id: string;
  readonly kind: SkillSourceKind;
  readonly directory: string;
}

export function createDirectorySkillSource(options: DirectorySkillSourceOptions): SkillSource {
  validateSourceId(options.id);
  const directory = resolve(options.directory);
  let discovered = new Map<string, string>();
  return Object.freeze({
    id: options.id,
    kind: options.kind,
    async discover(context: SkillDiscoveryContext): Promise<readonly SkillDescriptor[]> {
      throwIfAborted(context.signal);
      let discoveryDirectory = directory;
      if (options.kind === "project") {
        const workspaceRoot = resolve(context.workspaceRoot);
        if (!within(workspaceRoot, directory)) {
          throw new SkillValidationError("Project Skill source 必须位于 workspaceRoot 内");
        }
        try {
          const [workspaceRootReal, directoryReal] = await Promise.all([
            realpath(workspaceRoot),
            realpath(directory),
          ]);
          if (!within(workspaceRootReal, directoryReal)) {
            throw new SkillValidationError("Project Skill source symlink 越过 workspaceRoot");
          }
          discoveryDirectory = directoryReal;
        } catch (error) {
          if (isMissing(error)) {
            discovered = new Map();
            return Object.freeze([]);
          }
          throw error;
        }
      }
      let entries: Dirent[];
      try {
        entries = await readdir(discoveryDirectory, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) {
          discovered = new Map();
          return Object.freeze([]);
        }
        throw error;
      }
      const bundles: LoadedBundle[] = [];
      for (const entry of entries
        .filter((candidate) => candidate.isDirectory())
        .sort((left, right) => compareSkillText(left.name, right.name))) {
        throwIfAborted(context.signal);
        bundles.push(
          await loadDirectoryBundle(
            options.id,
            options.kind,
            join(discoveryDirectory, entry.name),
            context.signal,
          ),
        );
      }
      const next = new Map<string, string>();
      for (const bundle of bundles) {
        const ref: SkillRef = {
          id: bundle.descriptor.id,
          version: bundle.descriptor.version,
          digest: bundle.descriptor.digest,
          sourceId: options.id,
        };
        const key = refKey(ref);
        if (next.has(key)) {
          throw new SkillValidationError(`Skill source ${options.id} 返回重复 skill: ${ref.id}`);
        }
        next.set(key, bundle.descriptor.provenance.location);
      }
      discovered = next;
      return Object.freeze(bundles.map((bundle) => bundle.descriptor));
    },
    async load(
      ref: SkillRef,
      loadOptions?: { readonly signal?: AbortSignal },
    ): Promise<SkillContent> {
      throwIfAborted(loadOptions?.signal);
      if (ref.sourceId !== options.id) {
        throw new SkillValidationError(`Skill ref ${ref.id} 不属于 source ${options.id}`);
      }
      const location = discovered.get(refKey(ref));
      if (!location)
        throw new SkillValidationError(`Skill ref 不在 discovery snapshot 中: ${ref.id}`);
      const loaded = await loadDirectoryBundle(
        options.id,
        options.kind,
        location,
        loadOptions?.signal,
      );
      if (
        loaded.descriptor.id !== ref.id ||
        loaded.descriptor.version !== ref.version ||
        loaded.descriptor.digest !== ref.digest
      ) {
        throw new SkillValidationError(`Skill ${ref.id} 在 discovery 后发生变化`);
      }
      return loaded.content;
    },
  });
}

export function createUserSkillSource(directory: string): SkillSource {
  return createDirectorySkillSource({ id: "user-skills", kind: "user", directory });
}

export function createProjectSkillSource(directory: string): SkillSource {
  return createDirectorySkillSource({ id: "project-skills", kind: "project", directory });
}

export function createBuiltInSkillSource(
  definitions: readonly StaticSkillDefinition[],
  sourceId = "built-in-skills",
): SkillSource {
  validateSourceId(sourceId);
  const byKey = new Map<string, SkillContent>();
  const descriptors = definitions.map((definition, index) => {
    if (
      typeof definition.instructions !== "string" ||
      typeof definition.description !== "string" ||
      typeof definition.id !== "string" ||
      typeof definition.version !== "string"
    ) {
      throw new SkillValidationError("Built-in Skill metadata/content 类型无效");
    }
    validateSkillIdentity(definition.id, definition.version, definition.description);
    if (definition.instructions.trim().length === 0) {
      throw new SkillValidationError(`Skill ${definition.id} instructions 不能为空`);
    }
    const resources = Object.entries(definition.resources ?? {})
      .sort(([left], [right]) => compareSkillText(left, right))
      .map(([path, content]) => {
        if (typeof content !== "string") {
          throw new SkillValidationError(`Skill ${definition.id} resource ${path} 必须是 string`);
        }
        return Object.freeze({
          path: validateRelativeFile(path, `Skill ${definition.id} resource`),
          content,
        });
      });
    const totalBytes = [
      definition.instructions,
      ...resources.map((resource) => resource.content),
    ].reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 0);
    if (totalBytes > bundleMaxBytes) {
      throw new SkillValidationError(
        `Skill ${definition.id} bundle 超过 ${bundleMaxBytes} bytes 限制`,
      );
    }
    const digest = skillContentDigest({ ...definition, resources });
    const descriptor = Object.freeze({
      id: definition.id,
      version: definition.version,
      description: definition.description,
      digest,
      provenance: Object.freeze({
        sourceId,
        sourceKind: "built_in" as const,
        location: `built-in:${index}`,
      }),
    });
    byKey.set(
      refKey({ id: definition.id, version: definition.version, digest, sourceId }),
      Object.freeze({
        instructions: definition.instructions,
        resources: Object.freeze(resources),
        digest,
      }),
    );
    return descriptor;
  });
  return Object.freeze({
    id: sourceId,
    kind: "built_in" as const,
    async discover(context: SkillDiscoveryContext) {
      throwIfAborted(context.signal);
      return Object.freeze([...descriptors]);
    },
    async load(ref: SkillRef, options?: { readonly signal?: AbortSignal }): Promise<SkillContent> {
      throwIfAborted(options?.signal);
      if (ref.sourceId !== sourceId) {
        throw new SkillValidationError(`Skill ref ${ref.id} 不属于 source ${sourceId}`);
      }
      const content = byKey.get(refKey(ref));
      if (!content) throw new SkillValidationError(`未知 built-in Skill ref: ${ref.id}`);
      return content;
    },
  });
}
