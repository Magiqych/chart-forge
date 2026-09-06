import { describe, expect, it } from "vitest";

import {
  clampViewportStart,
  clampZoom,
  fitToWidth,
  lowerBoundByStart,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  maxBoundedDuration,
  centreOnTime,
  followStartSec,
  FOLLOW_HIGH_FRACTION,
  FOLLOW_LEAD_FRACTION,
  FOLLOW_LOW_FRACTION,
  isTimeVisible,
  maxScrollStartSec,
  MIN_SCROLL_THUMB_PX,
  panBySeconds,
  revealStartSec,
  scrollbarGeometry,
  startSecAfterZoom,
  startSecForThumbLeft,
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

describe("scrollbar geometry", () => {
  // 200 s of audio, 1000 px of canvas at 100 px/s: 10 s on screen, 190 s of travel.
  const view = (startSec: number, pixelsPerSecond = 100): Viewport => ({
    startSec,
    pixelsPerSecond,
    widthPx: 1000,
  });
  const DURATION = 200;
  const TRACK = 1000;

  it("sizes the thumb by the fraction of the track on screen", () => {
    const g = scrollbarGeometry(view(0), DURATION, TRACK);
    // 10 s of 200 s is a twentieth of the track.
    expect(g.thumbWidthPx).toBeCloseTo(50, 6);
    expect(g.thumbLeftPx).toBe(0);
    expect(g.scrollable).toBe(true);
  });

  it("puts the thumb at the far right when the view is at the end", () => {
    const g = scrollbarGeometry(view(maxScrollStartSec(view(0), DURATION)), DURATION, TRACK);
    expect(g.thumbLeftPx).toBeCloseTo(g.trackWidthPx - g.thumbWidthPx, 6);
  });

  it("puts the thumb halfway when the view is halfway", () => {
    const g = scrollbarGeometry(view(95), DURATION, TRACK);
    expect(g.thumbLeftPx).toBeCloseTo((TRACK - g.thumbWidthPx) / 2, 6);
  });

  it("follows a zoom without anyone telling it to", () => {
    // The same startSec at four times the zoom shows a quarter of the time, so the thumb
    // is a quarter as wide - and it moves, because the travel it sits in grew. Both
    // thumbs here are comfortably above the minimum, so the proportion is the whole
    // story.
    const wide = scrollbarGeometry(view(50, 25), DURATION, TRACK);
    const close = scrollbarGeometry(view(50, 100), DURATION, TRACK);
    expect(wide.thumbWidthPx).toBeCloseTo(200, 6);
    expect(close.thumbWidthPx).toBeCloseTo(wide.thumbWidthPx / 4, 6);
    expect(close.thumbLeftPx + close.thumbWidthPx).toBeLessThanOrEqual(TRACK + 1e-9);

    // What must hold through a zoom: the thumb still stands for the time the view is
    // actually showing, at either zoom level.
    for (const zoom of [25, 100]) {
      const g = scrollbarGeometry(view(50, zoom), DURATION, TRACK);
      expect(startSecForThumbLeft(g.thumbLeftPx, view(50, zoom), DURATION, TRACK))
        .toBeCloseTo(50, 6);
    }
  });

  it("reports nothing to scroll when the whole track fits", () => {
    const g = scrollbarGeometry(view(0, 5), DURATION, TRACK);
    expect(g.scrollable).toBe(false);
    expect(g.thumbWidthPx).toBe(TRACK);
    expect(g.thumbLeftPx).toBe(0);
  });

  it("keeps the thumb big enough to grab at extreme zoom", () => {
    // 1000 px at 2000 px/s is half a second of a three-minute song: the proportional
    // thumb would be a third of a pixel.
    const g = scrollbarGeometry(view(60, 2000), DURATION, TRACK);
    expect(g.thumbWidthPx).toBe(MIN_SCROLL_THUMB_PX);
    expect(g.scrollable).toBe(true);
  });

  it("never lets the thumb leave the track", () => {
    for (const startSec of [-50, 0, 1, 95, 190, 500]) {
      for (const zoom of [5, 20, 100, 800, 2000]) {
        const g = scrollbarGeometry(view(startSec, zoom), DURATION, TRACK);
        expect(g.thumbLeftPx).toBeGreaterThanOrEqual(0);
        expect(g.thumbLeftPx + g.thumbWidthPx).toBeLessThanOrEqual(TRACK + 1e-9);
      }
    }
  });

  it("copes with a track of no width and a track of no length", () => {
    expect(scrollbarGeometry(view(0), DURATION, 0).scrollable).toBe(false);
    expect(scrollbarGeometry(view(0), 0, TRACK).scrollable).toBe(false);
  });
});

describe("startSecForThumbLeft", () => {
  const view = (startSec: number, pixelsPerSecond = 100): Viewport => ({
    startSec,
    pixelsPerSecond,
    widthPx: 1000,
  });
  const DURATION = 200;
  const TRACK = 1000;

  it("is the exact inverse of the geometry, so dragging does not drift", () => {
    for (const startSec of [0, 12.5, 95, 189.9, 190]) {
      const g = scrollbarGeometry(view(startSec), DURATION, TRACK);
      const back = startSecForThumbLeft(g.thumbLeftPx, view(startSec), DURATION, TRACK);
      expect(back).toBeCloseTo(startSec, 6);
    }
  });

  it("clamps a drag past either end of the track", () => {
    expect(startSecForThumbLeft(-500, view(50), DURATION, TRACK)).toBe(0);
    expect(startSecForThumbLeft(9999, view(50), DURATION, TRACK))
      .toBeCloseTo(maxScrollStartSec(view(50), DURATION), 6);
  });

  it("returns the start of the track when there is nothing to scroll", () => {
    expect(startSecForThumbLeft(400, view(0, 5), DURATION, TRACK)).toBe(0);
  });

  it("reaches the very start and the very end of a long track", () => {
    const zoomed = view(90, 400);
    expect(startSecForThumbLeft(0, zoomed, DURATION, TRACK)).toBe(0);
    const end = startSecForThumbLeft(TRACK, zoomed, DURATION, TRACK);
    // The last screen shows the end of the audio and no more.
    expect(end + viewportDurationSec(zoomed)).toBeCloseTo(DURATION, 6);
  });

  it("agrees with clampViewportStart at the ends", () => {
    const zoomed = view(0, 250);
    const end = startSecForThumbLeft(TRACK, zoomed, DURATION, TRACK);
    expect(clampViewportStart(end, zoomed, DURATION)).toBeCloseTo(end, 6);
    expect(clampViewportStart(end + 10, zoomed, DURATION)).toBeCloseTo(end, 6);
  });
});

describe("centreOnTime", () => {
  // 200 s of audio, 1000 px at 100 px/s: 10 s on screen.
  const view = (startSec: number, pixelsPerSecond = 100): Viewport => ({
    startSec, pixelsPerSecond, widthPx: 1000,
  });
  const DURATION = 200;

  it("puts the time in the middle of the view", () => {
    expect(centreOnTime(view(0), 100, DURATION)).toBeCloseTo(95, 9);
  });

  it("clamps at the head of the song rather than scrolling to a negative time", () => {
    expect(centreOnTime(view(50), 1, DURATION)).toBe(0);
    expect(centreOnTime(view(50), 0, DURATION)).toBe(0);
  });

  it("clamps at the end rather than leaving blank space on screen", () => {
    const end = centreOnTime(view(0), DURATION, DURATION);
    expect(end).toBeCloseTo(maxScrollStartSec(view(0), DURATION), 9);
    expect(end + viewportDurationSec(view(0))).toBeCloseTo(DURATION, 9);
  });

  it("does nothing dramatic when the whole song already fits", () => {
    expect(centreOnTime(view(0, 5), 100, DURATION)).toBe(0);
  });
});

describe("followStartSec", () => {
  const view = (startSec: number, pixelsPerSecond = 100): Viewport => ({
    startSec, pixelsPerSecond, widthPx: 1000,
  });
  const DURATION = 200;

  it("leaves the view alone while the playhead sits comfortably inside it", () => {
    // 10 s on screen from 50: the band runs from 52 to 57.
    expect(followStartSec(view(50), 53, DURATION)).toBeNull();
    expect(followStartSec(view(50), 56.9, DURATION)).toBeNull();
  });

  it("steps the view on when the playhead runs past the band", () => {
    const next = followStartSec(view(50), 58, DURATION);
    // The playhead lands well inside the new window rather than on its edge, so the
    // next step is a whole band away rather than the very next frame.
    expect(next).not.toBeNull();
    expect(58 - (next as number)).toBeCloseTo(3, 9);
  });

  it("steps back when the playhead is behind the view", () => {
    const next = followStartSec(view(50), 45, DURATION);
    expect(next).not.toBeNull();
    expect(next as number).toBeLessThan(50);
  });

  it("returns one start time, never a viewport of its own", () => {
    // There is a single viewport; follow reports where it should start and the caller
    // writes it. Nothing here holds a second scroll position.
    const next = followStartSec(view(50), 58, DURATION);
    expect(typeof next).toBe("number");
  });

  it("does not move past the end of the song", () => {
    const atEnd = view(190);
    expect(followStartSec(atEnd, 199.5, DURATION)).toBeNull();
  });

  it("stays still once it cannot improve matters", () => {
    // Already at the head with the playhead before the band: there is nowhere to go.
    expect(followStartSec(view(0), 0, DURATION)).toBeNull();
  });

  it("agrees with the scrollbar, because both read the same startSec", () => {
    const v = view(50);
    const next = followStartSec(v, 58, DURATION) as number;
    const moved = { ...v, startSec: next };
    const g = scrollbarGeometry(moved, DURATION, 1000);
    expect(startSecForThumbLeft(g.thumbLeftPx, moved, DURATION, 1000)).toBeCloseTo(next, 6);
  });
});

describe("keeping the playhead reachable through a zoom", () => {
  // 10 s to 20 s on screen.
  it("knows what is on screen", () => {
    expect(isTimeVisible(view, 10)).toBe(true);
    expect(isTimeVisible(view, 15)).toBe(true);
    expect(isTimeVisible(view, 20)).toBe(true);
    expect(isTimeVisible(view, 9.99)).toBe(false);
    expect(isTimeVisible(view, 20.01)).toBe(false);
  });

  it("leaves the view alone while the playhead is still on screen", () => {
    // The anchor put the view where the author asked for it. Recentring on every zoom
    // would take the view away from what they were pointing at.
    expect(revealStartSec(view, 15, 300)).toBeNull();
    expect(revealStartSec(view, 10, 300)).toBeNull();
  });

  it("brings the playhead back when the zoom pushed it off", () => {
    const startSec = revealStartSec(view, 40, 300);
    expect(startSec).not.toBeNull();
    expect(startSec).toBe(centreOnTime(view, 40, 300));
    expect(isTimeVisible({ ...view, startSec: startSec as number }, 40)).toBe(true);
  });

  it("reports no move when the view is already where it would be put", () => {
    // Right at the start of the recording there is nowhere to scroll to: the clamp in
    // centreOnTime already has the view where it belongs, so nothing should be said.
    const atZero: Viewport = { startSec: 0, pixelsPerSecond: 100, widthPx: 1000 };
    expect(revealStartSec(atZero, 0, 300)).toBeNull();
  });

  it("does not scroll past the end of the recording", () => {
    const startSec = revealStartSec(view, 299, 300) as number;
    expect(startSec).toBeLessThanOrEqual(maxScrollStartSec(view, 300));
  });

  it("leaves Follow to decide when Follow is on", () => {
    // The two are alternatives, not a sequence: Follow has its own idea of where the
    // playhead should sit, and a zoom must not overrule it with a centring.
    const zoomed: Viewport = { startSec: 10, pixelsPerSecond: 400, widthPx: 1000 };
    const followed = followStartSec(zoomed, 40, 300);
    expect(followed).not.toBeNull();
    expect(isTimeVisible({ ...zoomed, startSec: followed as number }, 40)).toBe(true);
  });
});

describe("startSecAfterZoom", () => {
  it("uses Follow's answer when Follow is on", () => {
    expect(startSecAfterZoom(view, 40, 300, true)).toBe(followStartSec(view, 40, 300));
    // Even for a playhead that is still on screen, Follow keeps its own invariant.
    expect(startSecAfterZoom(view, 19, 300, true)).toBe(followStartSec(view, 19, 300));
  });

  it("only reveals when Follow is off", () => {
    expect(startSecAfterZoom(view, 15, 300, false)).toBeNull();
    expect(startSecAfterZoom(view, 40, 300, false)).toBe(revealStartSec(view, 40, 300));
  });
});

describe("following the playhead during playback", () => {
  // 1000 px at 100 px/s: the view spans 10 s, from 10 s to 20 s.
  const span = 10;
  const lowSec = (v: Viewport) => v.startSec + span * FOLLOW_LOW_FRACTION;
  const highSec = (v: Viewport) => v.startSec + span * FOLLOW_HIGH_FRACTION;

  it("leaves the view alone while the playhead is inside the safety zone", () => {
    // This is what makes the timeline readable: for most of the width it is the playhead
    // that moves, not the whole picture underneath it.
    for (const at of [0.21, 0.3, 0.5, 0.6, 0.7, 0.77]) {
      expect(followStartSec(view, view.startSec + span * at, 300)).toBeNull();
    }
  });

  it("holds still right up to the edges of the zone", () => {
    expect(followStartSec(view, lowSec(view), 300)).toBeNull();
    expect(followStartSec(view, highSec(view), 300)).toBeNull();
  });

  it("steps the view once the playhead passes the right threshold", () => {
    const startSec = followStartSec(view, highSec(view) + 0.01, 300);
    expect(startSec).not.toBeNull();
    expect(startSec as number).toBeGreaterThan(view.startSec);
  });

  it("puts the playhead back near the left of the zone, not in the middle", () => {
    // Landing it low gives it most of the width to travel before the next step, so
    // playback scrolls in occasional readable jumps rather than creeping continuously.
    const playheadSec = highSec(view) + 0.01;
    const startSec = followStartSec(view, playheadSec, 300) as number;
    const fraction = (playheadSec - startSec) / span;
    expect(fraction).toBeCloseTo(FOLLOW_LEAD_FRACTION, 6);
    expect(fraction).toBeGreaterThan(FOLLOW_LOW_FRACTION);
    expect(fraction).toBeLessThan(FOLLOW_HIGH_FRACTION);
  });

  it("steps back when the playhead is behind the left threshold", () => {
    // After a seek backwards the playhead can be left of the zone, or off screen behind
    // it entirely. Follow catches up in that direction too.
    const startSec = followStartSec(view, lowSec(view) - 1, 300);
    expect(startSec).not.toBeNull();
    expect(startSec as number).toBeLessThan(view.startSec);
  });

  it("does not scroll past the start of the recording", () => {
    const atStart: Viewport = { startSec: 0, pixelsPerSecond: 100, widthPx: 1000 };
    // The playhead is at the very beginning, which is left of the zone, but there is
    // nowhere further left to go.
    expect(followStartSec(atStart, 0, 300)).toBeNull();
  });

  it("does not scroll past the end of the recording", () => {
    const near: Viewport = { startSec: 290, pixelsPerSecond: 100, widthPx: 1000 };
    const startSec = followStartSec(near, 299.5, 300);
    if (startSec !== null) {
      expect(startSec).toBeLessThanOrEqual(maxScrollStartSec(near, 300));
    }
    expect(followStartSec(near, 299.5, 300)).toBe(startSec);
  });

  it("keeps the playhead on screen after every step", () => {
    // Walk a playhead across the whole recording the way playback does, applying Follow
    // each time, and check it is never lost. This is the invariant the feature exists
    // for, and it is checked over a real run rather than at one instant.
    let v: Viewport = { startSec: 0, pixelsPerSecond: 100, widthPx: 1000 };
    for (let t = 0; t <= 300; t += 0.25) {
      const startSec = followStartSec(v, t, 300);
      if (startSec !== null) v = { ...v, startSec };
      expect(isTimeVisible(v, t)).toBe(true);
    }
  });

  it("does not depend on the playback rate", () => {
    // The clock is the audio element's own currentTime, so a faster rate simply supplies
    // bigger steps. Follow is a function of where the playhead is, never of how it got
    // there, and the same positions must give the same answers at any speed.
    const positions = (stepSec: number) => {
      let v: Viewport = { startSec: 0, pixelsPerSecond: 100, widthPx: 1000 };
      const seen: number[] = [];
      for (let t = 0; t <= 60; t += stepSec) {
        const startSec = followStartSec(v, t, 300);
        if (startSec !== null) v = { ...v, startSec };
        seen.push(v.startSec);
      }
      return seen;
    };
    // Sampling four times as often at 0.25x must reach the same left edges, in order.
    const slow = [...new Set(positions(0.25))];
    const fast = [...new Set(positions(1))];
    expect(slow).toEqual(fast);
  });

  it("is a different question from the zoom reveal", () => {
    // Playback follow keeps a moving playhead inside a comfortable band; the zoom reveal
    // only rescues one that a change of scale pushed off screen. A playhead at 60% is
    // fine for both, and one at 90% needs the first but not the second.
    const at60 = view.startSec + span * 0.6;
    expect(followStartSec(view, at60, 300)).toBeNull();
    expect(revealStartSec(view, at60, 300)).toBeNull();

    const at90 = view.startSec + span * 0.9;
    expect(followStartSec(view, at90, 300)).not.toBeNull();
    expect(revealStartSec(view, at90, 300)).toBeNull();
  });
});
