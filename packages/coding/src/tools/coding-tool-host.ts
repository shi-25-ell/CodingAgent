import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ArtifactStore,
  RunId,
  ToolDefinition,
  ToolExecution,
  ToolExecutor,
  ToolOutcome,
  ToolUpdate,
} from "@coding-agent/agent";
import type { JsonObject, JsonValue, ToolCall } from "@coding-agent/model";
import {
  createNodeLocalExecutionPorts,
  type LocalExecutionPorts,
  type LocalFilesystemPort,
} from "../adapters/local-execution-ports.js";
import { createEphemeralArtifactStore } from "./ephemeral-artifact-store.js";
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
  invalidate?(approvalId: string): void;
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
  readonly artifactStore?: ArtifactStore;
}

export interface CodingToolHost extends ToolExecutor, AsyncDisposable {
  readonly artifacts: ArtifactStore;
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
  readonly infrastructureFailure: ToolOutcome["infrastructureFailure"];

  constructor(
    status: FailureStatus,
    modelContent: string,
    options?: {
      readonly effectState?: ToolOutcome["effectState"];
      readonly abortObserved?: boolean;
      readonly artifactBytes?: Uint8Array;
      readonly evidence?: JsonObject;
      readonly infrastructureFailure?: NonNullable<ToolOutcome["infrastructureFailure"]>;
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
    this.infrastructureFailure = options?.infrastructureFailure;
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

function redactJson(value: JsonValue, redact: (text: string) => string): JsonValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redact));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(item, redact)]),
    );
  }
  return value;
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

function normalizeArguments(
  root: string,
  toolName: string,
  input: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const normalized = structuredClone(input);
  const normalizePath = (key: "path" | "cwd", fallback?: string): void => {
    const value = normalized[key] === undefined ? fallback : stringArgument(normalized, key);
    if (value === undefined) return;
    const absolute = lexicalPath(root, value);
    normalized[key] = modelPath(path.relative(root, absolute) || ".");
  };
  switch (toolName) {
    case "list_files":
      normalizePath("path", ".");
      normalized.recursive ??= true;
      break;
    case "search_text":
    case "git_diff":
      normalizePath("path", ".");
      break;
    case "run_command":
      normalizePath("cwd", ".");
      break;
    case "read_file":
    case "create_file":
    case "apply_patch":
    case "replace_file":
    case "delete_file":
      normalizePath("path");
      break;
  }
  return normalized;
}

async function readTarget(
  root: string,
  value: string,
  filesystem: LocalFilesystemPort,
): Promise<string> {
  const candidate = lexicalPath(root, value);
  let resolved: string;
  try {
    resolved = await filesystem.realpath(candidate);
  } catch (_error) {
    throw new ToolFailure("failed", "目标文件不存在或不可访问");
  }
  if (!isWithin(resolved, root)) throw new ToolFailure("rejected", "symlink 目标逃逸 workspace");
  return resolved;
}

