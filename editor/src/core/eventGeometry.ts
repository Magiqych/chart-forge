/**
 * Where an Analysis Event sits on screen, and which one a click landed on.
 *
 * The renderer and the hit test read their geometry from the same functions here. If
 * they each worked it out for themselves they would drift, and a click would select an
 * event other than the one under the pointer - the kind of bug that is invisible in a
 * screenshot and maddening in use.
 *
 * Nothing here mutates an event or an Analysis document. Selecting an event is a
 * question asked of the overlay, never a change to it.
 */

import { LANE_IDS, byLane, type LaneId, type ProjectedEvent } from "./analysis";
import { pitchRange, pitchToY } from "./lanes";
import { timeToX, type Viewport } from "./viewport";

/** Vertical inset of an instantaneous tick inside its lane row, in CSS pixels. */
export const TICK_INSET_PX = 8;
/** Height of a bounded event's span, in CSS pixels. */
export const SPAN_HEIGHT_PX = 5;
/** Minimum drawn width of a bounded span, so a very short one stays visible. */
export const MIN_SPAN_WIDTH_PX = 2;

export interface PitchRange {
  readonly minMidi: number;
  readonly maxMidi: number;
}

export type PitchRanges = Readonly<Record<LaneId, PitchRange>>;

/**
 * Per-lane pitch scales.
 *
 * Bass and vocals occupy very different registers - in the real document bass sits
 * around MIDI 31-60 and vocals around 55-84 - so a shared scale would flatten both into
 * unreadable bands. Computed once per projection and handed to everything that needs it.
 */
export function pitchRangesFor(projection: {
  readonly eventsByLane: Readonly<Record<LaneId, readonly ProjectedEvent[]>>;
}): PitchRanges {
  return byLane((lane) => pitchRange(projection.eventsByLane[lane]));
}

/**
 * The shortest a tick may be drawn, as a fraction of its lane's height.
 *
 * An event the Analyzer chose to emit is one the author may want to snap to, so it has to
 * be visible and clickable. A mark too short to see would be a filter pretending to be a
 * drawing.
 */
export const MIN_TICK_FRACTION = 0.35;

/**
 * How much of a lane's height an instantaneous tick takes, from its confidence.
 *
 * A guitar stem yields around eight events a second, and drawn at one uniform height that
 * is a picket fence: every attack looks alike, and the strong beats an author is charting
 * to are lost among the passing ones. Scaling the tick turns the same data into a shape
 * that can be read at a glance.
 *
 * An event with **no** confidence is drawn full height, because "unknown" is not "weak" -
 * the Analysis contract is explicit that absent means unknown, and shrinking those would
 * be the renderer inventing a claim the document never made. That is also why the lanes
 * that carry no confidence look exactly as they always did.
 */
export function tickFraction(confidence: number | undefined): number {
  if (confidence === undefined || !Number.isFinite(confidence)) return 1;
  const clamped = confidence < 0 ? 0 : confidence > 1 ? 1 : confidence;
  return MIN_TICK_FRACTION + (1 - MIN_TICK_FRACTION) * clamped;
}

export interface RowBox {
  readonly topPx: number;
  readonly heightPx: number;
}

/**
 * The screen box an event occupies.
 *
 * An instantaneous tick is a zero-width box: `leftPx === rightPx`. That is not a
 * degenerate case to guard against, it is what a tick is, and the distance function
 * below handles it without a special branch.
 */
export interface EventBox {
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
}

/**
 * Where an event is drawn, chosen by `endKind` and never by whether `endSec` happens to
 * be present. A future `unknown` gets the tick's box: its start is measured, its end is
 * not, so only the start is a thing worth clicking.
 */
