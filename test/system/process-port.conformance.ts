import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalProcessPort } from "../../packages/coding/src/tools/local-execution-ports.js";

export interface ProcessConformanceDialect {
  readonly successCommand: string;
  readonly quotingCommand: string;
  readonly failureCommand: string;
  readonly environmentCommand: string;
  readonly outputLimitCommand: string;
  readonly treeCommand: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10 })),
  );
});

async function waitForFiles(root: string, names: readonly string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await Promise.all(names.map((name) => access(path.join(root, name))));
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("process tree pid evidence 未及时生成");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const closingParenthesis = stat.lastIndexOf(")");
        if (closingParenthesis >= 0 && stat.slice(closingParenthesis + 2).startsWith("Z ")) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function request(command: string, cwd: string, timeoutMs = 5_000) {
  return {
    command,
    cwd,
    signal: new AbortController().signal,
    timeoutMs,
    inlineOutputBytes: 4_096,
    registeredSecrets: [] as readonly string[],
  };
}

export function defineProcessPortConformance(
  name: string,
  createPort: () => LocalProcessPort,
  dialect: ProcessConformanceDialect,
): void {
  describe(`${name} process conformance`, () => {
    it("preserves cwd, quoting and separate stdout/stderr", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "fast-process-conformance-"));
      temporaryDirectories.push(root);
      const successful = await createPort().run(request(dialect.successCommand, root));
      expect(successful).toMatchObject({ status: "succeeded", abortObserved: false });
      expect(JSON.parse(successful.modelContent)).toEqual({
        exitCode: 0,
        stdout: root,
        stderr: "err",
      });
      const quoted = await createPort().run(request(dialect.quotingCommand, root));
      expect(JSON.parse(quoted.modelContent).stdout).toBe('space " quote');
    });

    it("returns a canonical failed outcome for non-zero exit", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "fast-process-conformance-"));
      temporaryDirectories.push(root);
      const result = await createPort().run(request(dialect.failureCommand, root));
      expect(result).toMatchObject({
        status: "failed",
        effectState: "unknown",
        evidence: { exitCode: 7 },
      });
      expect(JSON.parse(result.modelContent).stderr).toBe("bad");
    });

    it("removes credential-shaped environment and spills bounded output", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "fast-process-conformance-"));
      temporaryDirectories.push(root);
      process.env.FAST_M5_PROCESS_SECRET = "registered-process-secret";
      try {
        const environment = await createPort().run(request(dialect.environmentCommand, root));
        expect(JSON.parse(environment.modelContent).stdout).toBe("<missing>");
        const limited = await createPort().run({
          ...request(dialect.outputLimitCommand, root),
          inlineOutputBytes: 64,
        });
        expect(limited).toMatchObject({
          status: "output_limit",
          evidence: { truncated: true, captureComplete: true },
          artifactBytes: expect.any(Uint8Array),
        });
      } finally {
        delete process.env.FAST_M5_PROCESS_SECRET;
      }
    });

    it("does not start a pre-aborted command", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "fast-process-conformance-"));
      temporaryDirectories.push(root);
      const controller = new AbortController();
      controller.abort();
      const result = await createPort().run({
        ...request(dialect.failureCommand, root),
        signal: controller.signal,
      });
      expect(result).toMatchObject({ status: "cancelled", abortObserved: true });
    });

    it("confirms process-tree cleanup before returning timeout", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "fast-process-conformance-"));
      temporaryDirectories.push(root);
      const pending = createPort().run(request(dialect.treeCommand, root, 3_000));
      await waitForFiles(root, ["child.pid", "grandchild.pid"]);
      const childPid = Number(await readFile(path.join(root, "child.pid"), "utf8"));
      const grandchildPid = Number(await readFile(path.join(root, "grandchild.pid"), "utf8"));
      await expect(pending).resolves.toMatchObject({ status: "timed_out" });
      expect(isRunning(childPid)).toBe(false);
      expect(isRunning(grandchildPid)).toBe(false);
    }, 20_000);

    it("confirms process-tree cleanup before returning cancellation", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "fast-process-conformance-"));
      temporaryDirectories.push(root);
      const controller = new AbortController();
      const pending = createPort().run({
        ...request(dialect.treeCommand, root, 10_000),
        signal: controller.signal,
      });
      await waitForFiles(root, ["child.pid", "grandchild.pid"]);
      const childPid = Number(await readFile(path.join(root, "child.pid"), "utf8"));
      const grandchildPid = Number(await readFile(path.join(root, "grandchild.pid"), "utf8"));
      controller.abort();
      await expect(pending).resolves.toMatchObject({ status: "cancelled", abortObserved: true });
      expect(isRunning(childPid)).toBe(false);
      expect(isRunning(grandchildPid)).toBe(false);
    }, 15_000);
  });
}
