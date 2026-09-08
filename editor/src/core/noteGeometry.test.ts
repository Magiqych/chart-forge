import { describe, expect, it } from "vitest";

import type { ChartNote } from "./chart";
import {
  distanceToNote, hitTestNote, isInstantaneous, isNoteVisible,
  noteGeometry, notesInRect, rectFromCorners, runConnectors, hitTestRunConnector,
  FLICK_ARROW_PX, MARKER_WIDTH_PX, MIN_GRIP_BODY_PX, RESIZE_HANDLE_PX,
} from "./noteGeometry";
import type { Viewport } from "./viewport";

const ROW = { topPx: 600, heightPx: 120 };
const LANES = 5;

/** 100 px/s starting at 10 s, so 10 s is x = 0 and each second is 100 px. */
const view = (pixelsPerSecond = 100, startSec = 10): Viewport => ({
  startSec,
  pixelsPerSecond,
  widthPx: 1000,
});

const tap = (timeSec: number, lane = 0, extra: Partial<ChartNote> = {}): ChartNote => ({
  id: `n-${timeSec}-${lane}`, type: "tap", timeSec, lane, ...extra,
});

const hold = (timeSec: number, endTimeSec: number, lane = 0, extra: Partial<ChartNote> = {}): ChartNote => ({
  id: `h-${timeSec}`, type: "hold", timeSec, endTimeSec, lane, ...extra,
});

describe("isInstantaneous", () => {
  it("is decided by the end time, not the type name", () => {
    // chartNote.type is an open vocabulary: a chart from elsewhere may use a word this
    // Editor has never seen, and it must still draw correctly.
    expect(isInstantaneous(tap(1))).toBe(true);
    expect(isInstantaneous({ ...tap(1), type: "somethingNobodyHasSeen" })).toBe(true);
    expect(isInstantaneous(hold(1, 2))).toBe(false);
    expect(isInstantaneous({ ...hold(1, 2), type: "alsoUnknown" })).toBe(false);
  });

  it("treats a degenerate end as instantaneous", () => {
    expect(isInstantaneous({ ...tap(1), endTimeSec: 1 })).toBe(true);
    expect(isInstantaneous({ ...tap(1), endTimeSec: 0.5 })).toBe(true);
  });
});

describe("a judgement marker", () => {
  it("is a bar centred on the note's own time", () => {
    const g = noteGeometry(tap(11), ROW, LANES, view());
    expect(g.shape).toBe("instant");
    expect(g.marker!.xPx).toBe(100);
    expect((g.marker!.leftPx + g.marker!.rightPx) / 2).toBeCloseTo(100, 9);
  });

  it("is the only part an instantaneous note has", () => {
    // A Tap is one moment. Nothing is held and nothing is travelled, so there is
    // nothing else to draw - which is what stops it looking like a Long.
    const g = noteGeometry(tap(11), ROW, LANES, view());
    expect(g.endMarker).toBeNull();
    expect(g.body).toBeNull();
    expect(g.connector).toBeNull();
  });

  it("stands the full height of its lane", () => {
    const g = noteGeometry(tap(11), ROW, LANES, view());
    const laneHeight = ROW.heightPx / LANES;
    expect(g.marker!.bottomPx - g.marker!.topPx).toBeGreaterThan(laneHeight * 0.6);
    expect(g.marker!.bottomPx - g.marker!.topPx).toBeLessThan(laneHeight);
  });

  it("sits in the lane it names", () => {
    const first = noteGeometry(tap(11, 0), ROW, LANES, view());
    const last = noteGeometry(tap(11, 4), ROW, LANES, view());
    expect(first.marker!.centreYPx).toBeLessThan(last.marker!.centreYPx);
    expect(last.bottomPx).toBeLessThanOrEqual(ROW.topPx + ROW.heightPx);
  });

  it("gives a flick the same marker as a tap", () => {
    // The direction is drawn beside the marker; it does not change where the moment is.
    const flick = noteGeometry(
      { ...tap(11), type: "flick", direction: "left" }, ROW, LANES, view(),
    );
    expect(flick.shape).toBe("flick");
    expect(flick.marker).toBeNull();
    expect(flick.endMarker).toBeNull();
    expect(flick.body).toBeNull();
    expect(flick.connector).toBeNull();
    // The arrow is the whole note, and it is centred on the moment.
    expect(flick.arrow!.xPx).toBe(100);
    expect((flick.arrow!.leftPx + flick.arrow!.rightPx) / 2).toBeCloseTo(100, 9);
    expect(flick.arrow!.rightPx - flick.arrow!.leftPx).toBe(FLICK_ARROW_PX);
  });

  it("gives a kind it has never heard of the same marker as a tap", () => {
    // Geometry is decided by the fields a note carries, never by its type name, so a
    // chart from elsewhere - or one carrying the retired `purple` - still draws.
    const plain = noteGeometry(tap(11, 2), ROW, LANES, view());
    for (const type of ["purple", "somethingNobodyHasSeen"]) {
      const other = noteGeometry({ ...tap(11, 2), type }, ROW, LANES, view());
      expect(other.shape).toBe("instant");
      expect(other.body).toBeNull();
      expect(other.connector).toBeNull();
      expect(other.marker).toEqual(plain.marker);
    }
  });

  it("has no marker where a flick is concerned, only an arrow", () => {
    const g = noteGeometry(
      { ...tap(11, 2), type: "flick", direction: "right" }, ROW, LANES, view(),
    );
    expect(g.marker).toBeNull();
  });
});

