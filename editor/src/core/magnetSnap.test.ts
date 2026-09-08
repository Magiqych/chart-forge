import { describe, expect, it } from "vitest";

import type { ChartNote } from "./chart";
import type { GuideAnchor } from "./guideAnchors";
import {
  buildMagnetCandidates,
  describeCandidate,
  magnetSnapDelta,
  magnetSnapEdge,
  magnetThresholdSec,
  nearestCandidateWithin,
  MAGNET_ENTER_PX,
  MAGNET_RELEASE_PX,
  SNAP_TIME_EPSILON_SEC,
  type MagnetEdgeInput,
  type MagnetHold,
  type MagnetSnapInput,
  type SnapCandidate,
} from "./magnetSnap";

const note = (
  id: string,
  timeSec: number,
  endTimeSec?: number,
): ChartNote => ({
  id,
  type: endTimeSec === undefined ? "tap" : "hold",
  timeSec,
  lane: 0,
  ...(endTimeSec === undefined ? {} : { endTimeSec }),
});

const anchor = (eventId: string, timeSec: number): GuideAnchor => ({
  timeSec,
  eventId,
  lane: "drums",
  edge: "start",
});

/**
 * A drag of one instantaneous note, stated the way the Timeline states it.
 *
 * `at` is where the note's own time would land if nothing took it, which is what an
 * author is actually thinking about while they drag.
 */
const dragTo = (
  candidates: readonly SnapCandidate[],
  fromSec: number,
  at: number,
  overrides: Partial<MagnetSnapInput> = {},
) =>
  magnetSnapDelta({
    candidates,
    baseEdgesSec: [fromSec],
    rawDeltaSec: at - fromSec,
    earliestMovingSec: fromSec,
    pixelsPerSecond: 100,
    enabled: true,
    ...overrides,
  });

describe("building the candidate list", () => {
  it("takes the beat grid", () => {
    const built = buildMagnetCandidates({ beatGrid: [0, 0.5, 1] });
    expect(built.map((c) => [c.timeSec, c.kind])).toEqual([
      [0, "beat"],
      [0.5, "beat"],
      [1, "beat"],
    ]);
  });

  it("takes the start of every other note", () => {
    const built = buildMagnetCandidates({ notes: [note("n1", 2), note("n2", 3)] });
    expect(built.map((c) => c.timeSec)).toEqual([2, 3]);
    expect(built.every((c) => c.kind === "note-start")).toBe(true);
    expect(built.map((c) => c.noteId)).toEqual(["n1", "n2"]);
  });

  it("takes the end of a note that has one", () => {
    const built = buildMagnetCandidates({ notes: [note("n1", 2, 4)] });
    expect(built).toEqual([
      { timeSec: 2, kind: "note-start", noteId: "n1" },
      { timeSec: 4, kind: "note-end", noteId: "n1" },
    ]);
  });

  it("does not invent an end for a note that has none", () => {
    const built = buildMagnetCandidates({ notes: [note("n1", 2)] });
    expect(built).toHaveLength(1);
  });

  it("ignores an end that is not after the start", () => {
    // A zero-length or inverted hold is its own start said twice; a candidate there
    // would be a place nothing is at.
    expect(buildMagnetCandidates({ notes: [note("n1", 2, 2)] })).toHaveLength(1);
    expect(buildMagnetCandidates({ notes: [note("n1", 2, 1)] })).toHaveLength(1);
  });

  it("excludes the note being dragged", () => {
    const built = buildMagnetCandidates({
      notes: [note("moving", 2, 4), note("other", 3)],
      excludeNoteIds: new Set(["moving"]),
    });
    expect(built).toEqual([{ timeSec: 3, kind: "note-start", noteId: "other" }]);
  });

  it("excludes every note of a multi-note selection, so a group cannot catch itself", () => {
    const built = buildMagnetCandidates({
      notes: [note("a", 1), note("b", 2), note("c", 3)],
      excludeNoteIds: new Set(["a", "b"]),
    });
    expect(built.map((c) => c.noteId)).toEqual(["c"]);
  });

  it("takes Analysis Event anchors when they are offered", () => {
    const built = buildMagnetCandidates({ eventAnchors: [anchor("ev-1", 1.25)] });
    expect(built).toEqual([{ timeSec: 1.25, kind: "event", eventId: "ev-1" }]);
  });

  it("drops times that are not finite", () => {
    const built = buildMagnetCandidates({
      beatGrid: [Number.NaN, Number.POSITIVE_INFINITY, 1],
      notes: [note("bad", Number.NaN), note("good", 2, Number.NaN)],
    });
    expect(built.map((c) => c.timeSec)).toEqual([1, 2]);
  });

  it("drops negative times, which are not places on the recording", () => {
    const built = buildMagnetCandidates({ beatGrid: [-1, -0.001, 0, 1] });
    expect(built.map((c) => c.timeSec)).toEqual([0, 1]);
  });

  it("returns candidates in ascending time whatever order the sources were in", () => {
    const built = buildMagnetCandidates({
      beatGrid: [4, 1],
      notes: [note("n", 3), note("m", 2)],
    });
    expect(built.map((c) => c.timeSec)).toEqual([1, 2, 3, 4]);
  });

  it("collapses a beat and a note that sit on the same instant into one candidate", () => {
    const built = buildMagnetCandidates({ beatGrid: [1], notes: [note("n", 1)] });
    expect(built).toEqual([{ timeSec: 1, kind: "beat" }]);
  });

  it("collapses a note start and another note's end at the same instant", () => {
    const built = buildMagnetCandidates({ notes: [note("held", 0.5, 1), note("next", 1)] });
    expect(built.map((c) => [c.timeSec, c.kind])).toEqual([
      [0.5, "note-start"],
      [1, "note-start"],
    ]);
  });

  it("collapses times that differ by less than the epsilon", () => {
    const built = buildMagnetCandidates({
      beatGrid: [1, 1 + SNAP_TIME_EPSILON_SEC / 2],
    });
    expect(built).toHaveLength(1);
  });

  it("keeps times that differ by more than the epsilon", () => {
    const built = buildMagnetCandidates({ beatGrid: [1, 1 + 1e-6] });
    expect(built).toHaveLength(2);
  });

  it("is deterministic when the same instant carries several kinds", () => {
    const once = buildMagnetCandidates({
      beatGrid: [2],
      notes: [note("z", 2), note("a", 2)],
      eventAnchors: [anchor("ev", 2)],
    });
    const again = buildMagnetCandidates({
      eventAnchors: [anchor("ev", 2)],
      notes: [note("a", 2), note("z", 2)],
      beatGrid: [2],
    });
    expect(once).toEqual(again);
    expect(once).toEqual([{ timeSec: 2, kind: "beat" }]);
  });

  it("copes with no sources at all", () => {
    expect(buildMagnetCandidates({})).toEqual([]);
  });
});

