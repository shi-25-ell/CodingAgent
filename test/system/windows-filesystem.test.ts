import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runId } from "@coding-agent/agent";
import { createCodingToolHost } from "@coding-agent/coding";
import type { ToolCall } from "@coding-agent/model";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function outcome(host: ReturnType<typeof createCodingToolHost>, call: ToolCall) {
  return host.execute(call, {
    runId: runId("filesystem-system"),
    signal: new AbortController().signal,
  }).outcome;
}

describe.skipIf(process.platform !== "win32")("Windows workspace filesystem safety", () => {
  it("拒绝 absolute/UNC/device/NUL/traversal 与大小写变化的 .git mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-filesystem-path-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, ".GIT"));
    const host = createCodingToolHost({ workspaceRoot: root });
    const paths = [
      path.join(root, "absolute.txt"),
      "\\\\server\\share\\file.txt",
      "\\\\?\\C:\\device.txt",
      "bad\0path.txt",
      "../escape.txt",
      ".GIT/config",
    ];
    for (const [index, candidate] of paths.entries()) {
      await expect(
        outcome(host, {
          type: "tool_call",
          callId: `unsafe-${index}`,
          name: "create_file",
          arguments: { path: candidate, content: "unsafe" },
        }),
      ).resolves.toMatchObject({ status: "rejected", effectState: "none" });
    }
  });

  it("read 可跟随 workspace 内 junction，enumeration 不递归 junction，escape read/mutation 均拒绝", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-filesystem-links-"));
    const outside = await mkdtemp(path.join(tmpdir(), "fast-filesystem-outside-"));
    temporaryDirectories.push(root, outside);
    const inside = path.join(root, "inside");
    await mkdir(inside);
    await writeFile(path.join(inside, "inside.txt"), "inside", "utf8");
    await writeFile(path.join(outside, "outside.txt"), "outside", "utf8");
    await symlink(inside, path.join(root, "inside-link"), "junction");
    await symlink(outside, path.join(root, "outside-link"), "junction");
    const host = createCodingToolHost({ workspaceRoot: root });

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "read-inside-link",
        name: "read_file",
        arguments: { path: "inside-link/inside.txt" },
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      modelContent: expect.stringContaining("inside"),
    });
    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "read-outside-link",
        name: "read_file",
        arguments: { path: "outside-link/outside.txt" },
      }),
    ).resolves.toMatchObject({ status: "rejected", effectState: "none" });
    const listed = await outcome(host, {
      type: "tool_call",
      callId: "list-links",
      name: "list_files",
      arguments: { path: ".", recursive: true },
    });
    expect(listed.modelContent).toContain("outside-link\tsymlink");
    expect(listed.modelContent).not.toContain("outside-link/outside.txt");
    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "mutate-link",
        name: "create_file",
        arguments: { path: "outside-link/new.txt", content: "escape" },
      }),
    ).resolves.toMatchObject({ status: "rejected", effectState: "none" });
  });

  it("approval 后 ancestor 被替换为 junction 时 fail closed 且不修改外部目标", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-filesystem-toctou-"));
    const outside = await mkdtemp(path.join(tmpdir(), "fast-filesystem-toctou-outside-"));
    temporaryDirectories.push(root, outside);
    const directory = path.join(root, "src");
    await mkdir(directory);
    await writeFile(path.join(directory, "a.txt"), "before", "utf8");
    await writeFile(path.join(outside, "a.txt"), "outside", "utf8");
    const expectedHash = createHash("sha256").update("before").digest("hex");
    const host = createCodingToolHost({
      workspaceRoot: root,
      permissionMode: "safe",
      approvalPort: {
        async request(request) {
          await rm(directory, { recursive: true });
          await symlink(outside, directory, "junction");
          return { decision: "allow_once", planFingerprint: request.plan.fingerprint };
        },
      },
    });

    await expect(
      outcome(host, {
        type: "tool_call",
        callId: "ancestor-race",
        name: "replace_file",
        arguments: { path: "src/a.txt", expectedHash, content: "after" },
      }),
    ).resolves.toMatchObject({ status: "rejected", effectState: "none" });
    await expect(readFile(path.join(outside, "a.txt"), "utf8")).resolves.toBe("outside");
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