describe("a marker is a thin bar, not a box", () => {
  it("is the same narrow width at every zoom", () => {
    // A moment has no duration to show at scale. A bar that grew with the zoom would
    // become a box whose left and right edges are both plausible readings of "when",
    // which is exactly what this Editor exists to make unambiguous.
    for (const zoom of [5, 25, 100, 400, 2000]) {
      const g = noteGeometry(tap(11), ROW, LANES, view(zoom));
      expect(g.marker!.rightPx - g.marker!.leftPx).toBe(MARKER_WIDTH_PX);
    }
  });

  it("is narrow enough to read as a line", () => {
    expect(MARKER_WIDTH_PX).toBeLessThanOrEqual(4);
    expect(MARKER_WIDTH_PX).toBeGreaterThanOrEqual(2);
  });

  it("is far taller than it is wide", () => {
    const g = noteGeometry(tap(11), ROW, LANES, view());
    const width = g.marker!.rightPx - g.marker!.leftPx;
    const height = g.marker!.bottomPx - g.marker!.topPx;
    expect(height).toBeGreaterThan(width * 4);
  });

  it("stays centred on the note's own time", () => {
    for (const zoom of [5, 100, 2000]) {
      const g = noteGeometry(tap(11), ROW, LANES, view(zoom));
      expect((g.marker!.leftPx + g.marker!.rightPx) / 2).toBeCloseTo(g.marker!.xPx, 9);
    }
  });

  it("gives an unfamiliar kind and a slide point the same bar as a tap", () => {
    const plain = noteGeometry(tap(11, 2), ROW, LANES, view());
    for (const type of ["purple", "slide"]) {
      const g = noteGeometry({ ...tap(11, 2), type }, ROW, LANES, view());
      expect(g.shape).toBe("instant");
      expect(g.marker).toEqual(plain.marker);
      expect(g.body).toBeNull();
      expect(g.arrow).toBeNull();
    }
  });
});

describe("a held note", () => {
  it("is two markers with a body between them", () => {
    const g = noteGeometry(hold(11, 11.5), ROW, LANES, view());
    expect(g.shape).toBe("held");
    expect(g.marker!.xPx).toBe(100);
    expect(g.endMarker?.xPx).toBe(150);
    expect(g.body).not.toBeNull();
    expect(g.connector).toBeNull();
  });

  it("has a body spanning exactly its own duration", () => {
    const g = noteGeometry(hold(11, 11.5), ROW, LANES, view());
    expect((g.body as { leftPx: number; rightPx: number }).rightPx -
           (g.body as { leftPx: number }).leftPx).toBeCloseTo(50, 9);
  });

  it("stretches and shrinks with the zoom, because the duration is real", () => {
    for (const zoom of [25, 50, 100, 400]) {
      const g = noteGeometry(hold(11, 11.5), ROW, LANES, view(zoom));
      const body = g.body as { leftPx: number; rightPx: number };
      expect(body.rightPx - body.leftPx).toBeCloseTo(0.5 * zoom, 9);
    }
  });

  it("is not subject to the marker clamps", () => {
    const g = noteGeometry(hold(11, 15), ROW, LANES, view(400));
    const body = g.body as { leftPx: number; rightPx: number };
    expect(body.rightPx - body.leftPx).toBeCloseTo(1600, 9);
  });

  it("stays in one lane", () => {
    const g = noteGeometry(hold(11, 12, 2), ROW, LANES, view());
    expect(g.endMarker?.lane).toBe(2);
    expect(g.endMarker?.centreYPx).toBe(g.marker!.centreYPx);
  });

  it("keeps its body shorter than its markers, so the moments stay legible", () => {
    const g = noteGeometry(hold(11, 12, 2), ROW, LANES, view());
    const body = g.body as { topPx: number; bottomPx: number };
    expect(body.bottomPx - body.topPx)
      .toBeLessThan(g.marker!.bottomPx - g.marker!.topPx);
  });
});

describe("a travelling note", () => {
  const slideNote = (lane: number, endLane: number): ChartNote => ({
    id: `s-${lane}-${endLane}`, type: "slide", timeSec: 11, endTimeSec: 12, lane, endLane,
  });

  it("is two markers joined by a connector, and never a body", () => {
    // This is the whole point of the distinction: a slide's checkpoints are instants and
    // the line between them is a path, so drawing it as a held body would say the player
    // keeps something pressed the entire way, which is not what a slide asks for.
    const g = noteGeometry(slideNote(0, 3), ROW, LANES, view());
    expect(g.shape).toBe("travelling");
    expect(g.body).toBeNull();
    expect(g.connector).not.toBeNull();
    expect(g.endMarker).not.toBeNull();
  });

  it("gives both ends the same marker a tap would get", () => {
    const g = noteGeometry(slideNote(0, 3), ROW, LANES, view());
    expect(g.marker!.rightPx - g.marker!.leftPx).toBe(MARKER_WIDTH_PX);
    expect(g.endMarker!.rightPx - g.endMarker!.leftPx).toBe(MARKER_WIDTH_PX);
  });

  it("runs its connector between the two markers' centres", () => {
    const g = noteGeometry(slideNote(0, 3), ROW, LANES, view());
    const c = g.connector as { fromXPx: number; fromYPx: number; toXPx: number; toYPx: number };
    expect(c.fromXPx).toBe(g.marker!.xPx);
    expect(c.fromYPx).toBe(g.marker!.centreYPx);
    expect(c.toXPx).toBe((g.endMarker as { xPx: number }).xPx);
    expect(c.toYPx).toBe((g.endMarker as { centreYPx: number }).centreYPx);
    expect(c.toYPx).toBeGreaterThan(c.fromYPx);
  });

  it("still travels when it comes back to the lane it started in", () => {
    // A level connector, not a held body: nothing about a slide requires it to end
    // elsewhere, and it is still a pair of checkpoints rather than something pressed.
    const g = noteGeometry(slideNote(2, 2), ROW, LANES, view());
    expect(g.shape).toBe("travelling");
    expect(g.body).toBeNull();
    const c = g.connector as { fromYPx: number; toYPx: number };
    expect(c.toYPx).toBe(c.fromYPx);
  });

  it("is told from a held note by the end lane, not by the type name", () => {
    // chartNote.type is an open vocabulary, so the fields decide.
    const named = noteGeometry(
      { id: "x", type: "somethingNobodyHasSeen", timeSec: 11, endTimeSec: 12, lane: 0, endLane: 2 },
      ROW, LANES, view(),
    );
    expect(named.shape).toBe("travelling");
    const held = noteGeometry(
      { id: "y", type: "slide", timeSec: 11, endTimeSec: 12, lane: 0 },
      ROW, LANES, view(),
    );
    expect(held.shape).toBe("held");
  });
});

