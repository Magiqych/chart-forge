/**
 * Hearing every moment of a note that has more than one.
 *
 * The defect this suite exists for: a connected Slide announced its first point and then
 * went silent. Joining slide points **merges** them into one note whose middle points
 * become `waypoints`, and the scheduler iterated notes reading `note.timeSec` - so a
 * four-point slide was one timestamp and made one sound.
 *
 * The fix flattens notes into moments before scheduling, so the tests below are about
 * moments: that every point of a slide is heard, that a plain Long's release is not
 * (releasing is not a hit), that a note finishing in a flick is heard again at its end,
 * and that none of it double-fires across a pause, a seek or a stalled clock.
 */

import { describe, expect, it } from "vitest";

import {
  connectSlides, emptyChart, flickEndAction, placeNote, setEndAction,
  type ChartNote, type ChartState,
} from "./chart";
import {
  advanceScheduler, buildHitPoints, endIsJudged, hitPointsOf, resetSchedulerTo,
  voiceForNote, type HitPoint,
} from "./hitScheduler";

const blank = (): ChartState => emptyChart({ audioPath: "song.wav", audioDurationSec: 30 });

/** A slide built the way the Editor builds one: points placed, then joined. */
function slideThrough(times: readonly number[]): ChartNote {
  let state = blank();
  times.forEach((timeSec, index) => {
    state = placeNote(state, { timeSec, lane: index % 5, type: "slide" }).state;
  });
  const ids = state.notes.map((note) => note.id);
  state = connectSlides(state, ids);
  const joined = state.notes[0];
  if (!joined) throw new Error("the slide did not survive being joined");
  return joined;
}

const times = (points: readonly HitPoint[]) => points.map((p) => p.timeSec);
const voices = (points: readonly HitPoint[]) => points.map((p) => p.voice);

/** Walk the clock forward one frame at a time and collect everything heard. */
function playThrough(
  points: readonly HitPoint[],
  fromSec: number,
  toSec: number,
  rate = 1,
  stallEvery = 0,
): readonly HitPoint[] {
  const perFrame = rate / 60;
  let state = resetSchedulerTo(fromSec);
  let clock = fromSec;
  const heard: HitPoint[] = [];
  for (let frame = 0; clock < toSec; frame += 1) {
    if (stallEvery === 0 || frame % stallEvery !== 0) clock += perFrame;
    const step = advanceScheduler(state, clock, points);
    state = step.state;
    heard.push(...step.fired);
    if (frame > 400000) throw new Error("the clock is not advancing");
  }
  return heard;
}

