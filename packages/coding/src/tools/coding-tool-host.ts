import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, open, opendir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  RunId,
  ToolDefinition,
  ToolExecution,
  ToolExecutor,
  ToolOutcome,
  ToolUpdate,
} from "@coding-agent/agent";
import type { JsonObject, JsonValue, ToolCall } from "@coding-agent/model";
import {
  createEphemeralArtifactStore,
  type ToolArtifactStore,
} from "./ephemeral-artifact-store.js";
import { ToolRegistry, type ToolRegistrySnapshot } from "./tool-registry.js";

export type PermissionMode = "safe" | "autonomous";
export type ToolEffect = "workspace_read" | "workspace_mutation" | "process" | "git_evidence";

export interface ToolResource {
  readonly kind: "path" | "command";
  readonly value: string;
}

export type ToolPrecondition =
  | { readonly kind: "content_hash"; readonly resource: string; readonly value: string }
  | { readonly kind: "path_absent"; readonly resource: string };

export interface ToolPlan {
  readonly callId: string;
  readonly toolName: string;
  readonly normalizedArguments: JsonObject;
  readonly resources: readonly ToolResource[];
  readonly effects: readonly ToolEffect[];
  readonly risks: readonly string[];
  readonly preconditions: readonly ToolPrecondition[];
  readonly policyVersion: string;
  readonly fingerprint: string;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly runId: RunId;
  readonly plan: ToolPlan;
}

export interface ApprovalResponse {
  readonly decision: "allow_once" | "deny";
  readonly planFingerprint: string;
}

export interface ApprovalPort {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResponse>;
}

export interface CodingToolHostOptions {
  readonly workspaceRoot: string;
  readonly maxOutputBytes?: number;
  readonly commandTimeoutMs?: number;
  readonly redactValues?: readonly string[];
  readonly redact?: (value: string) => string;
  readonly permissionMode?: PermissionMode;
  readonly approvalPort?: ApprovalPort;
  readonly policyVersion?: string;
  readonly artifactStore?: ToolArtifactStore;
}

export interface CodingToolHost extends ToolExecutor, AsyncDisposable {
  readonly artifacts: ToolArtifactStore;
}

type FailureStatus =
  | "rejected"
  | "denied"
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
  readonly artifactBytes: Uint8Array | undefined;
  readonly evidence: JsonObject | undefined;

  constructor(
    status: FailureStatus,
    modelContent: string,
    options?: {
      readonly effectState?: ToolOutcome["effectState"];
      readonly abortObserved?: boolean;
      readonly artifactBytes?: Uint8Array;
      readonly evidence?: JsonObject;
    },
  ) {
    super(modelContent);
    this.name = "ToolFailure";
    this.status = status;
    this.modelContent = modelContent;
    this.effectState = options?.effectState ?? "none";
    this.abortObserved = options?.abortObserved ?? false;
    this.artifactBytes = options?.artifactBytes;
    this.evidence = options?.evidence;
  }
}

const definitions: readonly ToolDefinition[] = [
  {
    name: "list_files",
    description: "列出 workspace 目录且不跟随 symlink directory",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      additionalProperties: false,
    },
  },
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
    name: "create_file",
    description: "原子创建 workspace 内的 UTF-8 文件",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
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
        expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
  },
  {
    name: "replace_file",
    description: "按 content hash 原子替换 workspace 内的 UTF-8 文件",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        content: { type: "string" },
      },
      required: ["path", "expectedHash", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "按 content hash 删除 workspace 内的 UTF-8 文件",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["path", "expectedHash"],
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
  {
    name: "git_status",
    description: "读取 workspace Git status evidence",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "git_diff",
    description: "读取 workspace Git diff evidence",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, cached: { type: "boolean" } },
      additionalProperties: false,
    },
  },
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] ?? null)}`)
    .join(",")}}`;
}

function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createRegistry(): ToolRegistrySnapshot {
  const registry = new ToolRegistry();
  for (const definition of definitions) registry.register({ definition });
  return registry.snapshot();
}

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

