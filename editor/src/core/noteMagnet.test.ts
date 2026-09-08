/**
 * Lining notes up with each other: the magnet's central job.
 *
 * The UX this suite exists for is one sentence - carry a note near another note's start
 * and their starts align - and it was unreliable for a reason worth stating. The beat
 * grid is subdivided: at a division of four with beats half a second apart there is a
 * grid line every 0.125 s, about twenty pixels at a normal zoom. Nearest-wins alone
 * therefore meant some grid line was almost always closer than the note being aimed at,
 * and the note start was unreachable however carefully the author aimed.
 *
 * So candidates now have a priority: things an author placed or a detector measured come
 * first, and the beat grid is the fallback when none of them is in reach. Every case
 * below is about that rule and the combinations it has to serve.
 */

import { describe, expect, it } from "vitest";

import type { LaneId, ProjectedEvent } from "./analysis";
import {
  connectSlides, emptyChart, placeNote, slidePoints,
  type ChartNote, type ChartState,
} from "./chart";
import type { ChartDecoration } from "./decoration";
import { buildGuideAnchors } from "./guideAnchors";
import {
  buildMagnetCandidates, candidatePriority, magnetSnapDelta, magnetSnapEdge,
  MAGNET_ENTER_PX, type MagnetHold, type SnapCandidate,
} from "./magnetSnap";

const blank = (): ChartState => emptyChart({ audioPath: "song.wav", audioDurationSec: 60 });

/** A beat grid subdivided the way the toolbar's default division produces one. */
const denseGrid = (fromSec: number, toSec: number, step = 0.125): readonly number[] => {
  const grid: number[] = [];
  for (let t = fromSec; t <= toSec + 1e-9; t += step) grid.push(Number(t.toFixed(6)));
  return grid;
};

const events = (
  specs: readonly { id: string; startSec: number; lane: LaneId }[],
): readonly ProjectedEvent[] =>
  specs.map((spec) => ({
    id: spec.id,
    type: "onset",
    startSec: spec.startSec,
    endKind: "instantaneous" as const,
    detectorId: "det",
    stemId: `stem-${spec.lane}`,
    lane: spec.lane,
  }));

const ALL_LANES: ReadonlySet<LaneId> = new Set<LaneId>(["drums", "other", "bass", "vocals"]);

const decoration = (id: string, startTimeSec: number, endTimeSec: number): ChartDecoration => ({
  id, type: "text", startTimeSec, endTimeSec, position: { x: 0.5, y: 0.5 }, text: "HI",
});

/**
 * One whole-object drag, exactly as the Timeline performs it.
 *
 * `carryTo` is where the pointer takes the dragged note's *start*. Every timing point of
 * the note is offered as an edge, which is what lets a slide line up by any of its points.
 */
function dragNote(
  state: ChartState,
  noteId: string,
  carryTo: number,
  sources: {
    beatGrid?: readonly number[];
    events?: readonly ProjectedEvent[];
    decorations?: readonly ChartDecoration[];
    alsoMoving?: readonly string[];
    enabled?: boolean;
    pixelsPerSecond?: number;
  } = {},
) {
  const moving = [noteId, ...(sources.alsoMoving ?? [])];
  const dragged = state.notes.find((note) => note.id === noteId);
  if (!dragged) throw new Error(`no note ${noteId}`);

  const candidates = buildMagnetCandidates({
    beatGrid: sources.beatGrid ?? [],
    notes: state.notes,
    excludeNoteIds: new Set(moving),
    decorations: sources.decorations ?? [],
    eventAnchors: buildGuideAnchors(sources.events ?? [], ALL_LANES, { includeEnds: true }),
  });

  const edges: number[] = [];
  let earliest = Number.POSITIVE_INFINITY;
  for (const id of moving) {
    const note = state.notes.find((candidate) => candidate.id === id);
    if (!note) continue;
    for (const point of slidePoints(note)) edges.push(point.timeSec);
    earliest = Math.min(earliest, note.timeSec);
  }

  const outcome = magnetSnapDelta({
    candidates,
    baseEdgesSec: edges,
    rawDeltaSec: carryTo - dragged.timeSec,
    earliestMovingSec: earliest,
    pixelsPerSecond: sources.pixelsPerSecond ?? 100,
    enabled: sources.enabled ?? true,
  });
  return { outcome, candidates, startsAt: dragged.timeSec + outcome.deltaSec };
}

const tapAt = (state: ChartState, timeSec: number, lane = 0) =>
  placeNote(state, { timeSec, lane, type: "tap" }).state;
