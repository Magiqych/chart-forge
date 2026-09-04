/**
 * Beat-grid snapping.
 *
 * The snap grid is built by subdividing the *detected* beats, never by generating a
 * uniform grid from a tempo number. The Analyzer emits `beats[]` and no tempo map; a
 * real performance drifts, so consecutive beat intervals differ, and a grid drawn from
 * an average bpm would agree with the audio at the start of a song and be audibly wrong
 * by the end. Interpolating inside each real interval keeps every subdivision tied to
 * the beats either side of it.
 *
 * Analysis Events are a snap target only when the author explicitly asks for it, in a
 * mode of their own. An onset is an observation about the recording, not a beat, so
 * having it silently attract notes alongside the grid would quietly turn the Analyzer
 * into the author. Choosing the mode is the author saying which of the two they mean.
 */

/**
 * What the timeline snaps a raw click to.
 *
 * `beat` and `event` are different questions, not two strengths of the same one: a beat
 * is where the music is counted, an onset is where a sound actually started. Mixing them
 * into one "snap harder" control would hide which of the two a note was aligned to, so
 * the modes are exclusive.
 *
 * Only `off` and `beat` survive a reload. The Project contract's `editor.snap` object is
 * closed - `{enabled, division}` and nothing else - so there is nowhere to record a third
 * mode without extending it, and `event` is experimental enough not to justify that. It
 * reads back as `off`.
 */
export type SnapMode = "off" | "beat" | "event";

/** `project.editor.snap`, as the Project contract defines it. */
export interface SnapSettings {
  readonly enabled: boolean;
  /** Subdivisions per beat: 1 snaps to the beats themselves, 4 to sixteenths in 4/4. */
  readonly division: number;
}

export const DEFAULT_SNAP: SnapSettings = { enabled: true, division: 1 };

/** How close a click must be to an event start for event snapping to take it. */
export const EVENT_SNAP_THRESHOLD_PX = 10;

/** Divisions the toolbar offers. 1 is the detected beat itself. */
export const SNAP_DIVISIONS = [1, 2, 3, 4, 6, 8] as const;

/**
 * Candidate times for a division of the detected beats.
 *
 * Each interval between two consecutive beats is split into `division` equal parts, so
 * an interval that ran long produces proportionally longer subdivisions. The last beat
 * is included as the final candidate; nothing is extrapolated past it, because there is
 * no evidence about where the next beat would have fallen.
 */
export function buildSnapGrid(
  beats: readonly { readonly timeSec: number }[],
  division: number,
): readonly number[] {
  if (beats.length === 0) return [];
  const steps = Math.max(1, Math.floor(division));
  if (beats.length === 1) return [beats[0]!.timeSec];

  const grid: number[] = [];
  for (let i = 0; i < beats.length - 1; i += 1) {
    const from = beats[i]!.timeSec;
    const to = beats[i + 1]!.timeSec;
    for (let step = 0; step < steps; step += 1) {
      grid.push(from + ((to - from) * step) / steps);
    }
  }
  grid.push(beats[beats.length - 1]!.timeSec);
  return grid;
}

/**
 * Snap a raw time to the nearest grid candidate.
 *
 * Outside the range the beats cover, the nearest end of the grid is returned rather than
 * the raw time: the alternative is a note that looks snapped but is not. Ties go to the
 * earlier candidate, so the result is deterministic.
 */
export function snapTime(
  rawSec: number,
  grid: readonly number[],
  settings: SnapSettings,
): number {
  if (!settings.enabled || grid.length === 0) return rawSec;
  if (rawSec <= grid[0]!) return grid[0]!;
  const last = grid[grid.length - 1]!;
  if (rawSec >= last) return last;

  // Binary search for the first candidate at or after rawSec, then compare neighbours.
  let low = 0;
  let high = grid.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (grid[mid]! < rawSec) low = mid + 1;
    else high = mid;
  }
  const after = grid[low]!;
  const before = grid[low - 1]!;
  return rawSec - before <= after - rawSec ? before : after;
}

/** Read `project.editor.snap`, falling back to the default when it is absent or partial. */
export function readSnapSettings(editor: unknown): SnapSettings {
  if (typeof editor !== "object" || editor === null) return DEFAULT_SNAP;
  const snap = (editor as Record<string, unknown>)["snap"];
  if (typeof snap !== "object" || snap === null) return DEFAULT_SNAP;
  const raw = snap as Record<string, unknown>;
  const division = raw["division"];
  return {
    enabled: typeof raw["enabled"] === "boolean" ? raw["enabled"] : DEFAULT_SNAP.enabled,
    division:
      typeof division === "number" && Number.isInteger(division) && division >= 1
        ? division
        : DEFAULT_SNAP.division,
  };
}


/**
 * Snap to the nearest Analysis Event start, within a screen-distance threshold.
 *
 * The threshold is in pixels, not seconds, so it means the same thing to the hand at
 * every zoom level: zoomed out, "near" covers a wide slice of time and snapping is
 * coarse; zoomed in, it narrows until the author can place a note between two onsets.
 * A time-based threshold would do the opposite of what the eye expects.
 *
 * Only `startSec` is a target. A bounded event's `endSec` is where a measured sound
 * stopped, which is not a moment a player is asked to hit.
 *
 * Returns the raw time unchanged when nothing is close enough: nothing is ever dragged
 * across the screen to an event the author was not aiming at.
 */
export function snapToNearestEventStart(
  rawSec: number,
  events: readonly { readonly startSec: number }[],
  pixelsPerSecond: number,
  thresholdPx: number = EVENT_SNAP_THRESHOLD_PX,
): number {
  if (events.length === 0 || pixelsPerSecond <= 0) return rawSec;
  const thresholdSec = thresholdPx / pixelsPerSecond;

  let bestSec = rawSec;
  let bestDistance = thresholdSec;
  for (const event of events) {
    const distance = Math.abs(event.startSec - rawSec);
    // Strictly nearer, so the earliest of several equidistant events wins and the
    // result does not depend on the order they happen to be scanned in.
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSec = event.startSec;
    }
  }
  return bestSec;
}
