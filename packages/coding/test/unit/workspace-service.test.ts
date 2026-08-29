import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createGitWorkspaceService,
  type WorkspaceError,
} from "../../src/workspace/workspace-service.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function initializeRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fast-workspace-service-"));
  temporaryRoots.push(root);
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
  await execFileAsync(
    "git",
    ["-c", "user.name=Fast Test", "-c", "user.email=fast@example.invalid", "add", "README.md"],
    { cwd: root },
  );
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Fast Test",
      "-c",
      "user.email=fast@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: root },
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Git WorkspaceService", () => {
  it("发现 repository root，并允许同一 branch 上的 dirty workspace 保持稳定 fingerprint", async () => {
    const root = await initializeRepository();
    const nested = path.join(root, "src", "nested");
    await mkdir(nested, { recursive: true });
    const service = createGitWorkspaceService();

    const clean = await service.inspect(nested);
    await writeFile(path.join(root, "README.md"), "changed\n", "utf8");
    const dirty = await service.inspect(root);

    expect(clean.clean).toBe(true);
    expect(dirty).toMatchObject({ clean: false, branch: "main" });
    expect(dirty.changedPaths).toContain("README.md");
    expect(dirty.binding).toEqual(clean.binding);
  });

  it("branch switch 改变 fingerprint，且非 repository fail closed", async () => {
    const root = await initializeRepository();
    const service = createGitWorkspaceService();
    const main = await service.inspect(root);
    await execFileAsync("git", ["switch", "-c", "alternate"], { cwd: root });
    const alternate = await service.inspect(root);

    expect(alternate.binding.fingerprint).not.toBe(main.binding.fingerprint);
    await expect(service.inspect(os.tmpdir())).rejects.toMatchObject({
      code: "WORKSPACE_NOT_REPOSITORY",
    } satisfies Partial<WorkspaceError>);
  });

  it("同一 branch 的 HEAD 变化会改变 fingerprint", async () => {
    const root = await initializeRepository();
    const service = createGitWorkspaceService();
    const before = await service.inspect(root);
    await writeFile(path.join(root, "next.txt"), "next\n", "utf8");
    await execFileAsync("git", ["add", "next.txt"], { cwd: root });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Fast Test",
        "-c",
        "user.email=fast@example.invalid",
        "commit",
        "-m",
        "next",
      ],
      { cwd: root },
    );
    const after = await service.inspect(root);

    expect(after.branch).toBe(before.branch);
    expect(after.head).not.toBe(before.head);
    expect(after.binding.fingerprint).not.toBe(before.binding.fingerprint);
  });

  it("提供 application-owned working tree Diff document", async () => {
    const root = await initializeRepository();
    await writeFile(path.join(root, "README.md"), "initial\nchanged\n", "utf8");
    await writeFile(path.join(root, "new.ts"), "export const value = 1;\n", "utf8");
    const service = createGitWorkspaceService();
    if (!service.readDiff) throw new Error("Git WorkspaceService 必须支持 readDiff");
    const document = await service.readDiff({ root, source: "working_tree" });

    expect(document.source).toBe("working_tree");
    expect(document.files.map((file) => [file.path, file.status])).toEqual([
      ["README.md", "modified"],
      ["new.ts", "created"],
    ]);
    expect(document.files.every((file) => file.patch?.startsWith("diff --git"))).toBe(true);
  });
});