function modelPath(value: string): string {
  return value.split(path.sep).join("/");
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

async function createPlan(
  root: string,
  call: ToolCall,
  args: Record<string, JsonValue>,
  policyVersion: string,
): Promise<ToolPlan> {
  const resources: ToolResource[] = [];
  const effects: ToolEffect[] = [];
  const risks: string[] = [];
  const preconditions: ToolPrecondition[] = [];
  switch (call.name) {
    case "list_files": {
      const relative = args.path === undefined ? "." : stringArgument(args, "path");
      lexicalPath(root, relative);
      resources.push({ kind: "path", value: relative });
      effects.push("workspace_read");
      break;
    }
    case "read_file": {
      const relative = stringArgument(args, "path");
      lexicalPath(root, relative);
      resources.push({ kind: "path", value: relative });
      effects.push("workspace_read");
      break;
    }
    case "search_text": {
      const relative = args.path === undefined ? "." : stringArgument(args, "path");
      lexicalPath(root, relative);
      resources.push({ kind: "path", value: relative });
      effects.push("workspace_read");
      break;
    }
    case "create_file": {
      const relative = stringArgument(args, "path");
      await mutationTarget(root, relative);
      resources.push({ kind: "path", value: relative });
      effects.push("workspace_mutation");
      risks.push("创建 workspace 文件");
      preconditions.push({ kind: "path_absent", resource: relative });
      break;
    }
    case "apply_patch": {
      const relative = stringArgument(args, "path");
      const target = await mutationTarget(root, relative);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(target);
      } catch (_error) {
        throw new ToolFailure("failed", "patch 目标文件不存在或不可访问");
      }
      resources.push({ kind: "path", value: relative });
      effects.push("workspace_mutation");
      risks.push("修改 workspace 文件");
      preconditions.push({ kind: "content_hash", resource: relative, value: contentHash(bytes) });
      if (args.expectedHash !== undefined && args.expectedHash !== contentHash(bytes)) {
        throw new ToolFailure("conflict", "expectedHash 与当前内容不一致");
      }
      break;
    }
    case "replace_file":
    case "delete_file": {
      const relative = stringArgument(args, "path");
      const expectedHash = stringArgument(args, "expectedHash");
      const target = await mutationTarget(root, relative);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(target);
      } catch (_error) {
        throw new ToolFailure("failed", "目标文件不存在或不可访问");
      }
      decodeUtf8(bytes);
      const actualHash = contentHash(bytes);
      if (expectedHash !== actualHash) {
        throw new ToolFailure("conflict", "expectedHash 与当前内容不一致");
      }
      resources.push({ kind: "path", value: relative });
      effects.push("workspace_mutation");
      risks.push(call.name === "replace_file" ? "替换 workspace 文件" : "删除 workspace 文件");
      preconditions.push({ kind: "content_hash", resource: relative, value: actualHash });
      break;
    }
    case "run_command": {
      const command = stringArgument(args, "command");
      const relative = args.cwd === undefined ? "." : stringArgument(args, "cwd");
      lexicalPath(root, relative);
      resources.push({ kind: "command", value: command }, { kind: "path", value: relative });
      effects.push("process");
      risks.push("启动 workspace-scoped foreground process");
      break;
    }
    case "git_status":
      resources.push({ kind: "path", value: ".git" });
      effects.push("git_evidence");
      break;
    case "git_diff": {
      const relative = args.path === undefined ? "." : stringArgument(args, "path");
      lexicalPath(root, relative);
      resources.push({ kind: "path", value: relative });
      effects.push("git_evidence");
      break;
    }
    default:
      throw new ToolFailure("rejected", `未知 tool: ${call.name}`);
  }
  const draft = {
    callId: call.callId,
    toolName: call.name,
    normalizedArguments: structuredClone(args) as JsonObject,
    resources,
    effects,
    risks,
    preconditions,
    policyVersion,
  };
  const fingerprint = createHash("sha256")
    .update(canonicalJson(draft as unknown as JsonObject))
    .digest("hex");
  return deepFreeze({ ...draft, fingerprint });
}

