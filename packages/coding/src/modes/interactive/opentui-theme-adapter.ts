import { RGBA, SyntaxStyle } from "@opentui/core";
import type { InteractiveTheme, ThemeColorValue } from "./theme.js";

type ResolvedColorGroup<T> = { readonly [K in keyof T]: RGBA };

export interface OpenTuiTheme {
  readonly id: InteractiveTheme["id"];
  readonly mode: InteractiveTheme["mode"];
  readonly usesTerminalDefaults: boolean;
  readonly colors: ResolvedColorGroup<InteractiveTheme["colors"]>;
  readonly markdown: ResolvedColorGroup<InteractiveTheme["markdown"]>;
  readonly syntax: ResolvedColorGroup<InteractiveTheme["syntax"]>;
  readonly diff: ResolvedColorGroup<InteractiveTheme["diff"]>;
}

export function toOpenTuiColor(value: ThemeColorValue): RGBA {
  return value === "none" ? RGBA.fromInts(0, 0, 0, 0) : RGBA.fromHex(value);
}

function resolveColorGroup<T extends object>(group: T): ResolvedColorGroup<T> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(group).map(([key, value]) => {
        if (typeof value !== "string") throw new TypeError(`theme token ${key} 必须是 color`);
        return [key, toOpenTuiColor(value as ThemeColorValue)];
      }),
    ) as ResolvedColorGroup<T>,
  );
}

/** Converts framework-independent visual tokens at the final OpenTUI seam. */
export function resolveOpenTuiTheme(theme: InteractiveTheme): OpenTuiTheme {
  return Object.freeze({
    id: theme.id,
    mode: theme.mode,
    usesTerminalDefaults: theme.usesTerminalDefaults,
    colors: resolveColorGroup(theme.colors),
    markdown: resolveColorGroup(theme.markdown),
    syntax: resolveColorGroup(theme.syntax),
    diff: resolveColorGroup(theme.diff),
  });
}

/** Caller owns the native SyntaxStyle resource and must destroy it with its component scope. */
export function createOpenTuiSyntaxStyle(theme: OpenTuiTheme): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    { scope: ["comment"], style: { foreground: theme.syntax.comment, italic: true } },
    {
      scope: ["keyword", "keyword.control", "keyword.function"],
      style: { foreground: theme.syntax.keyword },
    },
    {
      scope: ["function", "function.call", "method", "method.call"],
      style: { foreground: theme.syntax.function },
    },
    {
      scope: ["variable", "property", "field"],
      style: { foreground: theme.syntax.variable },
    },
    { scope: ["string", "string.special"], style: { foreground: theme.syntax.string } },
    { scope: ["number", "float"], style: { foreground: theme.syntax.number } },
    { scope: ["type", "type.builtin"], style: { foreground: theme.syntax.type } },
    { scope: ["operator"], style: { foreground: theme.syntax.operator } },
    { scope: ["punctuation"], style: { foreground: theme.syntax.punctuation } },
    {
      scope: ["constant", "constant.builtin", "boolean"],
      style: { foreground: theme.syntax.constant },
    },
  ]);
}
