/**
 * The Chart document the author is writing, and the commands that change it.
 *
 * This is a Chart, not an Analysis. Nothing in this module reads an Analysis Event:
 * `placeNote` takes plain numbers and at most an event *id*, so no property of an event
 * - its stem, its pitch, its duration - can reach a note. The author decides the time,
 * the lane and the type in every case.
 *
 * `chartNote.sourceEventId` is written only when the author placed the note by pointing
 * at an event, and means what the contract says it means: "a human-authored
 * back-reference ... never a claim that the note was generated from the event".
 *
 * `placeNote` and `deleteNote` are the only ways the note list changes. They are pure
 * and return a new state, so an undo stack can later be wrapped around them without
 * touching anything else.
 */

/** The lane a note sits in: 0-based from the left, below `playfield.laneCount`. */
export type LaneIndex = number;

/**
 * Note kinds this Editor can author.
 *
 * `chartNote.type` is an open vocabulary, so this list is what the Editor offers rather
 * than what a Chart may contain: a chart written elsewhere may use a word nobody here has
 * seen, and those are read, drawn and preserved untouched.
 *
 * These four are the gameplay kinds a Deresute-style chart is written from: Tap (`tap`),
 * Long (`hold`), Slide (`slide`) and Flick (`flick`). They are the contract's own words,
 * so nothing is translated on the way to disk.
 *
 * `purple` was briefly a fifth entry here and is not any more. It was never a settled
 * gameplay kind - the open question was whether it named a different thing to hit or just
 * a way a Tap is drawn - and offering it for authoring answered that question by
 * accident. It is no longer placeable. Nothing was removed from the contract to achieve
 * that, because nothing had been added to it: a chart that already says `purple` is still
 * valid, still loads, and is still drawn and written back untouched, as any unfamiliar
 * kind is. If Purple returns it will be as a Tap plus something in the game-specific
 * extension namespace, decided with real charts in hand.
 */
export const PLACEABLE_TYPES = ["tap", "hold", "slide", "flick"] as const;
export type PlaceableType = (typeof PLACEABLE_TYPES)[number];

/**
 * What the pointer is for.
 *
 * The top-level split in the Editor, above the choice of note kind: `edit` makes notes
 * and `select` chooses and removes them. Two modes rather than one list with `select`
 * bolted on the front, because "which kind am I placing" is a question that only exists
 * inside Edit, and mixing the two is what makes a click ambiguous.
 *
 * Nothing infers the mode from how far a pointer moved. A drag means "rubber-band" in
 * Select and "draw this note out" in Edit, decided before the gesture starts.
 */
export type EditorMode = "edit" | "select";

export const EDITOR_MODES: readonly EditorMode[] = ["edit", "select"];

/**
 * The directions this Editor authors a Flick in.
 *
 * The Chart contract's `direction` enumerates all eight compass points and any of them
 * is read, drawn and written back untouched. Offering all eight for authoring would be
 * offering choices this Editor has no opinion about, so the toolbar stays with the two
 * a Deresute flick actually uses.
 */
export const FLICK_DIRECTIONS = ["left", "right"] as const;
export type FlickDirection = (typeof FLICK_DIRECTIONS)[number];

/**
 * Which kinds are authored by dragging a length out rather than by clicking.
 *
 * Only a Long. A Slide used to be here, and is not any more: a slide is a chain of
 * judgement points, so the Editor places the **points** one click at a time and joins
 * them afterwards. That makes the second point a thing the author can see, move and
 * reconsider before committing to a connection, and it is the shape a multi-point slide
 * will need.
 */
export function isBoundedPlaceable(type: PlaceableType): boolean {
  return type === "hold";
}

/**
 * Which kinds may name a lane they finish in.
 *
 * This is the whole difference between a Long and a Slide: both can span time, but only
 * a Slide travels. A Long stays in the lane it started in.
 */
export function travelsBetweenLanes(type: PlaceableType): boolean {
  return type === "slide";
}

/**
 * Which kinds may carry an end time at all.
 *
 * A Long must have one - a Long with no length is not a Long. A Slide may have one, and
 * has none until its point is connected to another. Everything else may not.
 */
export function canCarryEnd(type: PlaceableType): boolean {
  return type === "hold" || type === "slide";
}

/**
 * The shortest a held note may be shrunk to by dragging its end.
 *
 * A resize that reaches the start would turn a Long into a zero-length hold, which is not
 * a Long at all. Rather than refusing mid-drag - which would make the grip feel broken -
 * the end simply stops here. Deliberately a small epsilon rather than a musical value:
 * the model knows nothing about beats, and inventing a minimum out of the snap division
 * would put grid knowledge in the wrong place.
 */
export const MIN_HELD_DURATION_SEC = 0.01;

export const DIRECTIONS = [
  "left", "right", "up", "down", "upLeft", "upRight", "downLeft", "downRight",
] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * One intermediate judgement point of a slide.
 *
 * An instant and a lane, and nothing else: a slide is judged at its points and merely
 * travelled between them, so a waypoint has no duration of its own to carry.
 */
export interface SlideWaypoint {
  readonly timeSec: number;
  readonly lane: LaneIndex;
}

