import type { TranscriptViewportState } from "./contracts.js";

export interface TranscriptBlockLayout {
  readonly id: string;
  readonly startRow: number;
  readonly endRow: number;
}

export interface TranscriptLayoutMeasurement {
  readonly viewportRows: number;
  readonly contentRows: number;
  readonly blocks: readonly TranscriptBlockLayout[];
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} 必须是非负整数`);
  return value;
}

function validateMeasurement(measurement: TranscriptLayoutMeasurement): void {
  nonNegativeInteger(measurement.viewportRows, "Transcript viewportRows");
  nonNegativeInteger(measurement.contentRows, "Transcript contentRows");
  let previousEnd = 0;
  const ids = new Set<string>();
  for (const block of measurement.blocks) {
    if (block.id.length === 0 || ids.has(block.id)) {
      throw new RangeError("Transcript block id 必须非空且唯一");
    }
    ids.add(block.id);
    nonNegativeInteger(block.startRow, `Transcript block ${block.id} startRow`);
    nonNegativeInteger(block.endRow, `Transcript block ${block.id} endRow`);
    if (block.endRow <= block.startRow || block.startRow < previousEnd) {
      throw new RangeError("Transcript block layout 必须按 row 排序且不能重叠");
    }
    if (block.endRow > measurement.contentRows) {
      throw new RangeError("Transcript block layout 不能超出 contentRows");
    }
    previousEnd = block.endRow;
  }
}

function maxScrollTop(measurement: TranscriptLayoutMeasurement): number {
  return Math.max(0, measurement.contentRows - measurement.viewportRows);
}

function clampScrollTop(scrollTop: number, maximum: number): number {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) {
    throw new RangeError("Transcript scrollTop 必须是非负有限数");
  }
  return Math.min(maximum, Math.floor(scrollTop));
}

function blockAtRow(
  blocks: readonly TranscriptBlockLayout[],
  row: number,
): TranscriptBlockLayout | undefined {
  let nearest: TranscriptBlockLayout | undefined;
  for (const block of blocks) {
    if (block.startRow > row) break;
    nearest = block;
    if (row < block.endRow) return block;
  }
  return nearest;
}

/** Captures renderer row state as a semantic Transcript anchor. */
export function captureTranscriptViewport(
  scrollTopInput: number,
  followTail: boolean,
  unseenBlockCountInput: number,
  measurement: TranscriptLayoutMeasurement,
): TranscriptViewportState {
  validateMeasurement(measurement);
  const maximum = maxScrollTop(measurement);
  const scrollTop = followTail ? maximum : clampScrollTop(scrollTopInput, maximum);
  const unseenBlockCount = followTail
    ? 0
    : nonNegativeInteger(unseenBlockCountInput, "Transcript unseenBlockCount");
  const anchor = followTail ? undefined : blockAtRow(measurement.blocks, scrollTop);
  return Object.freeze({
    scrollTop,
    followTail,
    unseenBlockCount,
    ...(anchor
      ? {
          anchorBlockId: anchor.id,
          anchorOffsetRows: Math.max(0, scrollTop - anchor.startRow),
        }
      : {}),
  });
}

/** Resolves a local semantic anchor against the latest renderer measurement. */
export function restoreTranscriptViewport(
  state: TranscriptViewportState,
  measurement: TranscriptLayoutMeasurement,
): TranscriptViewportState {
  validateMeasurement(measurement);
  const maximum = maxScrollTop(measurement);
  if (state.followTail) {
    return Object.freeze({ scrollTop: maximum, followTail: true, unseenBlockCount: 0 });
  }
  const anchor = state.anchorBlockId
    ? measurement.blocks.find((block) => block.id === state.anchorBlockId)
    : undefined;
  const anchorOffsetRows = nonNegativeInteger(
    state.anchorOffsetRows ?? 0,
    "Transcript anchorOffsetRows",
  );
  const scrollTop = anchor
    ? Math.min(maximum, anchor.startRow + anchorOffsetRows)
    : clampScrollTop(state.scrollTop, maximum);
  return Object.freeze({
    scrollTop,
    followTail: false,
    unseenBlockCount: nonNegativeInteger(state.unseenBlockCount, "Transcript unseenBlockCount"),
    ...(anchor
      ? {
          anchorBlockId: anchor.id,
          anchorOffsetRows: Math.max(0, scrollTop - anchor.startRow),
        }
      : {}),
  });
}
