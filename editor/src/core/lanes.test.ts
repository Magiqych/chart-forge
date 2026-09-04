import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROWS,
  findRow,
  layoutRows,
  PITCH_LANE_PADDING_PX,
  pitchRange,
  pitchToY,
  type RowId,
} from "./lanes";

const allVisible = () => true;

describe("row layout", () => {
  it("stacks visible rows without gaps", () => {
    const layout = layoutRows(DEFAULT_ROWS, allVisible);
    expect(layout.rows).toHaveLength(DEFAULT_ROWS.length);
    for (let i = 1; i < layout.rows.length; i += 1) {
      expect(layout.rows[i]?.topPx).toBe(layout.rows[i - 1]?.bottomPx);
    }
    expect(layout.rows[0]?.topPx).toBe(0);
  });

  it("totals the heights", () => {
    const layout = layoutRows(DEFAULT_ROWS, allVisible);
    const expected = DEFAULT_ROWS.reduce((n, r) => n + r.heightPx, 0);
    expect(layout.totalHeightPx).toBe(expected);
  });

  it("collapses hidden rows rather than leaving a hole", () => {
    const hidden = new Set<RowId>(["drums", "other"]);
    const layout = layoutRows(DEFAULT_ROWS, (id) => !hidden.has(id));
    expect(layout.rows.map((r) => r.id)).toEqual(["ruler", "waveform", "bass", "vocals", "notes"]);
    for (let i = 1; i < layout.rows.length; i += 1) {
      expect(layout.rows[i]?.topPx).toBe(layout.rows[i - 1]?.bottomPx);
    }
  });

  it("shrinks the total when rows are hidden", () => {
    const all = layoutRows(DEFAULT_ROWS, allVisible).totalHeightPx;
    const fewer = layoutRows(DEFAULT_ROWS, (id) => id !== "vocals").totalHeightPx;
    expect(fewer).toBeLessThan(all);
  });

  it("spans the beat grid across the lanes but not the ruler", () => {
    const layout = layoutRows(DEFAULT_ROWS, allVisible);
    const ruler = findRow(layout, "ruler");
    expect(layout.gridTopPx).toBe(ruler?.bottomPx);
    expect(layout.gridBottomPx).toBe(layout.totalHeightPx);
    expect(layout.gridTopPx).toBeGreaterThan(0);
  });

  it("finds a row by id, and reports a hidden one as absent", () => {
    const layout = layoutRows(DEFAULT_ROWS, (id) => id !== "bass");
    expect(findRow(layout, "drums")?.label).toBe("Drums");
    expect(findRow(layout, "bass")).toBeUndefined();
  });

  it("handles everything hidden", () => {
    const layout = layoutRows(DEFAULT_ROWS, () => false);
    expect(layout.rows).toHaveLength(0);
    expect(layout.totalHeightPx).toBe(0);
  });
});

describe("pitch to y", () => {
  const row = { topPx: 100, heightPx: 74 };
  const range = { minMidi: 40, maxMidi: 80 };

  it("puts the highest pitch at the top of the usable area", () => {
    expect(pitchToY(80, row, range)).toBeCloseTo(100 + PITCH_LANE_PADDING_PX, 6);
  });

  it("puts the lowest pitch at the bottom of the usable area", () => {
    expect(pitchToY(40, row, range)).toBeCloseTo(100 + 74 - PITCH_LANE_PADDING_PX, 6);
  });

  it("is monotonic: higher pitch is never lower on screen", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let midi = 40; midi <= 80; midi += 1) {
      const y = pitchToY(midi, row, range);
      expect(y).toBeLessThanOrEqual(previous);
      previous = y;
    }
  });

  it("puts the midpoint in the middle", () => {
    const mid = pitchToY(60, row, range);
    expect(mid).toBeCloseTo(100 + 74 / 2, 6);
  });

  it("clamps pitches outside the range instead of drawing off-lane", () => {
    const above = pitchToY(200, row, range);
    const below = pitchToY(0, row, range);
    expect(above).toBeGreaterThanOrEqual(row.topPx);
    expect(below).toBeLessThanOrEqual(row.topPx + row.heightPx);
    expect(above).toBeCloseTo(pitchToY(80, row, range), 6);
    expect(below).toBeCloseTo(pitchToY(40, row, range), 6);
  });

  it("centres everything when the range is degenerate", () => {
    expect(pitchToY(60, row, { minMidi: 60, maxMidi: 60 })).toBeCloseTo(137, 6);
  });

  it("stays inside the row for every pitch in range", () => {
    for (let midi = 40; midi <= 80; midi += 0.5) {
      const y = pitchToY(midi, row, range);
      expect(y).toBeGreaterThanOrEqual(row.topPx);
      expect(y).toBeLessThanOrEqual(row.topPx + row.heightPx);
    }
  });
});

describe("pitch range", () => {
  it("brackets the observed pitches with padding", () => {
    const events = [{ pitch: { midi: 50 } }, { pitch: { midi: 62 } }];
    expect(pitchRange(events, 2)).toEqual({ minMidi: 48, maxMidi: 64 });
  });

  it("ignores events without pitch", () => {
    const events = [{ pitch: { midi: 55 } }, {}, { pitch: { midi: 57 } }];
    expect(pitchRange(events, 0)).toEqual({ minMidi: 55, maxMidi: 57 });
  });

  it("falls back to a sane default when nothing has pitch", () => {
    expect(pitchRange([{}, {}])).toEqual({ minMidi: 36, maxMidi: 84 });
  });

  it("gives bass and vocals different scales, as their registers differ", () => {
    const bass = pitchRange([{ pitch: { midi: 31 } }, { pitch: { midi: 60 } }]);
    const vocals = pitchRange([{ pitch: { midi: 55 } }, { pitch: { midi: 84 } }]);
    expect(bass.minMidi).toBeLessThan(vocals.minMidi);
    expect(bass.maxMidi).toBeLessThan(vocals.maxMidi);
  });
});