/**
 * What the player does at the end of a note that has one.
 *
 * Deliberately its own object rather than a reuse of the note's `direction`. On a Long or
 * a Slide, `direction` would be ambiguous about whether it described the start or the
 * end - and on a plain Flick it already means the note's own direction. Saying `endAction`
 * says plainly which moment is meant.
 *
 * An object rather than a bare string so a later end action - a second tap, a hold-and-
 * release, whatever a real chart turns out to need - is a new `type` here rather than
 * another shape change.
 */
export interface NoteEndAction {
  readonly type: string;
  readonly direction?: Direction;
}

/** Kinds that can finish with something other than an ordinary release. */
export function canCarryEndAction(type: PlaceableType): boolean {
  return canCarryEnd(type);
}

/** Build the end action for a flick, or null for an ordinary release. */
export function flickEndAction(direction: FlickDirection | null): NoteEndAction | null {
  return direction === null ? null : { type: "flick", direction };
}

/** The direction a note's end flick points, or null when it just releases. */
export function endFlickDirection(note: ChartNote): Direction | null {
  if (note.endAction?.type !== "flick") return null;
  return note.endAction.direction ?? null;
}

export interface ChartNote {
  readonly id: string;
  readonly type: string;
  readonly timeSec: number;
  readonly lane: LaneIndex;
  readonly endTimeSec?: number;
  readonly endLane?: LaneIndex;
  /**
   * The middle of a multi-point slide, between the start and the end.
   *
   * Optional and additive. A reader that ignores it still sees a valid slide with the
   * right start and end, which is the fallback the contract documents - so an older
   * Player draws a straight line where a newer one draws the whole chain.
   */
  readonly waypoints?: readonly SlideWaypoint[];
  readonly direction?: Direction;
  /**
   * How the note finishes, when that is not an ordinary release.
   *
   * Only meaningful on a note that has an end. Optional and additive: a reader that
   * ignores it still sees a correct Long or Slide that simply releases.
   */
  readonly endAction?: NoteEndAction;
  readonly sourceEventId?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Every judgement point of a note, in order, start to end.
 *
 * The one place that knows how the three fields fit together, so the renderer, the hit
 * test and the commands never reassemble a chain by hand and never disagree about how
 * long it is. A note with no end is a single point; a slide with no waypoints is two.
 */
export function slidePoints(note: ChartNote): readonly SlideWaypoint[] {
  const points: SlideWaypoint[] = [{ timeSec: note.timeSec, lane: note.lane }];
  for (const point of note.waypoints ?? []) {
    points.push({ timeSec: point.timeSec, lane: point.lane });
  }
  if (note.endTimeSec !== undefined) {
    points.push({ timeSec: note.endTimeSec, lane: note.endLane ?? note.lane });
  }
  return points;
}

/** Build a note from an ordered list of points, folding the middle into `waypoints`. */
function noteFromPoints(
  note: ChartNote,
  points: readonly SlideWaypoint[],
): ChartNote {
  const [start, ...rest] = points;
  const end = rest.length > 0 ? (rest[rest.length - 1] as SlideWaypoint) : undefined;
  const middle = rest.slice(0, -1);

  const rebuilt: Record<string, unknown> = {
    ...note,
    timeSec: (start as SlideWaypoint).timeSec,
    lane: (start as SlideWaypoint).lane,
  };
  delete rebuilt["endTimeSec"];
  delete rebuilt["endLane"];
  delete rebuilt["waypoints"];

  if (end) {
    rebuilt["endTimeSec"] = end.timeSec;
    rebuilt["endLane"] = end.lane;
  }
  if (middle.length > 0) rebuilt["waypoints"] = middle;
  return rebuilt as unknown as ChartNote;
}

/**
 * A Chart document in memory.
 *
 * `base` holds every top-level field of the document as it was read, except `notes`.
 * Keeping it verbatim means metadata, extensions and any field a future contract adds
 * survive a load/save round trip untouched: this Editor only claims authority over the
 * note list.
 */
/**
 * A link between two notes that are played as one run.
 *
 * Both notes keep everything that makes them themselves - their id, time, lane and
 * direction - and this only says they are joined. It carries no judgement of its own:
 * nothing happens on the link, only at the notes it joins.
 *
 * Stored beside the notes rather than inside one because it is a relation between two of
 * them, not a fact about either. Every other field of a `ChartNote` states something about
 * that note's own moment; a `nextNoteId` would be the first that only means anything with
 * a second note in hand, and it would also have to be carried by every kind of note in
 * case it were ever wanted.
 */
export interface ChartConnection {
  readonly type: string;
  readonly fromNoteId: string;
  readonly toNoteId: string;
}

export interface ChartState {
  readonly base: Readonly<Record<string, unknown>>;
  /** Sorted by (timeSec, lane, id). */
  readonly notes: readonly ChartNote[];
  /**
   * Runs joining notes that are played together.
   *
   * Empty for a chart of independent notes, which is every chart written before this
   * existed - so nothing had to be migrated and nothing has to be written when there is
   * nothing to say.
   */
  readonly connections: readonly ChartConnection[];
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
  return { base, notes: [], connections: [], laneCount, nextIdSeq: 1 };
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
      ...(Array.isArray(entry["waypoints"])
        ? { waypoints: readWaypoints(entry["waypoints"], id, laneCount) }
        : {}),
      ...(typeof entry["direction"] === "string"
        ? { direction: entry["direction"] as Direction }
        : {}),
      ...(isPlainObject(entry["endAction"])
        ? { endAction: readEndAction(entry["endAction"], id) }
        : {}),
      ...(typeof entry["sourceEventId"] === "string"
        ? { sourceEventId: entry["sourceEventId"] }
        : {}),
      ...(isPlainObject(entry["metadata"]) ? { metadata: entry["metadata"] } : {}),
    };
  });

  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "notes" && key !== "connections") base[key] = value;
  }

  const sorted = sortNotes(notes);
  const connections = readConnections(raw["connections"], sorted);
  return { base, notes: sorted, connections, laneCount, nextIdSeq: seqAfter(sorted) };
}

