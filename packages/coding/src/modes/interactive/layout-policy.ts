import type { SidebarLocalState } from "../../projection/contracts.js";

export type TerminalWidthClass = "narrow" | "regular" | "wide";
export type TerminalHeightClass = "constrained" | "compact" | "comfortable";
export type SidebarPlacement = "closed" | "overlay" | "docked";

export interface InteractiveLayout {
  readonly width: number;
  readonly height: number;
  readonly widthClass: TerminalWidthClass;
  readonly heightClass: TerminalHeightClass;
  readonly primaryRegion: "transcript";
  readonly horizontalPaddingColumns: number;
  readonly mainColumns: number;
  readonly sidebar: {
    readonly visible: boolean;
    readonly placement: SidebarPlacement;
    readonly columns: number;
    readonly preference: SidebarLocalState["preference"];
    readonly explicitlyOpen: boolean;
  };
  readonly headerRows: number;
  readonly statusRows: number;
  readonly composer: {
    readonly minRows: number;
    readonly maxRows: number;
  };
}

export const interactiveLayoutBreakpoints = Object.freeze({
  regularColumns: 72,
  wideColumns: 121,
  compactRows: 20,
  constrainedRows: 12,
  horizontalPaddingColumns: 2,
  sidebarColumns: 42,
} as const);

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`);
  return value;
}

export function resolveInteractiveLayout(
  widthInput: number,
  heightInput: number,
  sidebarState: SidebarLocalState = { preference: "auto", open: false },
): InteractiveLayout {
  const width = positiveInteger(widthInput, "terminal width");
  const height = positiveInteger(heightInput, "terminal height");
  const widthClass: TerminalWidthClass =
    width >= interactiveLayoutBreakpoints.wideColumns
      ? "wide"
      : width >= interactiveLayoutBreakpoints.regularColumns
        ? "regular"
        : "narrow";
  const heightClass: TerminalHeightClass =
    height < interactiveLayoutBreakpoints.constrainedRows
      ? "constrained"
      : height < interactiveLayoutBreakpoints.compactRows
        ? "compact"
        : "comfortable";
  const constrained = heightClass === "constrained";
  const compact = heightClass === "compact";
  const horizontalPaddingColumns = Math.min(
    interactiveLayoutBreakpoints.horizontalPaddingColumns,
    Math.max(0, Math.floor((width - 1) / 2)),
  );
  const visible =
    sidebarState.open || (sidebarState.preference === "auto" && widthClass === "wide");
  const placement: SidebarPlacement = !visible
    ? "closed"
    : widthClass === "wide"
      ? "docked"
      : "overlay";
  const availableMainColumns = width - horizontalPaddingColumns * 2;
  const sidebarColumns = visible
    ? Math.min(interactiveLayoutBreakpoints.sidebarColumns, availableMainColumns)
    : 0;
  const base = {
    width,
    height,
    widthClass,
    heightClass,
    primaryRegion: "transcript" as const,
    horizontalPaddingColumns,
    mainColumns:
      placement === "docked"
        ? Math.max(1, availableMainColumns - sidebarColumns)
        : Math.max(1, availableMainColumns),
    sidebar: {
      visible,
      placement,
      columns: sidebarColumns,
      preference: sidebarState.preference,
      explicitlyOpen: sidebarState.open,
    },
    headerRows: constrained ? 1 : 1,
    statusRows: constrained ? 0 : 1,
    composer: constrained
      ? { minRows: 1, maxRows: 3 }
      : compact
        ? { minRows: 2, maxRows: 5 }
        : { minRows: 3, maxRows: 8 },
  };
  return Object.freeze(base);
}
