/**
 * Reading a Chart document into the model the Player plays.
 *
 * The contract is `schemas/chart.schema.json` and nothing else. This module does not
 * import anything from the Editor and never will - they are separate components joined
 * by the document, not by code - so everything here is derived from the schema's own
 * words, quoted where a decision rests on them.
 *
 * Two rules run through the whole file:
 *
 *   - **Shape decides, not the name.** `chartNote.type` is "an open vocabulary", so a
 *     kind this Player has never seen still has an end time, a direction, waypoints, and
 *     is played from those. An unknown type is reported, never silently turned into a tap.
 *   - **Nothing is repaired.** A document is read, not corrected. The Player writes no
 *     document at all, so a value it dislikes is carried through and dealt with at the
 *     moment it is used.
 *
 * `timing.offsetSec` is deliberately *not* applied to note times. The schema defines it
 * as "time in the audio at which musical time zero (bar 1, beat 1) occurs" - a beat-grid
 * anchor - while a note's `timeSec` is already "time in seconds from the start of the
 * audio". Adding one to the other would shift every note by a value that was never about
 * playback. The player's own latency correction is a session setting, not chart data.
 */

/** Kinds this Player draws with a shape of their own. The vocabulary stays open. */
export const KNOWN_NOTE_TYPES = ["tap", "hold", "slide", "flick"];

/** The eight compass points `#/$defs/direction` allows. */
export const DIRECTIONS = [
  "left", "right", "up", "down", "upLeft", "upRight", "downLeft", "downRight",
];

/**
 * What the player is asked to do at one instant.
 *
 * A note is not one moment. A slide is judged at every point along it, and a note that
 * finishes with a flick is judged again at its end, so judgement is driven by these and
 * never by notes. `id` names the point rather than the note, because two moments of one
 * slide are two separate things to get right.
 *
 *   tap         a single press
 *   flick       a directional swipe, with no length
 *   hold-start  a press that begins a held note
 *   waypoint    a point of a slide that must be reached, in that lane
 *   release     the end of a held note: let go
 *   flick-end   the end of a held note that finishes with a swipe
 */
