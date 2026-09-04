/**
 * Vertical layout of the timeline, and where a pitched event sits inside its lane.
 *
 * Pure geometry, kept out of the renderer so it can be tested directly.
 */

import type { LaneId } from "./analysis";

export type RowId = "ruler" | "waveform" | LaneId | "notes";

export interface Row {
  readonly id: RowId;
  readonly label: string;
  readonly heightPx: number;
}

/** Top-to-bottom order of the timeline. Drums first: it is the densest and most used. */
export const DEFAULT_ROWS: readonly Row[] = [
  { id: "ruler", label: "Time", heightPx: 22 },
  { id: "waveform", label: "Waveform", heightPx: 90 },
  { id: "drums", label: "Drums", heightPx: 46 },
  { id: "other", label: "Other", heightPx: 46 },
  { id: "bass", label: "Bass", heightPx: 74 },
  { id: "vocals", label: "Vocals", heightPx: 74 },
  { id: "notes", label: "Notes", heightPx: 70 },
];

export interface LayoutRow extends Row {
  readonly topPx: number;
  readonly bottomPx: number;
}

export interface Layout {
  readonly rows: readonly LayoutRow[];
  readonly totalHeightPx: number;
  /** Where the beat grid is drawn: across the event lanes, not the ruler. */
  readonly gridTopPx: number;
  readonly gridBottomPx: number;
}

/**
 * Stack the visible rows and record where the beat grid spans.
 *
 * Hidden rows collapse rather than leaving a gap, so turning a lane off actually buys
 * screen space instead of just blanking it.
 */
export function layoutRows(
  rows: readonly Row[],
  visible: (id: RowId) => boolean,
): Layout {
  const laid: LayoutRow[] = [];
  let y = 0;
  for (const row of rows) {
    if (!visible(row.id)) continue;
    laid.push({ ...row, topPx: y, bottomPx: y + row.heightPx });
    y += row.heightPx;
  }
  const ruler = laid.find((r) => r.id === "ruler");
  return {
    rows: laid,
    totalHeightPx: y,
    gridTopPx: ruler ? ruler.bottomPx : 0,
    gridBottomPx: y,
  };
}

export function findRow(layout: Layout, id: RowId): LayoutRow | undefined {
  return layout.rows.find((row) => row.id === id);
}

/** Padding kept inside a pitched lane so notes at the extremes stay visible. */
export const PITCH_LANE_PADDING_PX = 6;

/**
 * Where a pitch sits vertically inside its lane: higher pitch, higher on screen.
 *
 * The range is passed in rather than assumed, because bass and vocals occupy very
 * different registers - in the real document bass sits around MIDI 31-60 and vocals
 * around 55-84 - and a shared scale would flatten both into unreadable bands.
 */
export function pitchToY(
  midi: number,
  row: { readonly topPx: number; readonly heightPx: number },
  range: { readonly minMidi: number; readonly maxMidi: number },
): number {
  const usable = Math.max(1, row.heightPx - PITCH_LANE_PADDING_PX * 2);
  const span = range.maxMidi - range.minMidi;
  if (span <= 0) return row.topPx + row.heightPx / 2;
  const clamped = Math.min(range.maxMidi, Math.max(range.minMidi, midi));
  const fraction = (clamped - range.minMidi) / span;
  return row.topPx + PITCH_LANE_PADDING_PX + (1 - fraction) * usable;
}

/** Observed pitch range of a set of events, padded a little so nothing touches an edge. */
export function pitchRange(
  events: readonly { pitch?: { midi: number } }[],
  paddingSemitones = 2,
): { readonly minMidi: number; readonly maxMidi: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.pitch) {
      if (event.pitch.midi < min) min = event.pitch.midi;
      if (event.pitch.midi > max) max = event.pitch.midi;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { minMidi: 36, maxMidi: 84 };
  }
  return { minMidi: min - paddingSemitones, maxMidi: max + paddingSemitones };
}