/**
 * Read the runs joining notes.
 *
 * Validated on the way in, like the waypoints: a document from elsewhere may name a note
 * that is not there, or join one to itself, and a run the Editor cannot follow is worse
 * than no run at all. What it does *not* do is repair anything - a chart that fails here
 * fails to open, rather than opening as something subtly different from what it says.
 */
function readConnections(
  raw: unknown,
  notes: readonly ChartNote[],
): readonly ChartConnection[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ChartError("connections must be a list");

  const byId = new Map(notes.map((note) => [note.id, note]));
  return raw.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new ChartError(`connection ${index} is not an object`);
    }
    const type = entry["type"];
    const fromNoteId = entry["fromNoteId"];
    const toNoteId = entry["toNoteId"];
    if (typeof type !== "string" || type.length === 0) {
      throw new ChartError(`connection ${index} has no type`);
    }
    if (typeof fromNoteId !== "string" || typeof toNoteId !== "string") {
      throw new ChartError(`connection ${index} does not name two notes`);
    }
    for (const id of [fromNoteId, toNoteId]) {
      if (!byId.has(id)) {
        throw new ChartError(`connection ${index} names note ${id}, which is not here`);
      }
    }
    if (fromNoteId === toNoteId) {
      throw new ChartError(`connection ${index} joins note ${fromNoteId} to itself`);
    }
    const from = byId.get(fromNoteId) as ChartNote;
    const to = byId.get(toNoteId) as ChartNote;
    if (from.timeSec >= to.timeSec) {
      throw new ChartError(
        `connection ${index} does not run forwards from ${fromNoteId} to ${toNoteId}`,
      );
    }
    return { type, fromNoteId, toNoteId };
  });
}

/**
 * Read how a note finishes.
 *
 * Validated on the way in rather than trusted, like the waypoints: a document from
 * elsewhere may say anything, and a flick with no direction would draw nothing.
 */
function readEndAction(raw: Record<string, unknown>, id: string): NoteEndAction {
  const type = raw["type"];
  if (typeof type !== "string" || type.length === 0) {
    throw new ChartError(`note ${id} has an endAction with no type`);
  }
  const direction = raw["direction"];
  if (direction !== undefined && typeof direction !== "string") {
    throw new ChartError(`note ${id} has an endAction with a bad direction`);
  }
  if (direction !== undefined && !(DIRECTIONS as readonly string[]).includes(direction)) {
    throw new ChartError(`note ${id} ends with an unknown direction ${direction}`);
  }
  if (type === "flick" && direction === undefined) {
    throw new ChartError(`note ${id} ends in a flick with no direction`);
  }
  return {
    type,
    ...(direction !== undefined ? { direction: direction as Direction } : {}),
  };
}

/**
 * Read the middle points of a slide.
 *
 * Validated on the way in rather than trusted: a document from elsewhere may say
 * anything, and a waypoint outside the playfield or out of order would draw a path that
 * doubles back or leaves the lanes.
 */
function readWaypoints(
  raw: readonly unknown[],
  id: string,
  laneCount: number,
): readonly SlideWaypoint[] {
  return raw.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new ChartError(`note ${id} waypoint ${index} is not an object`);
    }
    const lane = entry["lane"];
    if (typeof lane !== "number" || !Number.isInteger(lane) || lane < 0 || lane >= laneCount) {
      throw new ChartError(
        `note ${id} waypoint ${index} is in lane ${String(lane)}, outside 0..${laneCount - 1}`,
      );
    }
    return {
      timeSec: requireFiniteNumber(entry["timeSec"], `note ${id} waypoint ${index} timeSec`),
      lane,
    };
  });
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
    if (note.waypoints !== undefined && note.waypoints.length > 0) {
      out["waypoints"] = note.waypoints.map((point) => ({
        timeSec: point.timeSec,
        lane: point.lane,
      }));
    }
    if (note.direction !== undefined) out["direction"] = note.direction;
    if (note.endAction !== undefined) {
      out["endAction"] = {
        type: note.endAction.type,
        ...(note.endAction.direction !== undefined
          ? { direction: note.endAction.direction }
          : {}),
      };
    }
    if (note.sourceEventId !== undefined) out["sourceEventId"] = note.sourceEventId;
    if (note.metadata !== undefined) out["metadata"] = note.metadata;
    return out;
  });
  const out: Record<string, unknown> = { ...state.base, notes };
  // Nothing is written when there is nothing to say, so a chart of independent notes is
  // byte-for-byte what it was before runs existed.
  if (state.connections.length > 0) {
    out["connections"] = orderedConnections(state).map((connection) => ({
      type: connection.type,
      fromNoteId: connection.fromNoteId,
      toNoteId: connection.toNoteId,
    }));
  }
  return out;
}