describe("viewport culling", () => {
  it("keeps a note on screen and drops one outside it", () => {
    const v = view();
    expect(isNoteVisible(noteGeometry(tap(15), ROW, LANES, v), v)).toBe(true);
    expect(isNoteVisible(noteGeometry(tap(60), ROW, LANES, v), v)).toBe(false);
    expect(isNoteVisible(noteGeometry(tap(0), ROW, LANES, v), v)).toBe(false);
  });

  it("keeps a long note that only overlaps the edges", () => {
    const v = view();
    expect(isNoteVisible(noteGeometry(hold(5, 40), ROW, LANES, v), v)).toBe(true);
  });

  it("keeps a bar straddling the left edge", () => {
    const v = view();
    expect(isNoteVisible(noteGeometry(tap(10), ROW, LANES, v), v)).toBe(true);
  });
});

describe("hit testing matches the drawn geometry", () => {
  const v = view();

  it("hits a marker exactly where it is drawn", () => {
    const note = tap(11, 2);
    const g = noteGeometry(note, ROW, LANES, v);
    const hit = hitTestNote(g.marker!.xPx, g.marker!.centreYPx, [note], ROW, LANES, v);
    expect(hit?.note.id).toBe(note.id);
    expect(hit?.distancePx).toBe(0);
  });

  it("hits anywhere along a long note's body", () => {
    const note = hold(11, 13, 1);
    const g = noteGeometry(note, ROW, LANES, v);
    const endX = (g.endMarker as { xPx: number }).xPx;
    for (const x of [g.marker!.xPx, (g.marker!.xPx + endX) / 2, endX]) {
      expect(hitTestNote(x, g.marker!.centreYPx, [note], ROW, LANES, v)?.note.id)
        .toBe(note.id);
    }
  });

  it("hits anywhere along a slide's trajectory", () => {
    const note: ChartNote = {
      id: "s-1", type: "slide", timeSec: 11, endTimeSec: 13, lane: 0, endLane: 4,
    };
    const g = noteGeometry(note, ROW, LANES, v);
    const c = g.connector as { fromXPx: number; fromYPx: number; toXPx: number; toYPx: number };
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const x = c.fromXPx + (c.toXPx - c.fromXPx) * t;
      const y = c.fromYPx + (c.toYPx - c.fromYPx) * t;
      expect(hitTestNote(x, y, [note], ROW, LANES, v)?.note.id).toBe(note.id);
    }
  });

  it("does not hit the empty corner beside a steep slide", () => {
    // The bounding box covers that corner; the parts do not, and the parts are what the
    // author can see. Selecting from a box would select things nothing was drawn on.
    const note: ChartNote = {
      id: "s-2", type: "slide", timeSec: 11, endTimeSec: 13, lane: 0, endLane: 4,
    };
    const g = noteGeometry(note, ROW, LANES, v);
    // Top-right of the box: late in time but still up at the starting lane.
    expect(hitTestNote(g.rightPx - 2, g.topPx + 2, [note], ROW, LANES, v)).toBeNull();
  });

  it("misses where nothing is drawn", () => {
    const note = tap(11, 2);
    const g = noteGeometry(note, ROW, LANES, v);
    expect(hitTestNote(g.marker!.xPx + 40, g.marker!.centreYPx, [note], ROW, LANES, v))
      .toBeNull();
    expect(hitTestNote(g.marker!.xPx, g.marker!.centreYPx + 50, [note], ROW, LANES, v))
      .toBeNull();
  });

  it("agrees with the drawn geometry at every zoom", () => {
    for (const zoom of [5, 25, 100, 400, 2000]) {
      const v2 = view(zoom);
      const note = tap(v2.startSec + v2.widthPx / zoom / 2, 3);
      const g = noteGeometry(note, ROW, LANES, v2);
      expect(hitTestNote(g.marker!.xPx, g.marker!.centreYPx, [note], ROW, LANES, v2)?.note.id)
        .toBe(note.id);
      expect(distanceToNote(g.marker!.xPx, g.marker!.centreYPx, g)).toBe(0);
    }
  });

  it("cannot select a note that is off screen", () => {
    const note = tap(60, 0);
    expect(hitTestNote(500, ROW.topPx + 10, [note], ROW, LANES, v)).toBeNull();
  });

  it("picks the nearer of two notes in one lane", () => {
    const near = tap(11, 0);
    const far = tap(11.4, 0);
    const g = noteGeometry(near, ROW, LANES, v);
    expect(hitTestNote(g.marker!.xPx, g.marker!.centreYPx, [near, far], ROW, LANES, v)?.note.id)
      .toBe(near.id);
  });

  it("separates simultaneous notes by lane", () => {
    const chord = [tap(11, 0), tap(11, 2), tap(11, 4)];
    for (const note of chord) {
      const g = noteGeometry(note, ROW, LANES, v);
      expect(hitTestNote(g.marker!.xPx, g.marker!.centreYPx, chord, ROW, LANES, v)?.note.id)
        .toBe(note.id);
    }
  });

  it("resolves an exact overlap the same way every time", () => {
    const a: ChartNote = { id: "n-aaa", type: "tap", timeSec: 11, lane: 0 };
    const b: ChartNote = { id: "n-bbb", type: "tap", timeSec: 11, lane: 0 };
    const g = noteGeometry(a, ROW, LANES, v);
    expect(hitTestNote(g.marker!.xPx, g.marker!.centreYPx, [a, b], ROW, LANES, v)?.note.id)
      .toBe("n-aaa");
    expect(hitTestNote(g.marker!.xPx, g.marker!.centreYPx, [b, a], ROW, LANES, v)?.note.id)
      .toBe("n-aaa");
  });
});

