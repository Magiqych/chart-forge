/**
 * The Chart document the author is writing, and the commands that change it.
 *
 * This is a Chart, not an Analysis. Nothing in this module reads an Analysis Event, and
 * `placeNote` takes plain numbers rather than an event, so there is no code path by
 * which looking at the overlay can create a note. The author decides the time and the
 * lane; `chartNote.sourceEventId` stays a hand-authored back-reference the contract
 * describes as "never a claim that the note was generated from the event", and this MVP
 * does not write it at all.
 *
 * `placeNote` and `deleteNote` are the only ways the note list changes. They are pure
 * and return a new state, so an undo stack can later be wrapped around them without
 * touching anything else.
 */

/** The lane a note sits in: 0-based from the left, below `playfield.laneCount`. */
export type LaneIndex = number;

/**
 * Note kinds this Editor can author with a single click.
 *
 * `chartNote.type` is an open vocabulary and a loaded chart may legitimately contain
 * `hold`, `slide` or anything else - those are preserved untouched. They cannot be
 * *placed* here because they need an end time or an end lane, which needs a drag.
 */
export const PLACEABLE_TYPES = ["tap", "flick"] as const;
export type PlaceableType = (typeof PLACEABLE_TYPES)[number];

export const DIRECTIONS = [
  "left", "right", "up", "down", "upLeft", "upRight", "downLeft", "downRight",
] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface ChartNote {
  readonly id: string;
  readonly type: string;
  readonly timeSec: number;
  readonly lane: LaneIndex;
  readonly endTimeSec?: number;
  readonly endLane?: LaneIndex;
  readonly direction?: Direction;
  readonly sourceEventId?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * A Chart document in memory.
 *
 * `base` holds every top-level field of the document as it was read, except `notes`.
 * Keeping it verbatim means metadata, extensions and any field a future contract adds
 * survive a load/save round trip untouched: this Editor only claims authority over the
 * note list.
 */
export interface ChartState {
  readonly base: Readonly<Record<string, unknown>>;
  /** Sorted by (timeSec, lane, id). */
  readonly notes: readonly ChartNote[];
  readonly laneCount: number;
  /** Next numeric suffix for a generated note id. */
  readonly nextIdSeq: number;
}

export class ChartError extends Error {}

export const CHART_VERSION = "0.1.0";

/**
 * Lanes for a chart the Editor creates from nothing.
 *
 * Five is Deresute's playfield width, so a chart written here fits that game without
 * this Editor claiming to implement it: `playfield.profile` stays "generic" because we
 * write no `extensions.deresute` data, and the contract says a non-generic profile
 * "implies a matching entry under 'extensions'".
 */
export const DEFAULT_LANE_COUNT = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFiniteNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ChartError(`${what} must be a finite number`);
  }
  return value;
}