describe("the threshold is a screen distance", () => {
  it("converts pixels to seconds through the zoom", () => {
    expect(magnetThresholdSec(100)).toBeCloseTo(MAGNET_ENTER_PX / 100, 12);
    expect(magnetThresholdSec(1000)).toBeCloseTo(MAGNET_ENTER_PX / 1000, 12);
  });

  it("halves when the zoom doubles", () => {
    expect(magnetThresholdSec(200)).toBeCloseTo(magnetThresholdSec(100) / 2, 12);
  });

  it("survives a nonsense zoom rather than snapping everything", () => {
    for (const zoom of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(magnetThresholdSec(zoom)).toBe(0);
    }
  });

  it("survives a nonsense threshold", () => {
    expect(magnetThresholdSec(100, 0)).toBe(0);
    expect(magnetThresholdSec(100, -5)).toBe(0);
  });
});

describe("finding the nearest candidate", () => {
  const grid = buildMagnetCandidates({ beatGrid: [0, 1, 2, 3, 4] });

  it("finds one inside the radius", () => {
    expect(nearestCandidateWithin(grid, 2.05, 0.1)?.timeSec).toBe(2);
  });

  it("finds nothing outside the radius", () => {
    expect(nearestCandidateWithin(grid, 2.5, 0.1)).toBeNull();
  });

  it("takes a candidate exactly on the radius", () => {
    expect(nearestCandidateWithin(grid, 2.1, 0.1)?.timeSec).toBe(2);
  });

  it("picks the nearer of two in reach", () => {
    expect(nearestCandidateWithin(grid, 2.4, 0.6)?.timeSec).toBe(2);
    expect(nearestCandidateWithin(grid, 2.6, 0.6)?.timeSec).toBe(3);
  });

  it("breaks an exact tie towards the earlier candidate, every time", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(nearestCandidateWithin(grid, 2.5, 0.6)?.timeSec).toBe(2);
    }
  });

  it("skips a candidate the caller vetoes and keeps looking", () => {
    const found = nearestCandidateWithin(grid, 2.4, 1.1, (c) => c.timeSec !== 2);
    expect(found?.timeSec).toBe(3);
  });

  it("returns null on an empty list, a nonsense time or a dead radius", () => {
    expect(nearestCandidateWithin([], 1, 1)).toBeNull();
    expect(nearestCandidateWithin(grid, Number.NaN, 1)).toBeNull();
    expect(nearestCandidateWithin(grid, 1, 0)).toBeNull();
  });

  it("agrees with a brute-force scan over a dense list", () => {
    const dense = buildMagnetCandidates({
      beatGrid: Array.from({ length: 500 }, (_, i) => i * 0.137),
    });
    for (const at of [0, 0.06, 1.9, 12.3456, 33.7, 68.4]) {
      const radius = 0.09;
      const brute = dense
        .filter((c) => Math.abs(c.timeSec - at) <= radius + SNAP_TIME_EPSILON_SEC)
        .reduce<SnapCandidate | null>(
          (best, c) =>
            best === null || Math.abs(c.timeSec - at) < Math.abs(best.timeSec - at) ? c : best,
          null,
        );
      expect(nearestCandidateWithin(dense, at, radius)).toEqual(brute);
    }
  });
});

