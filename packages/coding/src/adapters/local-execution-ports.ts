import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, open, opendir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, JsonValue } from "@coding-agent/model";

export interface LocalFileInfo {
  readonly directory: boolean;
  readonly symbolicLink: boolean;
  readonly device: number;
  readonly inode: number;
}

export interface LocalDirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly file: boolean;
  readonly symbolicLink: boolean;
}

export interface LocalAtomicFile extends AsyncDisposable {
  write(content: string): Promise<void>;
  sync(): Promise<void>;
  stat(): Promise<Pick<LocalFileInfo, "device" | "inode">>;
}

export interface LocalFilesystemPort {
  captureWorkspaceRoot(input: string): string;
  realpath(input: string): Promise<string>;
  inspect(input: string): Promise<LocalFileInfo>;
  read(input: string, signal?: AbortSignal): Promise<Uint8Array>;
  list(input: string): Promise<readonly LocalDirectoryEntry[]>;
  openExclusive(input: string): Promise<LocalAtomicFile>;
  rename(source: string, destination: string): Promise<void>;
  remove(input: string): Promise<void>;
}

export interface LocalProcessRequest {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly inlineOutputBytes: number;
  readonly registeredSecrets: readonly string[];
}

export interface LocalProcessResult {
  readonly status: "succeeded" | "rejected" | "failed" | "timed_out" | "output_limit" | "cancelled";
  readonly modelContent: string;
  readonly effectState: "unknown";
  readonly abortObserved: boolean;
  readonly artifactBytes?: Uint8Array;
  readonly evidence?: JsonObject;
  readonly infrastructureFailure?: { readonly code: string; readonly message: string };
}

export interface LocalProcessPort {
  runPowerShell(request: LocalProcessRequest): Promise<LocalProcessResult>;
}

export interface LocalGitPort {
  run(
    root: string,
    arguments_: readonly string[],
    signal: AbortSignal,
    maximumBytes: number,
  ): Promise<{
    readonly status: "succeeded" | "failed" | "output_limit" | "cancelled";
    readonly modelContent: string;
    readonly artifactBytes?: Uint8Array;
    readonly evidence?: JsonObject;
    readonly abortObserved: boolean;
  }>;
}

export interface LocalExecutionPorts {
  readonly filesystem: LocalFilesystemPort;
  readonly process: LocalProcessPort;
  readonly git: LocalGitPort;
}

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

function sanitizedEnvironment(registeredSecrets: readonly string[]): NodeJS.ProcessEnv {
  const allowed = new Set([
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
  ]);
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
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => resolve(false));
    killer.once("close", (code) => resolve(code === 0));
  });
}

function runPowerShell(request: LocalProcessRequest): Promise<LocalProcessResult> {
  if (process.platform !== "win32") {
    return Promise.resolve({
      status: "rejected",
      modelContent: "M2 run_command 仅支持 Windows PowerShell",
      effectState: "unknown",
      abortObserved: false,
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
    const settle = (result: LocalProcessResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", request.command],
      {
        cwd: request.cwd,
        env: sanitizedEnvironment(request.registeredSecrets),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>) => {
      const remaining = Math.max(0, captureMaximum + 1 - current.length);
      const next = Buffer.concat([current, chunk.subarray(0, remaining)]);
      if (next.length > captureMaximum) {
        captureExceeded = true;
        termination ??= terminateWindowsProcessTree(child.pid ?? 0);
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const abort = () => {
      termination ??= terminateWindowsProcessTree(child.pid ?? 0);
    };
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      termination ??= terminateWindowsProcessTree(child.pid ?? 0);
    }, request.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      settle({
        status: "failed",
        modelContent: "command process 无法启动",
        effectState: "unknown",
        abortObserved: false,
      });
    });
    child.once("close", async (code) => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
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

function runGit(
  root: string,
  arguments_: readonly string[],
  signal: AbortSignal,
  maximumBytes: number,
): Promise<Awaited<ReturnType<LocalGitPort["run"]>>> {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const settle = (result: Awaited<ReturnType<LocalGitPort["run"]>>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn("git", arguments_, {
      cwd: root,
      env: sanitizedEnvironment([]),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
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
      const result = JSON.stringify({
        exitCode: code,
        stdout: decodeUtf8(stdout),
        stderr: decodeUtf8(stderr),
      });
      const bytes = Buffer.from(result, "utf8");
      if (bytes.length > maximumBytes) {
        settle({
          status: "output_limit",
          modelContent: decodeUtf8Prefix(bytes.subarray(0, maximumBytes)),
          artifactBytes: bytes,
          evidence: { truncated: true, originalBytes: bytes.length, budget: "modelContent" },
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
    });
  });
}

export function createNodeLocalExecutionPorts(): LocalExecutionPorts {
  return {
    filesystem: {
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
    },
    process: { runPowerShell },
    git: { run: runGit },
  };
}
