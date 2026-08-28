import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, open, opendir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ToolDefinition,
  ToolExecution,
  ToolExecutor,
  ToolOutcome,
  ToolUpdate,
} from "@coding-agent/agent";
import type { JsonObject, JsonValue, ToolCall } from "@coding-agent/model";

export interface CodingToolHostOptions {
  readonly workspaceRoot: string;
  readonly maxOutputBytes?: number;
  readonly commandTimeoutMs?: number;
  readonly redactValues?: readonly string[];
  readonly redact?: (value: string) => string;
}

type FailureStatus =
  | "rejected"
  | "failed"
  | "timed_out"
  | "output_limit"
  | "cancelled"
  | "conflict";

class ToolFailure extends Error {
  readonly status: FailureStatus;
  readonly effectState: ToolOutcome["effectState"];
  readonly abortObserved: boolean;
  readonly modelContent: string;

  constructor(
    status: FailureStatus,
    modelContent: string,
    options?: {
      readonly effectState?: ToolOutcome["effectState"];
      readonly abortObserved?: boolean;
    },
  ) {
    super(modelContent);
    this.name = "ToolFailure";
    this.status = status;
    this.modelContent = modelContent;
    this.effectState = options?.effectState ?? "none";
    this.abortObserved = options?.abortObserved ?? false;
  }
}

const definitions: readonly ToolDefinition[] = [
  {
    name: "read_file",
    description: "读取 workspace 内的 UTF-8 文件",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_text",
    description: "在 workspace 文件中进行纯文本搜索",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, path: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description: "通过唯一 oldText 匹配修改 workspace 内的 UTF-8 文件",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description: "在 workspace 内通过固定的 non-interactive shell 执行前台命令",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, cwd: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

async function* noUpdates(): AsyncIterable<ToolUpdate> {}

function ensureObject(value: JsonObject): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ToolFailure("rejected", "Tool arguments 必须是 JSON object");
  }
  return value;
}

function validateKeys(
  input: Record<string, JsonValue>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ToolFailure("rejected", "Tool arguments 包含未知字段");
  }
  if (required.some((key) => !(key in input))) {
    throw new ToolFailure("rejected", "Tool arguments 缺少必填字段");
  }
}

function stringArgument(input: Record<string, JsonValue>, key: string, allowEmpty = false): string {
  const value = input[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new ToolFailure("rejected", `${key} 必须是${allowEmpty ? "" : "非空"} string`);
  }
  return value;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function lexicalPath(root: string, value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    /^[\\/]{2}/.test(value) ||
    /^\\\\[?.]\\/.test(value)
  ) {
    throw new ToolFailure("rejected", "path 必须是 workspace-relative path");
  }
  const candidate = path.resolve(root, value);
  if (!isWithin(candidate, root)) {
    throw new ToolFailure("rejected", "path 不能逃逸 workspace");
  }
  return candidate;
}

async function readTarget(root: string, value: string): Promise<string> {
  const candidate = lexicalPath(root, value);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (_error) {
    throw new ToolFailure("failed", "目标文件不存在或不可访问");
  }
  if (!isWithin(resolved, root)) throw new ToolFailure("rejected", "symlink 目标逃逸 workspace");
  return resolved;
}

async function mutationTarget(root: string, value: string): Promise<string> {
  const candidate = lexicalPath(root, value);
  const relative = path.relative(root, candidate);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new ToolFailure("rejected", "mutation 不允许 symlink/junction 路径");
      }
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        break;
      }
      throw new ToolFailure("failed", "mutation path 无法校验");
    }
  }
  if (segments[0]?.toLowerCase() === ".git") {
    throw new ToolFailure("rejected", "禁止直接修改 .git");
  }
  return candidate;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_error) {
    throw new ToolFailure("rejected", "仅支持有效 UTF-8 text");
  }
}

function decodeUtf8Prefix(bytes: Uint8Array): string {
  for (let length = bytes.length; length >= 0; length -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch (_error) {
      // A bounded UTF-8 prefix may end inside one multi-byte code point.
    }
  }
  return "";
}

