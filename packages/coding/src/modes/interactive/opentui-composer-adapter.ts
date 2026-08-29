import {
  decodePasteBytes,
  type KeyEvent,
  type PasteEvent,
  stripAnsiSequences,
  type TextareaOptions,
  type TextareaRenderable,
} from "@opentui/core";
import {
  ComposerHistory,
  ComposerSubmitGate,
  type PreparedComposerPaste,
  prepareComposerPaste,
} from "./composer-policy.js";
import type { OpenTuiTheme } from "./opentui-theme-adapter.js";

export interface OpenTuiComposerOptions {
  readonly initialValue?: string;
  readonly placeholder?: string;
}

export interface OpenTuiComposerBindingOptions {
  readonly onChanged: (value: string) => void;
  readonly onSubmit: (value: string) => void | Promise<void>;
  readonly onLargePaste?: (paste: PreparedComposerPaste) => void;
  readonly history?: ComposerHistory;
  readonly submitGate?: ComposerSubmitGate;
}

export function createOpenTuiComposerOptions(
  theme: OpenTuiTheme,
  options: OpenTuiComposerOptions = {},
): TextareaOptions {
  return Object.freeze({
    initialValue: options.initialValue ?? "",
    placeholder: options.placeholder ?? "Ask Dex Code…",
    placeholderColor: theme.colors.textSubtle,
    textColor: theme.colors.text,
    backgroundColor: theme.colors.backgroundElement,
    focusedTextColor: theme.colors.text,
    focusedBackgroundColor: theme.colors.backgroundElement,
    selectionFg: theme.colors.selectedText,
    selectionBg: theme.colors.backgroundSelection,
    cursorColor: theme.colors.focus,
    wrapMode: "word" as const,
    keyBindings: [
      { name: "return", action: "submit" as const },
      { name: "kpenter", action: "submit" as const },
      { name: "return", shift: true, action: "newline" as const },
      { name: "kpenter", shift: true, action: "newline" as const },
    ],
  });
}

function historyDirection(key: KeyEvent): "previous" | "next" | undefined {
  if (key.ctrl || key.meta || key.shift || key.super || key.hyper) return undefined;
  if (key.name === "up") return "previous";
  if (key.name === "down") return "next";
  return undefined;
}

/** Binds product input policy at the final OpenTUI seam. */
export function bindOpenTuiComposer(
  textarea: TextareaRenderable,
  options: OpenTuiComposerBindingOptions,
): () => void {
  const history = options.history ?? new ComposerHistory();
  const submitGate = options.submitGate ?? new ComposerSubmitGate();
  textarea.traits = { capture: ["submit", "navigate"] };
  textarea.onContentChange = () => options.onChanged(textarea.plainText);
  textarea.onSubmit = () => {
    submitGate.trigger(
      () => textarea.plainText,
      async (value) => {
        await options.onSubmit(value);
        history.record(value);
      },
    );
  };
  textarea.onPaste = (event: PasteEvent) => {
    event.preventDefault();
    const paste = prepareComposerPaste(stripAnsiSequences(decodePasteBytes(event.bytes)));
    textarea.insertText(paste.text);
    if (paste.large) options.onLargePaste?.(paste);
  };
  textarea.onKeyDown = (key: KeyEvent) => {
    const direction = historyDirection(key);
    if (!direction) return;
    const value = history.navigate(direction, textarea.plainText, {
      visualRow: textarea.visualCursor.visualRow,
      visualLineCount: textarea.virtualLineCount,
      hasSelection: textarea.hasSelection(),
    });
    if (value === undefined) return;
    key.preventDefault();
    textarea.setText(value);
    textarea.gotoBufferEnd();
  };
  return () => {
    textarea.onContentChange = undefined;
    textarea.onSubmit = undefined;
    textarea.onPaste = undefined;
    textarea.onKeyDown = undefined;
  };
}