export interface PlaceNoteSpec {
  readonly timeSec: number;
  readonly lane: LaneIndex;
  readonly type: PlaceableType;
  readonly direction?: Direction;
  /** End of a note that has a duration. */
  readonly endTimeSec?: number;
  /** How it finishes, when that is not an ordinary release. */
  readonly endAction?: NoteEndAction;
  /**
   * Lane the note finishes in, for the kinds that travel.
   *
   * A Long never sets this: it is a duration in one lane. A Slide does, and a Slide that
   * happens to end where it began simply records the same lane.
   */
  readonly endLane?: LaneIndex;
  /**
   * The Analysis Event the author was looking at, when they placed the note by pointing
   * at one.
   *
   * The contract calls this "a human-authored back-reference ... never a claim that the
   * note was generated from the event", and that is exactly what it is here: the author
   * still chose the lane, the type and whether to place anything at all. An ordinary
   * click on the timeline sets nothing, because in that case no event was consulted.
   */
  readonly sourceEventId?: string;
}

export interface PlaceResult {
  readonly state: ChartState;
  readonly note: ChartNote;
}

/**
 * Place one note. The editor command boundary for creating a note.
 *
 * Note the argument type: times, lanes and at most an event *id*, never an Analysis
 * Event itself. Nothing in this module can read an event's stem, pitch or duration, so
 * there is no way for one to decide a lane, a type or a note's end. An author who is
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
      `this Editor cannot place a ${spec.type} note; it offers ` +
        `${PLACEABLE_TYPES.join(", ")}`,
    );
  }
  if (spec.type === "flick" && spec.direction === undefined) {
    throw new ChartError("a flick note needs a direction");
  }

  const carriesEnd = canCarryEnd(spec.type);
  if (spec.endTimeSec !== undefined) {
    if (!carriesEnd) {
      throw new ChartError(`a ${spec.type} note cannot have an end time`);
    }
    requireFiniteNumber(spec.endTimeSec, "note endTimeSec");
    // A zero-length hold is not a hold. Snapping both ends of a drag to the same grid
    // line is the ordinary way to reach this, so it is refused rather than stored.
    if (spec.endTimeSec <= timeSec) {
      throw new ChartError("a held note must end after it starts");
    }
  } else if (isBoundedPlaceable(spec.type)) {
    throw new ChartError(`a ${spec.type} note needs an end time`);
  }

  if (spec.endLane !== undefined) {
    if (!travelsBetweenLanes(spec.type)) {
      throw new ChartError(`a ${spec.type} note cannot travel between lanes`);
    }
    if (
      !Number.isInteger(spec.endLane) ||
      spec.endLane < 0 ||
      spec.endLane >= state.laneCount
    ) {
      throw new ChartError(
        `end lane ${spec.endLane} is outside 0..${state.laneCount - 1}`,
      );
    }
  }
  if (spec.direction !== undefined && !(DIRECTIONS as readonly string[]).includes(spec.direction)) {
    throw new ChartError(`unknown direction ${spec.direction}`);
  }

  if (spec.endAction !== undefined) {
    if (!canCarryEndAction(spec.type)) {
      throw new ChartError(`a ${spec.type} note cannot have an end action`);
    }
    if (spec.endTimeSec === undefined) {
      throw new ChartError(`a ${spec.type} note with an end action needs an end time`);
    }
    if (spec.endAction.type === "flick" && spec.endAction.direction === undefined) {
      throw new ChartError("an end flick needs a direction");
    }
  }

  if (spec.sourceEventId !== undefined && spec.sourceEventId.length === 0) {
    throw new ChartError("sourceEventId must not be empty");
  }

  const note: ChartNote = {
    id: formatNoteId(state.nextIdSeq),
    type: spec.type,
    timeSec,
    lane: spec.lane,
    ...(spec.endTimeSec !== undefined ? { endTimeSec: spec.endTimeSec } : {}),
    ...(spec.endLane !== undefined ? { endLane: spec.endLane } : {}),
    ...(spec.type === "flick" && spec.direction ? { direction: spec.direction } : {}),
    ...(spec.endAction !== undefined ? { endAction: spec.endAction } : {}),
    // Deliberately not deduplicated: an author may build a chord or a roll from one
    // observed onset, so several notes legitimately cite the same event.
    ...(spec.sourceEventId !== undefined ? { sourceEventId: spec.sourceEventId } : {}),
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

/**
 * Move notes in time and across lanes.
 *
 * The delta is applied to the whole set, and both ends of a note that has two move
 * together: dragging a Long moves it, it does not stretch it. Stretching is what the
 * resize grip is for, and one gesture doing two things is how an author loses a length
 * they had already got right.
 *
 * The delta is **clamped once for the set**, not per note, so a group keeps its shape
 * when it meets the start of the recording or the edge of the playfield. Clamping each
 * note on its own would quietly collapse the group onto the boundary.
 */