describe("the four kinds are told apart by shape", () => {
  const v = view();

  it("gives each kind the parts it should have", () => {
    const parts = (note: ChartNote) => {
      const g = noteGeometry(note, ROW, LANES, v);
      return {
        shape: g.shape,
        markers: (g.marker ? 1 : 0) + (g.endMarker ? 1 : 0),
        body: g.body !== null,
        connector: g.connector !== null,
      };
    };

    expect(parts(tap(11, 0))).toEqual(
      { shape: "instant", markers: 1, body: false, connector: false },
    );
    expect(parts({ ...tap(11, 0), type: "somethingNobodyHasSeen" })).toEqual(
      { shape: "instant", markers: 1, body: false, connector: false },
    );
    expect(parts({ ...tap(11, 0), type: "flick", direction: "left" })).toEqual(
      { shape: "flick", markers: 0, body: false, connector: false },
    );
    expect(parts(hold(11, 12, 0))).toEqual(
      { shape: "held", markers: 2, body: true, connector: false },
    );
    expect(parts({
      id: "s", type: "slide", timeSec: 11, endTimeSec: 12, lane: 0, endLane: 3,
    })).toEqual(
      { shape: "travelling", markers: 2, body: false, connector: true },
    );
  });

  it("never gives a slide the body a long note has", () => {
    const long = noteGeometry(hold(11, 12, 0), ROW, LANES, v);
    const slide = noteGeometry(
      { id: "s", type: "slide", timeSec: 11, endTimeSec: 12, lane: 0, endLane: 3 },
      ROW, LANES, v,
    );
    expect(long.body).not.toBeNull();
    expect(slide.body).toBeNull();
  });

  it("selects an unfamiliar kind through the shared hit test", () => {
    const note = { ...tap(11, 2), type: "purple" };
    const g = noteGeometry(note, ROW, LANES, v);
    expect(hitTestNote(g.marker!.xPx, g.marker!.centreYPx, [note], ROW, LANES, v)?.note.id)
      .toBe(note.id);
  });

  it("selects a long note anywhere along its body, not only at the start", () => {
    const note = hold(11, 13, 1);
    const g = noteGeometry(note, ROW, LANES, v);
    const endX = (g.endMarker as { xPx: number }).xPx;
    for (const t of [0, 0.25, 0.75, 1]) {
      const x = g.marker!.xPx + (endX - g.marker!.xPx) * t;
      expect(hitTestNote(x, g.marker!.centreYPx, [note], ROW, LANES, v)?.note.id)
        .toBe(note.id);
    }
  });
});

