import { describe, expect, it } from "vitest";

import {
  buildSnapGrid, readSnapSettings, snapTime, snapToNearestEventStart, DEFAULT_SNAP,
} from "./snap";

const beat = (timeSec: number) => ({ timeSec });

/** Four beats exactly half a second apart. */
const EVEN = [0, 0.5, 1.0, 1.5].map(beat);

/**
 * Beats whose intervals differ, which is what a real detection looks like. These are
 * the shape the reference analysis actually has: no two intervals identical.
 */
const IRREGULAR = [10.0, 10.42, 10.9, 11.28].map(beat);

describe("buildSnapGrid", () => {
  it("is the beats themselves at division 1", () => {
    expect(buildSnapGrid(EVEN, 1)).toEqual([0, 0.5, 1.0, 1.5]);
  });

  it("splits each interval evenly at higher divisions", () => {
    expect(buildSnapGrid(EVEN, 2)).toEqual([0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5]);
    expect(buildSnapGrid(EVEN, 4)).toHaveLength(13);
  });

  it("subdivides each real interval independently, so an uneven bar stays uneven", () => {
    // The alternative - one uniform grid from an average tempo - would place these
    // subdivisions where no beat was detected. Each half here belongs to its own beat.
    const grid = buildSnapGrid(IRREGULAR, 2);
    expect(grid).toEqual([10.0, 10.21, 10.42, 10.66, 10.9, 11.09, 11.28]);
    expect(grid[1]! - grid[0]!).toBeCloseTo(0.21, 10);
    expect(grid[3]! - grid[2]!).toBeCloseTo(0.24, 10);
  });

  it("never extrapolates past the last detected beat", () => {
    const grid = buildSnapGrid(EVEN, 4);
    expect(grid[grid.length - 1]).toBe(1.5);
  });

  it("copes with no beats and with a single beat", () => {
    expect(buildSnapGrid([], 4)).toEqual([]);
    expect(buildSnapGrid([beat(3)], 4)).toEqual([3]);
  });

  it("treats a nonsensical division as 1 rather than dividing by zero", () => {
    expect(buildSnapGrid(EVEN, 0)).toEqual([0, 0.5, 1.0, 1.5]);
  });
});

describe("snapTime", () => {
  const grid = buildSnapGrid(EVEN, 2);

  it("returns the raw time when snapping is off", () => {
    expect(snapTime(0.37, grid, { enabled: false, division: 2 })).toBe(0.37);
  });

  it("returns the raw time when there is no grid to snap to", () => {
    expect(snapTime(0.37, [], DEFAULT_SNAP)).toBe(0.37);
  });

  it("leaves a time that is already exactly on a beat alone", () => {
    expect(snapTime(1.0, grid, DEFAULT_SNAP)).toBe(1.0);
  });

  it("snaps to the nearest candidate on either side", () => {
    expect(snapTime(0.51, grid, DEFAULT_SNAP)).toBe(0.5);
    expect(snapTime(0.72, grid, DEFAULT_SNAP)).toBe(0.75);
  });

  it("takes the earlier candidate at an exact midpoint, so the result is deterministic", () => {
    expect(snapTime(0.125, grid, DEFAULT_SNAP)).toBe(0);
    expect(snapTime(0.375, grid, DEFAULT_SNAP)).toBe(0.25);
  });

  it("reaches a subdivision that only exists at a higher division", () => {
    const quarters = buildSnapGrid(EVEN, 4);
    expect(snapTime(0.13, quarters, { enabled: true, division: 4 })).toBe(0.125);
    // The same time with only beats to snap to lands on the beat instead.
    expect(snapTime(0.13, buildSnapGrid(EVEN, 1), DEFAULT_SNAP)).toBe(0);
  });

  it("snaps across an uneven interval boundary by real distance, not by index", () => {
    const uneven = buildSnapGrid(IRREGULAR, 1);
    // 10.7 is 0.28 after 10.42 and 0.20 before 10.9, so it belongs to 10.9.
    expect(snapTime(10.7, uneven, DEFAULT_SNAP)).toBe(10.9);
    // 10.6 is 0.18 after 10.42 and 0.30 before 10.9.
    expect(snapTime(10.6, uneven, DEFAULT_SNAP)).toBe(10.42);
  });

  it("clamps to the first beat before the song's grid starts", () => {
    const uneven = buildSnapGrid(IRREGULAR, 1);
    expect(snapTime(0, uneven, DEFAULT_SNAP)).toBe(10.0);
    expect(snapTime(-5, uneven, DEFAULT_SNAP)).toBe(10.0);
  });

  it("clamps to the last beat after the song's grid ends", () => {
    const uneven = buildSnapGrid(IRREGULAR, 1);
    expect(snapTime(200, uneven, DEFAULT_SNAP)).toBe(11.28);
  });

  it("lands exactly on a candidate, never near it", () => {
    for (const raw of [0.01, 0.24, 0.26, 0.49, 1.49]) {
      expect(grid).toContain(snapTime(raw, grid, DEFAULT_SNAP));
    }
  });
});

