import stripAnsi from "strip-ansi";
import type { CodingToolProjection } from "../../projection/contracts.js";

export type ToolPresentationKind = "compact_row" | "output_block" | "inline_diff" | "code_block";

export type ToolPresentationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "denied"
  | "failed"
  | "cancelled"
  | "conflict";

export type ToolPresentationTone =
  | "neutral"
  | "pending"
  | "running"
  | "success"
  | "warning"
  | "error";

export interface ToolDiffEvidence {
  readonly format: "unified";
  readonly text: string;
  readonly filePath: string;
  readonly filetype?: string;
}

export interface ToolCodeEvidence {
  readonly content: string;
  readonly filePath?: string;
  readonly filetype?: string;
  readonly diagnostic?: string;
}

export interface ToolOutputPresentation {
  readonly text: string;
  readonly overflow: boolean;
  readonly expanded: boolean;
  readonly fullLineCount: number;
}

export interface ToolPresentation {
  readonly id: string;
  readonly callId: string;
  readonly toolName: string;
  readonly title: string;
  readonly kind: ToolPresentationKind;
  readonly status: ToolPresentationStatus;
  readonly tone: ToolPresentationTone;
  readonly visible: boolean;
  readonly rawOutputAvailable: boolean;
  readonly output?: ToolOutputPresentation;
  readonly diff?: ToolDiffEvidence;
  readonly code?: ToolCodeEvidence;
  readonly failureSummary?: string;
  readonly failureDetailAvailable: boolean;
  readonly failureDetail?: ToolOutputPresentation;
}

export interface ToolPresentationOptions {
  readonly availableColumns: number;
  readonly showDetails: boolean;
  readonly showGenericOutput: boolean;
  readonly expandedIds?: ReadonlySet<string>;
}

const compactTools = new Set([
  "read",
  "read_file",
  "grep",
  "search",
  "search_text",
  "glob",
  "list_files",
  "web_search",
  "websearch",
  "web_fetch",
  "webfetch",
]);
const shellTools = new Set(["bash", "shell", "run_command", "execute"]);
const editTools = new Set(["edit", "apply_patch", "replace_file"]);
const writeTools = new Set(["write", "create_file"]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function filetypeFromPath(filePath: string | undefined): string | undefined {
  const extension = filePath?.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
  if (!extension) return undefined;
  const aliases: Readonly<Record<string, string>> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rb: "ruby",
    rs: "rust",
    md: "markdown",
    yml: "yaml",
  };
  return aliases[extension] ?? extension;
}

export function extractToolDiffEvidence(tool: CodingToolProjection): ToolDiffEvidence | undefined {
  const diff = objectValue(tool.outcome?.evidence?.diff);
  const text = stringValue(diff?.text);
  const filePath = stringValue(diff?.filePath);
  if (diff?.format !== "unified" || !text || !filePath) return undefined;
  const filetype = stringValue(diff.filetype) ?? filetypeFromPath(filePath);
  return deepFreeze({
    format: "unified",
    text: sanitizeToolOutput(text),
    filePath,
    ...(filetype ? { filetype } : {}),
  });
}

