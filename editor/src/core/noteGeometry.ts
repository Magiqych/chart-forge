/**
 * Where a Chart Note sits on screen.
 *
 * One module, used by the renderer, the hit test, the placement preview, the rubber band
 * and viewport culling. If each worked its own geometry out they would drift, and a click
 * would select something other than what is under the pointer - a bug that is invisible
 * in a screenshot and maddening in use. The rule is: what is drawn and what is clickable
 * come from the same function.
 *
 * A note is described as a set of primitives rather than one box:
 *
 *   instantMarker    a moment the player must arrive at, drawn as a thin bar
 *   flickArrow       a flick, drawn as an arrow and nothing else
 *   longBody         time spent holding something down
 *   resizeHandle     the grip that changes how long that is
 *   slideConnector   a path travelled between two moments
 *
 * and which kind gets which:
 *
 *   Single, Purple   instantMarker
 *   Flick            flickArrow only - no bar at all
 *   Long             instantMarker + longBody + resizeHandle + instantMarker
 *   Slide point      instantMarker
 *   Slide connected  instantMarker + slideConnector + instantMarker
 *
 * The horizontal axis is time. A duration is converted to pixels through
 * `pixelsPerSecond`, so a Long stretches with the zoom exactly as its length deserves. A
 * marker is **not** a duration - it names one instant - so it is a thin bar of a fixed
 * readable width at every zoom, and the timeline stays a thing you read times off rather
 * than a row of boxes. The vertical axis is lanes, which is not a time scale and does not
 * zoom.
 */

import {
  endFlickDirection, slidePoints,
  type ChartConnection, type ChartNote, type ChartState,
} from "./chart";
import { laneBand, type LaneBand } from "./lanes";
import { timeToX, viewportEndSec, type Viewport } from "./viewport";

/**
 * Width of a judgement marker, in CSS pixels.
 *
 * A constant, not a converted duration. A moment has no width to scale: what the author
 * needs from it is an exact position on the time axis, and a bar that grows with the zoom
 * becomes a box whose left and right edges are both plausible readings of "when". Three
 * pixels is thin enough to read as a line and thick enough to see; the hit tolerance,
 * not the drawn width, is what makes it clickable.
 */
export const MARKER_WIDTH_PX = 3;

/** Vertical inset of a marker inside its lane band, in CSS pixels. */
export const NOTE_INSET_PX = 3;

/** Height of a held note's duration body, in CSS pixels. */
export const BOUNDED_BODY_HEIGHT_PX = 12;

/** Size of the box a flick arrow is drawn in, in CSS pixels. */
export const FLICK_ARROW_PX = 15;

/** Width of the grip at the end of a held note, in CSS pixels. */
export const RESIZE_HANDLE_PX = 9;

/**
 * How wide a held note has to be drawn before it offers a grip at its start as well.
 *
 * Three grips' worth, so there is always a middle to take hold of: with a grip at each
 * end and nothing between them the note could be stretched from either side but never
 * moved, and moving it is the more common thing to want. Below this the author zooms in,
 * which is what they would have to do to aim at a grip that small anyway.
 */
export const MIN_GRIP_BODY_PX = RESIZE_HANDLE_PX * 3;

/**
 * A note is instantaneous when it has no end time - not when its type happens to be
 * "tap".
 *
 * `chartNote.type` is an open vocabulary: a chart written elsewhere may use a name this
 * Editor has never seen. Switching geometry on the type would draw such a note wrongly
 * or not at all, whereas the presence of `endTimeSec` is a fact about the note that the
 * contract defines for every type.
 */
export function isInstantaneous(note: ChartNote): boolean {
  return note.endTimeSec === undefined || note.endTimeSec <= note.timeSec;
}

