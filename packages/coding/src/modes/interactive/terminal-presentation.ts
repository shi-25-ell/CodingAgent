import type { TerminalCapabilities } from "@opentui/core";

export type TerminalColorLevel = "none" | "ansi16" | "ansi256" | "truecolor";
export type TerminalGlyphMode = "unicode" | "ascii";

export interface TerminalPresentationProbe {
  readonly isTty: boolean;
  readonly term?: string;
  readonly noColor?: boolean;
  readonly forceColor?: boolean;
  readonly forceAscii?: boolean;
  readonly capabilities?: TerminalCapabilities | null;
}

export interface TerminalPresentationCapabilities {
  readonly colorLevel: TerminalColorLevel;
  readonly glyphMode: TerminalGlyphMode;
  readonly mouse: boolean;
  readonly bracketedPaste: boolean;
  readonly focusTracking: boolean;
  readonly hyperlinks: boolean;
}

export type InteractiveTerminalDiagnosticCode =
  | "INTERACTIVE_STDIN_NOT_TTY"
  | "INTERACTIVE_STDOUT_NOT_TTY"
  | "INTERACTIVE_RAW_MODE_UNAVAILABLE";

export interface InteractiveTerminalReadiness {
  readonly ready: boolean;
  readonly diagnostic?: {
    readonly code: InteractiveTerminalDiagnosticCode;
    readonly message: string;
  };
}

export interface InteractiveTerminalIoProbe {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly stdinSupportsRawMode: boolean;
}

export interface PresentationGlyphs {
  readonly branch: string;
  readonly horizontal: string;
  readonly vertical: string;
  readonly check: string;
  readonly failure: string;
  readonly warning: string;
  readonly pending: string;
  readonly expanded: string;
  readonly collapsed: string;
  readonly ellipsis: string;
}

export const unicodePresentationGlyphs: PresentationGlyphs = Object.freeze({
  branch: "↳",
  horizontal: "─",
  vertical: "│",
  check: "✓",
  failure: "✕",
  warning: "!",
  pending: "…",
  expanded: "▾",
  collapsed: "▸",
  ellipsis: "…",
});

export const asciiPresentationGlyphs: PresentationGlyphs = Object.freeze({
  branch: "->",
  horizontal: "-",
  vertical: "|",
  check: "OK",
  failure: "X",
  warning: "!",
  pending: "...",
  expanded: "v",
  collapsed: ">",
  ellipsis: "...",
});

export function resolveTerminalPresentationCapabilities(
  probe: TerminalPresentationProbe,
): TerminalPresentationCapabilities {
  const dumb = probe.term?.toLowerCase() === "dumb";
  const interactive = probe.isTty && !dumb;
  const capabilities = probe.capabilities;
  const colorLevel: TerminalColorLevel = probe.noColor
    ? "none"
    : probe.forceColor
      ? capabilities?.rgb
        ? "truecolor"
        : capabilities?.ansi256
          ? "ansi256"
          : "ansi16"
      : !interactive
        ? "none"
        : capabilities?.rgb
          ? "truecolor"
          : capabilities?.ansi256
            ? "ansi256"
            : "ansi16";
  return Object.freeze({
    colorLevel,
    glyphMode: probe.forceAscii || dumb ? "ascii" : "unicode",
    mouse: interactive,
    bracketedPaste: Boolean(interactive && capabilities?.bracketed_paste),
    focusTracking: Boolean(interactive && capabilities?.focus_tracking),
    hyperlinks: Boolean(interactive && capabilities?.hyperlinks),
  });
}

/** Fail-closed gate used before acquiring alternate-screen/raw-mode ownership. */
export function inspectInteractiveTerminal(
  probe: InteractiveTerminalIoProbe,
): InteractiveTerminalReadiness {
  if (!probe.stdinIsTty) {
    return Object.freeze({
      ready: false,
      diagnostic: Object.freeze({
        code: "INTERACTIVE_STDIN_NOT_TTY" as const,
        message: "interactive mode 需要 TTY stdin；redirected input 请使用 non-interactive mode。",
      }),
    });
  }
  if (!probe.stdoutIsTty) {
    return Object.freeze({
      ready: false,
      diagnostic: Object.freeze({
        code: "INTERACTIVE_STDOUT_NOT_TTY" as const,
        message:
          "interactive mode 需要 TTY stdout；redirected output 请使用 non-interactive mode。",
      }),
    });
  }
  if (!probe.stdinSupportsRawMode) {
    return Object.freeze({
      ready: false,
      diagnostic: Object.freeze({
        code: "INTERACTIVE_RAW_MODE_UNAVAILABLE" as const,
        message: "当前 stdin 不支持 raw mode，无法安全启动 interactive renderer。",
      }),
    });
  }
  return Object.freeze({ ready: true });
}

export function presentationGlyphs(mode: TerminalGlyphMode): PresentationGlyphs {
  return mode === "unicode" ? unicodePresentationGlyphs : asciiPresentationGlyphs;
}