describe("the moments of a note", () => {
  it("gives an instantaneous note exactly one", () => {
    const tap: ChartNote = { id: "n-1", type: "tap", timeSec: 1, lane: 0 };
    expect(times(hitPointsOf(tap))).toEqual([1]);
    expect(voices(hitPointsOf(tap))).toEqual(["tap"]);
  });

  it("gives a two-point slide both of its points", () => {
    const slide = slideThrough([1, 2]);
    expect(times(hitPointsOf(slide))).toEqual([1, 2]);
  });

  it("gives a three-point slide all three", () => {
    const slide = slideThrough([1, 1.5, 2]);
    expect(times(hitPointsOf(slide))).toEqual([1, 1.5, 2]);
  });

  it("gives a four-point slide all four - the case that was silent after the first", () => {
    const slide = slideThrough([1, 1.5, 2, 2.5]);
    expect(times(hitPointsOf(slide))).toEqual([1, 1.5, 2, 2.5]);
    expect(voices(hitPointsOf(slide))).toEqual(["holdStart", "tap", "tap", "tap"]);
  });

  it("gives every point of a long chain", () => {
    const slide = slideThrough([1, 1.25, 1.5, 1.75, 2, 2.25, 2.5]);
    expect(times(hitPointsOf(slide))).toHaveLength(7);
  });

  it("gives a plain Long only its start, because a release is not a hit", () => {
    const long: ChartNote = { id: "n-1", type: "hold", timeSec: 1, lane: 0, endTimeSec: 2 };
    expect(times(hitPointsOf(long))).toEqual([1]);
    expect(endIsJudged(long)).toBe(false);
  });

  it("gives a Long that finishes in a flick both moments", () => {
    let state = placeNote(blank(), {
      timeSec: 1, lane: 0, type: "hold", endTimeSec: 2,
    }).state;
    state = setEndAction(state, "n-0001", flickEndAction("left"));
    const long = state.notes[0] as ChartNote;
    expect(endIsJudged(long)).toBe(true);
    expect(times(hitPointsOf(long))).toEqual([1, 2]);
    expect(voices(hitPointsOf(long))).toEqual(["holdStart", "flick"]);
  });

  it("gives a slide that finishes in a flick a flick at its last point", () => {
    let state = blank();
    for (const [timeSec, lane] of [[1, 0], [1.5, 2], [2, 4]] as const) {
      state = placeNote(state, { timeSec, lane, type: "slide" }).state;
    }
    state = connectSlides(state, state.notes.map((n) => n.id));
    state = setEndAction(state, state.notes[0]?.id as string, flickEndAction("right"));
    const slide = state.notes[0] as ChartNote;
    expect(times(hitPointsOf(slide))).toEqual([1, 1.5, 2]);
    expect(voices(hitPointsOf(slide))).toEqual(["holdStart", "tap", "flick"]);
  });

  it("gives a standalone flick one moment, with a flick voice", () => {
    const flick: ChartNote = {
      id: "n-1", type: "flick", timeSec: 1, lane: 0, direction: "left",
    };
    expect(voices(hitPointsOf(flick))).toEqual(["flick"]);
  });

  it("decides by shape, not by type name", () => {
    // The retired `purple`, and anything a later contract adds, still gets a click.
    const unknown: ChartNote = { id: "n-1", type: "sparkle", timeSec: 1, lane: 0 };
    expect(voices(hitPointsOf(unknown))).toEqual(["tap"]);
    expect(voiceForNote(unknown)).toBe("tap");
  });

  it("gives every moment its own identity, so nothing collapses by time", () => {
    const slide = slideThrough([1, 1.5, 2]);
    const ids = hitPointsOf(slide).map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id.startsWith(slide.id))).toBe(true);
  });
});

describe("the whole chart's moments", () => {
  it("are in time order even when a slide reaches past a later note's start", () => {
    // The slide runs 1.0 to 2.5; the tap at 1.2 comes after it in the document because
    // notes are ordered by their starts. The moments must still ascend.
    let state = blank();
    for (const timeSec of [1, 1.5, 2, 2.5]) {
      state = placeNote(state, { timeSec, lane: 0, type: "slide" }).state;
    }
    state = connectSlides(state, state.notes.map((n) => n.id));
    state = placeNote(state, { timeSec: 1.2, lane: 3, type: "tap" }).state;

    const points = buildHitPoints(state.notes);
    expect(times(points)).toEqual([1, 1.2, 1.5, 2, 2.5]);
  });

  it("keeps two notes that share an instant, rather than collapsing them", () => {
    let state = placeNote(blank(), { timeSec: 5, lane: 0, type: "tap" }).state;
    state = placeNote(state, { timeSec: 5, lane: 2, type: "flick", direction: "left" }).state;
    const points = buildHitPoints(state.notes);
    expect(points).toHaveLength(2);
    expect(voices(points).sort()).toEqual(["flick", "tap"]);
  });

  it("keeps a slide's waypoint that lands on another note's start", () => {
    // Deduplicating by timestamp would silence one of these. They are two different
    // things the player has to do at one instant.
    let state = blank();
    for (const timeSec of [1, 1.5, 2]) {
      state = placeNote(state, { timeSec, lane: 0, type: "slide" }).state;
    }
    state = connectSlides(state, state.notes.map((n) => n.id));
    state = placeNote(state, { timeSec: 1.5, lane: 4, type: "tap" }).state;

    const points = buildHitPoints(state.notes);
    expect(points.filter((p) => p.timeSec === 1.5)).toHaveLength(2);
  });
});