export function eventBox(
  event: ProjectedEvent,
  row: RowBox,
  view: Viewport,
  range: PitchRange,
): EventBox {
  const x = timeToX(event.startSec, view);

  if (event.endKind === "bounded") {
    const endX = timeToX(event.endSec ?? event.startSec, view);
    const y = event.pitch
      ? pitchToY(event.pitch.midi, row, range)
      : row.topPx + row.heightPx / 2;
    return {
      leftPx: x,
      rightPx: Math.max(x + MIN_SPAN_WIDTH_PX, endX),
      topPx: y - SPAN_HEIGHT_PX / 2,
      bottomPx: y + SPAN_HEIGHT_PX / 2,
    };
  }

  return {
    leftPx: x,
    rightPx: x,
    topPx: row.topPx + TICK_INSET_PX,
    bottomPx: row.topPx + row.heightPx - TICK_INSET_PX,
  };
}

/** Distance from a point to the nearest part of a box; zero when the point is inside. */
export function distanceToBox(x: number, y: number, box: EventBox): number {
  const dx = Math.max(box.leftPx - x, 0, x - box.rightPx);
  const dy = Math.max(box.topPx - y, 0, y - box.bottomPx);
  return Math.hypot(dx, dy);
}

/**
 * One lane's worth of clickable events.
 *
 * The caller passes the events it actually drew - the visible slice for this lane - so
 * the hit test reuses the range index the renderer already built rather than scanning
 * the whole document. A lane whose layer is hidden simply is not among the targets,
 * which is what makes an invisible event unselectable rather than a special case here.
 */
export interface LaneHitTarget {
  readonly lane: LaneId;
  readonly row: RowBox;
  readonly range: PitchRange;
  readonly events: readonly ProjectedEvent[];
}

/**
 * Draw order, back to front, matching the renderer.
 *
 * Used only to break a tie: when two events are the same distance from the pointer, the
 * one drawn on top is the one the author can see, so it is the one they meant.
 */
export const LANE_DRAW_ORDER: readonly LaneId[] = LANE_IDS;

function zOrderOf(lane: LaneId): number {
  const index = LANE_DRAW_ORDER.indexOf(lane);
  return index < 0 ? -1 : index;
}

export interface AnalysisHit {
  readonly event: ProjectedEvent;
  readonly lane: LaneId;
  readonly distancePx: number;
}

/** How far from an event a click still counts as hitting it, in CSS pixels. */
export const HIT_TOLERANCE_PX = 6;

/**
 * The Analysis Event under a pointer, or null.
 *
 * When several events are in range the winner is decided in a fixed order, so the same
 * click always selects the same event:
 *
 *   1. distance to the pointer - the nearest thing is what was aimed at;
 *   2. draw order - among equals, the one visibly on top;
 *   3. `startSec` - earlier first;
 *   4. event id - the Analysis contract's own total order, so nothing is left to chance.
 *
 * There is no random or insertion-order fallback: every comparison ends in a decision.
 */
export function hitTestAnalysisEvent(
  x: number,
  y: number,
  view: Viewport,
  targets: readonly LaneHitTarget[],
  tolerancePx: number = HIT_TOLERANCE_PX,
): AnalysisHit | null {
  let best: AnalysisHit | null = null;
  let bestZ = -1;

  for (const target of targets) {
    const z = zOrderOf(target.lane);
    for (const event of target.events) {
      const box = eventBox(event, target.row, view, target.range);
      const distance = distanceToBox(x, y, box);
      if (distance > tolerancePx) continue;

      if (best === null || beats(distance, z, event, best.distancePx, bestZ, best.event)) {
        best = { event, lane: target.lane, distancePx: distance };
        bestZ = z;
      }
    }
  }
  return best;
}

/** Whether the first candidate wins the tie-break against the second. */
function beats(
  distance: number,
  z: number,
  event: ProjectedEvent,
  bestDistance: number,
  bestZ: number,
  bestEvent: ProjectedEvent,
): boolean {
  if (distance !== bestDistance) return distance < bestDistance;
  if (z !== bestZ) return z > bestZ;
  if (event.startSec !== bestEvent.startSec) return event.startSec < bestEvent.startSec;
  return event.id < bestEvent.id;
}