/**
 * What a note is made of.
 *
 * Decided by which fields the note carries, never by its type name, for the same reason
 * `isInstantaneous` is: the vocabulary is open.
 *
 * - `instant` - one judgement point and nothing else.
 * - `flick` - one judgement point that also names a direction, drawn as that direction.
 * - `held` - two judgement points with time held down between them, in one lane.
 * - `travelling` - two judgement points with a path between them, across lanes.
 *
 * `endLane` is what separates the last two. A note that names an end lane is describing
 * somewhere it goes; one that does not is describing time it lasts. A travelling note
 * whose end lane equals its start lane is still travelling - it simply travels nowhere.
 */
export type NoteShape = "instant" | "flick" | "held" | "travelling";

export function noteShape(note: ChartNote): NoteShape {
  if (isInstantaneous(note)) {
    return note.direction === undefined ? "instant" : "flick";
  }
  return note.endLane === undefined ? "held" : "travelling";
}

/** A judgement point: a moment the player must arrive at, drawn across its lane. */
export interface NoteMarker {
  /** X of the moment itself, which is what the note actually means. */
  readonly xPx: number;
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
  readonly centreYPx: number;
  readonly lane: number;
}

/**
 * A flick, drawn as an arrow instead of a bar.
 *
 * The arrow is centred on the note's own time: `xPx` is `timeToX(timeSec)` and the box is
 * symmetrical about it, so removing the bar does not make the moment ambiguous.
 */
export interface NoteArrow {
  readonly xPx: number;
  readonly centreYPx: number;
  readonly sizePx: number;
  readonly direction: string;
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
  readonly lane: number;
}

/** Time spent holding something down, in one lane. */
export interface NoteBody {
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
}

/** The grip that changes where a held note ends. */
export interface NoteBox {
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
}

/** A path travelled between two judgement points. */
export interface NoteConnector {
  readonly fromXPx: number;
  readonly fromYPx: number;
  readonly toXPx: number;
  readonly toYPx: number;
}

export interface NoteGeometry {
  readonly shape: NoteShape;
  /**
   * Every judgement point, in time order.
   *
   * A list rather than a start and an end, because a slide is a chain of any length and
   * nothing here should have an opinion about how many points that is. Empty for a flick,
   * which is its arrow; one for an instant; two for a Long; two or more for a slide.
   */
  readonly markers: readonly NoteMarker[];
  /** The first judgement point, or null for a flick. A convenience over `markers`. */
  readonly marker: NoteMarker | null;
  /** The last judgement point, when there is more than one. */
  readonly endMarker: NoteMarker | null;
  /**
   * The arrow a flick is drawn as, instead of a marker.
   *
   * A plain Flick has one in place of its only marker. A Long or a Slide that finishes in
   * a flick has one in place of its **last** marker, centred on `endTimeSec` - so the
   * moment the note is judged at is the middle of the arrow, exactly as it is the middle
   * of a bar. Nothing else about the note changes; the middle points of a chain keep
   * their bars, because only the end is flicked.
   */
  readonly arrow: NoteArrow | null;
  /** The held body, for a note the player keeps pressed. */
  readonly body: NoteBody | null;
  /** The grip at the end of that body. Only a held note can be resized. */
  /** The grip on the *end* of a held note. Null for anything without a length. */
  readonly resizeHandle: NoteBox | null;
  /**
   * The grip on the *start* of a held note, when there is room for one.
   *
   * Withheld on a note drawn narrower than `MIN_GRIP_BODY_PX`, because two grips on a
   * short bar leave no body between them and a note that cannot be grabbed anywhere but
   * its edges cannot be moved at all. The end grip is not withheld on the same test: it
   * has always been there, and taking it away at some zooms would be a change to a
   * gesture authors already rely on.
   */
  readonly startHandle: NoteBox | null;
  /**
   * The travelled path, one segment between each pair of consecutive points.
   *
   * A four-point slide has three of them. Drawn, hit-tested and rubber-banded segment by
   * segment, so a chain is never treated as one enormous bounding box.
   */
  readonly connectors: readonly NoteConnector[];
  /** The first segment, or null. A convenience over `connectors`. */
  readonly connector: NoteConnector | null;

