/**
 * Beat-grid snapping, and the resolver every placement time goes through.
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

import {
  guideRadiusSec, nearestGuideAnchor, type GuideAnchor,
} from "./guideAnchors";

/**
 * What the timeline snaps a raw click to.
 *
 * `beat` and `guide` are different questions, not two strengths of the same one: a beat
 * is where the music is counted, an onset is where a sound actually started. Mixing them
 * into one "snap harder" control would hide which of the two a note was aligned to, so
 * the modes are exclusive.
 *
 * `guide` snaps to the Analysis Events in the layers that are switched on - the same set
 * the arrow keys walk - which is what turns the overlay from something to look at into
 * something to aim at.
 *
 * Only `off` and `beat` survive a reload. The Project contract's `editor.snap` object is
 * closed - `{enabled, division}` and nothing else - so there is nowhere to record a third
 * mode without extending it. `guide` reads back as `off`.
 */
export type SnapMode = "off" | "beat" | "guide";

/** `project.editor.snap`, as the Project contract defines it. */
export interface SnapSettings {
  readonly enabled: boolean;
  /** Subdivisions per beat: 1 snaps to the beats themselves, 4 to sixteenths in 4/4. */
  readonly division: number;
}

export const DEFAULT_SNAP: SnapSettings = { enabled: true, division: 1 };

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
 * The one place a raw pointer time becomes the time a note is written at.
 *
 * Every placement goes through here - Single, Purple, Flick, a Slide point, the start and
 * the end of a Long as it is drawn, and the end of a Long as it is dragged. A kind that
 * took a different route would be a kind that snapped differently, and the author would
 * have no way to know which ones did.
 *
 * Pure, and given everything it needs, so what each mode does can be tested without a
 * canvas or a pointer.
 */
export interface PlacementSnapContext {
  readonly rawTimeSec: number;
  readonly snapMode: SnapMode;
  /** Beat-grid settings. Only consulted in `beat` mode. */
  readonly snap: SnapSettings;
  /** Subdivided detected beats. Only consulted in `beat` mode. */
  readonly grid: readonly number[];
  /** Guide anchors. Only consulted in `guide` mode. */
  readonly anchors: readonly GuideAnchor[];
  readonly pixelsPerSecond: number;
  readonly radiusPx?: number;
}

export interface PlacementSnapResult {
  /** Where the note goes. The raw time when nothing took it. */
  readonly timeSec: number;
  /**
   * The guide anchor it landed on, when it landed on one.
   *
   * Reported rather than swallowed so the caller can say what happened, and so a new
   * note can record the event it was aimed at as its `sourceEventId`.
   */
  readonly anchor: GuideAnchor | null;
}

export function resolvePlacementTime(
  context: PlacementSnapContext,
): PlacementSnapResult {
  const raw = Math.max(0, context.rawTimeSec);

  if (context.snapMode === "beat") {
    return { timeSec: Math.max(0, snapTime(raw, context.grid, context.snap)), anchor: null };
  }

  if (context.snapMode === "guide") {
    const radiusSec = guideRadiusSec(context.pixelsPerSecond, context.radiusPx);
    const anchor = nearestGuideAnchor(context.anchors, raw, radiusSec);
    // Nothing within reach means the author was not aiming at anything, so their own
    // click stands rather than being dragged somewhere they did not point.
    return anchor === null
      ? { timeSec: raw, anchor: null }
      : { timeSec: Math.max(0, anchor.timeSec), anchor };
  }

  return { timeSec: raw, anchor: null };
}