describe("rubber-band selection", () => {
  const v = view();
  // Five lanes over 120 px from y=600: each band is 24 px, lane 0 centred on 612.
  const slide = (timeSec: number, endTimeSec: number, lane: number, endLane: number): ChartNote =>
    ({ id: `s-${timeSec}`, type: "slide", timeSec, endTimeSec, lane, endLane });

  it("normalises a rectangle dragged in any direction", () => {
    const downRight = rectFromCorners(10, 20, 110, 220);
    expect(rectFromCorners(110, 220, 10, 20)).toEqual(downRight);
    expect(rectFromCorners(110, 20, 10, 220)).toEqual(downRight);
  });

  it("catches a note whose drawn bar it overlaps", () => {
    const note = tap(11, 1);
    const caught = notesInRect(rectFromCorners(90, 620, 110, 650), [note], ROW, LANES, v);
    expect(caught).toEqual([note]);
  });

  it("misses a note in the same lane at another time", () => {
    expect(notesInRect(rectFromCorners(300, 620, 400, 650), [tap(11, 1)], ROW, LANES, v))
      .toEqual([]);
  });

  it("misses a note at the same time in another lane", () => {
    // y 700..720 is lane 4; the note is in lane 1.
    expect(notesInRect(rectFromCorners(90, 700, 110, 720), [tap(11, 1)], ROW, LANES, v))
      .toEqual([]);
  });

  it("catches a long note touched anywhere along its body", () => {
    // The band covers neither end of the note, only the middle of it. Selecting by the
    // start point alone would miss this, which is the whole reason intersection is the
    // rule.
    const note = hold(11, 13, 0);
    expect(notesInRect(rectFromCorners(180, 606, 220, 618), [note], ROW, LANES, v))
      .toEqual([note]);
  });

  it("catches a slide by its trajectory, not just its ends", () => {
    // Lane 0 at 11 s to lane 3 at 13 s: the connector runs from (100, 612) to (300, 684),
    // so a band on the line between them catches it. A band in the corner of its
    // bounding box, where nothing is drawn, does not.
    const note = slide(11, 13, 0, 3);
    expect(notesInRect(rectFromCorners(195, 645, 205, 655), [note], ROW, LANES, v))
      .toEqual([note]);
    expect(notesInRect(rectFromCorners(280, 605, 300, 615), [note], ROW, LANES, v))
      .toEqual([]);
  });

  it("catches a slide by either of its judgement points", () => {
    const note = slide(11, 13, 0, 3);
    expect(notesInRect(rectFromCorners(95, 605, 105, 620), [note], ROW, LANES, v))
      .toEqual([note]);
    expect(notesInRect(rectFromCorners(295, 678, 305, 690), [note], ROW, LANES, v))
      .toEqual([note]);
  });

  it("returns notes in chart order whichever way the band was dragged", () => {
    const notes = [tap(11, 0), tap(11.5, 1), tap(12, 2)];
    const forwards = notesInRect(rectFromCorners(80, 600, 220, 700), notes, ROW, LANES, v);
    const backwards = notesInRect(rectFromCorners(220, 700, 80, 600), notes, ROW, LANES, v);
    expect(forwards.map((n) => n.id)).toEqual(["n-11-0", "n-11.5-1", "n-12-2"]);
    expect(backwards).toEqual(forwards);
  });

  it("selects nothing for a band over empty space", () => {
    expect(notesInRect(rectFromCorners(500, 600, 600, 720), [tap(11, 0)], ROW, LANES, v))
      .toEqual([]);
  });

  it("agrees with the hit test about what is under a point", () => {
    // A degenerate band at a point must catch exactly what a click there would find,
    // because both read the same geometry.
    const notes = [tap(11, 1), hold(12, 14, 3)];
    for (const [x, y] of [[100, 636], [250, 684], [500, 600]] as const) {
      const hit = hitTestNote(x, y, notes, ROW, LANES, v);
      const band = notesInRect(rectFromCorners(x, y, x, y), notes, ROW, LANES, v);
      expect(band.map((n) => n.id)).toEqual(hit ? [hit.note.id] : []);
    }
  });

  it("does not depend on where the viewport starts", () => {
    // The same note, the same place on screen, a different scroll position: the band is
    // in canvas pixels and so is the geometry, so scrolling changes nothing.
    const scrolled: Viewport = { startSec: 30, pixelsPerSecond: 100, widthPx: 1000 };
    const here = notesInRect(rectFromCorners(90, 620, 110, 650), [tap(11, 1)], ROW, LANES, v);
    const there = notesInRect(
      rectFromCorners(90, 620, 110, 650), [tap(31, 1)], ROW, LANES, scrolled,
    );
    expect(here).toHaveLength(1);
    expect(there).toHaveLength(1);
  });

  it("does not depend on the zoom", () => {
    const zoomed: Viewport = { startSec: 10, pixelsPerSecond: 400, widthPx: 1000 };
    // At 400 px/s, 11 s is x = 400 rather than x = 100.
    expect(notesInRect(rectFromCorners(390, 620, 410, 650), [tap(11, 1)], ROW, LANES, zoomed))
      .toHaveLength(1);
    expect(notesInRect(rectFromCorners(90, 620, 110, 650), [tap(11, 1)], ROW, LANES, zoomed))
      .toHaveLength(0);
  });
});