export function moveNotes(
  state: ChartState,
  ids: readonly string[],
  deltaSec: number,
  deltaLane: number,
): ChartState {
  if (ids.length === 0) return state;
  requireFiniteNumber(deltaSec, "move deltaSec");
  if (!Number.isInteger(deltaLane)) throw new ChartError("move deltaLane must be whole");

  const wanted = new Set(ids);
  const moving = state.notes.filter((note) => wanted.has(note.id));
  if (moving.length !== wanted.size) {
    const present = new Set(state.notes.map((note) => note.id));
    const missing = [...wanted].filter((id) => !present.has(id));
    throw new ChartError(`no note with id ${missing.join(", ")}`);
  }

  // How far the set may actually go before something would fall off an edge.
  let earliest = Number.POSITIVE_INFINITY;
  let lowestLane = Number.POSITIVE_INFINITY;
  let highestLane = Number.NEGATIVE_INFINITY;
  for (const note of moving) {
    earliest = Math.min(earliest, note.timeSec);
    for (const point of slidePoints(note)) {
      lowestLane = Math.min(lowestLane, point.lane);
      highestLane = Math.max(highestLane, point.lane);
    }
  }
  const seconds = Math.max(deltaSec, -earliest);
  const lanes = Math.max(
    -lowestLane,
    Math.min(deltaLane, state.laneCount - 1 - highestLane),
  );
  if (seconds === 0 && lanes === 0) return state;

  const shifted = state.notes.map((note) => {
    if (!wanted.has(note.id)) return note;
    return {
      ...note,
      timeSec: note.timeSec + seconds,
      lane: note.lane + lanes,
      ...(note.endTimeSec !== undefined ? { endTimeSec: note.endTimeSec + seconds } : {}),
      ...(note.endLane !== undefined ? { endLane: note.endLane + lanes } : {}),
      ...(note.waypoints !== undefined
        ? {
            waypoints: note.waypoints.map((point) => ({
              timeSec: point.timeSec + seconds,
              lane: point.lane + lanes,
            })),
          }
        : {}),
    };
  });
  return { ...state, notes: sortNotes(shifted) };
}

/**
 * Change where a held note ends, and nothing else.
 *
 * `timeSec` is deliberately untouched: the start of a Long is the moment the player is
 * asked to press, and a grip on the far end has no business moving it. Shrinking stops at
 * `MIN_HELD_DURATION_SEC` rather than refusing, so the grip stays usable at the limit.
 */
export function resizeNote(state: ChartState, id: string, endTimeSec: number): ChartState {
  requireFiniteNumber(endTimeSec, "note endTimeSec");
  const note = state.notes.find((candidate) => candidate.id === id);
  if (!note) throw new ChartError(`no note with id ${id}`);
  if (note.endTimeSec === undefined) {
    throw new ChartError(`note ${id} has no end to move`);
  }
  if (note.endLane !== undefined) {
    throw new ChartError(`note ${id} ends in a lane, not at a length`);
  }

  const wanted = Math.max(endTimeSec, note.timeSec + MIN_HELD_DURATION_SEC);
  if (wanted === note.endTimeSec) return state;
  return {
    ...state,
    notes: state.notes.map((candidate) =>
      candidate.id === id ? { ...candidate, endTimeSec: wanted } : candidate,
    ),
  };
}

/**
 * Whether a note is a flick in its own right, rather than a note that ends in one.
 *
 * The two are different things stored in different places, and this is the one question
 * that tells them apart: a standalone Flick has its own `direction`; a Long or a Slide
 * that finishes with a flick has an `endAction`. Nothing should read one and mean the
 * other.
 */
export function isStandaloneFlick(note: ChartNote): boolean {
  return note.direction !== undefined && note.endTimeSec === undefined;
}

/**
 * Change which way a standalone Flick points.
 *
 * Only the direction changes: the time, the lane, the id and any `sourceEventId` are the
 * note's identity and its provenance, and turning an arrow round says nothing about any
 * of them.
 *
 * Deliberately separate from `setEndAction`, which changes how a Long or a Slide
 * *finishes*. Both offer Left and Right, and they write to different fields; one command
 * doing both would be one command that could not say which it meant.
 */
export function setFlickDirection(
  state: ChartState,
  id: string,
  direction: Direction,
): ChartState {
  const note = state.notes.find((candidate) => candidate.id === id);
  if (!note) throw new ChartError(`no note with id ${id}`);
  if (!isStandaloneFlick(note)) {
    throw new ChartError(`note ${id} is not a flick`);
  }
  if (!(DIRECTIONS as readonly string[]).includes(direction)) {
    throw new ChartError(`unknown direction ${direction}`);
  }
  if (note.direction === direction) return state;

  return {
    ...state,
    notes: state.notes.map((candidate) =>
      candidate.id === id ? { ...candidate, direction } : candidate,
    ),
  };
}

/**
 * Change how a note finishes, or take the end action away.
 *
 * Only the end action changes: the note's times, lanes and points are untouched, because
 * choosing to flick at the end of a Long says nothing about when the Long is.
 */