describe("magnet snapping a drag", () => {
  const grid = buildMagnetCandidates({ beatGrid: [0, 1, 2, 3] });

  it("snaps when the note comes inside the threshold", () => {
    // 100 px/s, so the threshold is 0.1 s. 2.05 is inside it.
    const out = dragTo(grid, 0.4, 2.05);
    expect(out.candidate?.timeSec).toBe(2);
    expect(0.4 + out.deltaSec).toBeCloseTo(2, 12);
  });

  it("does not snap when it stays outside the threshold", () => {
    const out = dragTo(grid, 0.4, 2.2);
    expect(out.candidate).toBeNull();
    expect(out.guideTimeSec).toBeNull();
    expect(out.deltaSec).toBeCloseTo(2.2 - 0.4, 12);
  });

  it("snaps to a note start", () => {
    const candidates = buildMagnetCandidates({ notes: [note("other", 5)] });
    const out = dragTo(candidates, 1, 4.96);
    expect(out.candidate).toEqual({ timeSec: 5, kind: "note-start", noteId: "other" });
  });

  it("snaps to a note end", () => {
    const candidates = buildMagnetCandidates({ notes: [note("held", 5, 6)] });
    const out = dragTo(candidates, 1, 6.04);
    expect(out.candidate).toEqual({ timeSec: 6, kind: "note-end", noteId: "held" });
  });

  it("snaps to an Analysis Event anchor when Guide Snap offered one", () => {
    const candidates = buildMagnetCandidates({ eventAnchors: [anchor("ev-9", 3.33)] });
    const out = dragTo(candidates, 1, 3.3);
    expect(out.candidate?.kind).toBe("event");
    expect(out.guideTimeSec).toBe(3.33);
  });

  it("never offers the note it is moving", () => {
    const candidates = buildMagnetCandidates({
      notes: [note("moving", 2)],
      excludeNoteIds: new Set(["moving"]),
    });
    // A drag that barely moves would otherwise be caught by the note's own start and
    // pinned in place.
    const out = dragTo(candidates, 2, 2.02);
    expect(out.candidate).toBeNull();
    expect(out.deltaSec).toBeCloseTo(0.02, 12);
  });

  it("chooses the nearest of several candidates in reach", () => {
    const candidates = buildMagnetCandidates({ beatGrid: [2, 2.06, 2.15] });
    const out = dragTo(candidates, 0, 2.05);
    expect(out.candidate?.timeSec).toBe(2.06);
  });

  it("gives the same answer for the same drag, every time", () => {
    const candidates = buildMagnetCandidates({ beatGrid: [2, 2.1] });
    const answers = new Set(
      Array.from({ length: 10 }, () => JSON.stringify(dragTo(candidates, 0, 2.05))),
    );
    expect(answers.size).toBe(1);
  });

  it("returns the raw delta when the magnet is switched off", () => {
    const out = dragTo(grid, 0.4, 2.05, { enabled: false });
    expect(out.candidate).toBeNull();
    expect(out.deltaSec).toBeCloseTo(2.05 - 0.4, 12);
  });

  it("returns the raw delta when there are no candidates", () => {
    const out = dragTo([], 0.4, 2.05);
    expect(out.deltaSec).toBeCloseTo(2.05 - 0.4, 12);
  });

  it("puts the guide exactly where the note lands", () => {
    const out = dragTo(grid, 0.4, 2.03);
    expect(out.guideTimeSec).toBe(out.candidate?.timeSec);
    expect(0.4 + out.deltaSec).toBeCloseTo(out.guideTimeSec as number, 12);
  });

  it("survives a nonsense delta", () => {
    const out = dragTo(grid, 1, Number.NaN);
    expect(Number.isFinite(out.deltaSec)).toBe(true);
  });
});

