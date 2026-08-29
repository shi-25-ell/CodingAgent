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
    { scope: ["default"], style: { foreground: theme.colors.text } },
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
    {
      scope: ["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4"],
      style: { foreground: theme.markdown.heading, bold: true },
    },
    {
      scope: ["markup.heading.1"],
      style: { foreground: theme.markdown.heading, bold: true, underline: true },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: { foreground: theme.markdown.strong, bold: true },
    },
    {
      scope: ["markup.italic"],
      style: { foreground: theme.markdown.emphasis, italic: true },
    },
    { scope: ["markup.list"], style: { foreground: theme.markdown.listMarker } },
    {
      scope: ["markup.quote"],
      style: { foreground: theme.markdown.blockQuote, italic: true },
    },
    {
      scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"],
      style: { foreground: theme.markdown.inlineCode },
    },
    {
      scope: ["markup.link", "markup.link.url"],
      style: { foreground: theme.markdown.link, underline: true },
    },
    {
      scope: ["markup.link.label", "label"],
      style: { foreground: theme.markdown.linkText, underline: true },
    },
    { scope: ["conceal"], style: { foreground: theme.colors.textMuted } },
    {
      scope: ["markup.list.checked"],
      style: { foreground: theme.colors.success },
    },
    {
      scope: ["markup.list.unchecked", "markup.strikethrough"],
      style: { foreground: theme.colors.textMuted },
    },
    {
      scope: ["diff.plus"],
      style: { foreground: theme.diff.added, background: theme.diff.addedBackground },
    },
    {
      scope: ["diff.minus"],
      style: { foreground: theme.diff.removed, background: theme.diff.removedBackground },
    },
    {
      scope: ["diff.delta"],
      style: { foreground: theme.diff.context, background: theme.diff.contextBackground },
    },
    { scope: ["error"], style: { foreground: theme.colors.error, bold: true } },
    { scope: ["warning"], style: { foreground: theme.colors.warning, bold: true } },
    { scope: ["info"], style: { foreground: theme.colors.info } },
  ]);
}