async function enforceHardGuard(root: string, plan: ToolPlan): Promise<void> {
  const args = ensureObject(plan.normalizedArguments);
  switch (plan.toolName) {
    case "list_files":
      await readTarget(root, args.path === undefined ? "." : stringArgument(args, "path"));
      return;
    case "read_file":
      await readTarget(root, stringArgument(args, "path"));
      return;
    case "search_text":
      await readTarget(root, args.path === undefined ? "." : stringArgument(args, "path"));
      return;
    case "create_file":
    case "apply_patch":
    case "replace_file":
    case "delete_file":
      await mutationTarget(root, stringArgument(args, "path"));
      return;
    case "run_command": {
      const cwd = await readTarget(
        root,
        args.cwd === undefined ? "." : stringArgument(args, "cwd"),
      );
      if (!(await lstat(cwd)).isDirectory()) {
        throw new ToolFailure("rejected", "cwd 必须是 directory");
      }
      return;
    }
    case "git_status":
      return;
    case "git_diff":
      lexicalPath(root, args.path === undefined ? "." : stringArgument(args, "path"));
      return;
  }
}

async function revalidatePreconditions(root: string, plan: ToolPlan): Promise<void> {
  for (const precondition of plan.preconditions) {
    const target = await mutationTarget(root, precondition.resource);
    if (precondition.kind === "path_absent") {
      try {
        await lstat(target);
        throw new ToolFailure("conflict", "目标在批准后已存在");
      } catch (error) {
        if (error instanceof ToolFailure) throw error;
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          continue;
        }
        throw new ToolFailure("conflict", "目标不存在条件无法确认");
      }
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(target);
    } catch (_error) {
      throw new ToolFailure("conflict", "目标在批准后不可访问");
    }
    if (contentHash(bytes) !== precondition.value) {
      throw new ToolFailure("conflict", "目标在批准后已变化");
    }
  }
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
  const inline = Buffer.from(decodeUtf8Prefix(bytes.subarray(0, maximum)));
  throw new ToolFailure("output_limit", inline.toString("utf8"), {
    effectState,
    artifactBytes: bytes,
    evidence: {
      truncated: true,
      originalBytes: bytes.length,
      inlineBytes: inline.length,
      budget: "modelContent",
    },
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
  return bounded(
    JSON.stringify({ path: relative, contentHash: contentHash(bytes), content: decodeUtf8(bytes) }),
    maximum,
  );
}

async function* listEntries(
  root: string,
  directory: string,
  recursive: boolean,
): AsyncIterable<string> {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (entry.name === ".git") continue;
    const target = path.join(directory, entry.name);
    if (!isWithin(target, root)) continue;
    const relative = modelPath(path.relative(root, target));
    if (entry.isSymbolicLink()) {
      yield `${relative}\tsymlink`;
    } else if (entry.isDirectory()) {
      yield `${relative}\tdirectory`;
      if (recursive) yield* listEntries(root, target, true);
    } else if (entry.isFile()) {
      yield `${relative}\tfile`;
    }
  }
}

async function listFilesTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
): Promise<string> {
  validateKeys(args, [], ["path", "recursive"]);
  const relative = args.path === undefined ? "." : stringArgument(args, "path");
  const recursive = args.recursive === undefined ? true : args.recursive;
  if (typeof recursive !== "boolean") throw new ToolFailure("rejected", "recursive 必须是 boolean");
  checkAbort(signal);
  const target = await readTarget(root, relative);
  if (!(await lstat(target)).isDirectory()) {
    throw new ToolFailure("rejected", "list_files path 必须是 directory");
  }
  const entries: string[] = [];
  for await (const entry of listEntries(root, target, recursive)) {
    checkAbort(signal);
    entries.push(entry);
  }
  return bounded(entries.sort().join("\n"), maximum);
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
      if (line.includes(query)) {
        matches.push(`${modelPath(path.relative(root, file))}:${index + 1}:${line}`);
      }
    });
  }
  return bounded(matches.join("\n"), maximum);
}