  /** Bounding box of every part above. Culling and coarse rejection use it. */
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
}

export interface NoteRow {
  readonly topPx: number;
  readonly heightPx: number;
}

/**
 * The grip drawn over one end of a held note.
 *
 * One function for both ends, so the two are the same target of the same size and an
 * author's hand learns one thing rather than two. A few pixels taller than the body, so
 * the grip can be aimed at without having to hit the bar exactly.
 */
function gripAt(marker: NoteMarker): NoteBox {
  return {
    leftPx: marker.xPx - RESIZE_HANDLE_PX / 2,
    rightPx: marker.xPx + RESIZE_HANDLE_PX / 2,
    topPx: marker.centreYPx - BOUNDED_BODY_HEIGHT_PX / 2 - 3,
    bottomPx: marker.centreYPx + BOUNDED_BODY_HEIGHT_PX / 2 + 3,
  };
}

function markerAt(
  timeSec: number,
  lane: number,
  row: NoteRow,
  laneCount: number,
  view: Viewport,
): NoteMarker {
  const band: LaneBand = laneBand(row, laneCount, lane);
  const usableHeight = Math.max(2, band.heightPx - NOTE_INSET_PX * 2);
  const xPx = timeToX(timeSec, view);
  return {
    xPx,
    leftPx: xPx - MARKER_WIDTH_PX / 2,
    rightPx: xPx + MARKER_WIDTH_PX / 2,
    topPx: band.topPx + NOTE_INSET_PX,
    bottomPx: band.topPx + NOTE_INSET_PX + usableHeight,
    centreYPx: band.centreYPx,
    lane,
  };
}

/**
 * The parts a note is drawn from.
 *
 * A held note's body spans `timeToX(endTimeSec) - timeToX(timeSec)` and nothing else, so
 * it stretches and shrinks with the zoom exactly as its duration deserves. Nothing else
 * here scales: a marker names an instant and an arrow names a direction, and neither has
 * a length to be shown at scale.
 */