describe("playing a four-point slide", () => {
  const slide = slideThrough([1, 1.5, 2, 2.5]);
  const points = buildHitPoints([slide]);

  it("sounds at every point at full speed", () => {
    expect(times(playThrough(points, 0.9, 2.6))).toEqual([1, 1.5, 2, 2.5]);
  });

  for (const rate of [1, 0.5, 0.25, 0.1]) {
    it(`sounds at every point at ${rate}x`, () => {
      expect(times(playThrough(points, 0.9, 2.6, rate))).toEqual([1, 1.5, 2, 2.5]);
    });
  }

  it("sounds each point exactly once when the clock stalls", () => {
    // A media clock that updates less often than the display repeats a time. A "the
    // playhead is near a point" test would fire the same point on each repeat.
    expect(times(playThrough(points, 0.9, 2.6, 0.1, 3))).toEqual([1, 1.5, 2, 2.5]);
  });

  it("catches two points crossed in one frame", () => {
    // One step over 1.4 -> 2.1 spans both 1.5 and 2.0. Neither may be swallowed, and a
    // loop that stopped at the first would lose the second.
    const step = advanceScheduler(resetSchedulerTo(1.4), 2.1, points);
    expect(times(step.fired)).toEqual([1.5, 2]);
  });

  it("catches every point of a slide crossed in one dropped frame", () => {
    // A hitch just inside the seek threshold. Anything wider than a second is a seek by
    // design, so the window here is 0.9 s and has to catch all three points inside it.
    const dense = buildHitPoints([slideThrough([1, 1.3, 1.6, 1.85])]);
    const step = advanceScheduler(resetSchedulerTo(0.95), 1.85, dense);
    expect(step.seeked).toBe(false);
    expect(times(step.fired)).toEqual([1, 1.3, 1.6, 1.85]);
  });

  it("says nothing twice across a pause and a resume", () => {
    const first = playThrough(points, 0.9, 1.7);
    expect(times(first)).toEqual([1, 1.5]);
    // Resuming adopts the position: what was already heard is not replayed.
    const second = playThrough(points, 1.7, 2.6);
    expect(times(second)).toEqual([2, 2.5]);
  });

  it("stays silent over a forward seek and plays normally after it", () => {
    const seek = advanceScheduler(resetSchedulerTo(0.9), 2.2, points);
    expect(seek.seeked).toBe(true);
    expect(seek.fired).toEqual([]);
    const after = advanceScheduler(seek.state, 2.6, points);
    expect(times(after.fired)).toEqual([2.5]);
  });

  it("stays silent over a backward seek and plays the points again from there", () => {
    let state = resetSchedulerTo(2.6);
    const back = advanceScheduler(state, 0.9, points);
    expect(back.seeked).toBe(true);
    expect(back.fired).toEqual([]);
    state = back.state;
    expect(times(playThrough(points, 0.9, 2.6))).toEqual([1, 1.5, 2, 2.5]);
  });

  it("gives the same points at 0.1x as at full speed", () => {
    expect(times(playThrough(points, 0.9, 2.6, 0.1)))
      .toEqual(times(playThrough(points, 0.9, 2.6, 1)));
  });
});

describe("a slide beside other notes", () => {
  it("sounds the slide's points and the notes around it, all of them", () => {
    let state = blank();
    for (const timeSec of [1, 1.5, 2]) {
      state = placeNote(state, { timeSec, lane: 0, type: "slide" }).state;
    }
    state = connectSlides(state, state.notes.map((n) => n.id));
    state = placeNote(state, { timeSec: 1.75, lane: 3, type: "tap" }).state;
    state = placeNote(state, { timeSec: 2.5, lane: 4, type: "flick", direction: "left" }).state;

    const heard = playThrough(buildHitPoints(state.notes), 0.9, 2.6);
    expect(times(heard)).toEqual([1, 1.5, 1.75, 2, 2.5]);
    expect(voices(heard)).toEqual(["holdStart", "tap", "tap", "tap", "flick"]);
  });

  it("does not let a Long's silent release swallow a note at the same instant", () => {
    let state = placeNote(blank(), {
      timeSec: 1, lane: 0, type: "hold", endTimeSec: 2,
    }).state;
    state = placeNote(state, { timeSec: 2, lane: 3, type: "tap" }).state;
    const heard = playThrough(buildHitPoints(state.notes), 0.9, 2.1);
    expect(times(heard)).toEqual([1, 2]);
    expect(voices(heard)).toEqual(["holdStart", "tap"]);
  });
});
