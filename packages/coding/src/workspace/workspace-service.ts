import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceBinding } from "@coding-agent/agent";
import type {
  CodingDiffDocument,
  CodingDiffFile,
  DiffViewerSource,
} from "../projection/contracts.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceSnapshot {
  readonly binding: WorkspaceBinding;
  readonly head: string;
  readonly branch: string;
  readonly clean: boolean;
  readonly changedPaths: readonly string[];
}

export interface WorkspaceService {
  inspect(root: string): Promise<WorkspaceSnapshot>;
  readDiff?(input: {
    readonly root: string;
    readonly source: DiffViewerSource;
    readonly paths?: readonly string[];
  }): Promise<CodingDiffDocument>;
}

export type WorkspaceErrorCode =
  | "WORKSPACE_UNAVAILABLE"
  | "WORKSPACE_NOT_REPOSITORY"
  | "WORKSPACE_INSPECTION_FAILED"
  | "DIFF_SOURCE_UNAVAILABLE";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

interface GitOutput {
  readonly stdout: string;
}

async function git(
  root: string,
  args: readonly string[],
  options: { readonly allowExitOne?: boolean; readonly trim?: boolean } = {},
): Promise<string> {
  try {
    const result = (await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1_024 * 1_024,
    })) as GitOutput;
    return options.trim === false ? result.stdout : result.stdout.trim();
  } catch (error) {
    if (
      options.allowExitOne === true &&
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === 1 || error.code === 128)
    ) {
      return "";
    }
    throw error;
  }
}

function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function changedPaths(status: string): readonly string[] {
  if (status.length === 0) return [];
  return status
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .sort((left, right) => left.localeCompare(right));
}

function filetype(filePath: string): string | undefined {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return extension || undefined;
}

function patchCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function statusFiles(
  status: string,
): readonly { path: string; status: CodingDiffFile["status"] }[] {
  return status
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({
      path: entry.slice(3).replaceAll("\\", "/"),
      status:
        entry.startsWith("??") || entry[0] === "A" || entry[1] === "A"
          ? ("created" as const)
          : entry[0] === "D" || entry[1] === "D"
            ? ("deleted" as const)
            : ("modified" as const),
    }));
}

function nameStatusFiles(
  status: string,
): readonly { path: string; status: CodingDiffFile["status"] }[] {
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => {
      const [code = "M", filePath = ""] = entry.split("\t");
      return {
        path: filePath.replaceAll("\\", "/"),
        status: code.startsWith("A")
          ? ("created" as const)
          : code.startsWith("D")
            ? ("deleted" as const)
            : ("modified" as const),
      };
    });
}

