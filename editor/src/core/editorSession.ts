/**
 * One authoring session: the chart and its undo history, the editor settings that
 * belong with it, whether either differs from disk, and what is selected.
 *
 * Every change goes through one of the functions here, which is the point: they are the
 * editor's command boundary. Nothing in the UI touches the history directly - a click
 * calls a command, the command produces a new chart state, and recording it is this
 * module's business.
 *
 * Two documents can be dirty, and they are tracked apart. The Chart is dirty when the
 * state in memory is not the one on disk - an identity comparison, so undoing back to
 * what was saved reports clean by construction. The Project is dirty when the snap
 * settings have changed; those are not undoable, because undo is for authoring the
 * chart and a tool setting is not part of the document being authored. They are saved
 * together but can fail apart - the chart is written first, and a project write that
 * fails afterwards leaves a complete chart on disk - so one flag could not describe the
 * outcome honestly. The UI still shows one indicator; `isDirty` is what it reads.
 *
 * Keeping the transitions here rather than inside React also means the rules that matter
 * - a failed save stays dirty, undo cannot leave a selection pointing at a note that no
 * longer exists - are plain functions that can be tested without a browser.
 */

import {
  chainOf, connectRun, connectSlides, deleteNotes, disconnectRun, disconnectSlide,
  isConnected, moveNotes, noteAt, placeNote, resizeNote, setEndAction,
  setFlickDirection, whyNotConnectable, whyNotConnectableRun,
  type NoteEndAction,
  type ChartNote, type ChartState, type Direction, type PlaceableType, type PlaceNoteSpec,
} from "./chart";
import {
  baseForCommand, canRedo, canUndo, isChartDirty as historyDirty,
  markSaved as historyMarkSaved, openHistory, record,
  redo as historyRedo, undo as historyUndo,
  type ChartHistory,
} from "./chartHistory";
import { DEFAULT_SNAP, type SnapMode, type SnapSettings } from "./snap";

export interface EditorSession {
  /** The chart, the states around it, and which one matches the disk. */
  readonly history: ChartHistory;
  /**
   * Snap settings for this session, restored from `project.editor.snap` on load and
   * written back on save. A tool setting, not part of the document, so it is not
   * undoable.
   */
  readonly snap: SnapSettings;
  /**
   * Which of beat and Analysis Event snapping is active.
   *
   * Working state. `off` and `beat` are recoverable from the persisted `snap.enabled`;
   * `event` is not, because the contract's snap object has no room for a third mode, so
   * it reads back as `off` after a reload.
   */
  readonly snapMode: SnapMode;
  /** True when the project's editor settings differ from what is on disk. */
  readonly projectDirty: boolean;
  /**
   * The selected notes, in the order they were added.
   *
   * A plain readonly array rather than a Set: React state is replaced, never mutated,
   * and an array of a handful of ids compares and renders predictably where a mutable
   * Set quietly shared between renders would not. Selections are small - a rubber band
   * over a busy bar, not the whole chart - so membership tests over one are cheap.
   *
   * Working state throughout: it steers the next command, is never written into either
   * document, and never makes anything dirty.
   */
  readonly selectedNoteIds: readonly string[];
  /**
   * The selected Analysis Event, if any.
   *
   * Held apart from `selectedNoteIds` on purpose: one is a guide object the author is
   * consulting, the other an authoring object they own, and conflating them is exactly
   * the confusion this Editor exists to avoid. Temporary state - it reaches neither the
   * Chart nor the Project, selecting an event dirties nothing, and undo does not touch
   * it, because looking at the analysis is not editing.
   */
  readonly selectedEventId: string | null;
}

/** How many notes are selected. */
export function selectionCount(session: EditorSession): number {
  return session.selectedNoteIds.length;
}

export function isSelected(session: EditorSession, noteId: string): boolean {
  return session.selectedNoteIds.includes(noteId);
}

/**
 * The one selected note, when there is exactly one.
 *
 * The inspector shows a note's details only when a single note is selected; with several
 * it shows a summary instead, because twenty detail panels answer no question anyone was
 * asking.
 */
