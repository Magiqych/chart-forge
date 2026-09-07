/**
 * Magnet Snap: what an already-placed note is pulled onto while it is dragged.
 *
 * A different question from the placement snap in `snap.ts`, and kept in its own module
 * for that reason. Placement asks "where should this new note go", and its answer is
 * about the *pointer*: the author is aiming at a beat or at a sound they can see. Magnet
 * Snap asks "what is this existing note lining up with", and its answer is about the
 * *note*: the author is carrying something that already has a length and a shape past
 * other things on the timeline, and what they want is for its edges to meet theirs.
 *
 * That difference is why the delta is not simply the snapped pointer movement. Snapping
 * the pointer quantises how far the note travels and leaves the note itself wherever it
 * already was, off the grid, for ever. Snapping the note's own edges puts the note *on*
 * the thing it was carried to - which is the whole point of a magnet, and what the dotted
 * guide is able to promise.
 *
 * Nothing here is written to any document. A candidate is a place the author could line
 * something up with; what the Chart records is the note, at the time the drag committed.
 * There is no schema for any of this and there must not be one.
 *
 * Pure, and given everything it needs, so the behaviour can be tested exhaustively
 * without a canvas, a pointer or a browser.
 */

import type { ChartNote } from "./chart";
import type { GuideAnchor } from "./guideAnchors";

/**
 * How close the dragged note has to come before the magnet takes it, in CSS pixels.
 *
 * A screen distance rather than a number of seconds, for the same reason the Guide Snap
 * radius is one: it has to mean the same thing to the hand at every zoom. Zoomed out,
 * twelve pixels covers a wide slice of time and the magnet is generous; zoomed in, it
 * narrows until the author can place a note a few milliseconds off a beat on purpose. A
 * fixed number of seconds would be an immovable magnet at one zoom and no magnet at all
 * at another.
 */
export const MAGNET_ENTER_PX = 12;

/**
 * How far the note has to be pulled away before the magnet lets go, in CSS pixels.
 *
 * Deliberately larger than the distance that captures it, and this gap is what makes the
 * feature feel like a magnet rather than a rounding rule. With one threshold the note is
 * taken and released at the same place, so a hand that stops near a beat sits exactly on
 * the boundary and the note flickers on and off it; and the moment of capture is over
 * almost as soon as it happens, which reads as a twitch rather than as being held.
 *
 * With two, the gesture has the three phases the author expects: it approaches, it is
 * caught, and it stays caught through small movements until they clearly pull it off.
 * The cost is that letting go returns the note to the pointer in one step, so the gap is
 * kept moderate - a release far from where the hand is would read as the note escaping.
 */
export const MAGNET_RELEASE_PX = 20;

/**
 * When two times count as the same instant.
 *
 * A nanosecond: far below anything audible, far above the rounding error of adding a
 * drag delta to a time in the tens or hundreds of seconds. Used to collapse a beat and a
 * note that sit on top of each other into one candidate - and therefore one guide line -
 * and to keep the threshold test from rejecting a candidate that is exactly on it.
 */
export const SNAP_TIME_EPSILON_SEC = 1e-9;

/**
 * Where a candidate came from.
 *
 * Carried through so the caller can say what a note landed on, and so duplicates at the
 * same instant collapse in a defined order rather than whichever happened to be built
 * first.
 */
export type SnapCandidateKind = "beat" | "note-start" | "note-end" | "event";

export interface SnapCandidate {
  readonly timeSec: number;
  readonly kind: SnapCandidateKind;
  /** The note an edge candidate came from. Absent for beats and Analysis Events. */
  readonly noteId?: string;
  /** The Analysis Event an `event` candidate came from. Absent otherwise. */
  readonly eventId?: string;
}

/**
 * Which kind survives when several land on the same instant.
 *
 * The guide is one line at one time, so only one candidate needs to be kept, and the
 * order decides which one gets to describe it. A beat first: when a note has been carried
 * onto a beat that another note already sits on, "the beat" is the more useful statement
 * about where it went. Then the note edges, then the Analysis Event, which is the
 * loosest claim of the three.
 */
const KIND_RANK: Readonly<Record<SnapCandidateKind, number>> = {
  beat: 0,
  "note-start": 1,
  "note-end": 2,
  event: 3,
};

/** A total order over candidates, so the same inputs always give the same answer. */
function compareCandidates(a: SnapCandidate, b: SnapCandidate): number {
  if (a.timeSec !== b.timeSec) return a.timeSec - b.timeSec;
  const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (rank !== 0) return rank;
  return (a.noteId ?? a.eventId ?? "").localeCompare(b.noteId ?? b.eventId ?? "");
}

