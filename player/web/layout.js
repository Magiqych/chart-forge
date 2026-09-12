/**
 * When a note is on screen, and which notes are worth drawing at all.
 *
 * The *where* moved to `note-space.js` when the flight became a three-dimensional one;
 * this module keeps the two questions that are about time rather than about space - how
 * long a note is in the air, and which of a chart's several hundred notes are in the air
 * right now - and re-exports the geometry so that the modules and tests that only wanted
 * "where is this note" still have one place to ask.
 *
 * The rule both halves are built on is unchanged: every position is a function of chart
 * time and nothing else. Nothing is integrated frame by frame, so a dropped frame moves a
 * note to where it should be rather than leaving it behind, and two machines running at
 * different frame rates draw the same chart identically.
 */

import { flightPhase, projectionOf } from "./note-space.js";

export {
  WORLD,
  flightPhase,
  projectionOf,
  playfieldGeometry,
  laneCentreX,
  positionOf,
  positionBetween,
  noteRadiusAt,
  ribbonHalfWidth,
  clipFlightSpan,
  sampleRibbon,
} from "./note-space.js";

/**
 * The approach: how long a note is on screen before it reaches the tap line, at speed 1.
 *
 * Around a beat and a half of a fast song. It is the *only* thing that decides when a note
 * appears, and it is the same for every kind of note - a chart's `timeSec` says when a note
 * must be hit, and the Player subtracts this to know when to start drawing it. Nothing in
 * the geometry may give one kind of note a different arrival time from another.
 *
 * Faster note speeds shorten it, which is what a note-speed control does in every game of
 * this kind: the note does not move faster along the same path, it appears later and has
 * less distance to cover.
 */
export const BASE_TRAVEL_SEC = 1.6;

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 4;

export function travelSecFor(speed) {
  const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  return BASE_TRAVEL_SEC / clamped;
}

/**
 * How far along its journey a moment is: 0 as it appears, 1 at the tap line.
 *
 * The old name for `flightPhase`, kept because it reads better at the call sites that ask
 * about a moment rather than about a note. They are the same function.
 */
export const progressOf = flightPhase;

/** The perspective projection at a phase. See `projectionOf` in `note-space.js`. */
export const project = projectionOf;

/**
 * Binary search: the index after the last note that starts at or before `timeSec`.
 *
 * `notes` must be in ascending `timeSec`, which `readChart` guarantees.
 */
export function upperBoundByTime(notes, timeSec) {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (notes[mid].timeSec <= timeSec) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The notes that are on screen between two moments.
 *
 * A song is several hundred notes and a frame is 16 ms, so walking the whole chart every
 * frame is the one obviously wrong thing to do here. Instead the notes are already
 * sorted by start, `prefixMaxEnd[i]` is the latest any of the first i+1 notes finishes,
 * and the scan walks back from the newest note that has appeared and stops as soon as no
 * earlier note can possibly still be visible. A thirteen-second slide is found by this;
 * a naive window would have lost it as soon as its start scrolled away.
 */
export function visibleNotes(chart, fromSec, toSec) {
  const { notes, prefixMaxEnd, endTimes } = chart;
  const out = [];
  let index = upperBoundByTime(notes, toSec) - 1;
  for (; index >= 0; index -= 1) {
    if (prefixMaxEnd[index] < fromSec) break;
    if (endTimes[index] >= fromSec) out.push(notes[index]);
  }
  out.reverse();
  return out;
}

/**
 * The decorations being shown at a moment, in painting order.
 *
 * The contract says a decoration with no end "is shown for a default duration decided by
 * the reader". One second is the duration the Editor shows one for, so an author who
 * dropped a caption in without deciding how long it lingers sees the same thing here as
 * they saw while placing it. Nothing is written back: the document still has no end.
 */
export const DEFAULT_DECORATION_DURATION_SEC = 1;

export function visibleDecorations(decorations, chartTimeSec, defaultDurationSec = DEFAULT_DECORATION_DURATION_SEC) {
  const shown = [];
  for (const decoration of decorations) {
    const start = decoration.startTimeSec;
    if (typeof start !== "number" || !Number.isFinite(start)) continue;
    const end =
      typeof decoration.endTimeSec === "number" && decoration.endTimeSec > start
        ? decoration.endTimeSec
        : start + defaultDurationSec;
    if (chartTimeSec >= start && chartTimeSec <= end) shown.push({ decoration, startSec: start, endSec: end });
  }
  shown.sort((a, b) => (a.decoration.zIndex ?? 0) - (b.decoration.zIndex ?? 0));
  return shown;
}