export function soleSelectedId(session: EditorSession): string | null {
  return session.selectedNoteIds.length === 1 ? (session.selectedNoteIds[0] as string) : null;
}

/** The chart as it stands now. */
export function chartOf(session: EditorSession): ChartState {
  return session.history.present;
}

export function isChartDirty(session: EditorSession): boolean {
  return historyDirty(session.history);
}

/** What the UI shows: one indicator over both documents. */
export function isDirty(session: EditorSession): boolean {
  return isChartDirty(session) || session.projectDirty;
}

export function canUndoSession(session: EditorSession): boolean {
  return canUndo(session.history);
}

export function canRedoSession(session: EditorSession): boolean {
  return canRedo(session.history);
}

/** A freshly loaded or freshly created chart is clean: nothing has been changed yet. */
export function openSession(
  chart: ChartState,
  snap: SnapSettings = DEFAULT_SNAP,
): EditorSession {
  return {
    history: openHistory(chart),
    snap,
    snapMode: snap.enabled ? "beat" : "off",
    projectDirty: false,
    selectedNoteIds: [],
    selectedEventId: null,
  };
}

/** Place a note and select it, so the next Delete acts on what was just placed. */
export function place(session: EditorSession, spec: PlaceNoteSpec): EditorSession {
  const { state, note } = placeNote(baseForCommand(session.history), spec);
  return {
    ...session,
    history: record(session.history, state),
    selectedNoteIds: [note.id],
  };
}

/**
 * Place a note at a time the author took from an Analysis Event they selected.
 *
 * The separation from `place` is the whole design. This is a second, deliberate
 * authoring action after selecting an event - selecting one creates nothing - and the
 * caller still supplies the lane and the type, which no property of the event
 * influences. What the event contributes is one number, its measured start, plus its id
 * recorded as provenance.
 *
 * The time arrives already decided and is not snapped again: the author picked this
 * event precisely because they wanted where the sound actually is, and pulling it back
 * onto the beat grid would throw away the reason for the whole gesture.
 */
export function placeAtEvent(
  session: EditorSession,
  event: { readonly id: string; readonly startSec: number },
  lane: number,
  type: PlaceableType,
  direction?: Direction,
): EditorSession {
  const { state, note } = placeNote(baseForCommand(session.history), {
    timeSec: event.startSec,
    lane,
    type,
    ...(direction !== undefined ? { direction } : {}),
    sourceEventId: event.id,
  });
  // The event stays selected: placing one note from it is not a reason to stop looking
  // at it, and an author may want a second note in another lane at the same instant.
  return {
    ...session,
    history: record(session.history, state),
    selectedNoteIds: [note.id],
  };
}

export function remove(session: EditorSession, noteId: string): EditorSession {
  return removeMany(session, [noteId]);
}

/**
 * Delete several notes as one command.
 *
 * One history step, whether it is one note or twenty: the author made one decision, so
 * one press of undo should reverse it. Building it out of repeated single deletes would
 * bury that decision under twenty steps to walk back through.
 */
export function removeMany(
  session: EditorSession,
  noteIds: readonly string[],
): EditorSession {
  if (noteIds.length === 0) return session;
  const chart = deleteNotes(chartOf(session), noteIds);
  const gone = new Set(noteIds);
  return {
    ...session,
    history: record(session.history, chart),
    selectedNoteIds: session.selectedNoteIds.filter((id) => !gone.has(id)),
  };
}

/**
 * Move the selection in time and across lanes, as one command.
 *
 * One history step for the whole drag, recorded when the pointer comes up. The preview
 * during the drag lives in the timeline and never reaches here, so undo reverses the move
 * the author made rather than the hundred pointer events it was made of.
 */
export function moveSelected(
  session: EditorSession,
  deltaSec: number,
  deltaLane: number,
): EditorSession {
  if (session.selectedNoteIds.length === 0) return session;
  const chart = moveNotes(chartOf(session), session.selectedNoteIds, deltaSec, deltaLane);
  if (chart === chartOf(session)) return session;
  return { ...session, history: record(session.history, chart) };
}