const longAt = (state: ChartState, timeSec: number, endTimeSec: number, lane = 1) =>
  placeNote(state, { timeSec, lane, type: "hold", endTimeSec }).state;

function slideThrough(state: ChartState, times: readonly number[]): ChartState {
  const before = new Set(state.notes.map((n) => n.id));
  let next = state;
  times.forEach((timeSec, index) => {
    next = placeNote(next, { timeSec, lane: index % 5, type: "slide" }).state;
  });
  const fresh = next.notes.filter((n) => !before.has(n.id)).map((n) => n.id);
  return connectSlides(next, fresh);
}

describe("a note start finds another note start", () => {
  it("aligns two starts that were a few milliseconds apart", () => {
    // The central case: A at 4.992 carried towards B at 5.000.
    let state = tapAt(blank(), 5);          // n-0001, the target
    state = tapAt(state, 1, 2);             // n-0002, the one being dragged
    const { outcome, startsAt } = dragNote(state, "n-0002", 4.992);
    expect(outcome.candidate?.kind).toBe("note-start");
    expect(startsAt).toBe(5);
  });

  it("is not buried by a subdivided beat grid", () => {
    // The target sits at 5.03, deliberately off the grid. The pointer at 5.01 is a third
    // as far from the grid line at 5.0 as it is from the note - so nearest-wins alone
    // took the grid line every time and the note was unreachable however carefully the
    // author aimed. The note is what they were aiming at.
    let state = tapAt(blank(), 5.03);
    state = tapAt(state, 1, 2);
    const { outcome, startsAt } = dragNote(state, "n-0002", 5.01, {
      beatGrid: denseGrid(4, 6),
    });
    expect(outcome.candidate?.kind).toBe("note-start");
    expect(startsAt).toBe(5.03);
  });

  it("still takes the beat grid when no note is in reach", () => {
    let state = tapAt(blank(), 20);
    state = tapAt(state, 1, 2);
    const { outcome, startsAt } = dragNote(state, "n-0002", 5.01, {
      beatGrid: denseGrid(4, 6),
    });
    expect(outcome.candidate?.kind).toBe("beat");
    expect(startsAt).toBe(5);
  });

  it("lands on the same instant when a note start sits exactly on a beat", () => {
    // The two collapse into one candidate - one place, so one guide line - and which
    // name survives is a labelling decision. What matters is where the note lands.
    let state = tapAt(blank(), 5);
    state = tapAt(state, 1, 2);
    expect(dragNote(state, "n-0002", 5.01, { beatGrid: denseGrid(4, 6) }).startsAt).toBe(5);
  });

  it("takes the nearer of two note starts", () => {
    let state = tapAt(blank(), 5);
    state = tapAt(state, 5.06, 3);
    state = tapAt(state, 1, 2);
    expect(dragNote(state, "n-0003", 5.05).startsAt).toBe(5.06);
    expect(dragNote(state, "n-0003", 5.01).startsAt).toBe(5);
  });

  it("does nothing outside the threshold", () => {
    let state = tapAt(blank(), 5);
    state = tapAt(state, 1, 2);
    const { outcome, startsAt } = dragNote(state, "n-0002", 5.3);
    expect(outcome.candidate).toBeNull();
    expect(startsAt).toBeCloseTo(5.3, 9);
  });
});