export function noteGeometry(
  note: ChartNote,
  row: NoteRow,
  laneCount: number,
  view: Viewport,
): NoteGeometry {
  const shape = noteShape(note);

  if (shape === "flick") {
    const arrow = arrowAt(
      markerAt(note.timeSec, note.lane, row, laneCount, view),
      note.direction as string,
    );
    return {
      shape,
      markers: [],
      marker: null,
      endMarker: null,
      arrow,
      body: null,
      resizeHandle: null,
      startHandle: null,
      connectors: [],
      connector: null,
      leftPx: arrow.leftPx,
      rightPx: arrow.rightPx,
      topPx: arrow.topPx,
      bottomPx: arrow.bottomPx,
    };
  }

  // The chain comes from the model, so nothing here reassembles start/waypoints/end by
  // hand and nothing can disagree with the commands about how long a slide is.
  const markers = slidePoints(note).map((point) =>
    markerAt(point.timeSec, point.lane, row, laneCount, view),
  );
  const first = markers[0] as NoteMarker;
  const last = markers[markers.length - 1] as NoteMarker;

  if (shape === "instant") {
    return {
      shape,
      markers,
      marker: first,
      endMarker: null,
      arrow: null,
      body: null,
      resizeHandle: null,
      startHandle: null,
      connectors: [],
      connector: null,
      leftPx: first.leftPx,
      rightPx: first.rightPx,
      topPx: first.topPx,
      bottomPx: first.bottomPx,
    };
  }

  // A held note keeps the lane pressed between its two markers. A travelling one does
  // not: it is somewhere else by then, so there are paths instead of a body.
  const body: NoteBody | null =
    shape === "held"
      ? {
          leftPx: first.xPx,
          rightPx: last.xPx,
          topPx: first.centreYPx - BOUNDED_BODY_HEIGHT_PX / 2,
          bottomPx: first.centreYPx + BOUNDED_BODY_HEIGHT_PX / 2,
        }
      : null;

  // Only a held note offers a grip: its end is a length the author can change. A slide's
  // end is a place, and moving it is a different question this Editor does not answer yet.
  const resizeHandle: NoteBox | null =
    shape === "held" ? gripAt(last) : null;

  // A held note's start is a length the author can change from the other side, and the
  // two grips are the same object drawn at the two ends. It appears only once the body is
  // wide enough to leave something between them to take hold of.
  const startHandle: NoteBox | null =
    shape === "held" && last.xPx - first.xPx >= MIN_GRIP_BODY_PX ? gripAt(first) : null;

  const connectors: NoteConnector[] =
    shape === "travelling"
      ? markers.slice(0, -1).map((from, index) => {
          const to = markers[index + 1] as NoteMarker;
          return {
            fromXPx: from.xPx,
            fromYPx: from.centreYPx,
            toXPx: to.xPx,
            toYPx: to.centreYPx,
          };
        })
      : [];

  // A note that ends in a flick draws its last judgement point as an arrow instead of a
  // bar. The connector still runs to the same place, because the arrow is centred on the
  // moment the bar would have marked.
  const endFlick = endFlickDirection(note);
  const arrow = endFlick === null ? null : arrowAt(last, endFlick);
  const drawnMarkers = arrow === null ? markers : markers.slice(0, -1);

  const boxes = arrow === null ? markers : [...drawnMarkers, arrow];

  return {
    shape,
    markers: drawnMarkers,
    marker: drawnMarkers[0] ?? null,
    endMarker: drawnMarkers.length > 1 ? (drawnMarkers[drawnMarkers.length - 1] as NoteMarker) : null,
    arrow,
    body,
    resizeHandle,
    startHandle,
    connectors,
    connector: connectors[0] ?? null,
    leftPx: Math.min(...boxes.map((m) => m.leftPx)),
    rightPx: Math.max(...boxes.map((m) => m.rightPx)),
    topPx: Math.min(...boxes.map((m) => m.topPx)),
    bottomPx: Math.max(...boxes.map((m) => m.bottomPx)),
  };
}

/** The arrow box for a judgement point that is flicked rather than released. */
function arrowAt(marker: NoteMarker, direction: string): NoteArrow {
  const half = FLICK_ARROW_PX / 2;
  return {
    xPx: marker.xPx,
    centreYPx: marker.centreYPx,
    sizePx: FLICK_ARROW_PX,
    direction,
    leftPx: marker.xPx - half,
    rightPx: marker.xPx + half,
    topPx: marker.centreYPx - half,
    bottomPx: marker.centreYPx + half,
    lane: marker.lane,
  };
}

/** Which part of a note a pointer landed on. */
export type NotePart =
  | "marker"
  | "waypoint"
  | "endMarker"
  | "arrow"
  | "body"
  | "resizeHandle"
  | "startHandle"
  | "connector";

/** Distance from a point to a box, zero when inside. */
function distanceToBox(
  x: number,
  y: number,
  box: { leftPx: number; rightPx: number; topPx: number; bottomPx: number },
): number {
  const left = Math.min(box.leftPx, box.rightPx);
  const right = Math.max(box.leftPx, box.rightPx);
  const dx = Math.max(left - x, 0, x - right);
  const dy = Math.max(box.topPx - y, 0, y - box.bottomPx);
  return Math.hypot(dx, dy);
}