async function mutationTarget(
  root: string,
  value: string,
  filesystem: LocalFilesystemPort,
): Promise<string> {
  const candidate = lexicalPath(root, value);
  const relative = path.relative(root, candidate);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await filesystem.inspect(current);
      if (info.symbolicLink) {
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
  filesystem: LocalFilesystemPort,
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
      await mutationTarget(root, relative, filesystem);
      resources.push({ kind: "path", value: relative });
      effects.push("workspace_mutation");
      risks.push("创建 workspace 文件");
      preconditions.push({ kind: "path_absent", resource: relative });
      break;
    }
    case "apply_patch": {
      const relative = stringArgument(args, "path");
      const target = await mutationTarget(root, relative, filesystem);
      let bytes: Uint8Array;
      try {
        bytes = await filesystem.read(target);
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
      const target = await mutationTarget(root, relative, filesystem);
      let bytes: Uint8Array;
      try {
        bytes = await filesystem.read(target);
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

function redactPlan(plan: ToolPlan, redact: (value: string) => string): ToolPlan {
  return deepFreeze({
    ...plan,
    normalizedArguments: redactJson(plan.normalizedArguments, redact) as JsonObject,
    resources: plan.resources.map((resource) => ({ ...resource, value: redact(resource.value) })),
    risks: plan.risks.map(redact),
    preconditions: plan.preconditions.map((precondition) => ({
      ...precondition,
      resource: redact(precondition.resource),
    })),
  });
}

async function enforceHardGuard(
  root: string,
  plan: ToolPlan,
  filesystem: LocalFilesystemPort,
): Promise<void> {
  const args = ensureObject(plan.normalizedArguments);
  switch (plan.toolName) {
    case "list_files":
      await readTarget(
        root,
        args.path === undefined ? "." : stringArgument(args, "path"),
        filesystem,
      );
      return;
    case "read_file":
      await readTarget(root, stringArgument(args, "path"), filesystem);
      return;
    case "search_text":
      await readTarget(
        root,
        args.path === undefined ? "." : stringArgument(args, "path"),
        filesystem,
      );
      return;
    case "create_file":
    case "apply_patch":
    case "replace_file":
    case "delete_file":
      await mutationTarget(root, stringArgument(args, "path"), filesystem);
      return;
    case "run_command": {
      const cwd = await readTarget(
        root,
        args.cwd === undefined ? "." : stringArgument(args, "cwd"),
        filesystem,
      );
      if (!(await filesystem.inspect(cwd)).directory) {
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

async function revalidatePreconditions(
  root: string,
  plan: ToolPlan,
  filesystem: LocalFilesystemPort,
): Promise<void> {
  for (const precondition of plan.preconditions) {
    const target = await mutationTarget(root, precondition.resource, filesystem);
    if (precondition.kind === "path_absent") {
      try {
        await filesystem.inspect(target);
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
      bytes = await filesystem.read(target);
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
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new ToolFailure("rejected", "仅支持 UTF-8 text，binary 不可用");
    return text;
  } catch (_error) {
    if (_error instanceof ToolFailure) throw _error;
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
  filesystem: LocalFilesystemPort,
): Promise<string> {
  const relative = stringArgument(args, "path");
  checkAbort(signal);
  const target = await readTarget(root, relative, filesystem);
  const bytes = await filesystem.read(target, signal);
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
  filesystem: LocalFilesystemPort,
): AsyncIterable<string> {
  const entries = await filesystem.list(directory);
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const target = path.join(directory, entry.name);
    if (!isWithin(target, root)) continue;
    const relative = modelPath(path.relative(root, target));
    if (entry.symbolicLink) {
      yield `${relative}\tsymlink`;
    } else if (entry.directory) {
      yield `${relative}\tdirectory`;
      if (recursive) yield* listEntries(root, target, true, filesystem);
    } else if (entry.file) {
      yield `${relative}\tfile`;
    }
  }
}

async function listFilesTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
  filesystem: LocalFilesystemPort,
): Promise<string> {
  const relative = args.path === undefined ? "." : stringArgument(args, "path");
  const recursive = args.recursive === undefined ? true : args.recursive;
  if (typeof recursive !== "boolean") throw new ToolFailure("rejected", "recursive 必须是 boolean");
  checkAbort(signal);
  const target = await readTarget(root, relative, filesystem);
  if (!(await filesystem.inspect(target)).directory) {
    throw new ToolFailure("rejected", "list_files path 必须是 directory");
  }
  const entries: string[] = [];
  for await (const entry of listEntries(root, target, recursive, filesystem)) {
    checkAbort(signal);
    entries.push(entry);
  }
  return bounded(entries.sort().join("\n"), maximum);
}

async function* filesUnder(
  root: string,
  directory: string,
  filesystem: LocalFilesystemPort,
): AsyncIterable<string> {
  const entries = await filesystem.list(directory);
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.symbolicLink) continue;
    if (entry.directory) {
      if (entry.name === ".git") continue;
      yield* filesUnder(root, target, filesystem);
    } else if (entry.file && isWithin(target, root)) {
      yield target;
    }
  }
}

async function searchTextTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
  filesystem: LocalFilesystemPort,
): Promise<string> {
  const query = stringArgument(args, "query");
  const relative = args.path === undefined ? "." : stringArgument(args, "path");
  checkAbort(signal);
  const target = await readTarget(root, relative, filesystem);
  const info = await filesystem.inspect(target);
  const candidates = info.directory
    ? filesUnder(root, target, filesystem)
    : (async function* () {
        yield target;
      })();
  const matches: string[] = [];
  for await (const file of candidates) {
    checkAbort(signal);
    let text: string;
    try {
      text = decodeUtf8(await filesystem.read(file, signal));
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
  filesystem: LocalFilesystemPort,
): Promise<string> {
  const target = await mutationTarget(root, relative, filesystem);
  const parent = path.dirname(target);
  let parentResolved: string;
  try {
    parentResolved = await filesystem.realpath(parent);
  } catch (_error) {
    throw new ToolFailure("failed", "目标 parent directory 不存在或不可访问");
  }
  if (parentResolved !== parent)
    throw new ToolFailure("rejected", "mutation parent 不能是 symlink/junction");
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await filesystem.openExclusive(temporary);
  let committed = false;
  try {
    await handle.write(content);
    await handle.sync();
    checkAbort(signal);
    await mutationTarget(root, relative, filesystem);
    if (precondition.kind === "absent") {
      try {
        await filesystem.inspect(target);
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
        current = await filesystem.read(target, signal);
      } catch (_error) {
        throw new ToolFailure("conflict", "目标在提交前不可访问");
      }
      if (contentHash(current) !== precondition.value) {
        throw new ToolFailure("conflict", "目标在提交前已变化");
      }
    }
    checkAbort(signal);
    await filesystem.rename(temporary, target);
    committed = true;
  } finally {
    await handle[Symbol.asyncDispose]();
    if (!committed) await filesystem.remove(temporary);
  }
  return JSON.stringify({ path: relative, contentHash: contentHash(Buffer.from(content, "utf8")) });
}

async function createFileTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  filesystem: LocalFilesystemPort,
): Promise<string> {
  return atomicWrite(
    root,
    stringArgument(args, "path"),
    stringArgument(args, "content", true),
    signal,
    { kind: "absent" },
    filesystem,
  );
}

async function replaceFileTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  filesystem: LocalFilesystemPort,
): Promise<string> {
  const relative = stringArgument(args, "path");
  const expectedHash = stringArgument(args, "expectedHash");
  const target = await mutationTarget(root, relative, filesystem);
  let current: Uint8Array;
  try {
    current = await filesystem.read(target, signal);
  } catch (_error) {
    throw new ToolFailure("failed", "replace_file 目标不存在或不可访问");
  }
  decodeUtf8(current);
  if (contentHash(current) !== expectedHash) {
    throw new ToolFailure("conflict", "expectedHash 与当前内容不一致");
  }
  return atomicWrite(
    root,
    relative,
    stringArgument(args, "content", true),
    signal,
    {
      kind: "hash",
      value: expectedHash,
    },
    filesystem,
  );
}

async function deleteFileTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  filesystem: LocalFilesystemPort,
): Promise<string> {
  const relative = stringArgument(args, "path");
  const expectedHash = stringArgument(args, "expectedHash");
  const target = await mutationTarget(root, relative, filesystem);
  let current: Uint8Array;
  try {
    current = await filesystem.read(target, signal);
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
  await filesystem.rename(target, tombstone);
  try {
    await filesystem.remove(tombstone);
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
  filesystem: LocalFilesystemPort,
): Promise<string> {
  const relative = stringArgument(args, "path");
  const oldText = stringArgument(args, "oldText");
  const newText = stringArgument(args, "newText", true);
  checkAbort(signal);
  const target = await mutationTarget(root, relative, filesystem);
  let original: string;
  try {
    original = decodeUtf8(await filesystem.read(target, signal));
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
  const handle = await filesystem.openExclusive(temporary);
  let committed = false;
  try {
    await handle.write(updated);
    await handle.sync();
    checkAbort(signal);
    await mutationTarget(root, relative, filesystem);
    let current: string;
    try {
      current = decodeUtf8(await filesystem.read(target, signal));
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      throw new ToolFailure("conflict", "patch 目标在提交前不可访问");
    }
    if (current !== original) {
      throw new ToolFailure("conflict", "patch 目标在提交前已变化");
    }
    const [rootNow, parentNow, pathInfo, handleInfo] = await Promise.all([
      filesystem.realpath(root),
      filesystem.realpath(path.dirname(target)),
      filesystem.inspect(temporary),
      handle.stat(),
    ]);
    if (
      rootNow !== root ||
      parentNow !== path.dirname(target) ||
      pathInfo.device !== handleInfo.device ||
      pathInfo.inode !== handleInfo.inode
    ) {
      throw new ToolFailure("conflict", "patch path identity 在提交前已变化");
    }
    checkAbort(signal);
    await filesystem.rename(temporary, target);
    committed = true;
  } finally {
    await handle[Symbol.asyncDispose]();
    if (!committed) await filesystem.remove(temporary);
  }
  return JSON.stringify({ path: relative, changed: true });
}

async function runCommandTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
  timeoutMs: number,
  registeredSecrets: readonly string[],
  ports: LocalExecutionPorts,
): Promise<string> {
  const command = stringArgument(args, "command");
  const relativeCwd = args.cwd === undefined ? "." : stringArgument(args, "cwd");
  checkAbort(signal);
  const cwd = await readTarget(root, relativeCwd, ports.filesystem);
  if (!(await ports.filesystem.inspect(cwd)).directory) {
    throw new ToolFailure("rejected", "cwd 必须是 directory");
  }
  checkAbort(signal);
  const result = await ports.process.runPowerShell({
    command,
    cwd,
    signal,
    timeoutMs,
    inlineOutputBytes: maximum,
    registeredSecrets,
  });
  if (result.status !== "succeeded") {
    throw new ToolFailure(result.status, result.modelContent, {
      effectState: result.effectState,
      abortObserved: result.abortObserved,
      ...(result.artifactBytes ? { artifactBytes: result.artifactBytes } : {}),
      ...(result.evidence ? { evidence: result.evidence } : {}),
      ...(result.infrastructureFailure
        ? { infrastructureFailure: result.infrastructureFailure }
        : {}),
    });
  }
  return result.modelContent;
}

async function gitStatusTool(
  root: string,
  signal: AbortSignal,
  maximum: number,
  ports: LocalExecutionPorts,
): Promise<string> {
  const result = await ports.git.run(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    signal,
    maximum,
  );
  if (result.status !== "succeeded") {
    throw new ToolFailure(result.status, result.modelContent, {
      abortObserved: result.abortObserved,
      ...(result.artifactBytes ? { artifactBytes: result.artifactBytes } : {}),
      ...(result.evidence ? { evidence: result.evidence } : {}),
    });
  }
  return result.modelContent;
}

async function gitDiffTool(
  root: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
  maximum: number,
  ports: LocalExecutionPorts,
): Promise<string> {
  const gitArgs = ["diff", "--no-ext-diff", "--no-textconv"];
  if (args.cached === true) gitArgs.push("--cached");
  gitArgs.push("--");
  if (args.path !== undefined && args.path !== ".") {
    gitArgs.push(stringArgument(args, "path"));
  }
  const result = await ports.git.run(root, gitArgs, signal, maximum);
  if (result.status !== "succeeded") {
    throw new ToolFailure(result.status, result.modelContent, {
      abortObserved: result.abortObserved,
      ...(result.artifactBytes ? { artifactBytes: result.artifactBytes } : {}),
      ...(result.evidence ? { evidence: result.evidence } : {}),
    });
  }
  return result.modelContent;
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
    ...(failure.infrastructureFailure
      ? { infrastructureFailure: failure.infrastructureFailure }
      : {}),
  };
}

export function createCodingToolHostWithPorts(
  options: CodingToolHostOptions,
  ports: LocalExecutionPorts,
): CodingToolHost {
  const root = ports.filesystem.captureWorkspaceRoot(options.workspaceRoot);
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
        let permissionRequestCount = 0;
        let permissionAllowedCount = 0;
        let permissionDeniedCount = 0;
        let permissionDecision: "allowed" | "denied" | undefined;
        const evidence = (additional: JsonObject = {}): JsonObject => ({
          ...(activePlan
            ? {
                planFingerprint: activePlan.fingerprint,
                effects: activePlan.effects,
              }
            : {}),
          permissionRequested: permissionRequestCount > 0,
          permissionRequestCount,
          permissionAllowedCount,
          permissionDeniedCount,
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
          const args = normalizeArguments(root, call.name, ensureObject(validation.value));
          let plan = await createPlan(root, call, args, policyVersion, ports.filesystem);
          activePlan = redactPlan(plan, redact);
          let preconditionsValidated = false;
          await enforceHardGuard(root, plan, ports.filesystem);
          if (
            permissionMode === "safe" &&
            plan.effects.some((effect) => effect === "workspace_mutation" || effect === "process")
          ) {
            if (!options.approvalPort) {
              permissionRequestCount += 1;
              permissionDeniedCount += 1;
              permissionDecision = "denied";
              throw new ToolFailure("denied", "Safe Mode 需要明确批准");
            }
            while (true) {
              permissionRequestCount += 1;
              const approvalPlan = redactPlan(plan, redact);
              activePlan = approvalPlan;
              const approvalId = randomUUID();
              const response = await options.approvalPort.request(
                { approvalId, runId: context.runId, plan: approvalPlan },
                context.signal,
              );
              checkAbort(context.signal);
              if (response.planFingerprint !== plan.fingerprint) {
                throw new ToolFailure("rejected", "approval fingerprint 不匹配或已失效");
              }
              if (response.decision === "deny") {
                permissionDeniedCount += 1;
                permissionDecision = "denied";
                throw new ToolFailure("denied", "用户拒绝 ToolPlan");
              }
              permissionAllowedCount += 1;
              const refreshedPlan = await createPlan(
                root,
                call,
                args,
                policyVersion,
                ports.filesystem,
              );
              await enforceHardGuard(root, refreshedPlan, ports.filesystem);
              if (refreshedPlan.fingerprint !== plan.fingerprint) {
                options.approvalPort.invalidate?.(approvalId);
                plan = refreshedPlan;
                activePlan = redactPlan(refreshedPlan, redact);
                continue;
              }
              try {
                await revalidatePreconditions(root, plan, ports.filesystem);
                preconditionsValidated = true;
              } catch (error) {
                if (!(error instanceof ToolFailure) || error.status !== "conflict") throw error;
                const changedPlan = await createPlan(
                  root,
                  call,
                  args,
                  policyVersion,
                  ports.filesystem,
                );
                await enforceHardGuard(root, changedPlan, ports.filesystem);
                if (changedPlan.fingerprint === plan.fingerprint) throw error;
                options.approvalPort.invalidate?.(approvalId);
                plan = changedPlan;
                activePlan = redactPlan(changedPlan, redact);
                continue;
              }
              permissionDecision = "allowed";
              break;
            }
          }
          if (!preconditionsValidated) {
            await revalidatePreconditions(root, plan, ports.filesystem);
          }
          checkAbort(context.signal);
          let modelContent: string;
          let effectState: ToolOutcome["effectState"] = "none";
          switch (call.name) {
            case "list_files":
              modelContent = await listFilesTool(
                root,
                args,
                context.signal,
                maximum,
                ports.filesystem,
              );
              break;
            case "read_file":
              modelContent = await readFileTool(
                root,
                args,
                context.signal,
                maximum,
                ports.filesystem,
              );
              break;
            case "search_text":
              modelContent = await searchTextTool(
                root,
                args,
                context.signal,
                maximum,
                ports.filesystem,
              );
              break;
            case "create_file":
              modelContent = await createFileTool(root, args, context.signal, ports.filesystem);
              effectState = "committed";
              break;
            case "apply_patch":
              modelContent = await applyPatchTool(root, args, context.signal, ports.filesystem);
              effectState = "committed";
              break;
            case "replace_file":
              modelContent = await replaceFileTool(root, args, context.signal, ports.filesystem);
              effectState = "committed";
              break;
            case "delete_file":
              modelContent = await deleteFileTool(root, args, context.signal, ports.filesystem);
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
                ports,
              );
              effectState = "unknown";
              break;
            case "git_status":
              modelContent = await gitStatusTool(root, context.signal, maximum, ports);
              break;
            case "git_diff":
              modelContent = await gitDiffTool(root, args, context.signal, maximum, ports);
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
            const failureEvidence = evidence({
              ...(error.evidence ?? {}),
              ...(call.name === "run_command" &&
              call.arguments !== null &&
              !Array.isArray(call.arguments) &&
              typeof call.arguments === "object" &&
              typeof call.arguments.command === "string"
                ? { command: redact(call.arguments.command) }
                : {}),
            });
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
                    evidence: { ...failureEvidence, artifactSpillFailed: true },
                    ...(error.infrastructureFailure
                      ? { infrastructureFailure: error.infrastructureFailure }
                      : {}),
                  }),
                );
              }
            }
            return outcomeFromFailure(
              call.callId,
              new ToolFailure(error.status, redact(error.modelContent), {
                effectState: error.effectState,
                abortObserved: error.abortObserved,
                evidence: failureEvidence,
                ...(error.infrastructureFailure
                  ? { infrastructureFailure: error.infrastructureFailure }
                  : {}),
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

export function createCodingToolHost(options: CodingToolHostOptions): CodingToolHost {
  return createCodingToolHostWithPorts(options, createNodeLocalExecutionPorts());
}
