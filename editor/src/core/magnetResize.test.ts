/**
 * A magnetised grip drag, end to end, without a pointer.
 *
 * The companion to `magnetDrag.test.ts`, for the other half of Select Mode. A press on a
 * grip records the note and its candidates, every pointer move asks `magnetSnapEdge`
 * where that one edge should be, and the pointer coming up calls `resize` or
 * `resizeStart` exactly once. These tests drive that sequence against a real session, so
 * what is checked is what the author gets: the edge lands on the thing the guide named,
 * the other end has not moved a bit, and one press of undo puts the note back.
 *
 * Before this, a grip went through the placement resolver instead - which snapped only to
 * whatever the Snap control was set to, could not see another note's edge at all, and
 * drew no guide, so there was no way to tell a snap from a coincidence.
 *
 * The one thing they cannot check is the canvas. That is what the GUI pass is for.
 */

import { describe, expect, it } from "vitest";

import type { LaneId, ProjectedEvent } from "./analysis";
import { emptyChart, placeNote, MIN_HELD_DURATION_SEC, type ChartNote } from "./chart";
import {
  chartOf, openSession, redo, resize, resizeStart, select, undo, type EditorSession,
} from "./editorSession";
import { buildGuideAnchors } from "./guideAnchors";
import {
  buildMagnetCandidates, magnetSnapEdge, type MagnetEdgeHold, type SnapCandidate,
} from "./magnetSnap";
import type { ResizeEdge } from "./pointerIntent";

const BEATS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const ALL_LANES: ReadonlySet<LaneId> = new Set<LaneId>(["drums", "other", "bass", "vocals"]);

/** Analysis Events as the overlay holds them, converted the way the Editor converts them. */
function eventsOf(
  specs: readonly { id: string; startSec: number; endSec?: number; lane: LaneId }[],
): readonly ProjectedEvent[] {
  return specs.map((spec) => ({
    id: spec.id,
    type: "onset",
    startSec: spec.startSec,
    ...(spec.endSec === undefined ? {} : { endSec: spec.endSec }),
    endKind: spec.endSec === undefined ? ("instantaneous" as const) : ("bounded" as const),
    detectorId: `det-${spec.lane}`,
    stemId: `stem-${spec.lane}`,
    lane: spec.lane,
  }));
}

function chartWith(
  specs: readonly { timeSec: number; endTimeSec?: number; lane?: number }[],
): EditorSession {
  let state = emptyChart({ audioPath: "song.wav", audioDurationSec: 30 });
  for (const spec of specs) {
    state = placeNote(state, {
      timeSec: spec.timeSec,
      lane: spec.lane ?? 0,
      type: spec.endTimeSec === undefined ? "tap" : "hold",
      ...(spec.endTimeSec === undefined ? {} : { endTimeSec: spec.endTimeSec }),
    }).state;
  }
  return openSession(state);
}

const noteOf = (session: EditorSession, id: string): ChartNote => {
  const found = chartOf(session).notes.find((note) => note.id === id);
  if (!found) throw new Error(`no note ${id}`);
  return found;
};

/**
 * One complete drag of one grip, exactly as the Timeline performs it.
 *
 * `toSec` is where the pointer carries that edge. The candidates are built once at the
 * press, with the note itself excluded; the bound comes from the end that is *not*
 * moving; and the chart is touched once at the release.
 */
function gripDrag(
  session: EditorSession,
  noteId: string,
  edge: ResizeEdge,
  toSec: number,
  options: {
    pixelsPerSecond?: number;
    enabled?: boolean;
    beats?: readonly number[];
    steps?: number;
    events?: readonly ProjectedEvent[];
    visibleLanes?: ReadonlySet<LaneId>;
  } = {},
): { session: EditorSession; guides: (number | null)[]; candidates: readonly SnapCandidate[] } {
  const pixelsPerSecond = options.pixelsPerSecond ?? 100;
  const note = noteOf(session, noteId);
  if (note.endTimeSec === undefined) throw new Error(`${noteId} has no end`);
  const selected = select(session, noteId);

  const candidates = buildMagnetCandidates({
    beatGrid: options.beats ?? BEATS,
    notes: chartOf(selected).notes,
    excludeNoteIds: new Set([noteId]),
    eventAnchors: buildGuideAnchors(
      options.events ?? [],
      options.visibleLanes ?? ALL_LANES,
      { includeEnds: true },
    ),
  });

  const fixedSec = edge === "start" ? note.endTimeSec : note.timeSec;
  const fromSec = edge === "start" ? note.timeSec : note.endTimeSec;
  const bound =
    edge === "start"
      ? { maxTimeSec: fixedSec - MIN_HELD_DURATION_SEC }
      : { minTimeSec: fixedSec + MIN_HELD_DURATION_SEC };

  const steps = options.steps ?? 10;
  const guides: (number | null)[] = [];
  let hold: MagnetEdgeHold | null = null;
  let landed = fromSec;
  for (let step = 1; step <= steps; step += 1) {
    const at = fromSec + ((toSec - fromSec) * step) / steps;
    const outcome = magnetSnapEdge({
      candidates,
      rawTimeSec: Math.max(0, at),
      ...bound,
      pixelsPerSecond,
      enabled: options.enabled ?? true,
      held: hold,
    });
    hold = outcome.hold;
    guides.push(outcome.guideTimeSec);
    landed = outcome.timeSec;
  }

  const committed =
    edge === "start" ? resizeStart(selected, noteId, landed) : resize(selected, noteId, landed);
  return { session: committed, guides, candidates };
}

