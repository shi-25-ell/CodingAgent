import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ContextContribution, ContextSource, ContextSourceInput } from "@coding-agent/agent";
import type { InstructionPart } from "@coding-agent/model";

export interface ProjectInstructionsContextSourceOptions {
  readonly workspaceRoot: string;
  readonly activeDirectory?: string;
  readonly filenames?: readonly string[];
  readonly maxFileBytes?: number;
}

export interface ProjectInstructionRef {
  readonly path: string;
  readonly digest: string;
}

export interface ProjectInstructionsSnapshot {
  readonly refs: readonly ProjectInstructionRef[];
  readonly source: ContextSource;
}

interface PreparedOptions {
  readonly root: string;
  readonly filenames: readonly string[];
  readonly maxFileBytes: number;
  readonly searchDirectories: readonly string[];
}

function missing(error: unknown): boolean {
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

function directories(root: string, active: string): readonly string[] {
  if (!within(root, active)) {
    throw new TypeError("activeDirectory 必须位于 workspaceRoot 内");
  }
  const result: string[] = [];
  let current = active;
  for (;;) {
    result.unshift(current);
    if (current === root) return result;
    const parent = dirname(current);
    if (parent === current) throw new TypeError("无法构造 project instruction directory chain");
    current = parent;
  }
}

function estimate(parts: readonly InstructionPart[]): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(parts)).byteLength / 4);
}

function prepareOptions(options: ProjectInstructionsContextSourceOptions): PreparedOptions {
  const root = resolve(options.workspaceRoot);
  const active = resolve(options.activeDirectory ?? root);
  const filenames = Object.freeze([...(options.filenames ?? ["AGENTS.md", "CONTEXT.md"])]);
  if (
    filenames.length === 0 ||
    filenames.some(
      (name) =>
        name.length === 0 ||
        name.includes("/") ||
        name.includes("\\") ||
        name === "." ||
        name === "..",
    ) ||
    new Set(filenames).size !== filenames.length
  ) {
    throw new TypeError("Project instruction filenames 必须是唯一的直接文件名");
  }
  const maxFileBytes = options.maxFileBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new TypeError("maxFileBytes 必须是正整数");
  }
  const searchDirectories = directories(root, active);
  return { root, filenames, maxFileBytes, searchDirectories };
}

async function collectContributions(
  options: PreparedOptions,
  signal?: AbortSignal,
): Promise<readonly ContextContribution[]> {
  if (signal?.aborted) {
    throw new DOMException("Project instructions 收集已取消", "AbortError");
  }
  const rootReal = await realpath(options.root);
  const contributions: ContextContribution[] = [];
  for (const directory of options.searchDirectories) {
    for (const filename of options.filenames) {
      if (signal?.aborted) {
        throw new DOMException("Project instructions 收集已取消", "AbortError");
      }
      const path = join(directory, filename);
      let metadata: Stats;
      try {
        metadata = await stat(path);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      if (!metadata.isFile()) throw new TypeError(`Project instruction 不是普通文件: ${path}`);
      if (metadata.size > options.maxFileBytes) {
        throw new TypeError(`Project instruction 超过 ${options.maxFileBytes} bytes: ${path}`);
      }
      const actual = await realpath(path);
      if (!within(rootReal, actual)) {
        throw new TypeError(`Project instruction symlink 越过 workspaceRoot: ${path}`);
      }
      const bytes = await readFile(actual);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new TypeError(`Project instruction 必须是有效 UTF-8: ${path}`, { cause: error });
      }
      if (text.trim().length === 0) continue;
      const pathFromRoot = relative(options.root, path).replaceAll("\\", "/");
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const parts = Object.freeze<InstructionPart[]>([
        Object.freeze({
          type: "text",
          text: `Project instructions (${pathFromRoot}):\n${text}`,
        }),
      ]);
      contributions.push(
        Object.freeze({
          id: `project-instructions:${pathFromRoot}:${digest}`,
          sourceId: "project_instructions",
          priority: 900,
          required: true,
          orderingGroup: "project_instructions",
          sequence: contributions.length,
          estimatedTokens: estimate(parts),
          provenance: Object.freeze({
            kind: "project",
            id: pathFromRoot,
            digest,
            attributes: Object.freeze({ workspaceRoot: options.root }),
          }),
          sensitivity: "workspace",
          content: Object.freeze({ kind: "instructions", parts }),
        }),
      );
    }
  }
  return Object.freeze(contributions);
}

export function createProjectInstructionsContextSource(
  options: ProjectInstructionsContextSourceOptions,
): ContextSource {
  const prepared = prepareOptions(options);
  return Object.freeze({
    id: "project_instructions",
    collect(input: ContextSourceInput): Promise<readonly ContextContribution[]> {
      return collectContributions(prepared, input.signal);
    },
  });
}

export async function createProjectInstructionsSnapshot(
  options: ProjectInstructionsContextSourceOptions,
): Promise<ProjectInstructionsSnapshot> {
  const contributions = await collectContributions(prepareOptions(options));
  const refs = Object.freeze(
    contributions.map((contribution) => {
      const digest = contribution.provenance.digest;
      if (!digest) throw new TypeError("Project instruction contribution 缺少 digest");
      return Object.freeze({
        path: contribution.provenance.id,
        digest,
      });
    }),
  );
  return Object.freeze({
    refs,
    source: Object.freeze({
      id: "project_instructions",
      async collect(input: ContextSourceInput): Promise<readonly ContextContribution[]> {
        if (input.signal.aborted) {
          throw new DOMException("Project instructions 收集已取消", "AbortError");
        }
        return contributions;
      },
    }),
  });
}