/** Distance from a point to a line segment, zero when it lies on it. */
function distanceToSegment(
  x: number,
  y: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(x - x1, y - y1);
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

export interface PartHit {
  readonly part: NotePart;
  readonly distancePx: number;
}

/**
 * The nearest part of a note to a point, and how far away it is.
 *
 * Measured against the parts rather than the bounding box, so the empty triangle beside a
 * steep slide is not clickable just because the slide's box happens to cover it.
 *
 * The resize handle is tested first and wins ties. It sits on top of the end of the body,
 * and the whole point of a grip is that pressing it grips rather than doing whatever the
 * thing underneath would have done.
 */
export function nearestPart(x: number, y: number, geometry: NoteGeometry): PartHit {
  let best: PartHit = { part: "marker", distancePx: Number.POSITIVE_INFINITY };
  const consider = (part: NotePart, distancePx: number) => {
    if (distancePx < best.distancePx) best = { part, distancePx };
  };

  // The end grip first and the start grip second, so a note too short for the two boxes
  // to be told apart still resizes from the end, exactly as it did before there was a
  // start grip at all.
  if (geometry.resizeHandle) {
    consider("resizeHandle", distanceToBox(x, y, geometry.resizeHandle));
  }
  if (geometry.startHandle) {
    consider("startHandle", distanceToBox(x, y, geometry.startHandle));
  }
  geometry.markers.forEach((marker, index) => {
    const part: NotePart =
      index === 0 ? "marker" : index === geometry.markers.length - 1 ? "endMarker" : "waypoint";
    consider(part, distanceToBox(x, y, marker));
  });
  if (geometry.arrow) consider("arrow", distanceToBox(x, y, geometry.arrow));
  if (geometry.body) consider("body", distanceToBox(x, y, geometry.body));
  for (const c of geometry.connectors) {
    consider(
      "connector",
      distanceToSegment(x, y, c.fromXPx, c.fromYPx, c.toXPx, c.toYPx),
    );
  }
  return best;
}

/** Distance from a point to the nearest part of a note; zero when the point is on one. */
export function distanceToNote(x: number, y: number, geometry: NoteGeometry): number {
  return nearestPart(x, y, geometry).distancePx;
}

/**
 * Whether a note can be seen at all in this viewport.
 *
 * Shared with the renderer so that culling and hit testing agree on what is on screen:
 * a note the renderer skipped must not be selectable, and one it drew must be.
 */
export function isNoteVisible(geometry: NoteGeometry, view: Viewport): boolean {
  return geometry.rightPx >= 0 && geometry.leftPx <= view.widthPx;
}

/**
 * Rough seconds a note may extend beyond its own time, for widening a range query.
 *
 * Taken from the widest part anything is drawn as - the flick arrow - so a range query
 * never rejects a note whose arrow would still have been on screen.
 */
export function noteMarginSec(view: Viewport): number {
  return FLICK_ARROW_PX / Math.max(1e-6, view.pixelsPerSecond);
}

export interface NoteHit {
  readonly note: ChartNote;
  readonly distancePx: number;
  /** Which part was nearest, so a press on the grip can resize rather than move. */
  readonly part: NotePart;
}

/** How close a click has to be to a note to count as landing on it. */
export const NOTE_HIT_TOLERANCE_PX = 6;

/**
 * The note under a pointer, or null.
 *
 * Uses the drawn geometry, so the target is exactly what the author can see. Ties are
 * broken by distance and then by note id, so the same click always selects the same
 * note rather than depending on document order.
 */
export function hitTestNote(
  x: number,
  y: number,
  notes: readonly ChartNote[],
  row: NoteRow,
  laneCount: number,
  view: Viewport,
  tolerancePx: number = NOTE_HIT_TOLERANCE_PX,
): NoteHit | null {
  const margin = noteMarginSec(view);
  const from = view.startSec - margin;
  const to = viewportEndSec(view) + margin;

  let best: NoteHit | null = null;
  for (const note of notes) {
    const end = note.endTimeSec ?? note.timeSec;
    if (end < from || note.timeSec > to) continue;

    const geometry = noteGeometry(note, row, laneCount, view);
    const hit = nearestPart(x, y, geometry);
    if (hit.distancePx > tolerancePx) continue;

    if (
      best === null ||
      hit.distancePx < best.distancePx ||
      (hit.distancePx === best.distancePx && note.id < best.note.id)
    ) {
      best = { note, distancePx: hit.distancePx, part: hit.part };
    }
  }
  return best;
}

/** A rectangle in canvas pixels, as a rubber band drags one out. */
export interface SelectionRect {
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
}

/**
 * Build a rectangle from two corners.
 *
 * Normalised, so dragging up-left works exactly like dragging down-right rather than
 * producing an inside-out rectangle that intersects nothing.
 */
export function rectFromCorners(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): SelectionRect {
  return {
    leftPx: Math.min(x1, x2),
    rightPx: Math.max(x1, x2),
    topPx: Math.min(y1, y2),
    bottomPx: Math.max(y1, y2),
  };
}

function rectOverlapsBox(
  rect: SelectionRect,
  box: { leftPx: number; rightPx: number; topPx: number; bottomPx: number },
): boolean {
  const left = Math.min(box.leftPx, box.rightPx);
  const right = Math.max(box.leftPx, box.rightPx);
  const top = Math.min(box.topPx, box.bottomPx);
  const bottom = Math.max(box.topPx, box.bottomPx);
  return right >= rect.leftPx && left <= rect.rightPx &&
         bottom >= rect.topPx && top <= rect.bottomPx;
}

/** Whether a line segment touches a rectangle at all. */
function rectOverlapsSegment(
  rect: SelectionRect,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  // Either end inside is the common case and costs almost nothing to check.
  const inside = (x: number, y: number) =>
    x >= rect.leftPx && x <= rect.rightPx && y >= rect.topPx && y <= rect.bottomPx;
  if (inside(x1, y1) || inside(x2, y2)) return true;

  // Otherwise the segment has to cross an edge. Liang-Barsky against the rectangle,
  // which answers "does it cross at all" without working out where.
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const tests: readonly (readonly [number, number])[] = [
    [-dx, x1 - rect.leftPx],
    [dx, rect.rightPx - x1],
    [-dy, y1 - rect.topPx],
    [dy, rect.bottomPx - y1],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
}

/**
 * Whether a rubber band touches any part a note is actually drawn from.
 *
 * Part by part rather than bounding box: a rectangle in the empty corner beside a steep
 * slide has not touched the slide, and should not select it. What is caught is what can
 * be seen to be caught.
 */
export function rectIntersectsNote(rect: SelectionRect, geometry: NoteGeometry): boolean {
  for (const marker of geometry.markers) {
    if (rectOverlapsBox(rect, marker)) return true;
  }
  if (geometry.arrow && rectOverlapsBox(rect, geometry.arrow)) return true;
  if (geometry.body && rectOverlapsBox(rect, geometry.body)) return true;
  for (const c of geometry.connectors) {
    if (rectOverlapsSegment(rect, c.fromXPx, c.fromYPx, c.toXPx, c.toYPx)) return true;
  }
  return false;
}

/**
 * Every note a rubber band touches.
 *
 * Intersection with the drawn parts, not containment of the start point: a Long caught
 * anywhere along its body, or a Slide caught anywhere along its trajectory, is caught -
 * which is what an author sweeping a rectangle over a bar plainly means. The geometry
 * comes from the same `noteGeometry` the renderer and the hit test use, so what is inside
 * the rectangle on screen is what ends up selected.
 *
 * Returned in chart order, so the same rectangle always yields the same list.
 */
export function notesInRect(
  rect: SelectionRect,
  notes: readonly ChartNote[],
  row: NoteRow,
  laneCount: number,
  view: Viewport,
): readonly ChartNote[] {
  const margin = noteMarginSec(view);
  const from = view.startSec - margin;
  const to = viewportEndSec(view) + margin;

  const found: ChartNote[] = [];
  for (const note of notes) {
    // Cheap time-range rejection first, so a rubber band over a busy bar does not build
    // geometry for every note in a long chart.
    const end = note.endTimeSec ?? note.timeSec;
    if (end < from || note.timeSec > to) continue;

    const geometry = noteGeometry(note, row, laneCount, view);
    if (rectIntersectsNote(rect, geometry)) found.push(note);
  }
  return found;
}


/**
 * A drawn link between two notes that are played as one run.
 *
 * Between notes rather than inside one, because that is what a connection is - so unlike
 * a slide's connectors, which belong to a single note's geometry, these are worked out
 * for the chart as a whole and drawn as their own layer.
 *
 * The endpoints are the notes' own centres at their own times. Joining two flicks does
 * not move either of them: `fromXPx` is `timeToX(from.timeSec)` and nothing is nudged to
 * make the line meet neatly.
 */
export interface RunConnector {
  readonly connection: ChartConnection;
  readonly fromNoteId: string;
  readonly toNoteId: string;
  readonly fromXPx: number;
  readonly fromYPx: number;
  readonly toXPx: number;
  readonly toYPx: number;
}

/** The centre of whatever a note is drawn as - an arrow for a flick, a bar otherwise. */
function noteCentre(
  note: ChartNote,
  row: NoteRow,
  laneCount: number,
  view: Viewport,
): { readonly xPx: number; readonly yPx: number } {
  const geometry = noteGeometry(note, row, laneCount, view);
  const anchor = geometry.arrow ?? geometry.marker;
  return {
    xPx: anchor?.xPx ?? timeToX(note.timeSec, view),
    yPx: anchor?.centreYPx ?? 0,
  };
}

/**
 * Every run link on screen.
 *
 * Built from the same `noteGeometry` the notes themselves are drawn from, so a link ends
 * exactly where its note is drawn, at every zoom and after any edit. A link whose notes
 * are both off screen is dropped; one with a single end on screen is kept, because the
 * line crossing the edge is the visible half of it.
 */
export function runConnectors(
  state: Pick<ChartState, "notes" | "connections">,
  row: NoteRow,
  laneCount: number,
  view: Viewport,
): readonly RunConnector[] {
  if (state.connections.length === 0) return [];
  const byId = new Map(state.notes.map((note) => [note.id, note]));

  const margin = noteMarginSec(view);
  const from = view.startSec - margin;
  const to = viewportEndSec(view) + margin;

  const connectors: RunConnector[] = [];
  for (const connection of state.connections) {
    const start = byId.get(connection.fromNoteId);
    const end = byId.get(connection.toNoteId);
    if (!start || !end) continue;
    if (end.timeSec < from || start.timeSec > to) continue;

    const a = noteCentre(start, row, laneCount, view);
    const b = noteCentre(end, row, laneCount, view);
    connectors.push({
      connection,
      fromNoteId: start.id,
      toNoteId: end.id,
      fromXPx: a.xPx,
      fromYPx: a.yPx,
      toXPx: b.xPx,
      toYPx: b.yPx,
    });
  }
  return connectors;
}

/** How close a click has to be to a run link to count as landing on it. */
export const RUN_CONNECTOR_TOLERANCE_PX = 5;

/**
 * The run link under a pointer, or null.
 *
 * Tested *after* the notes, so pressing an arrow selects that one flick and pressing the
 * line between two selects the run. That is the distinction an author needs: the whole
 * point of keeping the flicks separate is being able to reach one of them.
 */
export function hitTestRunConnector(
  x: number,
  y: number,
  connectors: readonly RunConnector[],
  tolerancePx: number = RUN_CONNECTOR_TOLERANCE_PX,
): RunConnector | null {
  let best: RunConnector | null = null;
  let bestDistance = tolerancePx;
  for (const connector of connectors) {
    const distance = distanceToSegment(
      x, y, connector.fromXPx, connector.fromYPx, connector.toXPx, connector.toYPx,
    );
    if (distance > bestDistance) continue;
    if (best === null || distance < bestDistance) {
      best = connector;
      bestDistance = distance;
    }
  }
  return best;
}