describe("dragging a held note's start grip", () => {
  const longChart = () => chartWith([{ timeSec: 10, endTimeSec: 14 }]);

  it("lands the start on the beat and leaves the end alone", () => {
    const { session: after, guides } = gripDrag(longChart(), "n-0001", "start", 11.03, {
      steps: 1,
    });
    const note = noteOf(after, "n-0001");
    expect(note.timeSec).toBe(11);
    expect(note.endTimeSec).toBe(14);
    expect(guides[guides.length - 1]).toBe(11);
  });

  it("lands on an Analysis Event", () => {
    const sung = eventsOf([{ id: "ev-vox", startSec: 11.37, endSec: 11.8, lane: "vocals" }]);
    const { session: after } = gripDrag(longChart(), "n-0001", "start", 11.34, {
      beats: [], events: sung,
    });
    expect(noteOf(after, "n-0001").timeSec).toBe(11.37);
    expect(noteOf(after, "n-0001").endTimeSec).toBe(14);
  });

  it("lands on another note's start and on another note's end", () => {
    const session = chartWith([
      { timeSec: 10, endTimeSec: 14 },
      { timeSec: 11.4, endTimeSec: 11.9, lane: 1 },
    ]);
    expect(
      noteOf(gripDrag(session, "n-0001", "start", 11.43, { beats: [] }).session, "n-0001").timeSec,
    ).toBe(11.4);
    expect(
      noteOf(gripDrag(session, "n-0001", "start", 11.93, { beats: [] }).session, "n-0001").timeSec,
    ).toBe(11.9);
  });

  it("stays where the hand put it when nothing is in reach", () => {
    const { session: after } = gripDrag(longChart(), "n-0001", "start", 10.62, { beats: [] });
    expect(noteOf(after, "n-0001").timeSec).toBeCloseTo(10.62, 9);
  });

  it("cannot be caught by the note's own start or its own end", () => {
    const { candidates, session: after } = gripDrag(longChart(), "n-0001", "start", 13.6, {
      beats: [],
    });
    expect(candidates.some((candidate) => candidate.noteId === "n-0001")).toBe(false);
    // Without the exclusion the grip would be pulled straight back onto 10 and refuse to
    // move at all, or onto 14 and collapse the note.
    expect(noteOf(after, "n-0001").timeSec).toBeCloseTo(13.6, 9);
  });

  it("keeps the note a hold, however far past its end it is dragged", () => {
    for (const target of [14, 14.5, 20, 100]) {
      const { session: after } = gripDrag(longChart(), "n-0001", "start", target);
      const note = noteOf(after, "n-0001");
      expect(note.endTimeSec!).toBeGreaterThan(note.timeSec);
      expect(note.endTimeSec!).toBe(14);
      // Exactly the minimum the model promises, to within the error of subtracting two
      // times a tenth of a second apart. What matters is that it is a hold at all.
      expect(note.endTimeSec! - note.timeSec).toBeCloseTo(MIN_HELD_DURATION_SEC, 12);
    }
  });

  it("never goes before the start of the recording", () => {
    const early = chartWith([{ timeSec: 0.3, endTimeSec: 2 }]);
    const { session: after } = gripDrag(early, "n-0001", "start", -5, { beats: [0, 0.5, 1] });
    expect(noteOf(after, "n-0001").timeSec).toBeGreaterThanOrEqual(0);
  });

  it("records one history step, and undo puts both times back", () => {
    const before = longChart();
    const { session: after } = gripDrag(before, "n-0001", "start", 11.03, { steps: 12 });
    expect(noteOf(after, "n-0001").timeSec).toBe(11);

    const back = undo(after);
    expect(noteOf(back, "n-0001").timeSec).toBe(10);
    expect(noteOf(back, "n-0001").endTimeSec).toBe(14);

    const forward = redo(back);
    expect(noteOf(forward, "n-0001").timeSec).toBe(11);
    expect(noteOf(forward, "n-0001").endTimeSec).toBe(14);
  });

  it("moves freely when the magnet is suspended", () => {
    const { session: after } = gripDrag(longChart(), "n-0001", "start", 11.03, {
      enabled: false, steps: 1,
    });
    expect(noteOf(after, "n-0001").timeSec).toBeCloseTo(11.03, 9);
  });
});