/** Change where a held note ends. One history step for the whole drag. */
export function resize(
  session: EditorSession,
  noteId: string,
  endTimeSec: number,
): EditorSession {
  const chart = resizeNote(chartOf(session), noteId, endTimeSec);
  if (chart === chartOf(session)) return session;
  return { ...session, history: record(session.history, chart) };
}

/**
 * Turn a standalone Flick round. One history step.
 *
 * Reselecting the direction it already has records nothing: an author checking which way
 * a flick points should not fill the undo stack by looking.
 */
export function changeFlickDirection(
  session: EditorSession,
  noteId: string,
  direction: Direction,
): EditorSession {
  const chart = setFlickDirection(chartOf(session), noteId, direction);
  if (chart === chartOf(session)) return session;
  return { ...session, history: record(session.history, chart) };
}

/**
 * Change how the selected note finishes. One history step.
 *
 * Available after the note exists as well as while placing it, because deciding that a
 * Long ends in a flick is a judgement an author makes listening back, not one they always
 * have when they draw the note out.
 */
export function changeEndAction(
  session: EditorSession,
  noteId: string,
  action: NoteEndAction | null,
): EditorSession {
  const chart = setEndAction(chartOf(session), noteId, action);
  if (chart === chartOf(session)) return session;
  return { ...session, history: record(session.history, chart) };
}

/**
 * Whether the current selection can be joined, and why not if it cannot.
 *
 * One button, two meanings, chosen by what is selected rather than by a mode: two slide
 * points make a slide, two flicks make a run of flicks. Nothing joins across the two -
 * a slide and a flick are different things to do and there is no sensible way to run them
 * together - and a note that is neither is simply not connectable.
 *
 * Asked in one place so the toolbar button, the inspector button and the commands agree
 * about when connecting is possible, and so a disabled button can say why.
 */
export function connectableSelection(session: EditorSession): {
  readonly ok: boolean;
  readonly why: string;
  /** Which command would run. `null` when none would. */
  readonly kind: "slide" | "run" | null;
} {
  const ids = session.selectedNoteIds;
  if (ids.length !== 2) {
    return { ok: false, why: "Select exactly two notes to join", kind: null };
  }
  const chart = chartOf(session);
  const notes = ids.flatMap((id) => {
    const note = chart.notes.find((candidate) => candidate.id === id);
    return note ? [note] : [];
  });
  if (notes.length !== 2) {
    return { ok: false, why: "Select exactly two notes to join", kind: null };
  }

  const [first, second] = notes as [ChartNote, ChartNote];

  if (first.type === "flick" && second.type === "flick") {
    const why = whyNotConnectableRun(chart, ids);
    if (why !== null) return { ok: false, why, kind: "run" };
    const size = chainOf(chart, first.id).length + chainOf(chart, second.id).length;
    return { ok: true, why: `Join these into a run of ${size} flicks`, kind: "run" };
  }

  if (first.type === "slide" && second.type === "slide") {
    const why = whyNotConnectable(first, second);
    if (why !== null) return { ok: false, why, kind: "slide" };
    const points = notes.reduce(
      (total, note) =>
        total + (note.waypoints?.length ?? 0) + (note.endTimeSec === undefined ? 1 : 2),
      0,
    );
    return { ok: true, why: `Join these into one ${points}-point slide`, kind: "slide" };
  }

  return {
    ok: false,
    why: "Join two slide points, or two flicks - not one of each",
    kind: null,
  };
}

/**
 * Join the two selected slide points, leaving the resulting slide selected.
 *
 * The selection is rewritten rather than left alone: one of the two ids no longer names
 * anything, and a selection holding a note that has gone would arm Delete against
 * nothing.
 */
export function connect(session: EditorSession): EditorSession {
  const ids = session.selectedNoteIds;
  if (ids.length !== 2) return session;
  const { kind } = connectableSelection(session);
  if (kind === "run") return connectFlickRun(session);
  if (kind !== "slide") return session;

  const before = chartOf(session);
  const chart = connectSlides(before, ids);
  const survivor = chart.notes.find((note) => ids.includes(note.id));
  return {
    ...session,
    history: record(session.history, chart),
    selectedNoteIds: survivor ? [survivor.id] : [],
  };
}