describe("every combination of edges", () => {
  it("takes a Single onto a Long's start and onto its end", () => {
    let state = longAt(blank(), 5, 7);
    state = tapAt(state, 1, 3);
    expect(dragNote(state, "n-0002", 4.97).outcome.candidate?.kind).toBe("note-start");
    expect(dragNote(state, "n-0002", 4.97).startsAt).toBe(5);
    expect(dragNote(state, "n-0002", 6.97).outcome.candidate?.kind).toBe("note-end");
    expect(dragNote(state, "n-0002", 6.97).startsAt).toBe(7);
  });

  it("takes a Long's start onto another note's start, keeping its length", () => {
    let state = tapAt(blank(), 5);
    state = longAt(state, 1, 2.75);
    const { startsAt } = dragNote(state, "n-0002", 4.97);
    expect(startsAt).toBe(5);
    // The delta moves both ends, so the length is preserved by construction.
    const note = state.notes.find((n) => n.id === "n-0002") as ChartNote;
    expect((note.endTimeSec as number) - note.timeSec).toBe(1.75);
  });

  it("takes a Long's end onto another note's start", () => {
    // Carried so the Long's *end* arrives near the tap: the drag lines up by whichever
    // edge came nearest, which is the whole point of offering both.
    let state = tapAt(blank(), 5);
    state = longAt(state, 1, 2.75);
    const { outcome } = dragNote(state, "n-0002", 3.28);
    expect(outcome.candidate?.kind).toBe("note-start");
    expect(outcome.guideTimeSec).toBe(5);
  });

  it("takes a Long's end onto another note's end", () => {
    let state = longAt(blank(), 5, 7);
    state = longAt(state, 1, 2.75, 3);
    const { outcome } = dragNote(state, "n-0002", 5.28);
    expect(outcome.candidate?.kind).toBe("note-end");
    expect(outcome.guideTimeSec).toBe(7);
  });

  it("takes a Flick onto another note's start", () => {
    let state = tapAt(blank(), 5);
    state = placeNote(state, { timeSec: 1, lane: 3, type: "flick", direction: "left" }).state;
    expect(dragNote(state, "n-0002", 4.98).startsAt).toBe(5);
  });

  it("takes a Slide's start onto another note's start", () => {
    let state = tapAt(blank(), 10);
    state = slideThrough(state, [1, 1.5, 2]);
    const slide = state.notes.find((n) => n.type === "slide") as ChartNote;
    expect(dragNote(state, slide.id, 9.97).startsAt).toBe(10);
  });

  it("offers a Slide's waypoints as things to line up with", () => {
    let state = slideThrough(blank(), [1, 1.5, 2]);
    state = tapAt(state, 20, 4);
    const candidates = buildMagnetCandidates({ notes: state.notes });
    expect(candidates.filter((c) => c.kind === "note-point").map((c) => c.timeSec))
      .toEqual([1.5]);
  });

  it("lands a note on a Slide's waypoint", () => {
    let state = slideThrough(blank(), [1, 1.5, 2]);
    state = tapAt(state, 20, 4);
    const tap = state.notes.find((n) => n.timeSec === 20) as ChartNote;
    const { outcome, startsAt } = dragNote(state, tap.id, 1.47);
    expect(outcome.candidate?.kind).toBe("note-point");
    expect(startsAt).toBe(1.5);
  });

  it("lines a Slide up by one of its own middle points", () => {
    // Carried so the slide's waypoint, not its start, is what meets the tap.
    let state = slideThrough(blank(), [1, 1.5, 2]);
    state = tapAt(state, 10, 4);
    const slide = state.notes.find((n) => n.type === "slide") as ChartNote;
    const { outcome } = dragNote(state, slide.id, 9.52);
    expect(outcome.guideTimeSec).toBe(10);
  });
});

describe("the other sources still work", () => {
  it("takes a note onto a decoration's edges", () => {
    const state = tapAt(blank(), 1);
    const decorations = [decoration("dec-0001", 5, 6)];
    expect(dragNote(state, "n-0001", 4.98, { decorations }).startsAt).toBe(5);
    expect(dragNote(state, "n-0001", 5.98, { decorations }).startsAt).toBe(6);
  });

  it("takes a note onto an Analysis Event", () => {
    const state = tapAt(blank(), 1);
    const vocals = events([{ id: "ev-vox", startSec: 5.37, lane: "vocals" }]);
    expect(dragNote(state, "n-0001", 5.34, { events: vocals }).startsAt).toBe(5.37);
  });

  it("takes a note onto an Analysis Event even with a dense grid present", () => {
    // The regression that started all of this: events must not be buried by the grid.
    const state = tapAt(blank(), 1);
    const vocals = events([{ id: "ev-vox", startSec: 5.37, lane: "vocals" }]);
    const { outcome } = dragNote(state, "n-0001", 5.4, {
      events: vocals, beatGrid: denseGrid(4, 6),
    });
    expect(outcome.candidate?.kind).toBe("event");
    expect(outcome.guideTimeSec).toBe(5.37);
  });

  it("takes a note onto a beat when that is all there is", () => {
    const state = tapAt(blank(), 1);
    expect(dragNote(state, "n-0001", 4.98, { beatGrid: [4, 4.5, 5, 5.5] }).startsAt).toBe(5);
  });

  it("puts every source in one list", () => {
    let state = tapAt(blank(), 5);
    state = tapAt(state, 1, 2);
    const { candidates } = dragNote(state, "n-0002", 5, {
      beatGrid: [4],
      decorations: [decoration("dec-0001", 6, 7)],
      events: events([{ id: "ev-1", startSec: 8, lane: "drums" }]),
    });
    expect(new Set(candidates.map((c) => c.kind))).toEqual(
      new Set(["beat", "note-start", "decoration-start", "decoration-end", "event"]),
    );
  });

  it("ranks the authored and measured sources above the grid", () => {
    for (const kind of [
      "note-start", "note-point", "note-end", "decoration-start", "decoration-end", "event",
    ] as const) {
      expect(candidatePriority({ timeSec: 0, kind })).toBeLessThan(
        candidatePriority({ timeSec: 0, kind: "beat" }),
      );
    }
  });
});