export function setEndAction(
  state: ChartState,
  id: string,
  action: NoteEndAction | null,
): ChartState {
  const note = state.notes.find((candidate) => candidate.id === id);
  if (!note) throw new ChartError(`no note with id ${id}`);

  if (action !== null) {
    if (note.endTimeSec === undefined) {
      throw new ChartError(`note ${id} has no end for an action to happen at`);
    }
    if (action.type === "flick" && action.direction === undefined) {
      throw new ChartError("an end flick needs a direction");
    }
  }

  const current = note.endAction;
  const same =
    (current === undefined && action === null) ||
    (current !== undefined &&
      action !== null &&
      current.type === action.type &&
      current.direction === action.direction);
  if (same) return state;

  const changed: Record<string, unknown> = { ...note };
  if (action === null) delete changed["endAction"];
  else changed["endAction"] = action;

  return {
    ...state,
    notes: state.notes.map((candidate) =>
      candidate.id === id ? (changed as unknown as ChartNote) : candidate,
    ),
  };
}

/** The kind of connection a run of flicks uses. */
export const FLICK_CONNECTION = "flick";

/** Connections in a stable order: by the time of the note each one starts at. */
export function orderedConnections(state: ChartState): readonly ChartConnection[] {
  const at = new Map(state.notes.map((note, index) => [note.id, index]));
  return [...state.connections].sort((a, b) => {
    const first = (at.get(a.fromNoteId) ?? 0) - (at.get(b.fromNoteId) ?? 0);
    return first !== 0 ? first : a.toNoteId.localeCompare(b.toNoteId);
  });
}

/** Every connection that touches a note, in either direction. */
export function connectionsTouching(
  state: ChartState,
  noteId: string,
): readonly ChartConnection[] {
  return state.connections.filter(
    (connection) => connection.fromNoteId === noteId || connection.toNoteId === noteId,
  );
}

/**
 * Every note in the run a note belongs to, in time order.
 *
 * A run is a simple chain - the contract forbids joining a note onwards or back to more
 * than once - so following the links from either end visits each note exactly once. A
 * note in no run is a run of one, which is what makes "is this connected" and "what is it
 * connected to" the same question.
 */
export function chainOf(state: ChartState, noteId: string): readonly ChartNote[] {
  const byId = new Map(state.notes.map((note) => [note.id, note]));
  if (!byId.has(noteId)) return [];

  const nextOf = new Map(state.connections.map((c) => [c.fromNoteId, c.toNoteId]));
  const previousOf = new Map(state.connections.map((c) => [c.toNoteId, c.fromNoteId]));

  let head = noteId;
  const guard = new Set<string>([head]);
  for (;;) {
    const before = previousOf.get(head);
    // The guard cannot fire on a valid chart - connections run forwards in time, so a
    // loop is unrepresentable - but a walk that cannot terminate is not a risk worth
    // taking with a document from elsewhere.
    if (before === undefined || guard.has(before)) break;
    guard.add(before);
    head = before;
  }

  const chain: ChartNote[] = [];
  let at: string | undefined = head;
  const seen = new Set<string>();
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    const note = byId.get(at);
    if (note) chain.push(note);
    at = nextOf.get(at);
  }
  return chain;
}

/** Whether a note has any run at all. */
export function isConnected(state: ChartState, noteId: string): boolean {
  return connectionsTouching(state, noteId).length > 0;
}

/**
 * Why a set of notes cannot be joined into one run, or null when they can.
 *
 * A pure question in one place, so the toolbar button, the inspector and the command
 * agree about when connecting is possible - and so a disabled button can say why.
 */
export function whyNotConnectableRun(
  state: ChartState,
  noteIds: readonly string[],
): string | null {
  const byId = new Map(state.notes.map((note) => [note.id, note]));
  const chosen = noteIds.map((id) => byId.get(id));
  if (chosen.some((note) => note === undefined)) return "Select notes that are in the chart";
  const notes = chosen as ChartNote[];

  if (new Set(noteIds).size < 2) return "A run needs two different notes";
  if (!notes.every((note) => note.type === "flick")) {
    return "Both must be flicks, or both slide points";
  }

  // Whole runs are joined, not loose ends: picking any note of a run means its run.
  const runs = new Map<string, readonly ChartNote[]>();
  for (const note of notes) {
    const run = chainOf(state, note.id);
    runs.set((run[0] as ChartNote).id, run);
  }
  if (runs.size < 2) return "Those notes are already in the same run";

  const spans = [...runs.values()].map((run) => ({
    from: (run[0] as ChartNote).timeSec,
    to: (run[run.length - 1] as ChartNote).timeSec,
  }));
  spans.sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i += 1) {
    if ((spans[i] as { from: number }).from <= (spans[i - 1] as { to: number }).to) {
      // Joining these would need the notes to interleave, and a run is one motion
      // travelled forwards. Refusing beats inventing an order nobody asked for.
      return "Those runs overlap in time";
    }
  }
  return null;
}

