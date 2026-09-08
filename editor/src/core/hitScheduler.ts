/**
 * Which moments of the chart playback has just passed.
 *
 * Pure, and driven by the audio element's own clock rather than a wall clock. That is
 * the whole point: at 0.75x speed a second of wall time is 0.75 s of chart time, so
 * anything counting frames or milliseconds would drift away from the notes it is meant
 * to be announcing. Chart time is the only time here.
 *
 * The rule is a half-open interval, `previous < timeSec <= current`, rather than "is the
 * playhead near a moment". A dropped frame can advance the clock by a third of a second,
 * and a test for nearness would silently swallow everything in the gap; an interval
 * catches all of them, and catches each exactly once.
 *
 * What it iterates is **hit points, not notes**, and that distinction is the whole
 * correctness of the module. A note is not one moment: a slide is judged at every point
 * along it, and a note that finishes with a flick is judged again at its end. Scheduling
 * from `note.timeSec` alone announced a connected slide once, at its first point, and
 * said nothing at any of the others - because joining slide points *merges* them into one
 * note whose middle points become `waypoints`. Fixing that by teaching the loop about
 * slides would have left the same hole open for the next kind with more than one moment;
 * flattening notes into points closes it for all of them.
 */

import { slidePoints, type ChartNote } from "./chart";

/**
 * How far the clock may jump before it is a seek rather than playback.
 *
 * A frame at 60 Hz advances about 17 ms; a bad hitch might be a few hundred. Jumping a
 * whole second means someone moved the playhead, and firing everything in between would
 * be a burst of noise rather than feedback. Backwards is always a seek.
 */
export const SEEK_THRESHOLD_SEC = 1.0;

/**
 * Which sound a moment should make.
 *
 * The voices themselves live in the sound engine, so giving one a genuinely different
 * character is a change there and nowhere else.
 */
export type HitVoice = "tap" | "flick" | "holdStart";

/**
 * One moment of one note: a thing the player is asked to do at an instant.
 *
 * `id` identifies the *point*, not the note, so several moments of one slide are distinct
 * things that each fire once - and so anything that wants to deduplicate has an identity
 * to use that is not the timestamp. Two different notes may legitimately share a
 * timestamp, and both must be heard.
 */
export interface HitPoint {
  /** `${note.id}#${index}`. Unique across the chart. */
  readonly id: string;
  readonly timeSec: number;
  readonly voice: HitVoice;
  /** Which moment of the note this is, from zero. */
  readonly index: number;
  /** The note it belongs to, so a caller can say what was heard. */
  readonly note: ChartNote;
}

/**
 * Which sound a note's *first* moment should make.
 *
 * Decided by shape first - an end time makes it a hold start, a direction makes it a
 * flick - and only then by name, so a kind this Editor has never heard of still gets a
 * click rather than silence.
 */
export function voiceForNote(note: ChartNote): HitVoice {
  if (note.endTimeSec !== undefined && note.endTimeSec > note.timeSec) return "holdStart";
  if (note.direction !== undefined) return "flick";
  // Nothing consults a type name any more. Shape decides, so a kind this Editor has
  // never heard of - including the retired `purple` - gets the ordinary click rather
  // than silence.
  return "tap";
}

/**
 * Whether a note's end is a moment the player is judged at.
 *
 * Read from the fields rather than the type name, exactly as `voiceForNote` is. Two
 * things make an end a judgement:
 *
 *   it ends somewhere else  (`endLane`)   - the note travelled, so its last point is the
 *                                           end of a slide and is judged like any other
 *                                           point along it;
 *   it ends in an action    (`endAction`) - a flick, or whatever a later contract adds,
 *                                           which is by definition something to do.
 *
 * A plain Long has neither: its end is an ordinary release. Releasing is not a hit, and
 * announcing one would put a sound in the chart the player is not asked to make.
 */
export function endIsJudged(note: ChartNote): boolean {
  if (note.endTimeSec === undefined || note.endTimeSec <= note.timeSec) return false;
  return note.endLane !== undefined || note.endAction !== undefined;
}

/** The voice for a note's last moment, when that moment is judged at all. */
function endVoice(note: ChartNote): HitVoice {
  return note.endAction?.type === "flick" ? "flick" : "tap";
}