export interface MagnetCandidateSources {
  /**
   * Beat-grid times, already subdivided. Empty when the beat grid is not a target.
   *
   * Taken from the grid the rest of the Editor uses rather than rebuilt here, so the
   * magnet cannot line a note up with a beat the timeline is not drawing.
   */
  readonly beatGrid?: readonly number[];
  /** Every note in the chart. The moving ones are removed by `excludeNoteIds`. */
  readonly notes?: readonly ChartNote[];
  /**
   * The notes being dragged.
   *
   * They are excluded because a note cannot line up with itself, and because a group
   * moving together must not be caught on its own members - that would pull the group
   * apart, and the relative spacing inside a selection is something the author built.
   */
  readonly excludeNoteIds?: ReadonlySet<string>;
  /** Analysis Event anchors. Empty unless the author asked for Guide Snap. */
  readonly eventAnchors?: readonly GuideAnchor[];
}

/**
 * Every time the dragged note may be lined up with, ascending and without duplicates.
 *
 * Built once when a drag starts rather than on every pointer move: the list is a few
 * thousand entries for a real song, and rebuilding and re-sorting it sixty times a second
 * would be the one thing that made dragging feel heavy. The chart cannot change under a
 * drag - the preview never touches it - so the list stays true for the whole gesture.
 *
 * Times before zero and times that are not finite are dropped. A negative time is not a
 * place on the recording, and a note cannot be dragged to one.
 */
export function buildMagnetCandidates(
  sources: MagnetCandidateSources,
): readonly SnapCandidate[] {
  const exclude = sources.excludeNoteIds ?? new Set<string>();
  const candidates: SnapCandidate[] = [];

  for (const timeSec of sources.beatGrid ?? []) {
    if (usable(timeSec)) candidates.push({ timeSec, kind: "beat" });
  }

  for (const note of sources.notes ?? []) {
    if (exclude.has(note.id)) continue;
    if (usable(note.timeSec)) {
      candidates.push({ timeSec: note.timeSec, kind: "note-start", noteId: note.id });
    }
    // An end is only a place if the note actually has one. A zero-length or inverted end
    // is the note's own start said twice, and would add a candidate nothing is at.
    if (
      note.endTimeSec !== undefined &&
      usable(note.endTimeSec) &&
      note.endTimeSec > note.timeSec
    ) {
      candidates.push({ timeSec: note.endTimeSec, kind: "note-end", noteId: note.id });
    }
  }

  for (const anchor of sources.eventAnchors ?? []) {
    if (usable(anchor.timeSec)) {
      candidates.push({ timeSec: anchor.timeSec, kind: "event", eventId: anchor.eventId });
    }
  }

  candidates.sort(compareCandidates);
  return dedupe(candidates);
}

function usable(timeSec: number): boolean {
  return Number.isFinite(timeSec) && timeSec >= 0;
}

/**
 * Collapse candidates that name the same instant.
 *
 * A beat with a note already on it is one place, not two, and drawing two guide lines a
 * nanometre apart on top of each other would be a rendering artefact rather than
 * information. Each survivor is compared against the last one *kept*, not against its
 * immediate neighbour, so a long run of near-identical times cannot creep away from the
 * value that opened it.
 */