async function atomicWrite(
  root: string,
  relative: string,
  content: string,
  signal: AbortSignal,
  precondition: { readonly kind: "absent" } | { readonly kind: "hash"; readonly value: string },
): Promise<string> {
  const target = await mutationTarget(root, relative);
  const parent = path.dirname(target);
  let parentResolved: string;
  try {
    parentResolved = await realpath(parent);
  } catch (_error) {
    throw new ToolFailure("failed", "目标 parent directory 不存在或不可访问");
  }
  if (parentResolved !== parent)
    throw new ToolFailure("rejected", "mutation parent 不能是 symlink/junction");
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let committed = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    checkAbort(signal);
    await mutationTarget(root, relative);
    if (precondition.kind === "absent") {
      try {
        await lstat(target);
        throw new ToolFailure("conflict", "create_file 目标已存在");
      } catch (error) {
        if (error instanceof ToolFailure) throw error;
        if (
          error === null ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw new ToolFailure("conflict", "create_file 无法确认目标不存在");
        }
      }
    } else {
      let current: Uint8Array;
      try {
        current = await readFile(target, { signal });
      } catch (_error) {
        throw new ToolFailure("conflict", "目标在提交前不可访问");
      }
      if (contentHash(current) !== precondition.value) {
        throw new ToolFailure("conflict", "目标在提交前已变化");
      }
    }
    checkAbort(signal);
    await rename(temporary, target);
    committed = true;
  } finally {
    await handle.close();
    if (!committed) await rm(temporary, { force: true });
  }
  return JSON.stringify({ path: relative, contentHash: contentHash(Buffer.from(content, "utf8")) });
}

async function createFileTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<string> {
  validateKeys(args, ["path", "content"]);
  return atomicWrite(
    root,
    stringArgument(args, "path"),
    stringArgument(args, "content", true),
    signal,
    { kind: "absent" },
  );
}

async function replaceFileTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<string> {
  validateKeys(args, ["path", "expectedHash", "content"]);
  const relative = stringArgument(args, "path");
  const expectedHash = stringArgument(args, "expectedHash");
  const target = await mutationTarget(root, relative);
  let current: Uint8Array;
  try {
    current = await readFile(target, { signal });
  } catch (_error) {
    throw new ToolFailure("failed", "replace_file 目标不存在或不可访问");
  }
  decodeUtf8(current);
  if (contentHash(current) !== expectedHash) {
    throw new ToolFailure("conflict", "expectedHash 与当前内容不一致");
  }
  return atomicWrite(root, relative, stringArgument(args, "content", true), signal, {
    kind: "hash",
    value: expectedHash,
  });
}