describe("the threshold means the same thing at every zoom", () => {
  const grid = buildMagnetCandidates({ beatGrid: [0, 1, 2, 3] });

  it("snaps from the same number of pixels away, zoomed in or out", () => {
    // One candidate on its own, so what is being measured is the reach of the magnet and
    // not which of two neighbours won. At 10 px/s the threshold is a whole second, and a
    // grid would legitimately offer a different beat.
    const lone = buildMagnetCandidates({ beatGrid: [2] });
    for (const pixelsPerSecond of [10, 50, 100, 400, 2000]) {
      const insidePx = MAGNET_ENTER_PX - 1;
      const outsidePx = MAGNET_ENTER_PX + 1;
      const inside = dragTo(lone, 0.001, 2 + insidePx / pixelsPerSecond, { pixelsPerSecond });
      const outside = dragTo(lone, 0.001, 2 + outsidePx / pixelsPerSecond, { pixelsPerSecond });
      expect(inside.candidate?.timeSec).toBe(2);
      expect(outside.candidate).toBeNull();
    }
  });

  it("stops snapping to a beat an author has zoomed in past", () => {
    // 40 ms off the beat: caught at 100 px/s, deliberately left alone at 1000 px/s, which
    // is the zoom an author works at when 40 ms is the thing they are placing.
    expect(dragTo(grid, 0, 2.04, { pixelsPerSecond: 100 }).candidate?.timeSec).toBe(2);
    expect(dragTo(grid, 0, 2.04, { pixelsPerSecond: 1000 }).candidate).toBeNull();
  });

  it("does not snap at all when the zoom is nonsense", () => {
    expect(dragTo(grid, 0, 2.0001, { pixelsPerSecond: 0 }).candidate).toBeNull();
  });
});

describe("a dragged note lines up by either of its ends", () => {
  const grid = buildMagnetCandidates({ beatGrid: [0, 1, 2, 3, 4] });

  /** A two-second hold running from `startSec`, dragged so its start lands at `at`. */
  const dragHold = (startSec: number, lengthSec: number, at: number) =>
    magnetSnapDelta({
      candidates: grid,
      baseEdgesSec: [startSec, startSec + lengthSec],
      rawDeltaSec: at - startSec,
      earliestMovingSec: startSec,
      pixelsPerSecond: 100,
      enabled: true,
    });

  it("lines up by its start when that is the nearer end", () => {
    const out = dragHold(0.5, 1.3, 2.03);
    expect(out.guideTimeSec).toBe(2);
    expect(0.5 + out.deltaSec).toBeCloseTo(2, 12);
  });

  it("lines up by its end when that is the nearer end", () => {
    // Start lands at 1.6 (0.4 from a beat), end at 2.97 (0.03 from a beat).
    const out = dragHold(0.5, 1.37, 1.6);
    expect(out.guideTimeSec).toBe(3);
    expect(0.5 + 1.37 + out.deltaSec).toBeCloseTo(3, 12);
  });

  it("prefers the earlier end when both are equally close", () => {
    // A hold exactly one beat long: both ends are always the same distance from a beat.
    const out = dragHold(0.5, 1, 2.04);
    expect(out.guideTimeSec).toBe(2);
  });

  it("keeps the note's length: the delta moves both ends together", () => {
    const out = dragHold(0.5, 1.37, 1.6);
    const start = 0.5 + out.deltaSec;
    const end = 0.5 + 1.37 + out.deltaSec;
    expect(end - start).toBeCloseTo(1.37, 12);
  });
});