describe("a multi-point slide on screen", () => {
  const v = view();
  /** Four points: 11 s lane 0, 12 s lane 3, 13 s lane 1, 14 s lane 4. */
  const chain: ChartNote = {
    id: "s-chain",
    type: "slide",
    timeSec: 11,
    lane: 0,
    waypoints: [
      { timeSec: 12, lane: 3 },
      { timeSec: 13, lane: 1 },
    ],
    endTimeSec: 14,
    endLane: 4,
  };

  it("draws one marker per judgement point", () => {
    const g = noteGeometry(chain, ROW, LANES, v);
    expect(g.markers).toHaveLength(4);
    expect(g.markers.map((m) => m.lane)).toEqual([0, 3, 1, 4]);
    expect(g.markers.map((m) => m.xPx)).toEqual([100, 200, 300, 400]);
  });

  it("draws one connector between each pair of points", () => {
    // Four points make three segments, not one line from end to end.
    const g = noteGeometry(chain, ROW, LANES, v);
    expect(g.connectors).toHaveLength(3);
    expect(g.connectors.map((c) => [c.fromXPx, c.toXPx]))
      .toEqual([[100, 200], [200, 300], [300, 400]]);
  });

  it("joins the segments end to end", () => {
    const g = noteGeometry(chain, ROW, LANES, v);
    for (let i = 1; i < g.connectors.length; i += 1) {
      expect(g.connectors[i]!.fromXPx).toBe(g.connectors[i - 1]!.toXPx);
      expect(g.connectors[i]!.fromYPx).toBe(g.connectors[i - 1]!.toYPx);
    }
  });

  it("gives every point the same thin bar a tap gets", () => {
    const g = noteGeometry(chain, ROW, LANES, v);
    for (const marker of g.markers) {
      expect(marker.rightPx - marker.leftPx).toBe(MARKER_WIDTH_PX);
    }
  });

  it("still has no body, however many points it has", () => {
    const g = noteGeometry(chain, ROW, LANES, v);
    expect(g.shape).toBe("travelling");
    expect(g.body).toBeNull();
    expect(g.resizeHandle).toBeNull();
  });

  it("keeps the two-point slide working with no waypoints", () => {
    const pair: ChartNote = {
      id: "s-pair", type: "slide", timeSec: 11, endTimeSec: 13, lane: 0, endLane: 3,
    };
    const g = noteGeometry(pair, ROW, LANES, v);
    expect(g.markers).toHaveLength(2);
    expect(g.connectors).toHaveLength(1);
  });

  it("is selectable by any of its markers", () => {
    const g = noteGeometry(chain, ROW, LANES, v);
    for (const marker of g.markers) {
      expect(hitTestNote(marker.xPx, marker.centreYPx, [chain], ROW, LANES, v)?.note.id)
        .toBe("s-chain");
    }
  });

  it("is selectable along the second connector, not just the first", () => {
    const g = noteGeometry(chain, ROW, LANES, v);
    const second = g.connectors[1]!;
    const midX = (second.fromXPx + second.toXPx) / 2;
    const midY = (second.fromYPx + second.toYPx) / 2;
    const hit = hitTestNote(midX, midY, [chain], ROW, LANES, v);
    expect(hit?.note.id).toBe("s-chain");
    expect(hit?.part).toBe("connector");
  });

  it("reports a middle point as a waypoint rather than an end", () => {
    const g = noteGeometry(chain, ROW, LANES, v);
    const middle = g.markers[1]!;
    expect(hitTestNote(middle.xPx, middle.centreYPx, [chain], ROW, LANES, v)?.part)
      .toBe("waypoint");
  });

  it("is caught by a rubber band over any one of its segments", () => {
    const g = noteGeometry(chain, ROW, LANES, v);
    for (const c of g.connectors) {
      const midX = (c.fromXPx + c.toXPx) / 2;
      const midY = (c.fromYPx + c.toYPx) / 2;
      expect(notesInRect(
        rectFromCorners(midX - 4, midY - 4, midX + 4, midY + 4),
        [chain], ROW, LANES, v,
      )).toEqual([chain]);
    }
  });

  it("is not caught by a band in an empty corner of its bounding box", () => {
    // The chain spans lanes 0 to 4 and 11 s to 14 s, so its box is large. Only the parts
    // that are actually drawn should select it.
    const g = noteGeometry(chain, ROW, LANES, v);
    expect(notesInRect(
      rectFromCorners(g.rightPx - 2, g.topPx + 1, g.rightPx, g.topPx + 3),
      [chain], ROW, LANES, v,
    )).toEqual([]);
  });

  it("bounds itself around every point", () => {
    const g = noteGeometry(chain, ROW, LANES, v);
    expect(g.leftPx).toBe(Math.min(...g.markers.map((m) => m.leftPx)));
    expect(g.rightPx).toBe(Math.max(...g.markers.map((m) => m.rightPx)));
    expect(g.topPx).toBe(Math.min(...g.markers.map((m) => m.topPx)));
    expect(g.bottomPx).toBe(Math.max(...g.markers.map((m) => m.bottomPx)));
  });
});