/**
 * Join notes into one run.
 *
 * Takes any mix of loose notes and existing runs: two flicks, a run and a flick, a flick
 * and a run, or two runs that do not overlap. Every note of every run named is collected,
 * ordered by time, and linked head to tail - so `Connect` can be pressed again and again
 * to grow `A - B - C - D`.
 *
 * **Nothing is merged.** Each flick keeps its id, its time, its lane, its direction and
 * its provenance, and stays a note in its own right; only the links between them are new.
 * That is the whole reason a run is stored beside the notes: an author can turn the third
 * flick of four round afterwards without the other three knowing about it.
 *
 * Ordering is by time, never by the order the author selected, so picking a pair either
 * way round gives the same run.
 */
export function connectRun(state: ChartState, noteIds: readonly string[]): ChartState {
  const why = whyNotConnectableRun(state, noteIds);
  if (why !== null) throw new ChartError(why);

  const heads = new Map<string, readonly ChartNote[]>();
  const byId = new Map(state.notes.map((note) => [note.id, note]));
  for (const id of noteIds) {
    const run = chainOf(state, (byId.get(id) as ChartNote).id);
    heads.set((run[0] as ChartNote).id, run);
  }

  const members = [...heads.values()]
    .flat()
    .slice()
    .sort((a, b) => a.timeSec - b.timeSec);

  const existing = new Set(
    state.connections.map((c) => `${c.fromNoteId}\u0000${c.toNoteId}`),
  );
  const added: ChartConnection[] = [];
  for (let i = 0; i < members.length - 1; i += 1) {
    const from = members[i] as ChartNote;
    const to = members[i + 1] as ChartNote;
    if (existing.has(`${from.id}\u0000${to.id}`)) continue;
    added.push({ type: FLICK_CONNECTION, fromNoteId: from.id, toNoteId: to.id });
  }
  if (added.length === 0) return state;
  return { ...state, connections: [...state.connections, ...added] };
}

/**
 * Take a run apart, leaving every note exactly as it was.
 *
 * Only the links go. Unlike disconnecting a Slide - where the points had been folded into
 * one note and have to be recreated with new ids - nothing here was ever merged, so there
 * is nothing to rebuild and nothing to lose.
 */
export function disconnectRun(state: ChartState, noteId: string): ChartState {
  const chain = chainOf(state, noteId);
  if (chain.length < 2) throw new ChartError(`note ${noteId} is not in a run`);

  const members = new Set(chain.map((note) => note.id));
  const kept = state.connections.filter(
    (connection) =>
      !(members.has(connection.fromNoteId) && members.has(connection.toNoteId)),
  );
  if (kept.length === state.connections.length) return state;
  return { ...state, connections: kept };
}

/** Whether a note is a slide point waiting to be joined to another. */
export function isSlidePoint(note: ChartNote): boolean {
  return note.type === "slide" && note.endTimeSec === undefined;
}

/** Whether a note is a slide of two or more points that have already been joined. */
export function isSlideChain(note: ChartNote): boolean {
  return note.type === "slide" && note.endTimeSec !== undefined;
}

/** Whether a note can take part in a Connect at all: a slide point or a slide chain. */
export function isConnectable(note: ChartNote): boolean {
  return note.type === "slide";
}

/**
 * Why two notes cannot be joined, or null when they can.
 *
 * A pure question answered in one place, so the toolbar button, the inspector button and
 * the command itself agree about when connecting is possible - and so a disabled button
 * can say why rather than just being grey.
 */
export function whyNotConnectable(a: ChartNote, b: ChartNote): string | null {
  if (a.id === b.id) return "A slide needs two different notes";
  if (!isConnectable(a) || !isConnectable(b)) {
    return "Both notes must be slide points or slides";
  }

  const first = slidePoints(a);
  const second = slidePoints(b);
  const [earlier, later] =
    (first[0] as SlideWaypoint).timeSec <= (second[0] as SlideWaypoint).timeSec
      ? [first, second]
      : [second, first];

  const earlierEnd = earlier[earlier.length - 1] as SlideWaypoint;
  const laterStart = later[0] as SlideWaypoint;
  if (laterStart.timeSec === earlierEnd.timeSec) {
    return "Two slide points at the same time cannot be connected";
  }
  if (laterStart.timeSec < earlierEnd.timeSec) {
    // Joining these would need points to interleave, and a slide is one path travelled
    // forwards. Refusing is better than inventing an order the author did not ask for.
    return "These slides overlap in time";
  }
  return null;
}

/**
 * Join slide points and slides into one chain.
 *
 * Takes any mix: two loose points, a chain and a point, a point and a chain, or two
 * chains that do not overlap. Every judgement point of every input is collected, ordered
 * by time, and written back as one note - start, `waypoints`, end. So `Connect` can be
 * pressed again and again to grow `A -> B -> C -> D`, which is the whole reason a slide
 * is authored as points rather than dragged out in one go.
 *
 * Ordering is by **time**, never by the order the author selected, so picking the pair
 * either way round gives the same slide. Two points at the same instant are not a
 * direction to travel in and are refused.
 *
 * The **earliest** note survives, keeping its id and its `sourceEventId`, so a slide
 * built from a point that cited an Analysis Event still cites it. The others are removed:
 * they have become the middle and the end of the survivor. That is the honest cost of
 * representing a slide as one note, and it is why this is a single history step - undo
 * restores every original note exactly, because history restores whole states.
 */