export const POINT_KINDS = ["tap", "flick", "hold-start", "waypoint", "release", "flick-end"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Every judgement point of a note, in order, start to end.
 *
 * The one place that knows how `timeSec`, `waypoints` and `endTimeSec` fit together, so
 * the renderer, the judge and the autoplay cannot disagree about how long a slide is. A
 * note with no end is a single point; a slide with no waypoints is two.
 */
export function notePoints(note) {
  const points = [{ timeSec: note.timeSec, lane: note.lane }];
  for (const waypoint of note.waypoints) points.push({ timeSec: waypoint.timeSec, lane: waypoint.lane });
  if (note.endTimeSec !== null) {
    points.push({ timeSec: note.endTimeSec, lane: note.endLane ?? note.lane });
  }
  return points;
}

/** True when the note occupies a stretch of time rather than an instant. */
export function hasLength(note) {
  return note.endTimeSec !== null && note.endTimeSec > note.timeSec;
}

/**
 * The drawing kind of a note.
 *
 * The declared `type` wins when it is one this Player draws, so a chart that says
 * `slide` is drawn as a slide even where its start and end happen to share a lane.
 * Anything else is read from the fields, which is the only thing that can be done with a
 * word nobody here has seen.
 */
export function noteKind(note) {
  if (KNOWN_NOTE_TYPES.includes(note.type)) return note.type;
  if (hasLength(note)) {
    return note.waypoints.length > 0 || note.endLane !== null ? "slide" : "hold";
  }
  return note.direction !== null ? "flick" : "tap";
}

/**
 * Build the judgement points of one note.
 *
 * Every held note is judged at both ends here, including a plain Long whose end is an
 * ordinary release. That is a Player decision and worth stating: releasing a Long at the
 * right moment is something the game asks of the player, so it is scored. It is not a
 * claim about the document - the chart says only that the note ends at `endTimeSec`.
 */
export function judgePointsOf(note) {
  const points = notePoints(note);
  const bounded = hasLength(note);
  const last = points.length - 1;
  const out = [];

  points.forEach((point, index) => {
    if (!Number.isFinite(point.timeSec)) return;
    let kind;
    let direction = null;
    if (index === 0) {
      if (bounded) kind = "hold-start";
      else if (note.direction !== null) {
        kind = "flick";
        direction = note.direction;
      } else kind = "tap";
    } else if (bounded && index === last) {
      if (note.endAction !== null && note.endAction.type === "flick") {
        kind = "flick-end";
        direction = note.endAction.direction;
      } else {
        kind = "release";
      }
    } else {
      kind = "waypoint";
    }
    out.push({
      id: `${note.id}#${index}`,
      noteId: note.id,
      index,
      isFirst: index === 0,
      isLast: index === last,
      timeSec: point.timeSec,
      lane: point.lane,
      kind,
      direction,
    });
  });
  return out;
}

/**
 * Every judgement point of a whole chart, in the order they happen.
 *
 * Sorted rather than assumed: notes ascend by their starts, but a thirteen-second slide's
 * later points fall well after the start of notes that come after it in the document.
 * Ties break by point id so that the order of two simultaneous moments is a property of
 * the chart and not of the sort's implementation.
 */
export function buildJudgePoints(notes) {
  const points = notes.flatMap((note) => judgePointsOf(note));
  points.sort((a, b) => (a.timeSec !== b.timeSec ? a.timeSec - b.timeSec : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return points;
}

function readWaypoints(raw, laneCount, problems, noteId) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((entry, index) => {
    if (!isPlainObject(entry)) return;
    const timeSec = finiteOr(entry.timeSec, NaN);
    const lane = entry.lane;
    if (!Number.isFinite(timeSec) || !Number.isInteger(lane)) {
      problems.push(`note ${noteId}: waypoint ${index} has no usable time or lane; skipped`);
      return;
    }
    if (lane < 0 || lane >= laneCount) {
      problems.push(`note ${noteId}: waypoint ${index} is in lane ${lane}, outside the playfield; skipped`);
      return;
    }
    out.push({ timeSec, lane });
  });
  // A slide is "judged at its points and travelled between them", so the order they are
  // reached in is the order they are judged in, whatever order the file listed them in.
  out.sort((a, b) => a.timeSec - b.timeSec);
  return out;
}

function readEndAction(raw) {
  if (!isPlainObject(raw) || typeof raw.type !== "string") return null;
  return {
    type: raw.type,
    direction: typeof raw.direction === "string" ? raw.direction : null,
  };
}

/**
 * Read a Chart document.
 *
 * Throws only when the document cannot be played at all - no playfield, no notes array.
 * Everything smaller is a line in `problems`: a note in a lane that does not exist is
 * dropped and said so, because playing it would mean inventing a lane the author never
 * made.
 */
export function readChart(document) {
  if (!isPlainObject(document)) throw new Error("the chart document is not an object");
  const problems = [];

  const playfield = document.playfield;
  if (!isPlainObject(playfield)) throw new Error("chart.playfield is missing");
  const laneCount = playfield.laneCount;
  if (!Number.isInteger(laneCount) || laneCount < 1) {
    throw new Error("chart.playfield.laneCount must be a positive integer");
  }
  if (!Array.isArray(document.notes)) throw new Error("chart.notes must be an array");

  const seen = new Set();
  const notes = [];
  const unknownTypes = new Set();

  document.notes.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      problems.push(`notes[${index}] is not an object; skipped`);
      return;
    }
    const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
    if (id === null) {
      problems.push(`notes[${index}] has no id; skipped`);
      return;
    }
    if (seen.has(id)) {
      problems.push(`note ${id} appears more than once; the later one is skipped`);
      return;
    }
    const timeSec = finiteOr(entry.timeSec, NaN);
    if (!Number.isFinite(timeSec)) {
      problems.push(`note ${id} has no usable timeSec; skipped`);
      return;
    }
    const lane = entry.lane;
    if (!Number.isInteger(lane) || lane < 0 || lane >= laneCount) {
      problems.push(`note ${id} is in lane ${String(lane)}, outside 0..${laneCount - 1}; skipped`);
      return;
    }
    const type = typeof entry.type === "string" && entry.type.length > 0 ? entry.type : "tap";
    if (!KNOWN_NOTE_TYPES.includes(type)) unknownTypes.add(type);

    let endTimeSec = typeof entry.endTimeSec === "number" && Number.isFinite(entry.endTimeSec)
      ? entry.endTimeSec
      : null;
    if (endTimeSec !== null && endTimeSec <= timeSec) {
      problems.push(`note ${id} ends at or before it starts; played as an instant`);
      endTimeSec = null;
    }
    let endLane = Number.isInteger(entry.endLane) ? entry.endLane : null;
    if (endLane !== null && (endLane < 0 || endLane >= laneCount)) {
      problems.push(`note ${id} ends in lane ${endLane}, outside the playfield; ending in its own lane`);
      endLane = null;
    }
    const direction = typeof entry.direction === "string" ? entry.direction : null;
    if (direction !== null && !DIRECTIONS.includes(direction)) {
      problems.push(`note ${id} points '${direction}', which is not one of the eight compass points`);
    }

    seen.add(id);
    notes.push({
      id,
      type,
      timeSec,
      lane,
      endTimeSec,
      endLane,
      direction,
      endAction: readEndAction(entry.endAction),
      waypoints: readWaypoints(entry.waypoints, laneCount, problems, id),
    });
  });

  notes.sort((a, b) => (a.timeSec !== b.timeSec ? a.timeSec - b.timeSec : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const byId = new Map(notes.map((note) => [note.id, note]));
  const connections = [];
  if (Array.isArray(document.connections)) {
    for (const entry of document.connections) {
      if (!isPlainObject(entry)) continue;
      const from = byId.get(entry.fromNoteId);
      const to = byId.get(entry.toNoteId);
      if (!from || !to) {
        problems.push(`a ${String(entry.type)} connection names a note that is not in the chart; ignored`);
        continue;
      }
      connections.push({ type: typeof entry.type === "string" ? entry.type : "", fromNoteId: from.id, toNoteId: to.id });
    }
  }

  const decorations = Array.isArray(document.decorations)
    ? document.decorations.filter(isPlainObject).slice().sort((a, b) => finiteOr(a.startTimeSec, 0) - finiteOr(b.startTimeSec, 0))
    : [];

  const points = buildJudgePoints(notes);

  // Where each note stops mattering, and the running maximum of that, so the renderer can
  // find everything still on screen without walking the whole chart every frame. See
  // visibleNotes() in layout.js.
  const endTimes = notes.map((note) => {
    const own = notePoints(note);
    return own.length > 0 ? own[own.length - 1].timeSec : note.timeSec;
  });
  const prefixMaxEnd = [];
  let running = -Infinity;
  for (const end of endTimes) {
    running = Math.max(running, end);
    prefixMaxEnd.push(running);
  }

  const metadata = isPlainObject(document.metadata) ? document.metadata : {};
  const audio = isPlainObject(document.audio) ? document.audio : {};
  const timing = isPlainObject(document.timing) ? document.timing : {};

  const lastPointSec = points.length > 0 ? points[points.length - 1].timeSec : 0;

  return {
    version: typeof document.version === "string" ? document.version : "",
    title: typeof metadata.title === "string" ? metadata.title : "",
    artist: typeof metadata.artist === "string" ? metadata.artist : "",
    charter: typeof metadata.charter === "string" ? metadata.charter : "",
    difficulty: isPlainObject(metadata.difficulty) ? metadata.difficulty : null,
    laneCount,
    profile: typeof playfield.profile === "string" ? playfield.profile : "generic",
    audioPath: typeof audio.path === "string" ? audio.path : "",
    audioDurationSec: finiteOr(audio.durationSec, 0),
    /** The beat-grid anchor. Carried for display; never added to a note's time. */
    gridOffsetSec: finiteOr(timing.offsetSec, 0),
    bpm: finiteOr(timing.bpm, 0),
    notes,
    connections,
    decorations,
    points,
    prefixMaxEnd,
    endTimes,
    lastPointSec,
    unknownNoteTypes: [...unknownTypes],
    problems,
  };
}

/** A quick census for the loading screen and the report line. */
export function chartSummary(chart) {
  const counts = { tap: 0, hold: 0, slide: 0, flick: 0, other: 0 };
  for (const note of chart.notes) {
    const kind = noteKind(note);
    if (kind in counts) counts[kind] += 1;
    else counts.other += 1;
  }
  return {
    noteCount: chart.notes.length,
    pointCount: chart.points.length,
    connectionCount: chart.connections.length,
    decorationCount: chart.decorations.length,
    counts,
  };
}
