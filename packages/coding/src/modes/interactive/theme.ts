import type { UiThemeId } from "./contracts.js";

export type ThemeMode = "dark" | "light";
export type ThemeColorValue = `#${string}` | "none";

export interface TerminalThemeColors {
  readonly defaultForeground?: `#${string}`;
  readonly defaultBackground?: `#${string}`;
  readonly palette?: readonly `#${string}`[];
}

export interface InteractiveTheme {
  readonly id: UiThemeId;
  readonly mode: ThemeMode;
  readonly usesTerminalDefaults: boolean;
  readonly colors: {
    readonly primary: ThemeColorValue;
    readonly secondary: ThemeColorValue;
    readonly accent: ThemeColorValue;
    readonly info: ThemeColorValue;
    readonly success: ThemeColorValue;
    readonly warning: ThemeColorValue;
    readonly error: ThemeColorValue;
    readonly pending: ThemeColorValue;
    readonly running: ThemeColorValue;
    readonly streaming: ThemeColorValue;
    readonly reasoning: ThemeColorValue;
    readonly special: ThemeColorValue;
    readonly text: ThemeColorValue;
    readonly textMuted: ThemeColorValue;
    readonly textSubtle: ThemeColorValue;
    readonly textDisabled: ThemeColorValue;
    readonly selectedText: ThemeColorValue;
    readonly background: ThemeColorValue;
    readonly backgroundPanel: ThemeColorValue;
    readonly backgroundElement: ThemeColorValue;
    readonly backgroundMenu: ThemeColorValue;
    readonly backgroundSelection: ThemeColorValue;
    readonly border: ThemeColorValue;
    readonly borderActive: ThemeColorValue;
    readonly borderSubtle: ThemeColorValue;
    readonly focus: ThemeColorValue;
  };
  readonly markdown: {
    readonly text: ThemeColorValue;
    readonly heading: ThemeColorValue;
    readonly link: ThemeColorValue;
    readonly linkText: ThemeColorValue;
    readonly inlineCode: ThemeColorValue;
    readonly blockQuote: ThemeColorValue;
    readonly emphasis: ThemeColorValue;
    readonly strong: ThemeColorValue;
    readonly horizontalRule: ThemeColorValue;
    readonly listMarker: ThemeColorValue;
    readonly codeBlock: ThemeColorValue;
  };
  readonly syntax: {
    readonly comment: ThemeColorValue;
    readonly keyword: ThemeColorValue;
    readonly function: ThemeColorValue;
    readonly variable: ThemeColorValue;
    readonly string: ThemeColorValue;
    readonly number: ThemeColorValue;
    readonly type: ThemeColorValue;
    readonly operator: ThemeColorValue;
    readonly punctuation: ThemeColorValue;
    readonly constant: ThemeColorValue;
  };
  readonly diff: {
    readonly added: ThemeColorValue;
    readonly removed: ThemeColorValue;
    readonly context: ThemeColorValue;
    readonly hunkHeader: ThemeColorValue;
    readonly addedBackground: ThemeColorValue;
    readonly removedBackground: ThemeColorValue;
    readonly contextBackground: ThemeColorValue;
    readonly lineNumber: ThemeColorValue;
  };
}

export interface ResolveInteractiveThemeOptions {
  readonly themeId?: UiThemeId;
  readonly mode?: ThemeMode;
  readonly terminal?: TerminalThemeColors;
}

type ThemeCoreColors = InteractiveTheme["colors"] & {
  readonly diffAddedBackground: ThemeColorValue;
  readonly diffRemovedBackground: ThemeColorValue;
};

const hexPattern = /^#[0-9a-f]{6}$/i;