describe("what the magnet must never do", () => {
  it("never offers the note being dragged", () => {
    let state = longAt(blank(), 5, 7);
    state = tapAt(state, 1, 3);
    const { candidates } = dragNote(state, "n-0001", 5.2);
    expect(candidates.every((c) => c.noteId !== "n-0001")).toBe(true);
  });

  it("never offers a dragged slide's own waypoints", () => {
    const state = slideThrough(blank(), [1, 1.5, 2]);
    const slide = state.notes[0] as ChartNote;
    const { candidates } = dragNote(state, slide.id, 1.2);
    expect(candidates).toEqual([]);
  });

  it("never offers any member of a multi-note selection", () => {
    let state = tapAt(blank(), 5);
    state = tapAt(state, 5.5, 1);
    state = tapAt(state, 20, 2);
    const { candidates } = dragNote(state, "n-0001", 10, { alsoMoving: ["n-0002"] });
    expect(candidates.map((c) => c.noteId)).toEqual(["n-0003"]);
  });

  it("snaps nothing at all when the magnet is off", () => {
    let state = tapAt(blank(), 5);
    state = tapAt(state, 1, 2);
    const { outcome, startsAt } = dragNote(state, "n-0002", 4.99, {
      beatGrid: denseGrid(4, 6),
      decorations: [decoration("dec-0001", 4.995, 6)],
      events: events([{ id: "ev-1", startSec: 4.991, lane: "vocals" }]),
      enabled: false,
    });
    expect(outcome.candidate).toBeNull();
    expect(outcome.guideTimeSec).toBeNull();
    expect(startsAt).toBeCloseTo(4.99, 9);
  });
});

describe("a selection moves as one", () => {
  it("applies the same delta to every member, keeping their spacing", () => {
    let state = tapAt(blank(), 5);        // n-0001, moving
    state = tapAt(state, 5.5, 1);         // n-0002, moving
    state = tapAt(state, 10, 2);          // n-0003, the target
    const { outcome, startsAt } = dragNote(state, "n-0001", 9.97, {
      alsoMoving: ["n-0002"],
    });
    expect(startsAt).toBe(10);
    // The delta is one number applied to the whole set, so B keeps its half second.
    expect(5.5 + outcome.deltaSec).toBeCloseTo(10.5, 9);
  });

  it("lets the trailing member of a selection be what lines up", () => {
    let state = tapAt(blank(), 5);
    state = tapAt(state, 5.5, 1);
    state = tapAt(state, 10, 2);
    // Carried so B's start, not A's, arrives at the target.
    const { outcome } = dragNote(state, "n-0001", 9.48, { alsoMoving: ["n-0002"] });
    expect(outcome.guideTimeSec).toBe(10);
    expect(5.5 + outcome.deltaSec).toBe(10);
  });
});

describe("the threshold is a screen distance", () => {
  it("snaps from the same number of pixels away at every zoom", () => {
    let state = tapAt(blank(), 5);
    state = tapAt(state, 1, 2);
    for (const pixelsPerSecond of [60, 174, 510, 1515]) {
      const inside = (MAGNET_ENTER_PX - 2) / pixelsPerSecond;
      const outside = (MAGNET_ENTER_PX + 40) / pixelsPerSecond;
      expect(dragNote(state, "n-0002", 5 + inside, { pixelsPerSecond }).startsAt).toBe(5);
      expect(dragNote(state, "n-0002", 5 + outside, { pixelsPerSecond }).outcome.candidate)
        .toBeNull();
    }
  });

  it("reaches a smaller slice of time the further it is zoomed in", () => {
    let state = tapAt(blank(), 5);
    state = tapAt(state, 1, 2);
    // 0.05 s away: comfortably inside the magnet at 174 px/s, far outside it at 1515.
    expect(dragNote(state, "n-0002", 5.05, { pixelsPerSecond: 174 }).startsAt).toBe(5);
    expect(dragNote(state, "n-0002", 5.05, { pixelsPerSecond: 1515 }).outcome.candidate)
      .toBeNull();
  });
});

