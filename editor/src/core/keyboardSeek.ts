/**
 * How far an arrow key moves the playhead.
 *
 * A fixed number of seconds is the wrong unit for this. At the zoom where a bar fills the
 * screen, one second is a nudge; at the zoom where a single note fills it, one second is
 * off the edge. What an author actually wants is for the playhead to step by roughly the
 * same *visible* distance each press, whatever the zoom - a frame-advance rather than a
 * fixed jump.
 *
 * So the step is a distance on screen converted through `pixelsPerSecond`, which is the
 * same conversion the whole timeline is built on.
 */

import { type Viewport } from "./viewport";

/**
 * How far the playhead moves on screen per press, in CSS pixels.
 *
 * Small enough to place a note against a waveform edge, large enough that holding the key
 * crosses a bar in a reasonable time.
 *
 * Halved from the sixteen pixels this started at. Sixteen was chosen from how far the
 * playhead *appeared* to move, and it is a comfortable amount of travel - but the arrow
 * keys are not primarily how an author travels, they are how an author lands, and at
 * sixteen pixels a press was repeatedly stepping over the moment being aimed at rather
 * than onto it. Eight still reads as a movement on screen and takes the playhead close
 * enough to place a note by ear. Shift is still there for covering ground.
 */
export const KEYBOARD_STEP_PX = 8;

/** How much further a coarse step goes. Shift is "same idea, bigger". */
export const COARSE_STEP_MULTIPLIER = 5;

/**
 * Clamps on the converted step.
 *
 * At the maximum zoom of 2000 px/s, eight pixels is 4 ms - finer than anything an author
 * can hear, and slow enough to be useless for getting anywhere. At the minimum of 5 px/s
 * it is 1.6 s, which skips whole phrases. The clamps bound the conversion rather than
 * replacing it: between roughly 8 and 1600 px/s, where authoring actually happens, the
 * step is purely the screen distance.
 *
 * Halved along with the screen distance, and deliberately so. Had they been left where
 * they were, a press at the extremes of the zoom range would have kept its old size while
 * every press in between halved, and the key would have changed its mind about how far it
 * goes depending on how far the author had zoomed. The rule is one rule: every press,
 * everywhere, moves half what it used to.
 */
export const MIN_STEP_SEC = 0.005;
export const MAX_STEP_SEC = 1;

/**
 * The step for one arrow press, in seconds.
 *
 * Always positive; the direction is the caller's business.
 */
export function keyboardSeekStepSec(pixelsPerSecond: number, coarse = false): number {
  const scale = coarse ? COARSE_STEP_MULTIPLIER : 1;
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) {
    return MIN_STEP_SEC * scale;
  }
  const fromScreen = KEYBOARD_STEP_PX / pixelsPerSecond;
  const clamped = Math.min(MAX_STEP_SEC, Math.max(MIN_STEP_SEC, fromScreen));
  return clamped * scale;
}

/**
 * Where an arrow press should put the playhead.
 *
 * Clamped to the recording: a press at the very start or the very end moves as far as it
 * can and no further, rather than seeking to a time the audio does not have.
 */
export function keyboardSeekTarget(
  view: Viewport,
  playheadSec: number,
  direction: -1 | 1,
  durationSec: number,
  coarse = false,
): number {
  const step = keyboardSeekStepSec(view.pixelsPerSecond, coarse);
  const wanted = playheadSec + direction * step;
  return Math.min(Math.max(0, wanted), Math.max(0, durationSec));
}