/** Notes are stored and written in ascending time order, as the contract requires. */
function compareNotes(a: ChartNote, b: ChartNote): number {
  if (a.timeSec !== b.timeSec) return a.timeSec - b.timeSec;
  // Two notes may legitimately share a timestamp - a chord across lanes is the normal
  // case - so the tie-break has to be total, or serialisation would not be stable.
  if (a.lane !== b.lane) return a.lane - b.lane;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortNotes(notes: readonly ChartNote[]): ChartNote[] {
  return [...notes].sort(compareNotes);
}

const ID_PATTERN = /^n-(\d+)$/;

function seqAfter(notes: readonly ChartNote[]): number {
  let highest = 0;
  for (const note of notes) {
    const match = ID_PATTERN.exec(note.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

export function formatNoteId(seq: number): string {
  return `n-${String(seq).padStart(4, "0")}`;
}

/** Build the in-memory state for a chart that does not exist yet. */
export function emptyChart(options: {
  readonly audioPath: string;
  readonly audioDurationSec?: number;
  readonly laneCount?: number;
  readonly title?: string;
}): ChartState {
  const laneCount = options.laneCount ?? DEFAULT_LANE_COUNT;
  const base: Record<string, unknown> = {
    version: CHART_VERSION,
    ...(options.title ? { metadata: { title: options.title } } : {}),
    audio: {
      path: options.audioPath,
      ...(options.audioDurationSec !== undefined
        ? { durationSec: options.audioDurationSec }
        : {}),
    },
    // Only `offsetSec` is required, and it is the only timing fact we can state
    // honestly. The Analyzer emits detected beats, not a tempo map, so copying its
    // average `tempo.bpm` in here would describe a uniform grid the song does not have.
    timing: { offsetSec: 0 },
    playfield: { laneCount, profile: "generic" },
    extensions: {},
  };
  return { base, notes: [], laneCount, nextIdSeq: 1 };
}

/**
 * Read a Chart document into editor state.
 *
 * Strict about the fields the Editor must understand to draw and re-serialise a note,
 * tolerant about everything else: unknown note types, unknown top-level fields and
 * unknown metadata are carried through untouched.
 */
export function projectChart(raw: unknown): ChartState {
  if (!isPlainObject(raw)) throw new ChartError("Chart document is not an object");

  const version = typeof raw["version"] === "string" ? raw["version"] : "";
  if (!version.startsWith("0.1.")) {
    throw new ChartError(
      `unsupported Chart document version ${version || "(missing)"}; this Editor reads 0.1.x`,
    );
  }

  const playfield = raw["playfield"];
  if (!isPlainObject(playfield)) throw new ChartError("chart.playfield is missing");
  const laneCount = playfield["laneCount"];
  if (typeof laneCount !== "number" || !Number.isInteger(laneCount) || laneCount < 1) {
    throw new ChartError("chart.playfield.laneCount must be a positive integer");
  }

  const notesRaw = raw["notes"];
  if (!Array.isArray(notesRaw)) throw new ChartError("chart.notes must be an array");

  const seen = new Set<string>();
  const notes: ChartNote[] = notesRaw.map((entry, index) => {
    if (!isPlainObject(entry)) throw new ChartError(`chart.notes[${index}] is not an object`);
    const id = entry["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new ChartError(`chart.notes[${index}].id must be a non-empty string`);
    }
    if (seen.has(id)) throw new ChartError(`chart.notes contains duplicate id ${id}`);
    seen.add(id);

    const type = entry["type"];
    if (typeof type !== "string" || type.length === 0) {
      throw new ChartError(`note ${id} has no type`);
    }
    const lane = entry["lane"];
    if (typeof lane !== "number" || !Number.isInteger(lane) || lane < 0 || lane >= laneCount) {
      throw new ChartError(`note ${id} is in lane ${String(lane)}, outside 0..${laneCount - 1}`);
    }

    return {
      id,
      type,
      timeSec: requireFiniteNumber(entry["timeSec"], `note ${id} timeSec`),
      lane,
      ...(typeof entry["endTimeSec"] === "number" ? { endTimeSec: entry["endTimeSec"] } : {}),
      ...(typeof entry["endLane"] === "number" ? { endLane: entry["endLane"] } : {}),
      ...(typeof entry["direction"] === "string"
        ? { direction: entry["direction"] as Direction }
        : {}),
      ...(typeof entry["sourceEventId"] === "string"
        ? { sourceEventId: entry["sourceEventId"] }
        : {}),
      ...(isPlainObject(entry["metadata"]) ? { metadata: entry["metadata"] } : {}),
    };
  });

  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "notes") base[key] = value;
  }

  const sorted = sortNotes(notes);
  return { base, notes: sorted, laneCount, nextIdSeq: seqAfter(sorted) };
}

/** Write the state back out as a contract-shaped Chart document. */
export function serializeChart(state: ChartState): Record<string, unknown> {
  const notes = sortNotes(state.notes).map((note) => {
    const out: Record<string, unknown> = {
      id: note.id,
      type: note.type,
      timeSec: note.timeSec,
      lane: note.lane,
    };
    if (note.endTimeSec !== undefined) out["endTimeSec"] = note.endTimeSec;
    if (note.endLane !== undefined) out["endLane"] = note.endLane;
    if (note.direction !== undefined) out["direction"] = note.direction;
    if (note.sourceEventId !== undefined) out["sourceEventId"] = note.sourceEventId;
    if (note.metadata !== undefined) out["metadata"] = note.metadata;
    return out;
  });
  return { ...state.base, notes };
}

export interface PlaceNoteSpec {
  readonly timeSec: number;
  readonly lane: LaneIndex;
  readonly type: PlaceableType;
  readonly direction?: Direction;
}

export interface PlaceResult {
  readonly state: ChartState;
  readonly note: ChartNote;
}

/**
 * Place one note. The editor command boundary for creating a note.
 *
 * Note the argument type: times and lanes, never an Analysis Event. An author who is
 * looking at an onset still has to decide where the note goes.
 */
export function placeNote(state: ChartState, spec: PlaceNoteSpec): PlaceResult {
  const timeSec = requireFiniteNumber(spec.timeSec, "note timeSec");
  if (timeSec < 0) throw new ChartError("note timeSec must not be negative");

  if (!Number.isInteger(spec.lane) || spec.lane < 0 || spec.lane >= state.laneCount) {
    throw new ChartError(`lane ${spec.lane} is outside 0..${state.laneCount - 1}`);
  }
  if (!(PLACEABLE_TYPES as readonly string[]).includes(spec.type)) {
    throw new ChartError(
      `this Editor cannot place a ${spec.type} note; ` +
        `${PLACEABLE_TYPES.join(" and ")} are the types a single click can fully describe`,
    );
  }
  if (spec.type === "flick" && spec.direction === undefined) {
    throw new ChartError("a flick note needs a direction");
  }
  if (spec.direction !== undefined && !(DIRECTIONS as readonly string[]).includes(spec.direction)) {
    throw new ChartError(`unknown direction ${spec.direction}`);
  }

  const note: ChartNote = {
    id: formatNoteId(state.nextIdSeq),
    type: spec.type,
    timeSec,
    lane: spec.lane,
    ...(spec.type === "flick" && spec.direction ? { direction: spec.direction } : {}),
  };

  return {
    state: {
      ...state,
      notes: sortNotes([...state.notes, note]),
      nextIdSeq: state.nextIdSeq + 1,
    },
    note,
  };
}

/** Delete one note by id. Unknown ids are an error, not a silent no-op. */
export function deleteNote(state: ChartState, id: string): ChartState {
  const remaining = state.notes.filter((note) => note.id !== id);
  if (remaining.length === state.notes.length) {
    throw new ChartError(`no note with id ${id}`);
  }
  // nextIdSeq is not rewound: ids must stay stable and unique for the life of the
  // document, so a deleted id is never handed out again.
  return { ...state, notes: remaining };
}

/** The note at a given time and lane, within a tolerance. Used for click selection. */
export function noteAt(
  state: ChartState,
  timeSec: number,
  lane: LaneIndex,
  toleranceSec: number,
): ChartNote | null {
  let best: ChartNote | null = null;
  let bestDistance = toleranceSec;
  for (const note of state.notes) {
    if (note.lane !== lane) continue;
    const distance = Math.abs(note.timeSec - timeSec);
    if (distance <= bestDistance) {
      best = note;
      bestDistance = distance;
    }
  }
  return best;
}
