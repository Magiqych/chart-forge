/**
 * A magnetised drag, end to end, without a pointer.
 *
 * The Timeline component is thin on purpose: a press records what is moving, every
 * pointer move asks `magnetSnapDelta` where the note should be, and the pointer coming up
 * calls `moveSelected` once. These tests drive exactly that sequence against a real
 * session, so what is checked is the behaviour the author gets - the note lands on the
 * thing the guide named, one press of undo puts it back, and a chart's connections come
 * through untouched - rather than any one function in isolation.
 *
 * The one thing they cannot check is the canvas. That is what the GUI pass is for.
 */

import { describe, expect, it } from "vitest";

import { chainOf, connectRun, emptyChart, placeNote, type ChartNote } from "./chart";
import {
  canRedoSession, canUndoSession, chartOf, moveSelected, openSession, redo, select,
  selectMany, undo, type EditorSession,
} from "./editorSession";
import {
  buildMagnetCandidates, magnetSnapDelta, MAGNET_ENTER_PX, MAGNET_RELEASE_PX,
  type MagnetHold, type SnapCandidate,
} from "./magnetSnap";

const BEATS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

/** A chart with the notes described, in placement order. */
function chartWith(
  specs: readonly { timeSec: number; lane?: number; endTimeSec?: number; type?: string }[],
): EditorSession {
  let state = emptyChart({ audioPath: "song.wav", audioDurationSec: 10 });
  for (const spec of specs) {
    state = placeNote(state, {
      timeSec: spec.timeSec,
      lane: spec.lane ?? 0,
      type: (spec.type ?? (spec.endTimeSec === undefined ? "tap" : "hold")) as "tap" | "hold",
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
 * One complete drag of one note, exactly as the Timeline performs it.
 *
 * `toSec` is where the pointer carries the note's own start. The candidates are built
 * once at the press, the delta is recomputed on every move, and the chart is touched once
 * at the release - which is the whole history semantics of a drag in three lines.
 */
function drag(
  session: EditorSession,
  noteId: string,
  toSec: number,
  options: {
    pixelsPerSecond?: number;
    enabled?: boolean;
    beats?: readonly number[];
    steps?: number;
  } = {},
): { session: EditorSession; guides: (number | null)[]; candidates: readonly SnapCandidate[] } {
  const pixelsPerSecond = options.pixelsPerSecond ?? 100;
  const held = noteOf(session, noteId);
  const selected = select(session, noteId);

  const candidates = buildMagnetCandidates({
    beatGrid: options.beats ?? BEATS,
    notes: chartOf(selected).notes,
    excludeNoteIds: new Set(selected.selectedNoteIds),
  });
  const baseEdgesSec =
    held.endTimeSec !== undefined && held.endTimeSec > held.timeSec
      ? [held.timeSec, held.endTimeSec]
      : [held.timeSec];

  // Pointer moves on the way, as a real drag has hundreds. None of them touches the
  // chart; each simply recomputes where the note would go from where the hand now is,
  // and each carries the previous move's hold forward exactly as the Timeline does.
  const steps = options.steps ?? 10;
  const guides: (number | null)[] = [];
  let deltaSec = 0;
  let hold: MagnetHold | null = null;
  for (let step = 1; step <= steps; step += 1) {
    const at = held.timeSec + ((toSec - held.timeSec) * step) / steps;
    const outcome = magnetSnapDelta({
      candidates,
      baseEdgesSec,
      rawDeltaSec: at - held.timeSec,
      earliestMovingSec: held.timeSec,
      pixelsPerSecond,
      enabled: options.enabled ?? true,
      held: hold,
    });
    hold = outcome.hold;
    guides.push(outcome.guideTimeSec);
    deltaSec = outcome.deltaSec;
  }

  return { session: moveSelected(selected, deltaSec, 0), guides, candidates };
}

describe("dragging a note onto something", () => {
  it("lands it on the beat the guide named", () => {
    const session = chartWith([{ timeSec: 0.2 }]);
    const id = chartOf(session).notes[0]!.id;
    const dragged = drag(session, id, 2.04);

    expect(dragged.guides[dragged.guides.length - 1]).toBe(2);
    expect(noteOf(dragged.session, id).timeSec).toBeCloseTo(2, 12);
  });

  it("lands it on another note's start", () => {
    const session = chartWith([{ timeSec: 0.2 }, { timeSec: 2.37, lane: 2 }]);
    const [moving, target] = chartOf(session).notes;
    const dragged = drag(session, moving!.id, 2.34);

    expect(dragged.guides[dragged.guides.length - 1]).toBe(target!.timeSec);
    expect(noteOf(dragged.session, moving!.id).timeSec).toBeCloseTo(2.37, 12);
  });

  it("lands it on another note's end", () => {
    const session = chartWith([{ timeSec: 0.2 }, { timeSec: 2.2, endTimeSec: 3.13, lane: 2 }]);
    const moving = chartOf(session).notes.find((n) => n.timeSec === 0.2)!;
    const dragged = drag(session, moving.id, 3.16);

    expect(dragged.guides[dragged.guides.length - 1]).toBe(3.13);
    expect(noteOf(dragged.session, moving.id).timeSec).toBeCloseTo(3.13, 12);
  });

  it("leaves it where the hand put it when nothing is in reach", () => {
    const session = chartWith([{ timeSec: 0.2 }]);
    const id = chartOf(session).notes[0]!.id;
    // 2.3 is 30 px past the 2.0 beat and 20 px short of the 2.5 one: too far for the
    // beat behind to keep hold of it, and too far for the one ahead to take it.
    const dragged = drag(session, id, 2.3);

    // The guide comes and goes on the way - the note passes several beats, and being
    // taken by each in turn is the magnet working. What matters is that letting go
    // between them leaves the note between them.
    expect(dragged.guides.at(-1)).toBeNull();
    expect(noteOf(dragged.session, id).timeSec).toBeCloseTo(2.3, 12);
  });

  it("is not caught by the note it is moving", () => {
    const session = chartWith([{ timeSec: 0.77 }]);
    const id = chartOf(session).notes[0]!.id;
    // The only note in the chart is the one being dragged, and the beats are far away.
    const dragged = drag(session, id, 0.79, { beats: [] });

    expect(noteOf(dragged.session, id).timeSec).toBeCloseTo(0.79, 12);
  });

  it("moves freely when the magnet is suspended", () => {
    const session = chartWith([{ timeSec: 0.2 }]);
    const id = chartOf(session).notes[0]!.id;
    const dragged = drag(session, id, 2.04, { enabled: false });

    expect(dragged.guides.every((g) => g === null)).toBe(true);
    expect(noteOf(dragged.session, id).timeSec).toBeCloseTo(2.04, 12);
  });

  it("carries a held note's length with it and lines up by either end", () => {
    const session = chartWith([{ timeSec: 0.2, endTimeSec: 1.13 }]);
    const id = chartOf(session).notes[0]!.id;
    // Dragging the start to 1.6 puts the end at 2.53; the start is 0.1 from a beat and
    // the end 0.03 from one, so the end is what takes it.
    const dragged = drag(session, id, 1.6);
    const moved = noteOf(dragged.session, id);

    expect(dragged.guides[dragged.guides.length - 1]).toBe(2.5);
    expect(moved.endTimeSec).toBeCloseTo(2.5, 12);
    expect(moved.endTimeSec! - moved.timeSec).toBeCloseTo(0.93, 12);
  });

  it("stops changing its mind once the guide has settled", () => {
    // The guide switching between candidates during a drag is normal - the note passes
    // several - but the value it reports is always the one the note is actually on.
    const session = chartWith([{ timeSec: 0.2 }]);
    const id = chartOf(session).notes[0]!.id;
    const dragged = drag(session, id, 2.02);
    for (const guide of dragged.guides) {
      if (guide !== null) expect(BEATS).toContain(guide);
    }
    expect(noteOf(dragged.session, id).timeSec).toBeCloseTo(2, 12);
  });
});

/**
 * The gesture the author actually performs, one pixel at a time.
 *
 * The other tests here check where a drag *ends up*. This one checks what it *feels*
 * like on the way: a note carried steadily past a beat has to travel freely, be taken,
 * stay taken while the hand keeps moving, and then come free again - and the time
 * committed at the end has to be the time the guide was naming at that moment.
 */
describe("carrying a note past a beat, a pixel at a time", () => {
  const PPS = 100;

  /** Every pointer position from 40 px before the 2.0 beat to 40 px after it. */
  function sweepPastTheBeat(): {
    readonly guides: (number | null)[];
    readonly noteTimes: number[];
  } {
    const session = chartWith([{ timeSec: 0.2 }]);
    const id = chartOf(session).notes[0]!.id;
    const selected = select(session, id);
    // One beat on its own. With the usual half-second grid an 80 px sweep would pass
    // through more than one beat's reach, and what is being measured here is the shape of
    // a single capture rather than which of two neighbours won.
    const candidates = buildMagnetCandidates({
      beatGrid: [2],
      notes: chartOf(selected).notes,
      excludeNoteIds: new Set(selected.selectedNoteIds),
    });

    const guides: (number | null)[] = [];
    const noteTimes: number[] = [];
    let hold: MagnetHold | null = null;
    for (let px = -40; px <= 40; px += 1) {
      const at = 2 + px / PPS;
      const out = magnetSnapDelta({
        candidates,
        baseEdgesSec: [0.2],
        rawDeltaSec: at - 0.2,
        earliestMovingSec: 0.2,
        pixelsPerSecond: PPS,
        enabled: true,
        held: hold,
      });
      hold = out.hold;
      guides.push(out.guideTimeSec);
      // What the chart would hold if the pointer came up on this move.
      noteTimes.push(noteOf(moveSelected(selected, out.deltaSec, 0), id).timeSec);
    }
    return { guides, noteTimes };
  }

  it("moves freely, is taken, holds, and comes free again", () => {
    const { guides } = sweepPastTheBeat();
    const first = guides.findIndex((g) => g !== null);
    const last = guides.length - 1 - [...guides].reverse().findIndex((g) => g !== null);

    expect(guides[0]).toBeNull();                 // free on the way in
    expect(guides.at(-1)).toBeNull();             // free on the way out
    expect(first).toBeGreaterThan(0);
    // One unbroken stretch of being held, never flickering on and off a boundary.
    expect(guides.slice(first, last + 1).every((g) => g === 2)).toBe(true);
  });

  it("holds on for longer than it took to catch it", () => {
    const { guides } = sweepPastTheBeat();
    const width = guides.filter((g) => g !== null).length;
    // A single threshold would give 2 x enter. The release distance is wider, and that
    // asymmetry is what the hand reads as a magnet.
    expect(width).toBeGreaterThan(2 * MAGNET_ENTER_PX);
    expect(width).toBeCloseTo(MAGNET_ENTER_PX + MAGNET_RELEASE_PX + 1, 0);
  });

  it("commits exactly the time the guide was naming, on every move", () => {
    // The requirement that the guide cannot lie: at every pointer position, the note the
    // chart would receive sits on the guide, and where there is no guide it sits under
    // the hand.
    const { guides, noteTimes } = sweepPastTheBeat();
    guides.forEach((guide, i) => {
      if (guide !== null) expect(noteTimes[i]).toBeCloseTo(guide, 12);
    });
    expect(noteTimes[0]).toBeCloseTo(2 - 40 / PPS, 12);
    expect(noteTimes.at(-1)).toBeCloseTo(2 + 40 / PPS, 12);
  });

  it("never moves the note backwards while the hand moves forwards", () => {
    // A magnet may hold the note still, but it must never send it the other way: that
    // reads as the note fighting the hand.
    const { noteTimes } = sweepPastTheBeat();
    for (let i = 1; i < noteTimes.length; i += 1) {
      expect(noteTimes[i]!).toBeGreaterThanOrEqual(noteTimes[i - 1]! - 1e-12);
    }
  });
});

describe("what a drag does to the history", () => {
  it("records one step for the whole gesture", () => {
    const session = chartWith([{ timeSec: 0.2 }]);
    const id = chartOf(session).notes[0]!.id;
    const dragged = drag(session, id, 2.04).session;

    expect(canUndoSession(dragged)).toBe(true);
    // One undo, and the note is back where it started - not one undo per pointer move.
    const back = undo(dragged);
    expect(noteOf(back, id).timeSec).toBe(0.2);
    expect(canUndoSession(back)).toBe(false);
  });

  it("puts the note back exactly, not approximately", () => {
    const session = chartWith([{ timeSec: 0.2 }]);
    const id = chartOf(session).notes[0]!.id;
    const before = chartOf(session);
    const back = undo(drag(session, id, 2.04).session);

    expect(chartOf(back)).toEqual(before);
  });

  it("redoes to where the drag put it", () => {
    const session = chartWith([{ timeSec: 0.2 }]);
    const id = chartOf(session).notes[0]!.id;
    const dragged = drag(session, id, 2.04).session;
    const again = redo(undo(dragged));

    expect(canRedoSession(undo(dragged))).toBe(true);
    expect(noteOf(again, id).timeSec).toBeCloseTo(2, 12);
  });

  it("records nothing at all for a drag that changed nothing", () => {
    // The note is already on the beat and the magnet holds it there, so the whole
    // gesture is a no-op and must not fill the history with a step that undoes to the
    // state it is already in.
    const session = chartWith([{ timeSec: 2 }]);
    const id = chartOf(session).notes[0]!.id;
    const dragged = drag(session, id, 2.01).session;

    expect(noteOf(dragged, id).timeSec).toBe(2);
    expect(canUndoSession(dragged)).toBe(false);
  });

  it("takes three drags back one at a time", () => {
    const session = chartWith([{ timeSec: 0.2 }]);
    const id = chartOf(session).notes[0]!.id;
    const one = drag(session, id, 1.02).session;
    const two = drag(one, id, 2.02).session;
    const three = drag(two, id, 3.02).session;

    expect(noteOf(three, id).timeSec).toBeCloseTo(3, 12);
    expect(noteOf(undo(three), id).timeSec).toBeCloseTo(2, 12);
    expect(noteOf(undo(undo(three)), id).timeSec).toBeCloseTo(1, 12);
    expect(noteOf(undo(undo(undo(three))), id).timeSec).toBe(0.2);
  });
});

describe("what a drag leaves alone", () => {
  it("keeps a flick run connected, with the same connections", () => {
    let state = emptyChart({ audioPath: "song.wav", audioDurationSec: 10 });
    const first = placeNote(state, { timeSec: 1, lane: 0, type: "flick", direction: "right" });
    state = first.state;
    const second = placeNote(state, { timeSec: 1.2, lane: 1, type: "flick", direction: "right" });
    state = connectRun(second.state, [first.note.id, second.note.id]);
    const session = openSession(state);
    const before = chartOf(session).connections;

    const dragged = drag(session, second.note.id, 1.52).session;

    expect(chartOf(dragged).connections).toEqual(before);
    expect(chainOf(chartOf(dragged), first.note.id).map((n) => n.id))
      .toEqual([first.note.id, second.note.id]);
    expect(noteOf(dragged, second.note.id).timeSec).toBeCloseTo(1.5, 12);
  });

  it("leaves every note it is not moving exactly where it was", () => {
    const session = chartWith([{ timeSec: 0.2 }, { timeSec: 2.37, lane: 2 }]);
    const [moving, other] = chartOf(session).notes;
    const dragged = drag(session, moving!.id, 1.03).session;

    expect(noteOf(dragged, other!.id)).toEqual(other);
  });
});

describe("a selection of several notes", () => {
  /**
   * The Editor collapses the selection to one note when a drag begins, so this is not a
   * gesture an author can currently make. It is tested because the exclusion rule has to
   * be right the day that changes: a group must not be caught on its own members, which
   * would pull it apart, and the delta must reach every note in it unchanged.
   */
  it("does not offer the notes that are moving as candidates", () => {
    const session = chartWith([{ timeSec: 1 }, { timeSec: 1.4 }, { timeSec: 3 }]);
    const notes = chartOf(session).notes;
    const chosen = selectMany(session, [notes[0]!.id, notes[1]!.id]);

    const candidates = buildMagnetCandidates({
      beatGrid: [],
      notes: chartOf(chosen).notes,
      excludeNoteIds: new Set(chosen.selectedNoteIds),
    });
    expect(candidates.map((c) => c.noteId)).toEqual([notes[2]!.id]);
  });

  it("keeps the spacing inside the group when one of its notes snaps", () => {
    const session = chartWith([{ timeSec: 1 }, { timeSec: 1.4 }, { timeSec: 3 }]);
    const notes = chartOf(session).notes;
    const chosen = selectMany(session, [notes[0]!.id, notes[1]!.id]);
    const candidates = buildMagnetCandidates({
      beatGrid: BEATS,
      notes: chartOf(chosen).notes,
      excludeNoteIds: new Set(chosen.selectedNoteIds),
    });

    // The anchor is the note the author pressed; the rest of the group follows its delta.
    const outcome = magnetSnapDelta({
      candidates,
      baseEdgesSec: [1],
      rawDeltaSec: 1.03,
      earliestMovingSec: 1,
      pixelsPerSecond: 100,
      enabled: true,
    });
    const moved = moveSelected(chosen, outcome.deltaSec, 0);

    expect(outcome.guideTimeSec).toBe(2);
    expect(noteOf(moved, notes[0]!.id).timeSec).toBeCloseTo(2, 12);
    expect(noteOf(moved, notes[1]!.id).timeSec).toBeCloseTo(2.4, 12);
    // One history step for the group, not one per note.
    expect(noteOf(undo(moved), notes[0]!.id).timeSec).toBe(1);
    expect(noteOf(undo(moved), notes[1]!.id).timeSec).toBe(1.4);
  });
});

describe("the edges of the recording", () => {
  it("stops a drag at time zero rather than going negative", () => {
    const session = chartWith([{ timeSec: 1.2 }]);
    const id = chartOf(session).notes[0]!.id;
    const dragged = drag(session, id, -3, { beats: [] }).session;

    expect(noteOf(dragged, id).timeSec).toBe(0);
  });

  it("snaps to time zero itself", () => {
    const session = chartWith([{ timeSec: 1.2 }]);
    const id = chartOf(session).notes[0]!.id;
    const dragged = drag(session, id, 0.03);

    expect(dragged.guides[dragged.guides.length - 1]).toBe(0);
    expect(noteOf(dragged.session, id).timeSec).toBe(0);
  });

  it("puts the note exactly where the guide promised at a very high zoom", () => {
    const session = chartWith([{ timeSec: 1.2 }]);
    const id = chartOf(session).notes[0]!.id;
    // 2000 px/s is the Editor's maximum: the threshold is 5 ms, so a 2 ms approach is
    // taken and a 20 ms one is not.
    expect(drag(session, id, 2.002, { pixelsPerSecond: 2000 }).guides.at(-1)).toBe(2);
    expect(drag(session, id, 2.02, { pixelsPerSecond: 2000 }).guides.at(-1)).toBeNull();
  });

  it("puts the note exactly where the guide promised at a very low zoom", () => {
    const session = chartWith([{ timeSec: 1.2 }]);
    const id = chartOf(session).notes[0]!.id;
    // 5 px/s is the Editor's minimum: two seconds of reach, so the nearest beat wins from
    // a long way off - and the note still lands on it exactly.
    const dragged = drag(session, id, 3.4, { pixelsPerSecond: 5 });
    expect(dragged.guides.at(-1)).toBe(3.5);
    expect(noteOf(dragged.session, id).timeSec).toBe(3.5);
  });
});
