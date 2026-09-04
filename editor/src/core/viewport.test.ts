import { describe, expect, it } from "vitest";

import {
  clampViewportStart,
  clampZoom,
  fitToWidth,
  lowerBoundByStart,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  maxBoundedDuration,
  panBySeconds,
  timeToX,
  viewportDurationSec,
  viewportEndSec,
  visibleRange,
  visibleSlice,
  xToTime,
  zoomAtAnchor,
  type Viewport,
} from "./viewport";

const view: Viewport = { startSec: 10, pixelsPerSecond: 100, widthPx: 1000 };

describe("time <-> x", () => {
  it("maps the viewport start to x = 0", () => {
    expect(timeToX(10, view)).toBe(0);
  });

  it("maps one second to pixelsPerSecond", () => {
    expect(timeToX(11, view)).toBe(100);
  });

  it("maps times before the viewport to negative x", () => {
    expect(timeToX(9.5, view)).toBe(-50);
  });

  it("round-trips", () => {
    for (const t of [0, 1.5, 10, 37.25, 201.04]) {
      expect(xToTime(timeToX(t, view), view)).toBeCloseTo(t, 9);
    }
  });

  it("round-trips in the other direction", () => {
    for (const x of [-200, 0, 13, 999.5]) {
      expect(timeToX(xToTime(x, view), view)).toBeCloseTo(x, 9);
    }
  });
});

describe("viewport extent", () => {
  it("reports the visible duration", () => {
    expect(viewportDurationSec(view)).toBe(10);
  });

  it("reports the right edge", () => {
    expect(viewportEndSec(view)).toBe(20);
  });

  it("shows more seconds as zoom decreases", () => {
    expect(viewportDurationSec({ ...view, pixelsPerSecond: 20 })).toBe(50);
  });
});

describe("zoom", () => {
  it("clamps to the supported range", () => {
    expect(clampZoom(0.01)).toBe(MIN_PIXELS_PER_SECOND);
    expect(clampZoom(1e9)).toBe(MAX_PIXELS_PER_SECOND);
    expect(clampZoom(120)).toBe(120);
  });

  it("keeps the time under the anchor fixed", () => {
    const anchorX = 250;
    const before = xToTime(anchorX, view);
    const zoomed = zoomAtAnchor(view, 400, anchorX);
    expect(xToTime(anchorX, zoomed)).toBeCloseTo(before, 9);
  });

  it("keeps the anchor fixed when zooming out too", () => {
    const anchorX = 700;
    const before = xToTime(anchorX, view);
    const zoomed = zoomAtAnchor(view, 20, anchorX);
    expect(xToTime(anchorX, zoomed)).toBeCloseTo(before, 9);
  });

  it("anchoring at x=0 only changes the scale", () => {
    const zoomed = zoomAtAnchor(view, 200, 0);
    expect(zoomed.startSec).toBeCloseTo(view.startSec, 9);
    expect(zoomed.pixelsPerSecond).toBe(200);
  });

  it("respects the clamp while anchoring", () => {
    const zoomed = zoomAtAnchor(view, 1e9, 500);
    expect(zoomed.pixelsPerSecond).toBe(MAX_PIXELS_PER_SECOND);
  });

  it("fits a whole track to the width", () => {
    const pps = fitToWidth(200, 1000);
    expect(pps).toBeCloseTo(5, 9);
    expect(viewportDurationSec({ startSec: 0, pixelsPerSecond: pps, widthPx: 1000 })).toBeCloseTo(200, 6);
  });
});

describe("panning and clamping", () => {
  it("does not pan before zero", () => {
    expect(clampViewportStart(-50, view, 200)).toBe(0);
  });

  it("stops so the last screen ends at the track end", () => {
    expect(clampViewportStart(1000, view, 200)).toBe(190);
  });

  it("allows zero start when the track is shorter than the view", () => {
    expect(clampViewportStart(5, view, 4)).toBe(0);
  });

  it("pans by a delta and clamps", () => {
    expect(panBySeconds(view, 5, 200).startSec).toBe(15);
    expect(panBySeconds(view, -100, 200).startSec).toBe(0);
    expect(panBySeconds(view, 1e6, 200).startSec).toBe(190);
  });
});

describe("binary search over events", () => {
  const items = [0, 1, 1, 2, 5, 8, 8, 8, 13].map((startSec, i) => ({
    startSec,
    id: `e${i}`,
  }));

  it("finds the first index at or after a time", () => {
    expect(lowerBoundByStart(items, -1)).toBe(0);
    expect(lowerBoundByStart(items, 0)).toBe(0);
    expect(lowerBoundByStart(items, 1)).toBe(1);
    expect(lowerBoundByStart(items, 1.5)).toBe(3);
    expect(lowerBoundByStart(items, 8)).toBe(5);
    expect(lowerBoundByStart(items, 100)).toBe(items.length);
  });

  it("returns the first of a run of equal timestamps", () => {
    expect(lowerBoundByStart(items, 8)).toBe(5);
    expect(items[5]?.id).toBe("e5");
  });

  it("handles an empty array", () => {
    expect(lowerBoundByStart([], 1)).toBe(0);
  });

  it("agrees with a linear scan on random data", () => {
    const sorted = Array.from({ length: 500 }, (_, i) => ({ startSec: i * 0.37 }));
    for (const probe of [0, 1, 7.3, 50.2, 184.63, 200]) {
      const expected = sorted.findIndex((s) => s.startSec >= probe);
      expect(lowerBoundByStart(sorted, probe)).toBe(expected === -1 ? sorted.length : expected);
    }
  });
});

describe("visible range", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ startSec: i }));

  it("selects only what the window covers", () => {
    expect(visibleSlice(items, 10, 13).map((i) => i.startSec)).toEqual([10, 11, 12]);
  });

  it("widens the start by the longest bounded event", () => {
    const { from } = visibleRange(items, 10, 13, 4);
    expect(from).toBe(6);
  });

  it("never returns an inverted range", () => {
    const { from, to } = visibleRange(items, 50, 50);
    expect(to).toBeGreaterThanOrEqual(from);
  });

  it("returns nothing past the end", () => {
    expect(visibleSlice(items, 500, 600)).toHaveLength(0);
  });

  it("measures the longest bounded event and ignores instantaneous ones", () => {
    const mixed = [
      { startSec: 0, endSec: 0.5 },
      { startSec: 1 },
      { startSec: 2, endSec: 8.41 },
      { startSec: 9 },
    ];
    expect(maxBoundedDuration(mixed)).toBeCloseTo(6.41, 9);
  });

  it("reports zero when nothing is bounded", () => {
    expect(maxBoundedDuration([{ startSec: 1 }, { startSec: 2 }])).toBe(0);
  });

  it("keeps a long event visible after its start has scrolled off", () => {
    const events = [{ startSec: 100, endSec: 106.41 }, { startSec: 105 }];
    const longest = maxBoundedDuration(events);
    const slice = visibleSlice(events, 104, 108, longest);
    expect(slice.map((e) => e.startSec)).toContain(100);
  });
});