function bounded(
  text: string,
  maximum: number,
  effectState: ToolOutcome["effectState"] = "none",
): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return text;
  throw new ToolFailure("output_limit", decodeUtf8Prefix(bytes.subarray(0, maximum)), {
    effectState,
  });
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolFailure("cancelled", "ToolCall 已取消", { abortObserved: true });
  }
}

async function readFileTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
): Promise<string> {
  validateKeys(args, ["path"]);
  const relative = stringArgument(args, "path");
  checkAbort(signal);
  const target = await readTarget(root, relative);
  const bytes = await readFile(target, { signal });
  checkAbort(signal);
  return bounded(`${relative}\n${decodeUtf8(bytes)}`, maximum);
}

async function* filesUnder(root: string, directory: string): AsyncIterable<string> {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      yield* filesUnder(root, target);
    } else if (entry.isFile() && isWithin(target, root)) {
      yield target;
    }
  }
}

async function searchTextTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
): Promise<string> {
  validateKeys(args, ["query"], ["path"]);
  const query = stringArgument(args, "query");
  const relative = args.path === undefined ? "." : stringArgument(args, "path");
  checkAbort(signal);
  const target = await readTarget(root, relative);
  const info = await lstat(target);
  const candidates = info.isDirectory()
    ? filesUnder(root, target)
    : (async function* () {
        yield target;
      })();
  const matches: string[] = [];
  for await (const file of candidates) {
    checkAbort(signal);
    let text: string;
    try {
      text = decodeUtf8(await readFile(file, { signal }));
    } catch (error) {
      if (error instanceof ToolFailure && error.status === "rejected") continue;
      throw error;
    }
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(query)) matches.push(`${path.relative(root, file)}:${index + 1}:${line}`);
    });
  }
  return bounded(matches.join("\n"), maximum);
}

async function applyPatchTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<string> {
  validateKeys(args, ["path", "oldText", "newText"]);
  const relative = stringArgument(args, "path");
  const oldText = stringArgument(args, "oldText");
  const newText = stringArgument(args, "newText", true);
  checkAbort(signal);
  const target = await mutationTarget(root, relative);
  let original: string;
  try {
    original = decodeUtf8(await readFile(target, { signal }));
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    throw new ToolFailure("failed", "patch 目标文件不存在或不可访问");
  }
  const first = original.indexOf(oldText);
  if (first < 0 || original.indexOf(oldText, first + oldText.length) >= 0) {
    throw new ToolFailure("conflict", "oldText 必须在目标文件中唯一匹配");
  }
  const updated = `${original.slice(0, first)}${newText}${original.slice(first + oldText.length)}`;
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(updated, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    checkAbort(signal);
    await mutationTarget(root, relative);
    let current: string;
    try {
      current = decodeUtf8(await readFile(target, { signal }));
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      throw new ToolFailure("conflict", "patch 目标在提交前不可访问");
    }
    if (current !== original) {
      throw new ToolFailure("conflict", "patch 目标在提交前已变化");
    }
    checkAbort(signal);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return JSON.stringify({ path: relative, changed: true });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/(?:credential|secret|token|password|api[_-]?key)/i.test(name),
    ),
  );
}

