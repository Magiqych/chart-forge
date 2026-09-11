/**
 * Where a note is on screen at a given moment.
 *
 * Every position here is a function of chart time and nothing else. Nothing is
 * integrated frame by frame, so a dropped frame moves a note to where it should be
 * rather than leaving it behind, and two machines running at different frame rates draw
 * the same chart identically. `positionOf(t)` is the whole model.
 *
 * Pure arithmetic, no canvas: the renderer asks this module where things are, and the
 * tests ask it the same questions without a browser.
 */

/**
 * How long a note is on screen before it reaches the judgement line, at speed 1.
 *
 * Around a beat and a half of a fast song. Faster speeds shorten it, which is what a
 * note-speed control does in every game of this kind: the note does not move faster
 * along the same path, it appears later and has less distance to cover.
 */
export const BASE_TRAVEL_SEC = 1.6;

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 4;

/**
 * Strength of the perspective.
 *
 * The playfield is a trapezoid: lanes converge towards the back, so a note starts small
 * near the horizon and grows as it comes. 0 would be a flat column layout.
 */
export const DEPTH = 1.6;

/** How far past the judgement line a note keeps being drawn, in depth units. */
const MAX_OVERSHOOT = 0.35;

export function travelSecFor(speed) {
  const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  return BASE_TRAVEL_SEC / clamped;
}

/**
 * How far along its journey a moment is: 0 as it appears, 1 at the judgement line.
 *
 * Values above 1 are moments already past, which the renderer still draws briefly.
 */
export function progressOf(timeSec, chartTimeSec, travelSec) {
  if (!(travelSec > 0)) return 1;
  return 1 - (timeSec - chartTimeSec) / travelSec;
}

/**
 * The perspective projection, as a pure function of progress.
 *
 * A simple 1/z: depth `d` runs 1 at the back of the playfield to 0 at the judgement
 * line, the scale is `1/(1 + DEPTH*d)`, and the vertical position is that scale
 * normalised so the two ends land exactly on the top and the judgement line. The result
 * is that notes bunch towards the horizon and spread as they arrive, the way a lane
 * drawn in perspective has to.
 */
export function project(progress) {
  const depth = Math.max(-MAX_OVERSHOOT, 1 - progress);
  const scale = 1 / (1 + DEPTH * depth);
  const farScale = 1 / (1 + DEPTH);
  return { scale, yNorm: (1 - scale) / (1 - farScale) };
}

/**
 * The fixed geometry of the playfield for a given canvas size.
 *
 * `judgeY` sits above the bottom edge so that hit effects and the judgement text have
 * somewhere to be, and the playfield's top is the horizon the notes come from.
 */
export function playfieldGeometry(width, height, laneCount) {
  const judgeY = height * 0.82;
  const topY = height * 0.12;
  const nearWidth = Math.min(width * 0.96, height * 1.25);
  return {
    width,
    height,
    laneCount: Math.max(1, laneCount),
    centreX: width / 2,
    judgeY,
    topY,
    nearWidth,
    laneWidth: nearWidth / Math.max(1, laneCount),
  };
}

/** The x of a lane's centre at the judgement line, where the perspective scale is 1. */
export function laneCentreX(geometry, lane) {
  const left = geometry.centreX - geometry.nearWidth / 2;
  return left + (lane + 0.5) * geometry.laneWidth;
}

/** Where a moment in a lane is drawn, at a progress from `progressOf`. */
export function positionOf(geometry, lane, progress) {
  const { scale, yNorm } = project(progress);
  const nearX = laneCentreX(geometry, lane);
  return {
    x: geometry.centreX + (nearX - geometry.centreX) * scale,
    y: geometry.judgeY - yNorm * (geometry.judgeY - geometry.topY),
    scale,
  };
}

/** Where a point *between* two lanes is drawn - the body of a slide between waypoints. */
export function positionBetween(geometry, laneA, laneB, mix, progress) {
  const lane = laneA + (laneB - laneA) * mix;
  return positionOf(geometry, lane, progress);
}

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
