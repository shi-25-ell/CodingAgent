import { spawn } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { lstat, open, opendir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@coding-agent/model";
import type {
  LocalDirectoryEntry,
  LocalExecutionPorts,
  LocalFilesystemPort,
  LocalGitPort,
  LocalProcessRequest,
  LocalProcessResult,
} from "../tools/local-execution-ports.js";

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function decodeUtf8Prefix(bytes: Uint8Array): string {
  for (let length = bytes.length; length >= 0; length -= 1) {
    try {
      return decodeUtf8(bytes.subarray(0, length));
    } catch (_error) {
      // A bounded UTF-8 prefix may end inside one multi-byte code point.
    }
  }
  return "";
}

function sanitizedEnvironment(
  platform: "windows" | "linux",
  registeredSecrets: readonly string[],
): NodeJS.ProcessEnv {
  const allowed = new Set(
    platform === "windows"
      ? [
          "APPDATA",
          "COMSPEC",
          "LOCALAPPDATA",
          "NUMBER_OF_PROCESSORS",
          "OS",
          "PATH",
          "PATHEXT",
          "PROCESSOR_ARCHITECTURE",
          "PROCESSOR_IDENTIFIER",
          "SYSTEMROOT",
          "TEMP",
          "TMP",
          "USERPROFILE",
          "WINDIR",
        ]
      : ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "SHELL", "TMPDIR", "USER"],
  );
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        allowed.has(name.toUpperCase()) &&
        !/(?:credential|secret|token|password|api[_-]?key)/i.test(name) &&
        (value === undefined || !registeredSecrets.includes(value)),
    ),
  );
}

function terminateWindowsProcessTree(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      killer.kill();
      finish(false);
    }, 10_000);
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

function linuxProcessGroupHasLiveMembers(pid: number): boolean {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch {
        continue;
      }
      const closingParenthesis = stat.lastIndexOf(")");
      if (closingParenthesis < 0) continue;
      const fields = stat.slice(closingParenthesis + 2).split(" ");
      const state = fields[0];
      const processGroup = Number(fields[2]);
      if (processGroup === pid && state !== "Z") return true;
    }
    return false;
  } catch {
    // Non-/proc Linux environments fall back to the conservative process-group probe above.
    return true;
  }
}