describe("the start of the recording", () => {
  const grid = buildMagnetCandidates({ beatGrid: [0, 0.5, 1, 2] });

  it("snaps to time zero itself", () => {
    const out = dragTo(grid, 1, 0.03);
    expect(out.guideTimeSec).toBe(0);
    expect(1 + out.deltaSec).toBeCloseTo(0, 12);
  });

  it("will not carry the set before zero on a free move", () => {
    const out = dragTo([], 1, -5);
    expect(1 + out.deltaSec).toBe(0);
  });

  it("will not carry the set before zero on a snapped move either", () => {
    const out = dragTo(grid, 1, -5);
    expect(1 + out.deltaSec).toBeGreaterThanOrEqual(0);
  });

  it("refuses a candidate that would push the note's start below zero, and finds another", () => {
    // A one-second hold whose end is dragged next to the 0.5 beat: taking it would put
    // the start at -0.5. The magnet keeps looking rather than promising an impossible
    // move, and the note's own start finds the 1.0 beat instead.
    const out = magnetSnapDelta({
      candidates: grid,
      baseEdgesSec: [3, 4],
      rawDeltaSec: 1.03 - 3,
      earliestMovingSec: 3,
      pixelsPerSecond: 100,
      enabled: true,
    });
    expect(out.guideTimeSec).toBe(1);
    expect(3 + out.deltaSec).toBeCloseTo(1, 12);
  });

  it("keeps a group's shape when it meets zero", () => {
    // Two notes 0.4 s apart, the earlier at 0.2, dragged three seconds left.
    const out = magnetSnapDelta({
      candidates: [],
      baseEdgesSec: [0.2],
      rawDeltaSec: -3,
      earliestMovingSec: 0.2,
      pixelsPerSecond: 100,
      enabled: true,
    });
    expect(out.deltaSec).toBeCloseTo(-0.2, 12);
    // The second note of the group therefore lands at 0.4, not on top of the first.
    expect(0.6 + out.deltaSec).toBeCloseTo(0.4, 12);
  });
});

describe("floating point", () => {
  it("lands on the candidate's own value, not near it", () => {
    const candidates = buildMagnetCandidates({ beatGrid: [12.5] });
    const out = dragTo(candidates, 3.3333333333, 12.47);
    expect(out.guideTimeSec).toBe(12.5);
    // The note's committed time is the guide's time to well under a microsecond, so the
    // dotted line cannot sit beside the note it is explaining at any zoom.
    expect(Math.abs(3.3333333333 + out.deltaSec - 12.5)).toBeLessThan(1e-12);
  });

  it("still snaps to a candidate the drag lands on exactly", () => {
    const candidates = buildMagnetCandidates({ beatGrid: [2] });
    const out = dragTo(candidates, 0.7, 2);
    expect(out.guideTimeSec).toBe(2);
  });

  it("works far into a long recording", () => {
    const candidates = buildMagnetCandidates({ beatGrid: [3599.5] });
    const out = dragTo(candidates, 10, 3599.47);
    expect(out.guideTimeSec).toBe(3599.5);
    expect(10 + out.deltaSec).toBe(3599.5);
  });
});

describe("performance shape", () => {
  it("drags through a few thousand candidates without scanning them", () => {
    const notes = Array.from({ length: 2000 }, (_, i) => note(`n${i}`, i * 0.25, i * 0.25 + 0.1));
    const candidates = buildMagnetCandidates({
      beatGrid: Array.from({ length: 2000 }, (_, i) => i * 0.5),
      notes,
      excludeNoteIds: new Set(["n0"]),
    });
    const started = performance.now();
    for (let i = 0; i < 2000; i += 1) {
      dragTo(candidates, 0, 100 + i * 0.001);
    }
    // Two thousand pointer moves - far more than a real drag - well inside one frame.
    expect(performance.now() - started).toBeLessThan(100);
  });
});

/**
 * The two thresholds, which are what make this a magnet rather than a rounding rule.
 *
 * A note is taken at the enter distance and only let go at the wider release distance, so
 * the author feels it catch, feels it hold while their hand moves a little, and then
 * feels it come free. With a single threshold the note would be released at the exact
 * distance that captured it, and a hand resting near a beat would sit on the boundary
 * with the note flickering on and off it.
 */