export function extractToolCodeEvidence(tool: CodingToolProjection): ToolCodeEvidence | undefined {
  const code = objectValue(tool.outcome?.evidence?.code);
  const content = stringValue(code?.content);
  if (content === undefined) return undefined;
  const filePath = stringValue(code?.filePath);
  const filetype = stringValue(code?.filetype) ?? filetypeFromPath(filePath);
  const diagnostic = stringValue(code?.diagnostic);
  return deepFreeze({
    content: sanitizeToolOutput(content),
    ...(filePath ? { filePath } : {}),
    ...(filetype ? { filetype } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  });
}

export function sanitizeToolOutput(value: string): string {
  return Array.from(stripAnsi(value))
    .filter((character) => {
      if (character === "\n" || character === "\r" || character === "\t") return true;
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("");
}

export function collapseToolOutput(
  outputInput: string,
  maxLines: number,
  maxCharacters: number,
  expanded: boolean,
): ToolOutputPresentation {
  if (!Number.isInteger(maxLines) || maxLines < 1) throw new RangeError("maxLines 必须是正整数");
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new RangeError("maxCharacters 必须是正整数");
  }
  const output = sanitizeToolOutput(outputInput.trim());
  const lines = output.split("\n");
  const characters = Array.from(output);
  const overflow = lines.length > maxLines || characters.length > maxCharacters;
  if (expanded || !overflow) {
    return deepFreeze({
      text: output,
      overflow,
      expanded: expanded && overflow,
      fullLineCount: lines.length,
    });
  }
  const linePreview = lines.slice(0, maxLines).join("\n");
  const previewCharacters = Array.from(linePreview);
  const text =
    previewCharacters.length > maxCharacters
      ? `${previewCharacters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`
      : `${linePreview}\n…`;
  return deepFreeze({ text, overflow: true, expanded: false, fullLineCount: lines.length });
}

function status(tool: CodingToolProjection): ToolPresentationStatus {
  if (tool.status === "planned") return "pending";
  if (tool.status === "running") return "running";
  switch (tool.outcome?.status) {
    case "succeeded":
      return "succeeded";
    case "denied":
    case "rejected":
      return "denied";
    case "cancelled":
      return "cancelled";
    case "conflict":
      return "conflict";
    default:
      return "failed";
  }
}

function tone(value: ToolPresentationStatus): ToolPresentationTone {
  switch (value) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "succeeded":
      return "success";
    case "denied":
    case "cancelled":
      return "warning";
    case "failed":
    case "conflict":
      return "error";
  }
}

function title(tool: CodingToolProjection): string {
  const resource = tool.plan.resources[0]?.value;
  const name = tool.plan.toolName.replaceAll("_", " ");
  return resource ? `${name} ${resource}` : name;
}

function failureSummary(value: ToolPresentationStatus): string | undefined {
  switch (value) {
    case "failed":
      return "Tool failed";
    case "conflict":
      return "Tool conflict";
    case "denied":
      return "Tool denied";
    case "cancelled":
      return "Tool cancelled";
    default:
      return undefined;
  }
}

export function selectToolPresentation(
  tool: CodingToolProjection,
  options: ToolPresentationOptions,
): ToolPresentation {
  if (!Number.isInteger(options.availableColumns) || options.availableColumns < 1) {
    throw new RangeError("availableColumns 必须是正整数");
  }
  const currentStatus = status(tool);
  const successfulHistory = tool.status === "settled" && currentStatus === "succeeded";
  const visible = options.showDetails || !successfulHistory;
  const output = tool.outcome?.modelContent ?? "";
  const rawOutputAvailable = output.trim().length > 0;
  const diff = editTools.has(tool.plan.toolName) ? extractToolDiffEvidence(tool) : undefined;
  const code = writeTools.has(tool.plan.toolName) ? extractToolCodeEvidence(tool) : undefined;
  const kind: ToolPresentationKind = diff
    ? "inline_diff"
    : code
      ? "code_block"
      : shellTools.has(tool.plan.toolName)
        ? "output_block"
        : "compact_row";
  const outputExpanded = options.expandedIds?.has(`tool:${tool.callId}:output`) ?? false;
  const errorExpanded = options.expandedIds?.has(`tool:${tool.callId}:error`) ?? false;
  const isGeneric =
    !compactTools.has(tool.plan.toolName) &&
    !shellTools.has(tool.plan.toolName) &&
    !editTools.has(tool.plan.toolName) &&
    !writeTools.has(tool.plan.toolName);
  const shouldShowOutput =
    rawOutputAvailable &&
    !diff &&
    !code &&
    (shellTools.has(tool.plan.toolName) || (isGeneric && options.showGenericOutput));
  const maxLines = shellTools.has(tool.plan.toolName) ? 10 : 3;
  const maxCharacters = maxLines * Math.max(20, options.availableColumns - 6);
  const summary = failureSummary(currentStatus);
  return deepFreeze({
    id: `tool:${tool.callId}`,
    callId: tool.callId,
    toolName: tool.plan.toolName,
    title: title(tool),
    kind,
    status: currentStatus,
    tone: tone(currentStatus),
    visible,
    rawOutputAvailable,
    failureDetailAvailable: Boolean(summary && rawOutputAvailable),
    ...(shouldShowOutput
      ? { output: collapseToolOutput(output, maxLines, maxCharacters, outputExpanded) }
      : {}),
    ...(diff ? { diff } : {}),
    ...(code ? { code } : {}),
    ...(summary ? { failureSummary: summary } : {}),
    ...(summary && rawOutputAvailable && errorExpanded
      ? {
          failureDetail: collapseToolOutput(
            tool.outcome?.infrastructureFailure?.message ?? output,
            10,
            10 * Math.max(20, options.availableColumns - 6),
            true,
          ),
        }
      : {}),
  });
}
