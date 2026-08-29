import type {
  CodeOptions,
  DiffRenderableOptions,
  MarkdownOptions,
  SyntaxStyle,
} from "@opentui/core";
import type { DiffViewerFile, DiffViewerLayout } from "./diff-viewer.js";
import type { OpenTuiTheme } from "./opentui-theme-adapter.js";
import type { ToolDiffEvidence } from "./tool-presentation.js";

export interface InlineDiffAdapterOptions {
  readonly availableColumns: number;
  readonly wrapMode?: "word" | "char" | "none";
  readonly viewPreference?: "auto" | "stacked";
}

export interface MarkdownAdapterOptions {
  readonly content: string;
  readonly streaming: boolean;
  readonly conceal?: boolean;
}

export interface CodeAdapterOptions {
  readonly content: string;
  readonly filetype?: string;
  readonly streaming?: boolean;
  readonly wrapMode?: "word" | "char" | "none";
}

export interface DiffViewerAdapterOptions {
  readonly layout: DiffViewerLayout;
  readonly reviewed?: boolean;
}

export function createOpenTuiMarkdownOptions(
  theme: OpenTuiTheme,
  syntaxStyle: SyntaxStyle,
  options: MarkdownAdapterOptions,
): MarkdownOptions {
  return Object.freeze({
    content: options.content,
    syntaxStyle,
    fg: theme.markdown.text,
    bg: theme.colors.background,
    conceal: options.conceal ?? true,
    concealCode: true,
    streaming: options.streaming,
    internalBlockMode: "top-level",
    tableOptions: Object.freeze({ style: "grid" as const }),
  });
}

export function createOpenTuiCodeOptions(
  theme: OpenTuiTheme,
  syntaxStyle: SyntaxStyle,
  options: CodeAdapterOptions,
): CodeOptions {
  return Object.freeze({
    content: options.content,
    syntaxStyle,
    fg: theme.colors.text,
    bg: theme.colors.backgroundPanel,
    selectionFg: theme.colors.selectedText,
    selectionBg: theme.colors.backgroundSelection,
    ...(options.filetype ? { filetype: options.filetype } : {}),
    streaming: options.streaming ?? false,
    wrapMode: options.wrapMode ?? "word",
    conceal: true,
    drawUnstyledText: true,
  });
}

/**
 * Maps one mutation's structured evidence to the inline Transcript DiffRenderable.
 * Session/working-tree review remains a separate full-screen route owner.
 */
export function createOpenTuiInlineDiffOptions(
  evidence: ToolDiffEvidence,
  theme: OpenTuiTheme,
  syntaxStyle: SyntaxStyle,
  options: InlineDiffAdapterOptions,
): DiffRenderableOptions {
  if (!Number.isInteger(options.availableColumns) || options.availableColumns < 1) {
    throw new RangeError("availableColumns 必须是正整数");
  }
  return Object.freeze({
    diff: evidence.text,
    view:
      options.viewPreference === "stacked" || options.availableColumns <= 120 ? "unified" : "split",
    fg: theme.colors.text,
    ...(evidence.filetype ? { filetype: evidence.filetype } : {}),
    syntaxStyle,
    wrapMode: options.wrapMode ?? "word",
    conceal: true,
    showLineNumbers: true,
    selectionFg: theme.colors.selectedText,
    selectionBg: theme.colors.backgroundSelection,
    lineNumberFg: theme.diff.lineNumber,
    lineNumberBg: theme.diff.contextBackground,
    addedBg: theme.diff.addedBackground,
    removedBg: theme.diff.removedBackground,
    contextBg: theme.diff.contextBackground,
    addedContentBg: theme.diff.addedBackground,
    removedContentBg: theme.diff.removedBackground,
    contextContentBg: theme.diff.contextBackground,
    addedSignColor: theme.diff.added,
    removedSignColor: theme.diff.removed,
    addedLineNumberBg: theme.diff.addedBackground,
    removedLineNumberBg: theme.diff.removedBackground,
  });
}

/** Maps one application-provided file patch to the dedicated Diff route renderable. */
export function createOpenTuiDiffViewerOptions(
  file: DiffViewerFile,
  theme: OpenTuiTheme,
  syntaxStyle: SyntaxStyle,
  options: DiffViewerAdapterOptions,
): DiffRenderableOptions {
  const reviewed = options.reviewed ?? false;
  return Object.freeze({
    diff: file.patch ?? "",
    view: options.layout.view,
    fg: reviewed ? theme.colors.textMuted : theme.colors.text,
    ...(file.filetype ? { filetype: file.filetype } : {}),
    syntaxStyle,
    wrapMode: "char",
    conceal: true,
    showLineNumbers: true,
    selectionFg: theme.colors.selectedText,
    selectionBg: theme.colors.backgroundSelection,
    lineNumberFg: theme.diff.lineNumber,
    lineNumberBg: theme.diff.contextBackground,
    addedBg: reviewed ? theme.colors.backgroundElement : theme.diff.addedBackground,
    removedBg: reviewed ? theme.colors.backgroundElement : theme.diff.removedBackground,
    contextBg: theme.diff.contextBackground,
    addedContentBg: reviewed ? theme.colors.backgroundElement : theme.diff.addedBackground,
    removedContentBg: reviewed ? theme.colors.backgroundElement : theme.diff.removedBackground,
    contextContentBg: theme.diff.contextBackground,
    addedSignColor: reviewed ? theme.colors.textMuted : theme.diff.added,
    removedSignColor: reviewed ? theme.colors.textMuted : theme.diff.removed,
    addedLineNumberBg: reviewed ? theme.colors.backgroundElement : theme.diff.addedBackground,
    removedLineNumberBg: reviewed ? theme.colors.backgroundElement : theme.diff.removedBackground,
  });
}