export function connectSlides(state: ChartState, ids: readonly string[]): ChartState {
  if (ids.length < 2) throw new ChartError("a slide needs two notes to join");

  const wanted = new Set(ids);
  if (wanted.size < 2) throw new ChartError("a slide needs two different notes");
  const joining = state.notes.filter((note) => wanted.has(note.id));
  if (joining.length !== wanted.size) {
    const present = new Set(state.notes.map((note) => note.id));
    const missing = [...wanted].filter((id) => !present.has(id));
    throw new ChartError(`no note with id ${missing.join(", ")}`);
  }

  for (let i = 0; i < joining.length; i += 1) {
    for (let j = i + 1; j < joining.length; j += 1) {
      const why = whyNotConnectable(joining[i] as ChartNote, joining[j] as ChartNote);
      if (why !== null) throw new ChartError(why);
    }
  }

  const points = joining
    .flatMap((note) => slidePoints(note))
    .slice()
    .sort((a, b) => a.timeSec - b.timeSec);

  for (let i = 1; i < points.length; i += 1) {
    if ((points[i] as SlideWaypoint).timeSec <= (points[i - 1] as SlideWaypoint).timeSec) {
      throw new ChartError("two slide points at the same time cannot be connected");
    }
  }

  const survivor = joining.reduce((earliest, note) =>
    note.timeSec < earliest.timeSec ? note : earliest,
  );
  const connected = noteFromPoints({ ...survivor, type: "slide" }, points);

  const removed = new Set(joining.map((note) => note.id));
  removed.delete(survivor.id);
  const notes = state.notes
    .filter((note) => !removed.has(note.id))
    .map((note) => (note.id === survivor.id ? connected : note));
  return { ...state, notes: sortNotes(notes) };
}

/** Join exactly two. Kept because most of the Editor connects a pair at a time. */
export function connectSlide(
  state: ChartState,
  firstId: string,
  secondId: string,
): ChartState {
  return connectSlides(state, [firstId, secondId]);
}

/**
 * Take a slide back to the standalone points it was made of.
 *
 * Every point becomes its own note. The first keeps the slide's id; the rest are **new**
 * points with new ids, because the ids they had before being folded in were retired and
 * ids are never reissued. Undo, not Disconnect, is what restores the original notes
 * exactly.
 */
export function disconnectSlide(state: ChartState, id: string): ChartState {
  const note = state.notes.find((candidate) => candidate.id === id);
  if (!note) throw new ChartError(`no note with id ${id}`);
  if (note.endTimeSec === undefined) {
    throw new ChartError(`note ${id} is not a connected slide`);
  }

  const points = slidePoints(note);
  const first = points[0] as SlideWaypoint;

  const head: Record<string, unknown> = { ...note, timeSec: first.timeSec, lane: first.lane };
  delete head["endTimeSec"];
  delete head["endLane"];
  delete head["waypoints"];
  // Standalone points have no end, so there is no moment for an end action to happen at.
  // It is dropped rather than moved onto one of the points: turning the last point into a
  // flick would silently change what the player is asked to do, and keeping it on a note
  // with no end would be a document the contract rejects. Undo restores the chain and its
  // end action together, which is the honest way back.
  delete head["endAction"];

  let nextIdSeq = state.nextIdSeq;
  const tail = points.slice(1).map((point) => {
    const fresh: ChartNote = {
      id: formatNoteId(nextIdSeq),
      type: "slide",
      timeSec: point.timeSec,
      lane: point.lane,
    };
    nextIdSeq += 1;
    return fresh;
  });

  const notes = state.notes.map((candidate) =>
    candidate.id === id ? (head as unknown as ChartNote) : candidate,
  );
  return { ...state, notes: sortNotes([...notes, ...tail]), nextIdSeq };
}

/** Delete one note by id. Unknown ids are an error, not a silent no-op. */
export function deleteNote(state: ChartState, id: string): ChartState {
  return deleteNotes(state, [id]);
}

/**
 * Delete several notes as one change.
 *
 * One call rather than a fold over `deleteNote` because the caller records history
 * around a command: deleting a rubber-banded selection should be a single step to undo,
 * not twenty. Unknown ids are an error, so a stale selection cannot silently delete
 * fewer notes than the author was looking at.
 */
export function deleteNotes(state: ChartState, ids: readonly string[]): ChartState {
  if (ids.length === 0) return state;

  const wanted = new Set(ids);
  const remaining = state.notes.filter((note) => !wanted.has(note.id));
  if (state.notes.length - remaining.length !== wanted.size) {
    const present = new Set(state.notes.map((note) => note.id));
    const missing = [...wanted].filter((id) => !present.has(id));
    throw new ChartError(`no note with id ${missing.join(", ")}`);
  }
  // A note that has gone cannot be part of a run, so the links that named it go too.
  // Deliberately without healing the gap: deleting the middle of A - B - C leaves A and C
  // unconnected rather than silently joining them, because a chart that quietly rewires
  // itself is a chart an author cannot predict. Reconnecting is one press away.
  const connections = state.connections.filter(
    (connection) => !wanted.has(connection.fromNoteId) && !wanted.has(connection.toNoteId),
  );

  // nextIdSeq is not rewound: ids must stay stable and unique for the life of the
  // document, so a deleted id is never handed out again.
  return { ...state, notes: remaining, connections };
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
