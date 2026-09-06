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
 * crosses a bar in a reasonable time. Chosen by using it: below about ten pixels the
 * playhead barely appears to move, and above about thirty a press overshoots the detail
 * an author zoomed in to look at.
 */
export const KEYBOARD_STEP_PX = 16;

/** How much further a coarse step goes. Shift is "same idea, bigger". */
export const COARSE_STEP_MULTIPLIER = 5;

/**
 * Clamps on the converted step.
 *
 * At the maximum zoom of 2000 px/s, sixteen pixels is 8 ms - finer than anything an author
 * can hear, and slow enough to be useless for getting anywhere. At the minimum of 5 px/s
 * it is 3.2 s, which skips whole phrases. The clamps bound the conversion rather than
 * replacing it: between roughly 30 and 800 px/s, where authoring actually happens, the
 * step is purely the screen distance.
 */
export const MIN_STEP_SEC = 0.01;
export const MAX_STEP_SEC = 2;

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