/**
 * Every moment of one note, in order.
 *
 * Built from `slidePoints`, which is the one place that knows how `timeSec`, `waypoints`
 * and `endTimeSec` fit together - so this cannot drift from what the renderer draws or
 * what the hit test finds.
 */
export function hitPointsOf(note: ChartNote): readonly HitPoint[] {
  const points = slidePoints(note);
  const hasEnd = note.endTimeSec !== undefined && note.endTimeSec > note.timeSec;
  const lastIndex = points.length - 1;

  const out: HitPoint[] = [];
  points.forEach((point, index) => {
    // The last point is the end, and an end is only announced when it is judged.
    if (hasEnd && index === lastIndex && !endIsJudged(note)) return;
    if (!Number.isFinite(point.timeSec)) return;
    const voice =
      index === 0
        ? voiceForNote(note)
        : hasEnd && index === lastIndex
          ? endVoice(note)
          : // A waypoint: a checkpoint the player must have reached. An ordinary click,
            // because it is neither the press that began the note nor its finish.
            "tap";
    out.push({ id: `${note.id}#${index}`, timeSec: point.timeSec, voice, index, note });
  });
  return out;
}

/**
 * Every moment of a whole chart, in the order they happen.
 *
 * Sorted here rather than assumed: a slide's points ascend within one note, and notes
 * ascend by their starts, but a long slide's later points can fall after the start of a
 * note that comes after it in the document. The scheduler walks this list and stops at
 * the first entry past the current time, so it has to be in time order to stop correctly.
 *
 * Ties are broken by point id, so the order two simultaneous moments are announced in is
 * stable rather than an accident of the document.
 */
export function buildHitPoints(notes: readonly ChartNote[]): readonly HitPoint[] {
  const points = notes.flatMap((note) => hitPointsOf(note));
  return points.sort((a, b) => {
    if (a.timeSec !== b.timeSec) return a.timeSec - b.timeSec;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface SchedulerState {
  /** Chart time already announced, or null before playback has a position. */
  readonly lastTimeSec: number | null;
}

export const INITIAL_SCHEDULER: SchedulerState = { lastTimeSec: null };

export interface SchedulerStep {
  readonly state: SchedulerState;
  /** Points crossed by this step, in the order they occur. */
  readonly fired: readonly HitPoint[];
  /** True when the jump was treated as a seek and nothing was announced. */
  readonly seeked: boolean;
}

/**
 * Advance the scheduler to `currentSec` and report the moments crossed on the way.
 *
 * Points are expected in ascending `timeSec`, which `buildHitPoints` guarantees. Several
 * points sharing a timestamp all fire: that is a chord, or a slide point landing on a
 * tap, and hearing only one of them would misreport the chart. Nothing here deduplicates
 * by time - two moments at one instant are two moments.
 */
export function advanceScheduler(
  state: SchedulerState,
  currentSec: number,
  points: readonly HitPoint[],
): SchedulerStep {
  const previous = state.lastTimeSec;

  // Nothing to compare against yet: adopt the position without announcing anything, so
  // starting playback in the middle of a song does not replay everything before it.
  if (previous === null) {
    return { state: { lastTimeSec: currentSec }, fired: [], seeked: false };
  }

  const delta = currentSec - previous;
  if (delta < 0 || delta > SEEK_THRESHOLD_SEC) {
    // A seek in either direction. The cursor moves to the new position and the moments
    // that were skipped over stay silent.
    return { state: { lastTimeSec: currentSec }, fired: [], seeked: true };
  }
  if (delta === 0) {
    return { state, fired: [], seeked: false };
  }

  const fired: HitPoint[] = [];
  for (const point of points) {
    if (point.timeSec > currentSec) break;
    if (point.timeSec > previous) fired.push(point);
  }

  return { state: { lastTimeSec: currentSec }, fired, seeked: false };
}

/**
 * Put the cursor at a position without announcing anything.
 *
 * Used when playback starts or resumes: a moment before the resume point has already
 * happened, and one just after it should still be heard normally.
 */
export function resetSchedulerTo(currentSec: number): SchedulerState {
  return { lastTimeSec: currentSec };
}

/** Forget the position entirely, so the next step adopts wherever playback is. */
export function idleScheduler(): SchedulerState {
  return INITIAL_SCHEDULER;
}