describe("readSnapSettings", () => {
  it("falls back to the default when the project has no editor state", () => {
    expect(readSnapSettings(undefined)).toEqual(DEFAULT_SNAP);
    expect(readSnapSettings({})).toEqual(DEFAULT_SNAP);
    expect(readSnapSettings(null)).toEqual(DEFAULT_SNAP);
  });

  it("reads project.editor.snap as the Project contract defines it", () => {
    expect(readSnapSettings({ snap: { enabled: false, division: 4 } })).toEqual({
      enabled: false,
      division: 4,
    });
  });

  it("ignores a division that is not a positive integer", () => {
    expect(readSnapSettings({ snap: { division: 0 } }).division).toBe(DEFAULT_SNAP.division);
    expect(readSnapSettings({ snap: { division: 2.5 } }).division).toBe(DEFAULT_SNAP.division);
    expect(readSnapSettings({ snap: { division: "4" } }).division).toBe(DEFAULT_SNAP.division);
  });
});

describe("snapToNearestEventStart", () => {
  const events = [{ startSec: 10.0 }, { startSec: 10.37 }, { startSec: 11.2 }];

  it("takes the nearest event start within the threshold", () => {
    // At 100 px/s the default 10 px threshold is 0.1 s.
    expect(snapToNearestEventStart(10.34, events, 100)).toBe(10.37);
    expect(snapToNearestEventStart(10.05, events, 100)).toBe(10.0);
  });

  it("leaves a time alone when no event is close enough", () => {
    // Nothing is ever dragged across the screen to an event nobody aimed at.
    expect(snapToNearestEventStart(10.6, events, 100)).toBe(10.6);
  });

  it("narrows as the view zooms in, because the threshold is in pixels", () => {
    // The same 0.05 s gap: at 100 px/s it is 5 px away and snaps; at 1000 px/s it is
    // 50 px away and does not. That is what the eye expects of "near".
    expect(snapToNearestEventStart(10.05, events, 100)).toBe(10.0);
    expect(snapToNearestEventStart(10.05, events, 1000)).toBe(10.05);
  });

  it("widens as the view zooms out", () => {
    expect(snapToNearestEventStart(10.5, events, 10)).toBe(10.37);
  });

  it("never snaps to a bounded event's end", () => {
    // Only startSec is a target: an end is where a measured sound stopped, not a moment
    // a player is asked to hit.
    const bounded = [{ startSec: 20.0, endSec: 20.8 }];
    expect(snapToNearestEventStart(20.79, bounded, 100)).toBe(20.79);
    expect(snapToNearestEventStart(20.01, bounded, 100)).toBe(20.0);
  });

  it("resolves equidistant events the same way every time", () => {
    const pair = [{ startSec: 5.0 }, { startSec: 5.2 }];
    const forwards = snapToNearestEventStart(5.1, pair, 100);
    const backwards = snapToNearestEventStart(5.1, [...pair].reverse(), 100);
    expect(forwards).toBe(backwards);
    expect(forwards).toBe(5.0);
  });

  it("copes with no events and with a nonsensical zoom", () => {
    expect(snapToNearestEventStart(1.23, [], 100)).toBe(1.23);
    expect(snapToNearestEventStart(1.23, events, 0)).toBe(1.23);
  });

  it("honours a caller-supplied threshold", () => {
    // 10.6 is 0.23 s past the nearest start. A 10 px threshold at this zoom is 0.1 s
    // and does not reach it; a 60 px one is 0.6 s and does.
    expect(snapToNearestEventStart(10.6, events, 100, 10)).toBe(10.6);
    expect(snapToNearestEventStart(10.6, events, 100, 60)).toBe(10.37);
  });
});