async function runCommandTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
  timeoutMs: number,
): Promise<string> {
  validateKeys(args, ["command"], ["cwd"]);
  const command = stringArgument(args, "command");
  const relativeCwd = args.cwd === undefined ? "." : stringArgument(args, "cwd");
  checkAbort(signal);
  const cwd = await readTarget(root, relativeCwd);
  if (!(await lstat(cwd)).isDirectory()) throw new ToolFailure("rejected", "cwd 必须是 directory");
  checkAbort(signal);
  const executable = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const shellArgs =
    process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
      : ["--noprofile", "--norc", "-c", command];
  return new Promise<string>((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let exceeded = false;
    let timedOut = false;
    const child = spawn(executable, shellArgs, {
      cwd,
      env: sanitizedEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      const remaining = Math.max(0, maximum + 1 - current.length);
      const next = Buffer.concat([current, chunk.subarray(0, remaining)]);
      if (next.length > maximum) {
        exceeded = true;
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new ToolFailure("failed", "command process 无法启动"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        reject(
          new ToolFailure("cancelled", "command 已取消", {
            effectState: "unknown",
            abortObserved: true,
          }),
        );
        return;
      }
      if (timedOut) {
        reject(new ToolFailure("timed_out", "command 超时", { effectState: "unknown" }));
        return;
      }
      if (exceeded) {
        reject(
          new ToolFailure("output_limit", decodeUtf8Prefix(stdout.subarray(0, maximum)), {
            effectState: "unknown",
          }),
        );
        return;
      }
      const result = JSON.stringify({
        exitCode: code,
        stdout: decodeUtf8(stdout),
        stderr: decodeUtf8(stderr),
      });
      if (code !== 0) {
        reject(new ToolFailure("failed", bounded(result, maximum), { effectState: "none" }));
        return;
      }
      resolve(bounded(result, maximum));
    });
  });
}

function outcomeFromFailure(callId: string, failure: ToolFailure): ToolOutcome {
  return {
    callId,
    status: failure.status,
    isError: true,
    modelContent: failure.modelContent,
    effectState: failure.effectState,
    abortObserved: failure.abortObserved,
    artifacts: [],
  };
}

export function createCodingToolHost(options: CodingToolHostOptions): ToolExecutor {
  const root = realpathSync.native(path.resolve(options.workspaceRoot));
  const maximum = options.maxOutputBytes ?? 128 * 1024;
  const timeoutMs = options.commandTimeoutMs ?? 30_000;
  const redactValues = (options.redactValues ?? []).filter((value) => value.length > 0);
  const redact = (value: string): string => {
    const staticallyRedacted = redactValues.reduce(
      (text, secret) => text.split(secret).join("[REDACTED]"),
      value,
    );
    return options.redact?.(staticallyRedacted) ?? staticallyRedacted;
  };
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new TypeError("maxOutputBytes 必须是正安全整数");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("commandTimeoutMs 必须是正安全整数");
  }
  return {
    definitions: () => definitions,
    execute(call: ToolCall, context): ToolExecution {
      const result = (async (): Promise<ToolOutcome> => {
        try {
          checkAbort(context.signal);
          const args = ensureObject(call.arguments);
          let modelContent: string;
          let effectState: ToolOutcome["effectState"] = "none";
          switch (call.name) {
            case "read_file":
              modelContent = await readFileTool(root, args, context.signal, maximum);
              break;
            case "search_text":
              modelContent = await searchTextTool(root, args, context.signal, maximum);
              break;
            case "apply_patch":
              modelContent = await applyPatchTool(root, args, context.signal);
              effectState = "committed";
              break;
            case "run_command":
              modelContent = await runCommandTool(root, args, context.signal, maximum, timeoutMs);
              break;
            default:
              throw new ToolFailure("rejected", `未知 tool: ${call.name}`);
          }
          return {
            callId: call.callId,
            status: "succeeded",
            isError: false,
            modelContent: redact(modelContent),
            effectState,
            abortObserved: false,
            artifacts: [],
          };
        } catch (error) {
          if (error instanceof ToolFailure) {
            return outcomeFromFailure(
              call.callId,
              new ToolFailure(error.status, redact(error.modelContent), {
                effectState: error.effectState,
                abortObserved: error.abortObserved,
              }),
            );
          }
          if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            return outcomeFromFailure(
              call.callId,
              new ToolFailure("cancelled", "ToolCall 已取消", { abortObserved: true }),
            );
          }
          return outcomeFromFailure(
            call.callId,
            new ToolFailure("failed", "Tool execution failed"),
          );
        }
      })();
      return { updates: noUpdates(), outcome: result };
    },
  };
}