async function untrackedPatch(root: string, filePath: string): Promise<string> {
  const bytes = await readFile(path.join(root, filePath));
  if (bytes.includes(0)) {
    return [
      `diff --git a/${filePath} b/${filePath}`,
      "new file mode 100644",
      `Binary file ${filePath} differs`,
    ].join("\n");
  }
  const content = bytes.toString("utf8");
  const lines = content.split(/\r?\n/);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

/**
 * Git-backed workspace inspection. The durable fingerprint identifies a worktree, checked-out branch,
 * and HEAD, but not mutable file contents, so a Session can continue after its tools make the tree dirty.
 */
export function createGitWorkspaceService(): WorkspaceService {
  return {
    async inspect(root) {
      if (root.trim().length === 0) {
        throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "workspace root 不能为空");
      }
      let repositoryRoot: string;
      let commonDirectory: string;
      let head: string;
      let branch: string;
      let status: string;
      try {
        repositoryRoot = await git(root, ["rev-parse", "--show-toplevel"]);
        commonDirectory = await git(repositoryRoot, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        head = await git(repositoryRoot, ["rev-parse", "HEAD"]);
        branch = await git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
          allowExitOne: true,
        });
        status = await git(
          repositoryRoot,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
          { trim: false },
        );
      } catch (error) {
        throw new WorkspaceError(
          "WORKSPACE_NOT_REPOSITORY",
          "workspace 不是可用的 Git repository",
          { cause: error },
        );
      }
      let canonicalRoot: string;
      let canonicalCommonDirectory: string;
      try {
        [canonicalRoot, canonicalCommonDirectory] = await Promise.all([
          realpath(repositoryRoot),
          realpath(commonDirectory),
        ]);
      } catch (error) {
        throw new WorkspaceError(
          "WORKSPACE_INSPECTION_FAILED",
          "workspace canonical path 无法解析",
          { cause: error },
        );
      }
      const branchIdentity = branch.length > 0 ? `branch:${branch}` : `detached:${head}`;
      const fingerprint = createHash("sha256")
        .update("workspace-v1\0")
        .update(normalizeRoot(canonicalRoot))
        .update("\0")
        .update(normalizeRoot(canonicalCommonDirectory))
        .update("\0")
        .update(branchIdentity)
        .update("\0")
        .update(head)
        .digest("hex");
      const paths = changedPaths(status);
      return {
        binding: { root: canonicalRoot, fingerprint },
        head,
        branch: branch.length > 0 ? branch : "(detached)",
        clean: paths.length === 0,
        changedPaths: paths,
      };
    },
    async readDiff(input) {
      const snapshot = await this.inspect(input.root);
      const root = snapshot.binding.root;
      let status: string;
      let range: string | undefined;
      try {
        if (input.source === "branch") {
          let comparison = await git(root, ["rev-parse", "--verify", "@{upstream}"], {
            allowExitOne: true,
          });
          for (const candidate of [
            "refs/remotes/origin/HEAD^{commit}",
            "main^{commit}",
            "master^{commit}",
          ]) {
            if (comparison) break;
            comparison = await git(root, ["rev-parse", "--verify", candidate], {
              allowExitOne: true,
            });
          }
          if (!comparison) throw new Error("branch comparison base 不可用");
          const base = await git(root, ["merge-base", "HEAD", comparison]);
          range = `${base}..HEAD`;
          status = await git(root, ["diff", "--name-status", "--no-renames", range], {
            trim: false,
          });
        } else {
          status = await git(
            root,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
            { trim: false },
          );
        }
      } catch (error) {
        throw new WorkspaceError("DIFF_SOURCE_UNAVAILABLE", `${input.source} diff source 不可用`, {
          cause: error,
        });
      }
      const allowed = input.paths
        ? new Set(input.paths.map((item) => item.replaceAll("\\", "/")))
        : undefined;
      const files: CodingDiffFile[] = [];
      const changedFiles = range ? nameStatusFiles(status) : statusFiles(status);
      for (const item of changedFiles.filter((item) => !allowed || allowed.has(item.path))) {
        let patchText: string;
        const tracked = range
          ? true
          : (
              await git(root, ["ls-files", "--error-unmatch", "--", item.path], {
                allowExitOne: true,
              })
            ).length > 0;
        if (!tracked && item.status === "created")
          patchText = await untrackedPatch(root, item.path);
        else {
          const args = ["diff", "--no-ext-diff", "--no-textconv"];
          if (range) args.push(range);
          else args.push("HEAD");
          args.push("--", item.path);
          patchText = await git(root, args, { trim: false });
        }
        const counts = patchCounts(patchText);
        const detectedFiletype = filetype(item.path);
        files.push({
          path: item.path,
          status: item.status,
          additions: counts.additions,
          deletions: counts.deletions,
          ...(patchText ? { patch: patchText } : {}),
          ...(detectedFiletype ? { filetype: detectedFiletype } : {}),
        });
      }
      const revision = createHash("sha256")
        .update(JSON.stringify({ source: input.source, head: snapshot.head, files }))
        .digest("hex");
      return Object.freeze({
        version: 1,
        revision,
        source: input.source,
        files: Object.freeze(files.map((file) => Object.freeze(file))),
      });
    },
  };
}

export function sameWorkspaceRoot(left: string, right: string): boolean {
  return normalizeRoot(left) === normalizeRoot(right);
}
