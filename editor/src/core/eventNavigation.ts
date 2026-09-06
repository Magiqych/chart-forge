/**
 * Stepping through Analysis Events from the keyboard.
 *
 * The overlay is guide material, and the reason it is on screen is to be *read* against
 * the audio. Clicking each onset in turn to inspect it is the slow way to do that; up and
 * down walk the same list, moving the playhead to each event and selecting it so the
 * inspector follows.
 *
 * Chart Notes are deliberately not candidates. An Analysis Event is an observation about
 * the recording and a Chart Note is something the author wrote, and this is navigation
 * through the former. Mixing them would be exactly the conflation the whole project is
 * built to avoid - and it would also make the feature useless, since the notes are what
 * the author is placing while they read.
 */

import type { LaneId, ProjectedEvent } from "./analysis";

/**
 * Events an author could actually be looking at, in a stable order.
 *
 * Only lanes that are switched on: a hidden layer is not on screen, so jumping to one of
 * its events would move the playhead somewhere for no visible reason. Turning Bass off
 * therefore also stops the keyboard visiting bass events, which is the point - it turns
 * the overlay into a filter for reading.
 *
 * Sorted by `(startSec, lane, id)`. Time alone is not enough: several detectors can fire
 * on the same instant, and without the tie-break the order would depend on how the
 * projection happened to be built and the same key press could do different things on
 * different runs.
 */
export function navigableEvents(
  events: readonly ProjectedEvent[],
  visibleLanes: ReadonlySet<LaneId>,
): readonly ProjectedEvent[] {
  const usable = events.filter(
    (event) => event.lane !== null && visibleLanes.has(event.lane),
  );
  return [...usable].sort((a, b) => {
    if (a.startSec !== b.startSec) return a.startSec - b.startSec;
    const lane = (a.lane ?? "").localeCompare(b.lane ?? "");
    if (lane !== 0) return lane;
    return a.id.localeCompare(b.id);
  });
}

/**
 * How close two times have to be to count as the same instant.
 *
 * Without it, stepping forward from an event would find that event again - its own
 * `startSec` is not strictly greater than itself only in exact arithmetic, and floating
 * point makes "strictly after" unreliable on values that came from the same source.
 * A millisecond is far below anything audible and far above the error.
 */
export const EVENT_EPSILON_SEC = 0.001;

/**
 * The next or previous event, or null when there is none in that direction.
 *
 * `referenceSec` is where the author currently is: the selected event's start if one is
 * selected, otherwise the playhead. Using the selection when there is one is what makes
 * repeated presses walk the list one event at a time instead of sticking wherever the
 * playhead happened to round to.
 */
export function eventStep(
  events: readonly ProjectedEvent[],
  referenceSec: number,
  direction: -1 | 1,
): ProjectedEvent | null {
  if (direction === 1) {
    for (const event of events) {
      if (event.startSec > referenceSec + EVENT_EPSILON_SEC) return event;
    }
    return null;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as ProjectedEvent;
    if (event.startSec < referenceSec - EVENT_EPSILON_SEC) return event;
  }
  return null;
}

/**
 * Where the next step should be measured from.
 *
 * The selected event when there is one, so a run of presses walks the list; the playhead
 * otherwise, so the first press goes to whatever is next from where the author is
 * listening.
 */
export function navigationReferenceSec(
  selected: ProjectedEvent | null,
  playheadSec: number,
): number {
  return selected ? selected.startSec : playheadSec;
}
