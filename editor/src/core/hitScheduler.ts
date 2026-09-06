/**
 * Which notes playback has just passed.
 *
 * Pure, and driven by the audio element's own clock rather than a wall clock. That is
 * the whole point: at 0.75x speed a second of wall time is 0.75 s of chart time, so
 * anything counting frames or milliseconds would drift away from the notes it is meant
 * to be announcing. Chart time is the only time here.
 *
 * The rule is a half-open interval, `previous < timeSec <= current`, rather than "is the
 * playhead near a note". A dropped frame can advance the clock by a third of a second,
 * and a test for nearness would silently swallow every note in the gap; an interval
 * catches all of them, and catches each exactly once.
 */

import type { ChartNote } from "./chart";

/**
 * How far the clock may jump before it is a seek rather than playback.
 *
 * A frame at 60 Hz advances about 17 ms; a bad hitch might be a few hundred. Jumping a
 * whole second means someone moved the playhead, and firing everything in between would
 * be a burst of noise rather than feedback. Backwards is always a seek.
 */
export const SEEK_THRESHOLD_SEC = 1.0;

export interface SchedulerState {
  /** Chart time already announced, or null before playback has a position. */
  readonly lastTimeSec: number | null;
}

export const INITIAL_SCHEDULER: SchedulerState = { lastTimeSec: null };

export interface SchedulerStep {
  readonly state: SchedulerState;
  /** Notes crossed by this step, in the order they occur. */
  readonly fired: readonly ChartNote[];
  /** True when the jump was treated as a seek and nothing was announced. */
  readonly seeked: boolean;
}

/**
 * Advance the scheduler to `currentSec` and report the notes crossed on the way.
 *
 * Notes are expected in ascending `timeSec`, which the chart model already guarantees.
 * Several notes sharing a timestamp all fire: that is a chord, and hearing only one of
 * its lanes would misreport the chart.
 */
export function advanceScheduler(
  state: SchedulerState,
  currentSec: number,
  notes: readonly ChartNote[],
): SchedulerStep {
  const previous = state.lastTimeSec;

  // Nothing to compare against yet: adopt the position without announcing anything, so
  // starting playback in the middle of a song does not replay everything before it.
  if (previous === null) {
    return { state: { lastTimeSec: currentSec }, fired: [], seeked: false };
  }

  const delta = currentSec - previous;
  if (delta < 0 || delta > SEEK_THRESHOLD_SEC) {
    // A seek in either direction. The cursor moves to the new position and the notes
    // that were skipped over stay silent.
    return { state: { lastTimeSec: currentSec }, fired: [], seeked: true };
  }
  if (delta === 0) {
    return { state, fired: [], seeked: false };
  }

  const fired: ChartNote[] = [];
  for (const note of notes) {
    if (note.timeSec > currentSec) break;
    if (note.timeSec > previous) fired.push(note);
  }

  return { state: { lastTimeSec: currentSec }, fired, seeked: false };
}

/**
 * Put the cursor at a position without announcing anything.
 *
 * Used when playback starts or resumes: a note before the resume point has already
 * happened, and a note just after it should still be heard normally.
 */
export function resetSchedulerTo(currentSec: number): SchedulerState {
  return { lastTimeSec: currentSec };
}

/** Forget the position entirely, so the next step adopts wherever playback is. */
export function idleScheduler(): SchedulerState {
  return INITIAL_SCHEDULER;
}

/**
 * Which sound a note should make.
 *
 * Decided by shape first - an end time makes it a hold start, a direction makes it a
 * flick - and only then by name, so a kind this Editor has never heard of still gets a
 * click rather than silence. The voices themselves live in the sound engine, so giving
 * one a genuinely different character is a change there and nowhere else.
 */
export type HitVoice = "tap" | "flick" | "holdStart";

export function voiceForNote(note: ChartNote): HitVoice {
  if (note.endTimeSec !== undefined && note.endTimeSec > note.timeSec) return "holdStart";
  if (note.direction !== undefined) return "flick";
  // Nothing consults a type name any more. Shape decides, so a kind this Editor has
  // never heard of - including the retired `purple` - gets the ordinary click rather
  // than silence.
  return "tap";
}