describe("hysteresis", () => {
  const grid = buildMagnetCandidates({ beatGrid: [0, 1, 2, 3] });
  const PPS = 100;

  /** One pointer move: the note's own time would land at `at` if nothing took it. */
  const move = (fromSec: number, at: number, held: MagnetHold | null) =>
    magnetSnapDelta({
      candidates: grid,
      baseEdgesSec: [fromSec],
      rawDeltaSec: at - fromSec,
      earliestMovingSec: fromSec,
      pixelsPerSecond: PPS,
      enabled: true,
      held,
    });

  it("lets go at a greater distance than it takes hold at", () => {
    expect(MAGNET_RELEASE_PX).toBeGreaterThan(MAGNET_ENTER_PX);
  });

  it("does not take hold beyond the enter distance", () => {
    // 0.15 s is 15 px at this zoom: past the 12 px that captures.
    expect(move(0.4, 2.15, null).candidate).toBeNull();
  });

  it("keeps a note it has taken past the distance that would have taken it", () => {
    const caught = move(0.4, 2.05, null);
    expect(caught.candidate?.timeSec).toBe(2);
    // 0.15 s away: too far to capture, still inside the release distance.
    const still = move(0.4, 2.15, caught.hold);
    expect(still.guideTimeSec).toBe(2);
    expect(0.4 + still.deltaSec).toBeCloseTo(2, 12);
  });

  it("lets go once the note is pulled past the release distance", () => {
    const caught = move(0.4, 2.05, null);
    const gone = move(0.4, 2.25, caught.hold);
    expect(gone.candidate).toBeNull();
    expect(gone.guideTimeSec).toBeNull();
    expect(gone.hold).toBeNull();
    expect(0.4 + gone.deltaSec).toBeCloseTo(2.25, 12);
  });

  it("holds right up to the release distance and no further", () => {
    const caught = move(0.4, 2.05, null);
    // 20 px is exactly the release distance; 21 px is past it.
    expect(move(0.4, 2 + MAGNET_RELEASE_PX / PPS, caught.hold).guideTimeSec).toBe(2);
    expect(move(0.4, 2 + (MAGNET_RELEASE_PX + 1) / PPS, caught.hold).candidate).toBeNull();
  });

  it("gives the hold up when another candidate is strictly nearer", () => {
    // Zoomed far out, the candidates are closer together than the release distance, so a
    // note could otherwise stay stuck to a beat while sitting on top of the next one.
    const dense = buildMagnetCandidates({ beatGrid: [2, 2.1, 2.2] });
    const caught = magnetSnapDelta({
      candidates: dense, baseEdgesSec: [0], rawDeltaSec: 2, earliestMovingSec: 0,
      pixelsPerSecond: PPS, enabled: true, held: null,
    });
    expect(caught.candidate?.timeSec).toBe(2);
    const moved = magnetSnapDelta({
      candidates: dense, baseEdgesSec: [0], rawDeltaSec: 2.16, earliestMovingSec: 0,
      pixelsPerSecond: PPS, enabled: true, held: caught.hold,
    });
    expect(moved.guideTimeSec).toBe(2.2);
  });

  it("hands back a hold to carry into the next move, and null when free", () => {
    const caught = move(0.4, 2.02, null);
    expect(caught.hold).toEqual({ candidate: { timeSec: 2, kind: "beat" }, baseEdgeSec: 0.4 });
    expect(move(0.4, 2.4, null).hold).toBeNull();
  });

  it("ignores a hold while the magnet is suspended", () => {
    const caught = move(0.4, 2.02, null);
    const bypassed = magnetSnapDelta({
      candidates: grid, baseEdgesSec: [0.4], rawDeltaSec: 2.05 - 0.4,
      earliestMovingSec: 0.4, pixelsPerSecond: PPS, enabled: false, held: caught.hold,
    });
    expect(bypassed.candidate).toBeNull();
    expect(bypassed.hold).toBeNull();
  });

  it("never releases sooner than it captures, however the thresholds are given", () => {
    // A release distance smaller than the enter distance would let a note go on the very
    // move that took it, which would look like a note that cannot be snapped at all.
    const caught = magnetSnapDelta({
      candidates: grid, baseEdgesSec: [0], rawDeltaSec: 2.05, earliestMovingSec: 0,
      pixelsPerSecond: PPS, enabled: true, held: null, enterPx: 12, releasePx: 2,
    });
    expect(caught.candidate?.timeSec).toBe(2);
    const still = magnetSnapDelta({
      candidates: grid, baseEdgesSec: [0], rawDeltaSec: 2.05, earliestMovingSec: 0,
      pixelsPerSecond: PPS, enabled: true, held: caught.hold, enterPx: 12, releasePx: 2,
    });
    expect(still.guideTimeSec).toBe(2);
  });

  it("walks a whole sweep: free, caught, held, released, free", () => {
    // What the hand actually does - drag a note steadily past a beat - stated as the
    // sequence of states the author should feel, at 1 px per step.
    const states: string[] = [];
    let hold: MagnetHold | null = null;
    for (let px = -30; px <= 30; px += 1) {
      const out = move(0.4, 2 + px / PPS, hold);
      hold = out.hold;
      states.push(out.candidate === null ? "free" : "snap");
    }
    const first = states.indexOf("snap");
    const last = states.lastIndexOf("snap");

    expect(first).toBeGreaterThan(0);                    // free before
    expect(last).toBeLessThan(states.length - 1);        // free after
    // One unbroken run of snapping, never flickering in and out.
    expect(states.slice(first, last + 1).every((s) => s === "snap")).toBe(true);
    // Captured at the enter distance, released at the wider one, so the run is bigger
    // than twice the capture distance: that asymmetry is the magnet.
    const width = last - first + 1;
    expect(width).toBeGreaterThan(2 * MAGNET_ENTER_PX);
    expect(width).toBeCloseTo(MAGNET_ENTER_PX + MAGNET_RELEASE_PX + 1, 0);
  });

  it("gives the same sweep every time", () => {
    const run = () => {
      let hold: MagnetHold | null = null;
      return Array.from({ length: 61 }, (_, i) => {
        const out = move(0.4, 2 + (i - 30) / PPS, hold);
        hold = out.hold;
        return out.guideTimeSec;
      }).join(",");
    };
    expect(new Set([run(), run(), run()]).size).toBe(1);
  });
});