describe("dragging a held note's end grip", () => {
  const longChart = () => chartWith([{ timeSec: 10, endTimeSec: 14 }]);

  it("lands the end on the beat and leaves the start alone", () => {
    const { session: after, guides } = gripDrag(longChart(), "n-0001", "end", 15.02, {
      steps: 1,
    });
    const note = noteOf(after, "n-0001");
    expect(note.timeSec).toBe(10);
    expect(note.endTimeSec).toBe(15);
    expect(guides[guides.length - 1]).toBe(15);
  });

  it("lands on where a sung note stopped", () => {
    const sung = eventsOf([{ id: "ev-vox", startSec: 15.2, endSec: 15.83, lane: "vocals" }]);
    const { session: after } = gripDrag(longChart(), "n-0001", "end", 15.86, {
      beats: [], events: sung,
    });
    expect(noteOf(after, "n-0001").endTimeSec).toBe(15.83);
    expect(noteOf(after, "n-0001").timeSec).toBe(10);
  });

  it("lands on another note's start", () => {
    const session = chartWith([
      { timeSec: 10, endTimeSec: 14 },
      { timeSec: 15.44, lane: 1 },
    ]);
    const { session: after } = gripDrag(session, "n-0001", "end", 15.47, { beats: [] });
    expect(noteOf(after, "n-0001").endTimeSec).toBe(15.44);
  });

  it("keeps the note a hold, however far back its end is dragged", () => {
    for (const target of [10, 9, 0, -3]) {
      const { session: after } = gripDrag(longChart(), "n-0001", "end", target);
      const note = noteOf(after, "n-0001");
      expect(note.timeSec).toBe(10);
      expect(note.endTimeSec!).toBeGreaterThan(note.timeSec);
      // Exactly the minimum the model promises, to within the error of subtracting two
      // times a tenth of a second apart. What matters is that it is a hold at all.
      expect(note.endTimeSec! - note.timeSec).toBeCloseTo(MIN_HELD_DURATION_SEC, 12);
    }
  });

  it("cannot be caught by its own two ends", () => {
    const { candidates } = gripDrag(longChart(), "n-0001", "end", 15, { beats: [] });
    expect(candidates.some((candidate) => candidate.noteId === "n-0001")).toBe(false);
  });

  it("records one history step, and undo puts both times back", () => {
    const { session: after } = gripDrag(longChart(), "n-0001", "end", 15.02, { steps: 12 });
    const back = undo(after);
    expect(noteOf(back, "n-0001").timeSec).toBe(10);
    expect(noteOf(back, "n-0001").endTimeSec).toBe(14);
    expect(noteOf(redo(back), "n-0001").endTimeSec).toBe(15);
  });
});

describe("what a grip drag leaves alone", () => {
  it("keeps the note's identity and its lane", () => {
    const session = chartWith([{ timeSec: 10, endTimeSec: 14, lane: 2 }]);
    const before = noteOf(session, "n-0001");
    const { session: after } = gripDrag(session, "n-0001", "end", 15.02);
    const note = noteOf(after, "n-0001");
    expect(note.id).toBe(before.id);
    expect(note.lane).toBe(before.lane);
    expect(note.type).toBe(before.type);
  });

  it("leaves every other note exactly where it was", () => {
    const session = chartWith([
      { timeSec: 10, endTimeSec: 14 },
      { timeSec: 12, lane: 1 },
      { timeSec: 16, lane: 2 },
    ]);
    const { session: after } = gripDrag(session, "n-0001", "end", 15.02);
    expect(noteOf(after, "n-0002").timeSec).toBe(12);
    expect(noteOf(after, "n-0003").timeSec).toBe(16);
  });

  it("re-sorts the chart when a start is dragged past another note", () => {
    // The chart is ordered by start, so a note dragged past its neighbour has to take its
    // new place in the document rather than keep its old one.
    const session = chartWith([
      { timeSec: 10, endTimeSec: 14 },
      { timeSec: 11, lane: 1 },
    ]);
    const { session: after } = gripDrag(session, "n-0001", "start", 12.02);
    const times = chartOf(after).notes.map((note) => note.timeSec);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