describe("hysteresis across a drag", () => {
  it("keeps a note start it has caught while a beat drifts closer", () => {
    // The hold has to survive the grid, or the note would be stolen away mid-gesture by
    // a line the author was never aiming at.
    let state = tapAt(blank(), 5.03);
    state = tapAt(state, 1, 2);
    const dragged = state.notes.find((n) => n.id === "n-0002") as ChartNote;
    const candidates = buildMagnetCandidates({
      beatGrid: denseGrid(4, 6),
      notes: state.notes,
      excludeNoteIds: new Set(["n-0002"]),
    });

    let hold: MagnetHold | null = null;
    const seen: (string | undefined)[] = [];
    for (const at of [5.025, 5.02, 5.012, 5.005, 5.001]) {
      const outcome = magnetSnapDelta({
        candidates,
        baseEdgesSec: [dragged.timeSec],
        rawDeltaSec: at - dragged.timeSec,
        earliestMovingSec: dragged.timeSec,
        pixelsPerSecond: 100,
        enabled: true,
        held: hold,
      });
      hold = outcome.hold;
      seen.push(outcome.candidate?.kind);
    }
    expect(seen).toEqual(Array(5).fill("note-start"));
  });

  it("gives up the hold once something genuinely better is in reach", () => {
    let state = tapAt(blank(), 5);
    state = tapAt(state, 5.4, 1);
    state = tapAt(state, 1, 2);
    const dragged = state.notes.find((n) => n.id === "n-0003") as ChartNote;
    const candidates = buildMagnetCandidates({
      notes: state.notes,
      excludeNoteIds: new Set(["n-0003"]),
    });
    const held: MagnetHold = {
      candidate: { timeSec: 5, kind: "note-start", noteId: "n-0001" } as SnapCandidate,
      baseEdgeSec: dragged.timeSec,
    };
    const outcome = magnetSnapDelta({
      candidates,
      baseEdgesSec: [dragged.timeSec],
      rawDeltaSec: 5.4 - dragged.timeSec,
      earliestMovingSec: dragged.timeSec,
      pixelsPerSecond: 100,
      enabled: true,
      held,
    });
    expect(outcome.candidate?.timeSec).toBe(5.4);
  });
});

describe("the guide names what was reached", () => {
  it("reports the time the note actually lands on", () => {
    let state = tapAt(blank(), 5);
    state = tapAt(state, 1, 2);
    const { outcome, startsAt } = dragNote(state, "n-0002", 4.99);
    expect(outcome.guideTimeSec).toBe(5);
    expect(startsAt).toBe(outcome.guideTimeSec);
  });

  it("has a guide for every source, not only for beats", () => {
    const state = tapAt(blank(), 1);
    const withGuide = [
      dragNote(state, "n-0001", 4.99, { beatGrid: [5] }),
      dragNote(state, "n-0001", 4.99, { decorations: [decoration("dec-0001", 5, 6)] }),
      dragNote(state, "n-0001", 4.99, {
        events: events([{ id: "ev-1", startSec: 5, lane: "vocals" }]),
      }),
    ];
    for (const { outcome } of withGuide) expect(outcome.guideTimeSec).toBe(5);
  });

  it("reports nothing to draw on a free move", () => {
    const state = tapAt(blank(), 1);
    const { outcome } = dragNote(state, "n-0001", 4.5, { beatGrid: [6] });
    expect(outcome.guideTimeSec).toBeNull();
  });
});

describe("an edge drag lines up with note timings too", () => {
  const edgeTo = (candidates: readonly SnapCandidate[], at: number) =>
    magnetSnapEdge({ candidates, rawTimeSec: at, pixelsPerSecond: 100, enabled: true });

  it("takes a Long's grip onto another note's start, past a dense grid", () => {
    let state = tapAt(blank(), 5.03);
    state = longAt(state, 1, 2.75);
    const candidates = buildMagnetCandidates({
      beatGrid: denseGrid(4, 6),
      notes: state.notes,
      excludeNoteIds: new Set(["n-0002"]),
    });
    const out = edgeTo(candidates, 5.01);
    expect(out.candidate?.kind).toBe("note-start");
    expect(out.timeSec).toBe(5.03);
  });

  it("takes a grip onto a slide's waypoint", () => {
    let state = slideThrough(blank(), [1, 1.5, 2]);
    state = longAt(state, 10, 12);
    const candidates = buildMagnetCandidates({
      notes: state.notes,
      excludeNoteIds: new Set([state.notes.find((n) => n.type === "hold")?.id ?? ""]),
    });
    expect(edgeTo(candidates, 1.48).candidate?.kind).toBe("note-point");
  });
});