/**
 * Join the selected flicks into one run, and select the whole run.
 *
 * Unlike connecting slide points, no note is consumed: every flick survives with its own
 * id, time, lane and direction, and only the links are new. Selecting the whole run
 * afterwards is what makes the result visible - and clicking one of its flicks still
 * selects just that one, which is how the third of four gets turned round.
 */
export function connectFlickRun(session: EditorSession): EditorSession {
  const ids = session.selectedNoteIds;
  if (ids.length < 2) return session;
  const chart = connectRun(chartOf(session), ids);
  if (chart === chartOf(session)) return session;
  return {
    ...session,
    history: record(session.history, chart),
    selectedNoteIds: chainOf(chart, ids[0] as string).map((note) => note.id),
  };
}

/** Take a run of flicks apart. Every note stays exactly as it was. */
export function disconnectFlickRun(
  session: EditorSession,
  noteId: string,
): EditorSession {
  const before = chartOf(session);
  const chart = disconnectRun(before, noteId);
  if (chart === before) return session;
  return {
    ...session,
    history: record(session.history, chart),
    selectedNoteIds: chainOf(before, noteId).map((note) => note.id),
  };
}

/** Whether the selection is one run of flicks that could be taken apart. */
export function disconnectableRun(session: EditorSession): string | null {
  const ids = session.selectedNoteIds;
  if (ids.length === 0) return null;
  const chart = chartOf(session);
  const first = ids[0] as string;
  if (!isConnected(chart, first)) return null;
  const chain = chainOf(chart, first).map((note) => note.id);
  // Every selected note has to belong to the one run, so the button never takes apart
  // something the author cannot see is selected.
  return ids.every((id) => chain.includes(id)) ? first : null;
}

/** Take a connected slide back to two points, both left selected. */
export function disconnect(session: EditorSession, noteId: string): EditorSession {
  const before = chartOf(session);
  const chart = disconnectSlide(before, noteId);
  const existing = new Set(before.notes.map((note) => note.id));
  const fresh = chart.notes.find((note) => !existing.has(note.id));
  return {
    ...session,
    history: record(session.history, chart),
    selectedNoteIds: fresh ? [noteId, fresh.id] : [noteId],
  };
}

/** Delete everything currently selected, as one command. */
export function removeSelected(session: EditorSession): EditorSession {
  return removeMany(session, session.selectedNoteIds);
}

/**
 * Step back one authoring command.
 *
 * Only the chart moves. The viewport, the playhead, the layer visibility, the snap
 * settings and the selected Analysis Event all stay where they are: undo is for taking
 * back an edit to the document, not for rewinding where the author happens to be
 * looking.
 */
export function undo(session: EditorSession): EditorSession {
  const history = historyUndo(session.history);
  if (history === session.history) return session;
  return { ...session, history, selectedNoteIds: survivingSelection(session, history) };
}

export function redo(session: EditorSession): EditorSession {
  const history = historyRedo(session.history);
  if (history === session.history) return session;
  return { ...session, history, selectedNoteIds: survivingSelection(session, history) };
}

/**
 * Keep the selection only if the note it names still exists.
 *
 * Undoing a placement removes the note that was selected, and a selection pointing at
 * nothing would leave Delete enabled with no target. The selection is kept rather than
 * always cleared so that undoing an unrelated edit does not make the author re-select
 * what they were working on.
 */
function survivingSelection(
  session: EditorSession,
  history: ChartHistory,
): readonly string[] {
  if (session.selectedNoteIds.length === 0) return session.selectedNoteIds;
  const present = new Set(history.present.notes.map((note) => note.id));
  const kept = session.selectedNoteIds.filter((id) => present.has(id));
  return kept.length === session.selectedNoteIds.length ? session.selectedNoteIds : kept;
}

/**
 * Change the snap settings.
 *
 * Dirties the project rather than the chart: snapping decides where a *future* note
 * lands and changes nothing about the notes already placed. Setting the same values
 * again is not a change, so idly reopening a dropdown does not ask for a save.
 */
export function setSnap(session: EditorSession, snap: SnapSettings): EditorSession {
  if (snap.enabled === session.snap.enabled && snap.division === session.snap.division) {
    return session;
  }
  return { ...session, snap, projectDirty: true };
}