async function deleteFileTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<string> {
  validateKeys(args, ["path", "expectedHash"]);
  const relative = stringArgument(args, "path");
  const expectedHash = stringArgument(args, "expectedHash");
  const target = await mutationTarget(root, relative);
  let current: Uint8Array;
  try {
    current = await readFile(target, { signal });
  } catch (_error) {
    throw new ToolFailure("failed", "delete_file 目标不存在或不可访问");
  }
  decodeUtf8(current);
  if (contentHash(current) !== expectedHash) {
    throw new ToolFailure("conflict", "expectedHash 与当前内容不一致");
  }
  checkAbort(signal);
  const tombstone = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.delete`,
  );
  await rename(target, tombstone);
  try {
    await rm(tombstone);
  } catch (_error) {
    throw new ToolFailure("failed", "文件已移出目标路径但 cleanup 失败", {
      effectState: "partial",
    });
  }
  return JSON.stringify({ path: relative, deleted: true, previousHash: expectedHash });
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
  let committed = false;
  try {
    await handle.writeFile(updated, "utf8");
    await handle.sync();
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
    const [rootNow, parentNow, pathInfo, handleInfo] = await Promise.all([
      realpath(root),
      realpath(path.dirname(target)),
      lstat(temporary),
      handle.stat(),
    ]);
    if (
      rootNow !== root ||
      parentNow !== path.dirname(target) ||
      pathInfo.dev !== handleInfo.dev ||
      pathInfo.ino !== handleInfo.ino
    ) {
      throw new ToolFailure("conflict", "patch path identity 在提交前已变化");
    }
    checkAbort(signal);
    await rename(temporary, target);
    committed = true;
  } finally {
    await handle.close();
    if (!committed) await rm(temporary, { force: true });
  }
  return JSON.stringify({ path: relative, changed: true });
}

function sanitizedEnvironment(registeredSecrets: readonly string[] = []): NodeJS.ProcessEnv {
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

async function runCommandTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
  timeoutMs: number,
  registeredSecrets: readonly string[],
): Promise<string> {
  validateKeys(args, ["command"], ["cwd"]);
  const command = stringArgument(args, "command");
  const relativeCwd = args.cwd === undefined ? "." : stringArgument(args, "cwd");
  checkAbort(signal);
  const cwd = await readTarget(root, relativeCwd);
  if (!(await lstat(cwd)).isDirectory()) throw new ToolFailure("rejected", "cwd 必须是 directory");
  checkAbort(signal);
  if (process.platform !== "win32") {
    throw new ToolFailure("rejected", "M2 run_command 仅支持 Windows PowerShell");
  }
  const executable = "powershell.exe";
  const shellArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  return new Promise<string>((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const captureMaximum = Math.max(maximum, Math.min(maximum * 16, 8 * 1024 * 1024));
    let captureExceeded = false;
    let timedOut = false;
    let termination: Promise<boolean> | undefined;
    const child = spawn(executable, shellArgs, {
      cwd,
      env: sanitizedEnvironment(registeredSecrets),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
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
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      termination ??= terminateWindowsProcessTree(child.pid ?? 0);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new ToolFailure("failed", "command process 无法启动"));
    });
    child.once("close", async (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (termination && !(await termination)) {
        reject(
          new ToolFailure("failed", "process tree cleanup 无法确认", { effectState: "unknown" }),
        );
        return;
      }
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
      try {
        const result = JSON.stringify({
          exitCode: code,
          stdout: captureExceeded ? decodeUtf8Prefix(stdout) : decodeUtf8(stdout),
          stderr: captureExceeded ? decodeUtf8Prefix(stderr) : decodeUtf8(stderr),
        });
        const resultBytes = Buffer.from(result, "utf8");
        if (captureExceeded || resultBytes.length > maximum) {
          const inline = decodeUtf8Prefix(resultBytes.subarray(0, maximum));
          reject(
            new ToolFailure("output_limit", inline, {
              effectState: "unknown",
              artifactBytes: resultBytes,
              evidence: {
                truncated: true,
                stdoutBytes: stdout.length,
                stderrBytes: stderr.length,
                inlineBytes: Buffer.byteLength(inline),
                captureComplete: !captureExceeded,
                exitCode: code,
              },
            }),
          );
          return;
        }
        if (code !== 0) {
          reject(new ToolFailure("failed", result, { effectState: "unknown" }));
          return;
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runGitTool(
  root: string,
  args: readonly string[],
  signal: AbortSignal,
  maximum: number,
  registeredSecrets: readonly string[] = [],
): Promise<string> {
  checkAbort(signal);
  return new Promise<string>((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let exceeded = false;
    const child = spawn("git", args, {
      cwd: root,
      env: sanitizedEnvironment(registeredSecrets),
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
    child.once("error", () => {
      signal.removeEventListener("abort", abort);
      reject(new ToolFailure("failed", "git process 无法启动"));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        reject(new ToolFailure("cancelled", "Git evidence 已取消", { abortObserved: true }));
      } else if (exceeded) {
        reject(new ToolFailure("output_limit", decodeUtf8Prefix(stdout.subarray(0, maximum))));
      } else if (code !== 0) {
        reject(
          new ToolFailure(
            "failed",
            bounded(JSON.stringify({ exitCode: code, stderr: decodeUtf8(stderr) }), maximum),
          ),
        );
      } else {
        resolve(bounded(decodeUtf8(stdout), maximum));
      }
    });
  });
}

async function gitStatusTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
): Promise<string> {
  validateKeys(args, []);
  return runGitTool(root, ["status", "--porcelain=v1", "--untracked-files=all"], signal, maximum);
}

async function gitDiffTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
): Promise<string> {
  validateKeys(args, [], ["path", "cached"]);
  const gitArgs = ["diff", "--no-ext-diff", "--no-textconv"];
  if (args.cached === true) gitArgs.push("--cached");
  gitArgs.push("--");
  if (args.path !== undefined) {
    const relative = stringArgument(args, "path");
    lexicalPath(root, relative);
    gitArgs.push(relative);
  }
  return runGitTool(root, gitArgs, signal, maximum);
}

function outcomeFromFailure(
  callId: string,
  failure: ToolFailure,
  artifacts: readonly { readonly id: string }[] = [],
): ToolOutcome {
  return {
    callId,
    status: failure.status,
    isError: true,
    modelContent: failure.modelContent,
    effectState: failure.effectState,
    abortObserved: failure.abortObserved,
    artifacts,
    ...(failure.evidence ? { evidence: failure.evidence } : {}),
  };
}

export function createCodingToolHost(options: CodingToolHostOptions): CodingToolHost {
  const root = realpathSync.native(path.resolve(options.workspaceRoot));
  const registry = createRegistry();
  const maximum = options.maxOutputBytes ?? 128 * 1024;
  const timeoutMs = options.commandTimeoutMs ?? 30_000;
  const permissionMode = options.permissionMode ?? "autonomous";
  const policyVersion = options.policyVersion ?? "m2-tool-policy-1";
  const artifacts = options.artifactStore ?? createEphemeralArtifactStore();
  const ownsArtifacts = options.artifactStore === undefined;
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
    artifacts,
    definitions: () => registry.definitions(),
    execute(call: ToolCall, context): ToolExecution {
      const result = (async (): Promise<ToolOutcome> => {
        let activePlan: ToolPlan | undefined;
        let permissionRequested = false;
        let permissionDecision: "allowed" | "denied" | undefined;
        const evidence = (additional: JsonObject = {}): JsonObject => ({
          ...(activePlan
            ? {
                planFingerprint: activePlan.fingerprint,
                effects: activePlan.effects,
              }
            : {}),
          permissionRequested,
          ...(permissionDecision ? { permissionDecision } : {}),
          ...additional,
        });
        try {
          checkAbort(context.signal);
          const registered = registry.lookup(call.name);
          if (!registered) throw new ToolFailure("rejected", `未知 tool: ${call.name}`);
          const validation = registered.validate(call.arguments);
          if (!validation.valid) {
            throw new ToolFailure("rejected", "Tool arguments 不符合 strict JSON schema");
          }
          const args = ensureObject(validation.value);
          const plan = await createPlan(root, call, args, policyVersion);
          activePlan = plan;
          await enforceHardGuard(root, plan);
          if (
            permissionMode === "safe" &&
            plan.effects.some((effect) => effect === "workspace_mutation" || effect === "process")
          ) {
            if (!options.approvalPort) {
              permissionRequested = true;
              permissionDecision = "denied";
              throw new ToolFailure("denied", "Safe Mode 需要明确批准");
            }
            permissionRequested = true;
            const response = await options.approvalPort.request(
              { approvalId: randomUUID(), runId: context.runId, plan },
              context.signal,
            );
            checkAbort(context.signal);
            if (response.planFingerprint !== plan.fingerprint) {
              throw new ToolFailure("rejected", "approval fingerprint 不匹配或已失效");
            }
            if (response.decision === "deny") {
              permissionDecision = "denied";
              throw new ToolFailure("denied", "用户拒绝 ToolPlan");
            }
            permissionDecision = "allowed";
          }
          await revalidatePreconditions(root, plan);
          checkAbort(context.signal);
          let modelContent: string;
          let effectState: ToolOutcome["effectState"] = "none";
          switch (call.name) {
            case "list_files":
              modelContent = await listFilesTool(root, args, context.signal, maximum);
              break;
            case "read_file":
              modelContent = await readFileTool(root, args, context.signal, maximum);
              break;
            case "search_text":
              modelContent = await searchTextTool(root, args, context.signal, maximum);
              break;
            case "create_file":
              modelContent = await createFileTool(root, args, context.signal);
              effectState = "committed";
              break;
            case "apply_patch":
              modelContent = await applyPatchTool(root, args, context.signal);
              effectState = "committed";
              break;
            case "replace_file":
              modelContent = await replaceFileTool(root, args, context.signal);
              effectState = "committed";
              break;
            case "delete_file":
              modelContent = await deleteFileTool(root, args, context.signal);
              effectState = "committed";
              break;
            case "run_command":
              modelContent = await runCommandTool(
                root,
                args,
                context.signal,
                maximum,
                timeoutMs,
                redactValues,
              );
              effectState = "unknown";
              break;
            case "git_status":
              modelContent = await gitStatusTool(root, args, context.signal, maximum);
              break;
            case "git_diff":
              modelContent = await gitDiffTool(root, args, context.signal, maximum);
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
            evidence: evidence(
              call.name === "create_file"
                ? { changedFile: { path: stringArgument(args, "path"), change: "created" } }
                : call.name === "apply_patch" || call.name === "replace_file"
                  ? { changedFile: { path: stringArgument(args, "path"), change: "modified" } }
                  : call.name === "delete_file"
                    ? { changedFile: { path: stringArgument(args, "path"), change: "deleted" } }
                    : call.name === "run_command"
                      ? { command: redact(stringArgument(args, "command")), exitCode: 0 }
                      : {},
            ),
          };
        } catch (error) {
          if (error instanceof ToolFailure) {
            const artifactRefs: { readonly id: string }[] = [];
            if (error.artifactBytes) {
              const artifactText = redact(decodeUtf8(error.artifactBytes));
              try {
                artifactRefs.push(
                  await artifacts.put({
                    bytes: Buffer.from(artifactText, "utf8"),
                    mediaType: "text/plain",
                    provenance: `${call.name}:${call.callId}:output_limit`,
                  }),
                );
              } catch (_artifactError) {
                return outcomeFromFailure(
                  call.callId,
                  new ToolFailure("failed", "Artifact spill failed", {
                    effectState: error.effectState,
                    abortObserved: error.abortObserved,
                    evidence: evidence({ artifactSpillFailed: true }),
                  }),
                );
              }
            }
            return outcomeFromFailure(
              call.callId,
              new ToolFailure(error.status, redact(error.modelContent), {
                effectState: error.effectState,
                abortObserved: error.abortObserved,
                evidence: evidence(error.evidence ?? {}),
              }),
              artifactRefs,
            );
          }
          if (context.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            return outcomeFromFailure(
              call.callId,
              new ToolFailure("cancelled", "ToolCall 已取消", {
                abortObserved: true,
                evidence: evidence(),
              }),
            );
          }
          return outcomeFromFailure(
            call.callId,
            new ToolFailure("failed", "Tool execution failed", { evidence: evidence() }),
          );
        }
      })();
      return { updates: noUpdates(), outcome: result };
    },
    async [Symbol.asyncDispose]() {
      if (ownsArtifacts) await artifacts[Symbol.asyncDispose]();
    },
  };
}