describe("a note that ends in a flick", () => {
  const v = view();
  const heldFlick = (direction: string): ChartNote => ({
    id: "h-flick", type: "hold", timeSec: 11, endTimeSec: 13, lane: 1,
    endAction: { type: "flick", direction } as never,
  });

  it("draws an arrow instead of its last bar", () => {
    const g = noteGeometry(heldFlick("right"), ROW, LANES, v);
    expect(g.markers).toHaveLength(1);
    expect(g.arrow).not.toBeNull();
    expect(g.body).not.toBeNull();
  });

  it("centres the arrow on endTimeSec", () => {
    // Losing the bar must not lose the moment: the middle of the arrow is the instant.
    const g = noteGeometry(heldFlick("right"), ROW, LANES, v);
    expect(g.arrow!.xPx).toBe(300);
    expect((g.arrow!.leftPx + g.arrow!.rightPx) / 2).toBeCloseTo(300, 9);
  });

  it("keeps the start bar where it was", () => {
    const plain = noteGeometry(hold(11, 13, 1), ROW, LANES, v);
    const flicked = noteGeometry(heldFlick("left"), ROW, LANES, v);
    expect(flicked.markers[0]).toEqual(plain.markers[0]);
  });

  it("carries the stored direction into the arrow", () => {
    expect(noteGeometry(heldFlick("left"), ROW, LANES, v).arrow!.direction).toBe("left");
    expect(noteGeometry(heldFlick("right"), ROW, LANES, v).arrow!.direction).toBe("right");
  });

  it("is selectable by its end arrow", () => {
    const note = heldFlick("right");
    const g = noteGeometry(note, ROW, LANES, v);
    // Anywhere on the arrow selects the note, which is what matters.
    for (const x of [g.arrow!.leftPx + 1, g.arrow!.xPx, g.arrow!.rightPx - 1]) {
      expect(hitTestNote(x, g.arrow!.centreYPx, [note], ROW, LANES, v)?.note.id)
        .toBe("h-flick");
    }
  });

  it("lets the grip win where it overlaps the arrow, and the arrow win elsewhere", () => {
    // The grip sits on the end of the body, which is where the arrow now is. A press in
    // the middle grips - that is the point of a grip - and the wider parts of the arrow,
    // outside the grip's narrower box, report the arrow.
    const note = heldFlick("right");
    const g = noteGeometry(note, ROW, LANES, v);
    expect(hitTestNote(g.arrow!.xPx, g.arrow!.centreYPx, [note], ROW, LANES, v)?.part)
      .toBe("resizeHandle");
    expect(hitTestNote(g.arrow!.rightPx - 1, g.arrow!.centreYPx, [note], ROW, LANES, v)?.part)
      .toBe("arrow");
  });

  it("is caught by a rubber band over its end arrow", () => {
    const note = heldFlick("left");
    const g = noteGeometry(note, ROW, LANES, v);
    expect(notesInRect(
      rectFromCorners(g.arrow!.leftPx, g.arrow!.topPx, g.arrow!.rightPx, g.arrow!.bottomPx),
      [note], ROW, LANES, v,
    )).toEqual([note]);
  });

  it("bounds itself around the arrow, which is wider than a bar", () => {
    const plain = noteGeometry(hold(11, 13, 1), ROW, LANES, v);
    const flicked = noteGeometry(heldFlick("right"), ROW, LANES, v);
    expect(flicked.rightPx).toBeGreaterThan(plain.rightPx);
  });

  it("flicks only the last point of a chain", () => {
    const chain: ChartNote = {
      id: "s-flick", type: "slide", timeSec: 11, lane: 0,
      waypoints: [{ timeSec: 12, lane: 3 }, { timeSec: 13, lane: 1 }],
      endTimeSec: 14, endLane: 4,
      endAction: { type: "flick", direction: "right" } as never,
    };
    const g = noteGeometry(chain, ROW, LANES, v);
    // Four points: three keep their bars, the last becomes the arrow.
    expect(g.markers).toHaveLength(3);
    expect(g.arrow!.xPx).toBe(400);
    expect(g.connectors).toHaveLength(3);
  });

  it("runs the last connector all the way to the arrow", () => {
    const chain: ChartNote = {
      id: "s-flick2", type: "slide", timeSec: 11, lane: 0,
      endTimeSec: 13, endLane: 4,
      endAction: { type: "flick", direction: "left" } as never,
    };
    const g = noteGeometry(chain, ROW, LANES, v);
    const last = g.connectors[g.connectors.length - 1]!;
    expect(last.toXPx).toBe(g.arrow!.xPx);
    expect(last.toYPx).toBe(g.arrow!.centreYPx);
  });

  it("still offers the resize grip at the end", () => {
    const g = noteGeometry(heldFlick("right"), ROW, LANES, v);
    expect(g.resizeHandle).not.toBeNull();
    expect((g.resizeHandle!.leftPx + g.resizeHandle!.rightPx) / 2).toBeCloseTo(300, 9);
  });
});

describe("a run of flicks on screen", () => {
  const v = view();
  const flick = (id: string, timeSec: number, lane: number, direction: string): ChartNote =>
    ({ id, type: "flick", timeSec, lane, direction } as ChartNote);

  /** Four flicks at 11, 12, 13, 14 s in lanes 0, 1, 3, 4, joined head to tail. */
  const run = () => ({
    notes: [
      flick("f1", 11, 0, "right"),
      flick("f2", 12, 1, "right"),
      flick("f3", 13, 3, "left"),
      flick("f4", 14, 4, "right"),
    ],
    connections: [
      { type: "flick", fromNoteId: "f1", toNoteId: "f2" },
      { type: "flick", fromNoteId: "f2", toNoteId: "f3" },
      { type: "flick", fromNoteId: "f3", toNoteId: "f4" },
    ],
  });

  it("draws one link fewer than it has flicks", () => {
    expect(runConnectors(run(), ROW, LANES, v)).toHaveLength(3);
  });

  it("leaves every flick an arrow, with no bar", () => {
    for (const note of run().notes) {
      const g = noteGeometry(note, ROW, LANES, v);
      expect(g.arrow).not.toBeNull();
      expect(g.markers).toEqual([]);
      expect(g.body).toBeNull();
    }
  });

  it("runs each link from one arrow centre to the next", () => {
    const state = run();
    const connectors = runConnectors(state, ROW, LANES, v);
    for (const connector of connectors) {
      const from = state.notes.find((n) => n.id === connector.fromNoteId) as ChartNote;
      const to = state.notes.find((n) => n.id === connector.toNoteId) as ChartNote;
      const a = noteGeometry(from, ROW, LANES, v).arrow!;
      const b = noteGeometry(to, ROW, LANES, v).arrow!;
      expect(connector.fromXPx).toBe(a.xPx);
      expect(connector.fromYPx).toBe(a.centreYPx);
      expect(connector.toXPx).toBe(b.xPx);
      expect(connector.toYPx).toBe(b.centreYPx);
    }
  });

  it("does not shift a flick to make a link meet neatly", () => {
    // Joining two flicks says nothing about when either of them is.
    const connectors = runConnectors(run(), ROW, LANES, v);
    expect(connectors.map((c) => c.fromXPx)).toEqual([100, 200, 300]);
    expect(connectors.map((c) => c.toXPx)).toEqual([200, 300, 400]);
  });

  it("joins the links end to end", () => {
    const connectors = runConnectors(run(), ROW, LANES, v);
    for (let i = 1; i < connectors.length; i += 1) {
      expect(connectors[i]!.fromXPx).toBe(connectors[i - 1]!.toXPx);
      expect(connectors[i]!.fromYPx).toBe(connectors[i - 1]!.toYPx);
    }
  });

  it("follows a flick that moves", () => {
    const state = run();
    const moved = {
      ...state,
      notes: state.notes.map((n) => (n.id === "f2" ? { ...n, lane: 4 } : n)),
    };
    const before = runConnectors(state, ROW, LANES, v);
    const after = runConnectors(moved, ROW, LANES, v);
    // The two links either side of the moved flick end up somewhere new; the third does
    // not move at all.
    expect(after[0]!.toYPx).not.toBe(before[0]!.toYPx);
    expect(after[1]!.fromYPx).not.toBe(before[1]!.fromYPx);
    expect(after[2]).toEqual(before[2]);
  });

  it("draws nothing at all when there are no connections", () => {
    expect(runConnectors({ notes: run().notes, connections: [] }, ROW, LANES, v))
      .toEqual([]);
  });

  it("finds the link under a pointer, between the arrows", () => {
    const connectors = runConnectors(run(), ROW, LANES, v);
    const middle = connectors[1]!;
    const x = (middle.fromXPx + middle.toXPx) / 2;
    const y = (middle.fromYPx + middle.toYPx) / 2;
    const hit = hitTestRunConnector(x, y, connectors);
    expect(hit?.fromNoteId).toBe("f2");
    expect(hit?.toNoteId).toBe("f3");
  });

  it("finds nothing where no link is drawn", () => {
    const connectors = runConnectors(run(), ROW, LANES, v);
    expect(hitTestRunConnector(150, ROW.topPx + 2, connectors)).toBeNull();
  });

  it("leaves a press on an arrow to the note itself", () => {
    // Pressing an arrow must reach that one flick - which is the whole reason the flicks
    // stayed separate notes - so the note hit test is the one that answers there.
    const state = run();
    const arrow = noteGeometry(state.notes[1] as ChartNote, ROW, LANES, v).arrow!;
    expect(hitTestNote(arrow.xPx, arrow.centreYPx, state.notes, ROW, LANES, v)?.note.id)
      .toBe("f2");
  });

  it("catches every flick of a run in a rubber band over them", () => {
    const state = run();
    const caught = notesInRect(
      rectFromCorners(90, ROW.topPx, 410, ROW.topPx + ROW.heightPx),
      state.notes, ROW, LANES, v,
    );
    expect(caught.map((n) => n.id)).toEqual(["f1", "f2", "f3", "f4"]);
  });
});