function parseHex(value: string): readonly [number, number, number] {
  if (!hexPattern.test(value)) throw new TypeError(`无效 theme color: ${value}`);
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function formatHex(red: number, green: number, blue: number): `#${string}` {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function mix(left: `#${string}`, right: `#${string}`, amount: number): `#${string}` {
  const [lr, lg, lb] = parseHex(left);
  const [rr, rg, rb] = parseHex(right);
  return formatHex(lr + (rr - lr) * amount, lg + (rg - lg) * amount, lb + (rb - lb) * amount);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const dexDark: ThemeCoreColors = {
  primary: "#6f9fdd",
  secondary: "#70b88b",
  accent: "#ad96d4",
  info: "#68aebd",
  success: "#70b88b",
  warning: "#c9a45f",
  error: "#d5747b",
  pending: "#8f86a8",
  running: "#6f9fdd",
  streaming: "#68aebd",
  reasoning: "#ad96d4",
  special: "#c58a68",
  text: "#e5e8ec",
  textMuted: "#9aa2ad",
  textSubtle: "#747d89",
  textDisabled: "#59616c",
  selectedText: "#f2f6fb",
  background: "#0c0e11",
  backgroundPanel: "#12151a",
  backgroundElement: "#191d23",
  backgroundMenu: "#1e232a",
  backgroundSelection: "#243348",
  border: "#343a44",
  borderActive: "#4c5969",
  borderSubtle: "#292e36",
  focus: "#6f9fdd",
  diffAddedBackground: "#17271f",
  diffRemovedBackground: "#2b1b20",
};

const dexLight: ThemeCoreColors = {
  primary: "#356eae",
  secondary: "#397f57",
  accent: "#765aa3",
  info: "#337b8a",
  success: "#397f57",
  warning: "#966d22",
  error: "#b64f58",
  pending: "#746a89",
  running: "#356eae",
  streaming: "#337b8a",
  reasoning: "#765aa3",
  special: "#9b6041",
  text: "#1c2026",
  textMuted: "#5f6874",
  textSubtle: "#7d8692",
  textDisabled: "#a2a8b0",
  selectedText: "#ffffff",
  background: "#fbfbfc",
  backgroundPanel: "#f4f5f7",
  backgroundElement: "#eceef1",
  backgroundMenu: "#e5e8ec",
  backgroundSelection: "#356eae",
  border: "#c8cdd4",
  borderActive: "#9ba6b3",
  borderSubtle: "#dde0e5",
  focus: "#356eae",
  diffAddedBackground: "#e2f0e6",
  diffRemovedBackground: "#f5e1e3",
};

function themeFromCore(
  id: UiThemeId,
  mode: ThemeMode,
  core: ThemeCoreColors,
  usesTerminalDefaults: boolean,
): InteractiveTheme {
  const { diffAddedBackground, diffRemovedBackground, ...colors } = core;
  return deepFreeze({
    id,
    mode,
    usesTerminalDefaults,
    colors,
    markdown: {
      text: colors.text,
      heading: colors.accent,
      link: colors.primary,
      linkText: colors.info,
      inlineCode: colors.secondary,
      blockQuote: colors.warning,
      emphasis: colors.accent,
      strong: colors.primary,
      horizontalRule: colors.border,
      listMarker: colors.primary,
      codeBlock: colors.text,
    },
    syntax: {
      comment: colors.textMuted,
      keyword: colors.accent,
      function: colors.primary,
      variable: colors.text,
      string: colors.secondary,
      number: colors.warning,
      type: colors.info,
      operator: colors.textMuted,
      punctuation: colors.text,
      constant: colors.special,
    },
    diff: {
      added: colors.success,
      removed: colors.error,
      context: colors.textMuted,
      hunkHeader: colors.info,
      addedBackground: diffAddedBackground,
      removedBackground: diffRemovedBackground,
      contextBackground: colors.backgroundPanel,
      lineNumber: colors.textSubtle,
    },
  });
}

function ansi(terminal: TerminalThemeColors, index: number, fallback: `#${string}`): `#${string}` {
  const value = terminal.palette?.[index];
  return value && hexPattern.test(value) ? value : fallback;
}

function systemCore(mode: ThemeMode, terminal: TerminalThemeColors): ThemeCoreColors {
  const fallback = mode === "dark" ? dexDark : dexLight;
  const background = terminal.defaultBackground ?? (mode === "dark" ? "#000000" : "#ffffff");
  const foreground = terminal.defaultForeground ?? (mode === "dark" ? "#d8d8d8" : "#202020");
  parseHex(background);
  parseHex(foreground);
  const primary = ansi(terminal, 12, fallback.primary as `#${string}`);
  const secondary = ansi(terminal, 10, fallback.secondary as `#${string}`);
  const accent = ansi(terminal, 13, fallback.accent as `#${string}`);
  const error = ansi(terminal, 9, fallback.error as `#${string}`);
  const warning = ansi(terminal, 11, fallback.warning as `#${string}`);
  const info = ansi(terminal, 14, fallback.info as `#${string}`);
  return {
    primary,
    secondary,
    accent,
    info,
    success: secondary,
    warning,
    error,
    pending: mix(background, accent, 0.62),
    running: primary,
    streaming: info,
    reasoning: accent,
    special: ansi(terminal, 3, fallback.special as `#${string}`),
    text: "none",
    textMuted: mix(background, foreground, 0.62),
    textSubtle: mix(background, foreground, 0.46),
    textDisabled: mix(background, foreground, 0.34),
    selectedText: background,
    background: "none",
    backgroundPanel: mix(background, foreground, 0.05),
    backgroundElement: mix(background, foreground, 0.09),
    backgroundMenu: mix(background, foreground, 0.12),
    backgroundSelection: primary,
    border: mix(background, foreground, 0.22),
    borderActive: mix(background, foreground, 0.34),
    borderSubtle: mix(background, foreground, 0.15),
    focus: primary,
    diffAddedBackground: mix(background, secondary, mode === "dark" ? 0.2 : 0.14),
    diffRemovedBackground: mix(background, error, mode === "dark" ? 0.2 : 0.14),
  };
}

export function detectTerminalThemeMode(
  terminal: TerminalThemeColors | undefined,
): ThemeMode | undefined {
  if (!terminal?.defaultBackground) return undefined;
  const [red, green, blue] = parseHex(terminal.defaultBackground);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.5 ? "light" : "dark";
}

export function resolveInteractiveTheme(
  options: ResolveInteractiveThemeOptions = {},
): InteractiveTheme {
  const id = options.themeId ?? "dex";
  const mode = options.mode ?? detectTerminalThemeMode(options.terminal) ?? "dark";
  if (id === "dex") return themeFromCore(id, mode, mode === "dark" ? dexDark : dexLight, false);
  return themeFromCore(id, mode, systemCore(mode, options.terminal ?? {}), true);
}

export function themeContrastRatio(
  foreground: Exclude<ThemeColorValue, "none">,
  background: Exclude<ThemeColorValue, "none">,
): number {
  const relative = (value: `#${string}`): number => {
    const channels = parseHex(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
  };
  const left = relative(foreground);
  const right = relative(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

export const interactiveSpacingTokens = Object.freeze({
  none: 0,
  compact: 1,
  regular: 2,
  section: 3,
} as const);