function dedupe(sorted: readonly SnapCandidate[]): readonly SnapCandidate[] {
  const kept: SnapCandidate[] = [];
  for (const candidate of sorted) {
    const last = kept[kept.length - 1];
    if (last !== undefined && candidate.timeSec - last.timeSec <= SNAP_TIME_EPSILON_SEC) {
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}

/** How much time a screen distance covers at this zoom. Zero when the zoom is nonsense. */
export function magnetThresholdSec(
  pixelsPerSecond: number,
  thresholdPx: number = MAGNET_ENTER_PX,
): number {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return 0;
  if (!Number.isFinite(thresholdPx) || thresholdPx <= 0) return 0;
  return thresholdPx / pixelsPerSecond;
}

/** First index whose time is at or after `timeSec`, by binary search. */
function lowerBound(candidates: readonly SnapCandidate[], timeSec: number): number {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((candidates[mid] as SnapCandidate).timeSec < timeSec) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The candidate nearest a time and within reach of it, or null.
 *
 * Only the run of candidates inside the radius is examined, found by binary search and
 * walked outwards, so a chart with thousands of them costs a handful of comparisons per
 * pointer move rather than a full scan.
 *
 * `accept` lets the caller veto a candidate that is close enough but would produce an
 * impossible move - dragging a note's end onto something so early that its start would
 * fall before the recording begins. Vetoing here rather than afterwards matters: the
 * search simply moves on to the next-nearest, so the magnet still works instead of going
 * dead near the start of a song.
 *
 * Ties go to the earlier candidate, which is the same rule `snapTime` uses for the beat
 * grid. Two candidates equidistant from the pointer is not a rare case - it happens every
 * time the note is halfway between two beats - and the answer must not depend on which
 * one the search happened to look at first.
 */
export function nearestCandidateWithin(
  candidates: readonly SnapCandidate[],
  timeSec: number,
  radiusSec: number,
  accept: (candidate: SnapCandidate) => boolean = () => true,
): SnapCandidate | null {
  if (candidates.length === 0 || !Number.isFinite(timeSec) || radiusSec <= 0) return null;
  const reach = radiusSec + SNAP_TIME_EPSILON_SEC;

  const pivot = lowerBound(candidates, timeSec);
  let from = pivot;
  while (from > 0 && timeSec - (candidates[from - 1] as SnapCandidate).timeSec <= reach) {
    from -= 1;
  }
  let to = pivot;
  while (to < candidates.length && (candidates[to] as SnapCandidate).timeSec - timeSec <= reach) {
    to += 1;
  }

  let best: SnapCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  // Ascending, with a strict improvement test, so the earliest of several equally close
  // candidates is the one that wins.
  for (let i = from; i < to; i += 1) {
    const candidate = candidates[i] as SnapCandidate;
    const distance = Math.abs(candidate.timeSec - timeSec);
    if (distance > reach || distance >= bestDistance) continue;
    if (!accept(candidate)) continue;
    best = candidate;
    bestDistance = distance;
  }
  return best;
}

export interface MagnetSnapInput {
  readonly candidates: readonly SnapCandidate[];
  /**
   * The edges of the dragged note *before* the drag, in ascending order.
   *
   * Its `timeSec`, and its `endTimeSec` when it has one - so a Long lines up by whichever
   * of its two ends the author brought near something, exactly as a clip does in a video
   * editor. Given undragged rather than at the pointer's position so the returned delta
   * can be `candidate - edge`, which puts the edge on the candidate to the last bit the
   * format has, instead of accumulating the drag's own rounding into the answer.
   */
  readonly baseEdgesSec: readonly number[];
  /** How far the pointer has actually travelled, in seconds. Unsnapped. */
  readonly rawDeltaSec: number;
  /**
   * The earliest time in the whole moving set.
   *
   * The set may not be dragged before the start of the recording, and it is clamped as a
   * set rather than per note so a group keeps its shape when it meets zero. The same rule
   * `moveNotes` applies when the drag commits - stated here as well so that what the
   * author sees during the drag is what they get when they let go.
   */
  readonly earliestMovingSec: number;
  readonly pixelsPerSecond: number;
  /**
   * Whether the magnet is live at all.
   *
   * One flag rather than a condition spread through the caller, so every way of
   * suspending the magnet arrives here as the same thing and adding another is a change
   * in one place.
   */
  readonly enabled: boolean;
  /**
   * What the previous pointer move settled on, so a captured candidate can resist.
   *
   * This is the whole of the magnet's memory, and it is passed in rather than kept here
   * so the function stays pure: the caller holds it for the length of one drag and throws
   * it away with the gesture.
   */
  readonly held?: MagnetHold | null;
  readonly enterPx?: number;
  readonly releasePx?: number;
}

/**
 * A candidate the magnet is currently holding, and the edge it caught.
 *
 * The edge is remembered as well as the candidate because a Long has two, and "still
 * within reach" has to mean the same edge that was captured - otherwise a hold could be
 * kept alive by the far end of the note wandering past something else.
 */
export interface MagnetHold {
  readonly candidate: SnapCandidate;
  readonly baseEdgeSec: number;
}

export interface MagnetSnapOutcome {
  /** How far the selection should actually move. The raw delta when nothing took it. */
  readonly deltaSec: number;
  /** What it was taken by, for the caller to describe. */
  readonly candidate: SnapCandidate | null;
  /**
   * Where to draw the dotted guide, or null for a free move.
   *
   * The candidate's own time, and the same number the snapped edge lands on. The guide
   * and the note are therefore never computed apart: whatever the viewport does to one it
   * does to the other, so the line cannot drift off the note it is explaining at some
   * zoom or scroll position.
   */
  readonly guideTimeSec: number | null;
  /** Hand back to the next pointer move as `held`. Null when the move is free. */
  readonly hold: MagnetHold | null;
}

/**
 * The delta a drag should actually apply, where to say why, and what is being held.
 *
 * The one function that decides whether a move is magnetised, and it works in two stages.
 *
 * First, capture: every edge of the dragged note is offered to the candidates within the
 * *enter* distance and the closest match wins outright - so carrying a Long past a note
 * lines it up by whichever end came nearest, rather than always by its start. When two
 * edges are equally close the earlier one wins, so the answer does not depend on which
 * end the author happened to be looking at.
 *
 * Then, hold: a candidate captured on a previous move keeps the note as long as it is
 * still within the wider *release* distance, even though the note has by then travelled
 * past the distance that would have captured it. That asymmetry is the magnet. It is what
 * lets the author come near, feel the note take hold, move their hand a little without
 * losing it, and then pull it clearly away - instead of the note chattering on and off a
 * boundary that capture and release share.
 *
 * The hold gives way when something else is genuinely nearer. Without that, at a zoom
 * where the candidates are closer together than the release distance, a note could stay
 * stuck to a beat while sitting on top of the next one.
 */
export function magnetSnapDelta(input: MagnetSnapInput): MagnetSnapOutcome {
  const raw = Number.isFinite(input.rawDeltaSec) ? input.rawDeltaSec : 0;
  // The floor is the whole set's, not this edge's: clamping each note on its own would
  // collapse a group onto zero and lose the spacing the author built.
  const floor = Number.isFinite(input.earliestMovingSec) ? -input.earliestMovingSec : -Infinity;
  const free: MagnetSnapOutcome = {
    deltaSec: Math.max(raw, floor),
    candidate: null,
    guideTimeSec: null,
    hold: null,
  };

  if (!input.enabled || input.candidates.length === 0) return free;
  const enterSec = magnetThresholdSec(input.pixelsPerSecond, input.enterPx ?? MAGNET_ENTER_PX);
  if (enterSec <= 0) return free;
  // Never smaller than the distance that captures, or a note could be released the instant
  // it was taken.
  const releaseSec = Math.max(
    enterSec,
    magnetThresholdSec(input.pixelsPerSecond, input.releasePx ?? MAGNET_RELEASE_PX),
  );

  /** Whether taking this candidate for this edge would carry the set before zero. */
  const reachable = (candidate: SnapCandidate, base: number): boolean =>
    input.earliestMovingSec + (candidate.timeSec - base) >= 0;

  let bestCandidate: SnapCandidate | null = null;
  let bestBase = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const base of input.baseEdgesSec) {
    if (!Number.isFinite(base)) continue;
    const at = base + raw;
    // A candidate that would carry the set before the start of the recording is not a
    // place this note can go, so the search keeps looking rather than offering a guide
    // the move would then have to disobey.
    const found = nearestCandidateWithin(input.candidates, at, enterSec, (c) => reachable(c, base));
    if (!found) continue;
    const distance = Math.abs(found.timeSec - at);
    // Strictly closer, so an equal match on a later edge cannot displace an earlier one.
    if (distance >= bestDistance) continue;
    bestCandidate = found;
    bestBase = base;
    bestDistance = distance;
  }

  // The candidate already holding the note keeps it while it is still within reach and
  // nothing has come strictly nearer.
  const held = input.held;
  if (held && reachable(held.candidate, held.baseEdgeSec)) {
    const heldDistance = Math.abs(held.candidate.timeSec - (held.baseEdgeSec + raw));
    if (heldDistance <= releaseSec + SNAP_TIME_EPSILON_SEC && heldDistance <= bestDistance) {
      return {
        deltaSec: held.candidate.timeSec - held.baseEdgeSec,
        candidate: held.candidate,
        guideTimeSec: held.candidate.timeSec,
        hold: held,
      };
    }
  }

  if (bestCandidate === null) return free;
  return {
    deltaSec: bestCandidate.timeSec - bestBase,
    candidate: bestCandidate,
    guideTimeSec: bestCandidate.timeSec,
    hold: { candidate: bestCandidate, baseEdgeSec: bestBase },
  };
}

/** A short phrase naming what a note lined up with, for the status line. */
export function describeCandidate(candidate: SnapCandidate): string {
  const what =
    candidate.kind === "beat"
      ? "beat"
      : candidate.kind === "event"
        ? (candidate.eventId ?? "event")
        : `${candidate.noteId ?? "note"} ${candidate.kind === "note-start" ? "start" : "end"}`;
  return `${what} @ ${candidate.timeSec.toFixed(3)}s`;
}
