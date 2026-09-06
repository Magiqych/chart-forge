/**
 * Times an author can snap a note to, taken from the Analysis overlay.
 *
 * The Analyzer's job is to produce guide information for a human author, and this is the
 * most direct use of it there is: when the author is placing a note at a sound they can
 * see in the overlay, the Editor should let them land on it exactly instead of near it.
 *
 * The **source is shared with keyboard navigation** on purpose. `navigableEvents` decides
 * which events are on screen and therefore reachable, and both features read that one
 * answer, so the layer checkboxes mean the same thing to both: what you can walk to with
 * the arrow keys is what you can snap to, and hiding a layer removes it from both at
 * once. Two separate filters would drift, and the author would have no way to tell which
 * one was in force.
 *
 * Chart Notes are never a source. An Analysis Event is an observation about the recording
 * and a Chart Note is something the author wrote; snapping notes to other notes is a
 * different feature with different rules, and conflating them is exactly what the project
 * is built to avoid.
 *
 * Nothing here is written to the Chart. An anchor is a time the author aimed at; what the
 * document records is the note.
 */

import type { LaneId, ProjectedEvent } from "./analysis";
import { navigableEvents } from "./eventNavigation";

/**
 * How close a click has to be to an anchor, in CSS pixels.
 *
 * A screen distance rather than a number of seconds, so it means the same thing to the
 * hand at every zoom: zoomed out, "near" covers a wide slice of time; zoomed in, it
 * narrows until the author can place a note between two onsets a few milliseconds apart.
 * A fixed number of seconds would do the opposite of what the eye expects.
 */
export const GUIDE_SNAP_RADIUS_PX = 12;

/** Which end of an event an anchor came from. */
export type GuideEdge = "start" | "end";

export interface GuideAnchor {
  readonly timeSec: number;
  readonly eventId: string;
  readonly lane: LaneId;
  readonly edge: GuideEdge;
}

export interface GuideAnchorOptions {
  /**
   * Whether a bounded event's end is a candidate as well as its start.
   *
   * Off for placing a note, because what a player is asked to hit is where a sound
   * *started*. On for dragging the end of a Long, where the moment a measured sound
   * stopped is exactly the thing being aimed at.
   */
  readonly includeEnds?: boolean;
}

/**
 * Every time the author can snap to, in ascending order.
 *
 * Built from `navigableEvents`, so the visible-layer rule and the exclusion of Chart
 * Notes are stated once and obeyed by navigation and snapping alike.
 */
export function buildGuideAnchors(
  events: readonly ProjectedEvent[],
  visibleLanes: ReadonlySet<LaneId>,
  options: GuideAnchorOptions = {},
): readonly GuideAnchor[] {
  const anchors: GuideAnchor[] = [];
  for (const event of navigableEvents(events, visibleLanes)) {
    const lane = event.lane as LaneId;
    anchors.push({ timeSec: event.startSec, eventId: event.id, lane, edge: "start" });
    if (options.includeEnds && event.endSec !== undefined && event.endSec > event.startSec) {
      anchors.push({ timeSec: event.endSec, eventId: event.id, lane, edge: "end" });
    }
  }
  // navigableEvents orders by start; adding ends can break that, so sort once here and
  // let the search below rely on it.
  return anchors.sort((a, b) => a.timeSec - b.timeSec || compareAnchors(a, b));
}

/**
 * The tie-break between two anchors at the same instant.
 *
 * `end` before `start`: when the author has dragged the end of a Long to a place where
 * one sound stops and the next begins, the end is what they were aiming at - they were
 * looking for where to let go. Then lane, then event id, so the answer never depends on
 * the order the projection happened to be built in.
 */
function compareAnchors(a: GuideAnchor, b: GuideAnchor): number {
  if (a.edge !== b.edge) return a.edge === "end" ? -1 : 1;
  const lane = a.lane.localeCompare(b.lane);
  if (lane !== 0) return lane;
  return a.eventId.localeCompare(b.eventId);
}

/** How much time the snap radius covers at this zoom. */
export function guideRadiusSec(
  pixelsPerSecond: number,
  radiusPx: number = GUIDE_SNAP_RADIUS_PX,
): number {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return 0;
  return radiusPx / pixelsPerSecond;
}

/**
 * The anchor a raw time should snap to, or null when nothing is close enough.
 *
 * Nothing is ever dragged across the screen to an event the author was not aiming at:
 * outside the radius the raw time stands. Nearest wins; ties are broken by
 * `compareAnchors`, so the same click always gives the same answer.
 */
export function nearestGuideAnchor(
  anchors: readonly GuideAnchor[],
  rawSec: number,
  radiusSec: number,
): GuideAnchor | null {
  if (anchors.length === 0 || radiusSec <= 0) return null;

  let best: GuideAnchor | null = null;
  let bestDistance = radiusSec;
  for (const anchor of anchors) {
    const distance = Math.abs(anchor.timeSec - rawSec);
    if (distance > bestDistance) continue;
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance && compareAnchors(anchor, best) < 0)
    ) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best;
}

/** A short phrase naming what was snapped to, for the status line. */
export function describeAnchor(anchor: GuideAnchor): string {
  return `${anchor.lane} ${anchor.edge} @ ${anchor.timeSec.toFixed(3)}s`;
}
