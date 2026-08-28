import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceBinding } from "@coding-agent/agent";

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
}

export type WorkspaceErrorCode =
  | "WORKSPACE_UNAVAILABLE"
  | "WORKSPACE_NOT_REPOSITORY"
  | "WORKSPACE_INSPECTION_FAILED";

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
      error.code === 1
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
  };
}

export function sameWorkspaceRoot(left: string, right: string): boolean {
  return normalizeRoot(left) === normalizeRoot(right);
}
