import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runId } from "@coding-agent/agent";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeLinuxExecutionPorts } from "../../packages/coding/src/adapters/node-local-execution-adapters.js";
import { createCodingToolHost } from "../../packages/coding/src/tools/coding-tool-host.js";
import { defineProcessPortConformance } from "./process-port.conformance.js";

const onLinux = process.platform === "linux";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10 })),
  );
});

describe.skipIf(!onLinux)("Linux production adapters", () => {
  defineProcessPortConformance("Linux Bash", () => createNodeLinuxExecutionPorts().process, {
    successCommand: `printf '%s' "$PWD"; printf '%s' 'err' >&2`,
    quotingCommand: `printf '%s' 'space " quote'`,
    failureCommand: `printf '%s' 'bad' >&2; exit 7`,
    environmentCommand: `printf '%s' "\${FAST_M5_PROCESS_SECRET:-<missing>}"`,
    outputLimitCommand: `printf '%0160d' 0 | tr '0' 'A'; ` + `printf '%0160d' 0 | tr '0' 'B' >&2`,
    treeCommand:
      `(echo "$BASHPID" > child.pid; ` +
      `(echo "$BASHPID" > grandchild.pid; sleep 30) & wait) & wait`,
  });

  it("rejects a symlink that escapes workspace containment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-linux-filesystem-"));
    const outside = await mkdtemp(path.join(tmpdir(), "fast-linux-outside-"));
    temporaryDirectories.push(root, outside);
    await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
    await symlink(outside, path.join(root, "escape"), "dir");
    const host = createCodingToolHost({ workspaceRoot: root }, createNodeLinuxExecutionPorts());
    const result = await host.execute(
      {
        type: "tool_call",
        callId: "linux-symlink",
        name: "read_file",
        arguments: { path: "escape/secret.txt" },
      },
      { runId: runId("linux-symlink"), signal: new AbortController().signal },
    ).outcome;
    expect(result).toMatchObject({ status: "rejected", effectState: "none" });
  });

  it("runs Git evidence through the Linux production port", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-linux-git-"));
    temporaryDirectories.push(root);
    const initialized = await createNodeLinuxExecutionPorts().git.run(
      root,
      ["init", "-q"],
      new AbortController().signal,
      4_096,
      [],
    );
    expect(initialized.status).toBe("succeeded");
    const status = await createNodeLinuxExecutionPorts().git.run(
      root,
      ["status", "--short"],
      new AbortController().signal,
      4_096,
      [],
    );
    expect(status).toMatchObject({ status: "succeeded", abortObserved: false });
  });
});