/**
 * Choose which kind of snapping is active.
 *
 * Only `beat` corresponds to the persisted `snap.enabled`, so switching to or from it is
 * a project change; switching between `off` and `event` is not, since both leave the
 * stored settings saying the same thing. The division is untouched either way, so
 * turning beat snapping off and on again returns to the subdivision that was chosen.
 */
export function setSnapMode(session: EditorSession, mode: SnapMode): EditorSession {
  if (mode === session.snapMode) return session;
  const enabled = mode === "beat";
  const snapChanged = enabled !== session.snap.enabled;
  return {
    ...session,
    snapMode: mode,
    snap: { ...session.snap, enabled },
    projectDirty: session.projectDirty || snapChanged,
  };
}

/**
 * Select or clear the Analysis Event the author is consulting.
 *
 * Dirties nothing: the Analysis is read-only guidance, and pointing at part of it
 * changes no document.
 */
export function selectEvent(session: EditorSession, eventId: string | null): EditorSession {
  if (eventId === session.selectedEventId) return session;
  return { ...session, selectedEventId: eventId };
}

/** Replace the selection with one note, or clear it. */
export function select(session: EditorSession, noteId: string | null): EditorSession {
  return selectMany(session, noteId === null ? [] : [noteId]);
}

/** Replace the selection outright, as a rubber band does. */
export function selectMany(
  session: EditorSession,
  noteIds: readonly string[],
): EditorSession {
  if (sameSelection(session.selectedNoteIds, noteIds)) return session;
  return { ...session, selectedNoteIds: [...noteIds] };
}

/** Add notes to the selection, as a shift-drag does. Already-selected ids stay put. */
export function addToSelection(
  session: EditorSession,
  noteIds: readonly string[],
): EditorSession {
  if (noteIds.length === 0) return session;
  const have = new Set(session.selectedNoteIds);
  const added = noteIds.filter((id) => !have.has(id));
  if (added.length === 0) return session;
  return { ...session, selectedNoteIds: [...session.selectedNoteIds, ...added] };
}

/** Add a note if it is not selected, remove it if it is. What shift-click does. */
export function toggleSelected(session: EditorSession, noteId: string): EditorSession {
  return isSelected(session, noteId)
    ? { ...session, selectedNoteIds: session.selectedNoteIds.filter((id) => id !== noteId) }
    : { ...session, selectedNoteIds: [...session.selectedNoteIds, noteId] };
}

export function clearSelection(session: EditorSession): EditorSession {
  return selectMany(session, []);
}

function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Select whatever note is at this point, or clear the selection when there is none. */
export function selectAt(
  session: EditorSession,
  timeSec: number,
  lane: number,
  toleranceSec: number,
): { readonly session: EditorSession; readonly hit: ChartNote | null } {
  const hit = noteAt(chartOf(session), timeSec, lane, toleranceSec);
  return { session: select(session, hit?.id ?? null), hit };
}

/**
 * Both documents now match the disk. Called only after a save fully succeeded.
 *
 * The undo history survives: saving is not a barrier the author has to work forwards
 * from, and undoing past a save simply makes the chart dirty again.
 */
export function markSaved(session: EditorSession): EditorSession {
  return { ...session, history: historyMarkSaved(session.history), projectDirty: false };
}

/**
 * The chart reached disk but the project did not.
 *
 * The one partial outcome the save order can produce: the chart is written first, so a
 * failure updating the project afterwards leaves a complete chart and a project that
 * does not yet reference it or still holds the previous settings. The chart's saved
 * baseline moves to what was actually written - it is on disk, and undoing past it
 * should report dirty - while the project stays dirty and the next save finishes the job.
 */
export function markChartSaved(session: EditorSession): EditorSession {
  return { ...session, history: historyMarkSaved(session.history), projectDirty: true };
}

/**
 * A save failed before anything reached disk.
 *
 * The session is returned unchanged, which is the whole point of having this function
 * exist rather than nothing: the work is still only in memory, so the editor stays
 * dirty and the author keeps being told there is something to save.
 */
export function markSaveFailed(session: EditorSession): EditorSession {
  return session;
}