/**
 * The two grips on a held note.
 *
 * The end grip has always been there. The start grip is its mirror, and the only thing
 * that distinguishes them is that the start one is withheld on a note too narrow to leave
 * a body between the two - because a note grippable at both ends and nowhere else could
 * be stretched but never moved.
 */
describe("the grips on a held note", () => {
  const v = view();

  it("puts one grip on each end, the same size", () => {
    const g = noteGeometry(hold(11, 13), ROW, LANES, v);
    expect(g.startHandle).not.toBeNull();
    expect(g.resizeHandle).not.toBeNull();
    expect((g.startHandle!.leftPx + g.startHandle!.rightPx) / 2).toBeCloseTo(100, 9);
    expect((g.resizeHandle!.leftPx + g.resizeHandle!.rightPx) / 2).toBeCloseTo(300, 9);
    expect(g.startHandle!.rightPx - g.startHandle!.leftPx).toBe(RESIZE_HANDLE_PX);
    expect(g.resizeHandle!.rightPx - g.resizeHandle!.leftPx).toBe(RESIZE_HANDLE_PX);
  });

  it("gives an instantaneous note neither grip", () => {
    const g = noteGeometry(tap(11), ROW, LANES, v);
    expect(g.startHandle).toBeNull();
    expect(g.resizeHandle).toBeNull();
  });

  it("gives a travelling note neither grip", () => {
    const slide: ChartNote = {
      id: "s-1", type: "slide", timeSec: 11, endTimeSec: 13, lane: 0, endLane: 3,
    };
    const g = noteGeometry(slide, ROW, LANES, v);
    expect(g.startHandle).toBeNull();
    expect(g.resizeHandle).toBeNull();
  });

  it("withholds the start grip on a note too narrow to leave a body", () => {
    // A hair under the width that would leave three grips' worth to take hold of.
    const narrow = (MIN_GRIP_BODY_PX - 1) / 100;
    const g = noteGeometry(hold(11, 11 + narrow), ROW, LANES, v);
    expect(g.startHandle).toBeNull();
    // The end grip is not withheld: it is a gesture authors already rely on.
    expect(g.resizeHandle).not.toBeNull();
  });

  it("offers the start grip again once the author zooms in", () => {
    const narrow = (MIN_GRIP_BODY_PX - 1) / 100;
    const note = hold(11, 11 + narrow);
    expect(noteGeometry(note, ROW, LANES, view(100)).startHandle).toBeNull();
    expect(noteGeometry(note, ROW, LANES, view(400)).startHandle).not.toBeNull();
  });

  it("is what a press near either end lands on", () => {
    const note = hold(11, 13);
    const g = noteGeometry(note, ROW, LANES, v);
    const y = g.markers[0]!.centreYPx;
    expect(hitTestNote(100, y, [note], ROW, LANES, v)?.part).toBe("startHandle");
    expect(hitTestNote(300, y, [note], ROW, LANES, v)?.part).toBe("resizeHandle");
  });

  it("leaves the middle of the body selecting the note", () => {
    const note = hold(11, 13);
    const g = noteGeometry(note, ROW, LANES, v);
    const y = g.markers[0]!.centreYPx;
    expect(hitTestNote(200, y, [note], ROW, LANES, v)?.part).toBe("body");
  });
});