describe("describing what a note landed on", () => {
  it("names a beat", () => {
    expect(describeCandidate({ timeSec: 2, kind: "beat" })).toBe("beat @ 2.000s");
  });

  it("names a note and which end of it", () => {
    expect(describeCandidate({ timeSec: 2, kind: "note-start", noteId: "n1" }))
      .toBe("n1 start @ 2.000s");
    expect(describeCandidate({ timeSec: 2, kind: "note-end", noteId: "n1" }))
      .toBe("n1 end @ 2.000s");
  });

  it("names an event", () => {
    expect(describeCandidate({ timeSec: 2, kind: "event", eventId: "ev-1" }))
      .toBe("ev-1 @ 2.000s");
  });
});

/**
 * One edge dragged on its own.
 *
 * The resize counterpart of `magnetSnapDelta`, and the reason it exists: a grip follows
 * the pointer rather than carrying a note along with it, so the answer is a time and not
 * a distance. Everything else about the magnet - the sources, the pixel threshold, the
 * hysteresis - must be the same, and these check that it is.
 */
describe("magnet snapping one edge", () => {
  const grid = buildMagnetCandidates({ beatGrid: [0, 1, 2, 3] });

  const edgeTo = (
    candidates: readonly SnapCandidate[],
    at: number,
    overrides: Partial<MagnetEdgeInput> = {},
  ) =>
    magnetSnapEdge({
      candidates,
      rawTimeSec: at,
      pixelsPerSecond: 100,
      enabled: true,
      ...overrides,
    });

  it("takes the edge to a beat inside the threshold", () => {
    const out = edgeTo(grid, 2.05);
    expect(out.timeSec).toBe(2);
    expect(out.guideTimeSec).toBe(2);
    expect(out.candidate?.kind).toBe("beat");
  });

  it("leaves the edge alone outside the threshold", () => {
    const out = edgeTo(grid, 2.2);
    expect(out.timeSec).toBeCloseTo(2.2, 12);
    expect(out.candidate).toBeNull();
    expect(out.guideTimeSec).toBeNull();
    expect(out.hold).toBeNull();
  });

  it("takes an Analysis Event as readily as a beat", () => {
    const candidates = buildMagnetCandidates({ eventAnchors: [anchor("ev-3", 4.42)] });
    const out = edgeTo(candidates, 4.45);
    expect(out.timeSec).toBe(4.42);
    expect(out.candidate?.eventId).toBe("ev-3");
  });

  it("takes another note's start and another note's end", () => {
    const candidates = buildMagnetCandidates({ notes: [note("other", 5, 6)] });
    expect(edgeTo(candidates, 4.97).candidate?.kind).toBe("note-start");
    expect(edgeTo(candidates, 6.03).candidate?.kind).toBe("note-end");
  });

  it("chooses the nearest of several in reach, inside one tier", () => {
    const candidates = buildMagnetCandidates({ beatGrid: [2, 2.04] });
    expect(edgeTo(candidates, 2.05).timeSec).toBe(2.04);
    expect(edgeTo(candidates, 2.01).timeSec).toBe(2);
  });

  it("prefers a measured event to a beat that happens to be nearer", () => {
    // The beat grid is a ruler drawn across the whole song; an Analysis Event is a
    // moment something actually happened. When both are in reach the measured one wins,
    // because at a fine division there is always a grid line closer than whatever the
    // author is aiming at, and nearest-wins alone made the other sources unreachable.
    const candidates = buildMagnetCandidates({
      beatGrid: [2],
      eventAnchors: [anchor("ev-close", 2.04)],
    });
    expect(edgeTo(candidates, 2.05).timeSec).toBe(2.04);
    expect(edgeTo(candidates, 2.01).timeSec).toBe(2.04);
  });

  it("still takes the beat when nothing else is within reach", () => {
    const candidates = buildMagnetCandidates({
      beatGrid: [2],
      eventAnchors: [anchor("ev-far", 2.5)],
    });
    expect(edgeTo(candidates, 2.01).timeSec).toBe(2);
  });

  it("refuses a candidate on the wrong side of the other end, and finds another", () => {
    // A grip on the end, with the start pinned at 2: everything at or before 2 is a place
    // this edge cannot go, however close the pointer brings it.
    const out = edgeTo(grid, 2.02, { minTimeSec: 2.01 });
    expect(out.candidate).toBeNull();
    expect(out.timeSec).toBeCloseTo(2.02, 12);
  });

  it("clamps a pointer that has been dragged past the other end", () => {
    const out = edgeTo(grid, 0.5, { minTimeSec: 2.01 });
    expect(out.timeSec).toBe(2.01);
  });

  it("clamps a start grip dragged past its own end", () => {
    const out = edgeTo(grid, 9, { maxTimeSec: 2.99 });
    expect(out.timeSec).toBe(2.99);
  });

  it("never lands outside the bounds it was given", () => {
    for (let at = -1; at <= 5; at += 0.07) {
      const out = edgeTo(grid, at, { minTimeSec: 0.6, maxTimeSec: 2.4 });
      expect(out.timeSec).toBeGreaterThanOrEqual(0.6);
      expect(out.timeSec).toBeLessThanOrEqual(2.4);
      if (out.guideTimeSec !== null) expect(out.guideTimeSec).toBe(out.timeSec);
    }
  });

  it("moves freely when the magnet is suspended", () => {
    expect(edgeTo(grid, 2.02, { enabled: false }).timeSec).toBeCloseTo(2.02, 12);
  });

  it("holds on for longer than it took to catch it, like the whole-note magnet", () => {
    const enterSec = MAGNET_ENTER_PX / 100;
    const releaseSec = MAGNET_RELEASE_PX / 100;
    const caught = edgeTo(grid, 2 + enterSec / 2);
    expect(caught.hold?.candidate.timeSec).toBe(2);

    // Past the distance that would have taken it, but not past the release distance.
    const kept = edgeTo(grid, 2 + (enterSec + releaseSec) / 2, { held: caught.hold });
    expect(kept.timeSec).toBe(2);

    const freed = edgeTo(grid, 2 + releaseSec * 1.5, { held: caught.hold });
    expect(freed.candidate).toBeNull();
  });

  it("gives the hold up when another candidate is strictly nearer", () => {
    const held = { candidate: { timeSec: 2, kind: "beat" } as SnapCandidate };
    const out = edgeTo(grid, 3.01, { held });
    expect(out.timeSec).toBe(3);
  });

  it("does not snap at all when the zoom is nonsense", () => {
    expect(edgeTo(grid, 2.001, { pixelsPerSecond: 0 }).candidate).toBeNull();
  });

  it("survives a nonsense pointer time", () => {
    expect(Number.isFinite(edgeTo(grid, Number.NaN).timeSec)).toBe(true);
  });

  it("gives the same answer for the same input, every time", () => {
    const first = edgeTo(grid, 2.03);
    for (let i = 0; i < 20; i += 1) expect(edgeTo(grid, 2.03)).toEqual(first);
  });
});