async function terminateLinuxProcessTree(pid: number): Promise<boolean> {
  if (pid <= 0) return false;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return true;
    }
    return false;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  if (linuxProcessGroupHasLiveMembers(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (
        !(error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH")
      ) {
        return false;
      }
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!linuxProcessGroupHasLiveMembers(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return !linuxProcessGroupHasLiveMembers(pid);
}

interface ShellExecution {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly platform: "windows" | "linux";
  readonly detached: boolean;
  terminate(pid: number): Promise<boolean>;
}

function runShell(
  request: LocalProcessRequest,
  shell: ShellExecution,
): Promise<LocalProcessResult> {
  if (request.signal.aborted) {
    return Promise.resolve({
      status: "cancelled",
      modelContent: "command 已取消",
      effectState: "unknown",
      abortObserved: true,
    });
  }
  return new Promise<LocalProcessResult>((resolve) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const captureMaximum = Math.max(
      request.inlineOutputBytes,
      Math.min(request.inlineOutputBytes * 16, 8 * 1024 * 1024),
    );
    let captureExceeded = false;
    let timedOut = false;
    let termination: Promise<boolean> | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = (): void => {};
    const settle = (result: LocalProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const child = spawn(shell.executable, [...shell.arguments, request.command], {
      cwd: request.cwd,
      env: sanitizedEnvironment(shell.platform, request.registeredSecrets),
      windowsHide: true,
      detached: shell.detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>) => {
      const remaining = Math.max(0, captureMaximum + 1 - current.length);
      const next = Buffer.concat([current, chunk.subarray(0, remaining)]);
      if (next.length > captureMaximum) {
        captureExceeded = true;
        termination ??= shell.terminate(child.pid ?? 0);
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const terminateWithOutcome = async (status: "cancelled" | "timed_out"): Promise<void> => {
      termination ??= shell.terminate(child.pid ?? 0);
      if (!(await termination)) {
        settle({
          status: "failed",
          modelContent: "process tree cleanup 无法确认",
          effectState: "unknown",
          abortObserved: request.signal.aborted,
          infrastructureFailure: {
            code: "PROCESS_CLEANUP_UNCONFIRMED",
            message: "process tree cleanup 无法确认",
          },
        });
        return;
      }
      settle({
        status,
        modelContent: status === "cancelled" ? "command 已取消" : "command 超时",
        effectState: "unknown",
        abortObserved: status === "cancelled",
      });
    };
    abort = () => {
      void terminateWithOutcome("cancelled");
    };
    request.signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      void terminateWithOutcome("timed_out");
    }, request.timeoutMs);
    child.once("error", () => {
      settle({
        status: "failed",
        modelContent: "command process 无法启动",
        effectState: "unknown",
        abortObserved: false,
      });
    });
    child.once("close", async (code) => {
      if (termination && !(await termination)) {
        settle({
          status: "failed",
          modelContent: "process tree cleanup 无法确认",
          effectState: "unknown",
          abortObserved: request.signal.aborted,
          infrastructureFailure: {
            code: "PROCESS_CLEANUP_UNCONFIRMED",
            message: "process tree cleanup 无法确认",
          },
        });
        return;
      }
      if (request.signal.aborted) {
        settle({
          status: "cancelled",
          modelContent: "command 已取消",
          effectState: "unknown",
          abortObserved: true,
        });
        return;
      }
      if (timedOut) {
        settle({
          status: "timed_out",
          modelContent: "command 超时",
          effectState: "unknown",
          abortObserved: false,
        });
        return;
      }
      try {
        const result = JSON.stringify({
          exitCode: code,
          stdout: captureExceeded ? decodeUtf8Prefix(stdout) : decodeUtf8(stdout),
          stderr: captureExceeded ? decodeUtf8Prefix(stderr) : decodeUtf8(stderr),
        });
        const resultBytes = Buffer.from(result, "utf8");
        if (captureExceeded || resultBytes.length > request.inlineOutputBytes) {
          const inline = decodeUtf8Prefix(resultBytes.subarray(0, request.inlineOutputBytes));
          settle({
            status: "output_limit",
            modelContent: inline,
            effectState: "unknown",
            abortObserved: false,
            artifactBytes: resultBytes,
            evidence: {
              truncated: true,
              stdoutBytes: stdout.length,
              stderrBytes: stderr.length,
              inlineBytes: Buffer.byteLength(inline),
              captureComplete: !captureExceeded,
              exitCode: code,
            },
          });
          return;
        }
        settle({
          status: code === 0 ? "succeeded" : "failed",
          modelContent: result,
          effectState: "unknown",
          abortObserved: false,
          evidence: { exitCode: code as JsonValue },
        });
      } catch (_error) {
        settle({
          status: "failed",
          modelContent: "command output 不是有效 UTF-8",
          effectState: "unknown",
          abortObserved: false,
        });
      }
    });
  });
}

function runWindowsPowerShell(request: LocalProcessRequest): Promise<LocalProcessResult> {
  return runShell(request, {
    executable: "powershell.exe",
    arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    platform: "windows",
    detached: false,
    terminate: terminateWindowsProcessTree,
  });
}

function runLinuxBash(request: LocalProcessRequest): Promise<LocalProcessResult> {
  return runShell(request, {
    executable: "/bin/bash",
    arguments: ["--noprofile", "--norc", "-c"],
    platform: "linux",
    detached: true,
    terminate: terminateLinuxProcessTree,
  });
}

function runGit(
  root: string,
  arguments_: readonly string[],
  signal: AbortSignal,
  maximumBytes: number,
  registeredSecrets: readonly string[],
): Promise<Awaited<ReturnType<LocalGitPort["run"]>>> {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const captureMaximum = Math.max(maximumBytes, Math.min(maximumBytes * 16, 8 * 1024 * 1024));
    let captureExceeded = false;
    let settled = false;
    const settle = (result: Awaited<ReturnType<LocalGitPort["run"]>>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn("git", arguments_, {
      cwd: root,
      env: sanitizedEnvironment(
        process.platform === "win32" ? "windows" : "linux",
        registeredSecrets,
      ),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>) => {
      const remaining = Math.max(0, captureMaximum + 1 - current.length);
      const next = Buffer.concat([current, chunk.subarray(0, remaining)]);
      if (next.length > captureMaximum) {
        captureExceeded = true;
        child.kill();
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => {
      signal.removeEventListener("abort", abort);
      settle({
        status: "failed",
        modelContent: "Git process 无法启动",
        abortObserved: false,
      });
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        settle({ status: "cancelled", modelContent: "Git evidence 已取消", abortObserved: true });
        return;
      }
      try {
        const result = JSON.stringify({
          exitCode: code,
          stdout: captureExceeded ? decodeUtf8Prefix(stdout) : decodeUtf8(stdout),
          stderr: captureExceeded ? decodeUtf8Prefix(stderr) : decodeUtf8(stderr),
        });
        const bytes = Buffer.from(result, "utf8");
        if (captureExceeded || bytes.length > maximumBytes) {
          settle({
            status: "output_limit",
            modelContent: decodeUtf8Prefix(bytes.subarray(0, maximumBytes)),
            artifactBytes: bytes,
            evidence: {
              truncated: true,
              stdoutBytes: stdout.length,
              stderrBytes: stderr.length,
              originalBytes: bytes.length,
              captureComplete: !captureExceeded,
              budget: "modelContent",
            },
            abortObserved: false,
          });
          return;
        }
        settle({
          status: code === 0 ? "succeeded" : "failed",
          modelContent: result,
          evidence: { exitCode: code as JsonValue },
          abortObserved: false,
        });
      } catch (_error) {
        settle({
          status: "failed",
          modelContent: "Git output 不是有效 UTF-8",
          abortObserved: false,
        });
      }
    });
  });
}

function createBunFilesystemPort(): LocalFilesystemPort {
  return {
    captureWorkspaceRoot: (input) => realpathSync.native(path.resolve(input)),
    realpath,
    async inspect(input) {
      const info = await lstat(input);
      return {
        directory: info.isDirectory(),
        symbolicLink: info.isSymbolicLink(),
        device: info.dev,
        inode: info.ino,
      };
    },
    async read(input, signal) {
      return readFile(input, signal ? { signal } : undefined);
    },
    async list(input) {
      const directory = await opendir(input);
      const entries: LocalDirectoryEntry[] = [];
      for await (const entry of directory) {
        entries.push({
          name: entry.name,
          directory: entry.isDirectory(),
          file: entry.isFile(),
          symbolicLink: entry.isSymbolicLink(),
        });
      }
      return entries;
    },
    async openExclusive(input) {
      const handle = await open(input, "wx", 0o600);
      return {
        write: (content) => handle.writeFile(content, "utf8"),
        sync: () => handle.sync(),
        async stat() {
          const info = await handle.stat();
          return { device: info.dev, inode: info.ino };
        },
        async [Symbol.asyncDispose]() {
          await handle.close();
        },
      };
    },
    rename,
    remove: (input) => rm(input, { force: true }),
  };
}

export function createBunWindowsExecutionPorts(): LocalExecutionPorts {
  return {
    filesystem: createBunFilesystemPort(),
    process: { run: runWindowsPowerShell },
    git: { run: runGit },
  };
}

export function createBunLinuxExecutionPorts(): LocalExecutionPorts {
  return {
    filesystem: createBunFilesystemPort(),
    process: { run: runLinuxBash },
    git: { run: runGit },
  };
}

export function createBunLocalExecutionPorts(): LocalExecutionPorts {
  return process.platform === "win32"
    ? createBunWindowsExecutionPorts()
    : createBunLinuxExecutionPorts();
}
