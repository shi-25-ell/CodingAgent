import type { DiffRenderableOptions, SyntaxStyle } from "@opentui/core";
import type { OpenTuiTheme } from "./opentui-theme-adapter.js";
import type { ToolDiffEvidence } from "./tool-presentation.js";

export interface InlineDiffAdapterOptions {
  readonly availableColumns: number;
  readonly wrapMode?: "word" | "char" | "none";
  readonly viewPreference?: "auto" | "stacked";
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
