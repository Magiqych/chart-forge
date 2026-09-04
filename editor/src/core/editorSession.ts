/**
 * One authoring session: the chart, the editor settings that belong with it, whether
 * either differs from disk, and what is selected.
 *
 * Every change goes through one of the functions here, which is the point: they are the
 * editor's command boundary. Adding undo later means recording the before/after
 * `EditorSession` around each call, with nothing else to change.
 *
 * Two documents can be dirty, and they are tracked apart. Placing a note changes the
 * Chart; changing the snap division changes the Project's `editor` section. They are
 * saved together but they can fail apart - the chart is written first, and a project
 * write that fails afterwards leaves a complete chart on disk - so a single flag could
 * not describe the outcome honestly. The UI still shows one indicator; `isDirty` is what
 * it reads.
 *
 * Keeping the transitions here rather than inside React also means the rules that matter
 * - a failed save stays dirty, deleting clears the selection - are plain functions that
 * can be tested without a browser.
 */

import {
  deleteNote, noteAt, placeNote,
  type ChartNote, type ChartState, type PlaceNoteSpec,
} from "./chart";
import { DEFAULT_SNAP, type SnapSettings } from "./snap";

export interface EditorSession {
  readonly chart: ChartState;
  /**
   * Snap settings for this session, restored from `project.editor.snap` on load and
   * written back on save. Working state that the Project contract happens to persist,
   * not part of the Chart document.
   */
  readonly snap: SnapSettings;
  /** True when the in-memory chart differs from the last successful save or load. */
  readonly chartDirty: boolean;
  /** True when the project's editor settings differ from what is on disk. */
  readonly projectDirty: boolean;
  /**
   * The selected note, if any. Working state: it steers the next command, is never
   * written into either document, and never makes anything dirty.
   */
  readonly selectedNoteId: string | null;
}

/** What the UI shows: one indicator over both documents. */
export function isDirty(session: EditorSession): boolean {
  return session.chartDirty || session.projectDirty;
}

/** A freshly loaded or freshly created chart is clean: nothing has been changed yet. */
export function openSession(
  chart: ChartState,
  snap: SnapSettings = DEFAULT_SNAP,
): EditorSession {
  return { chart, snap, chartDirty: false, projectDirty: false, selectedNoteId: null };
}

/** Place a note and select it, so the next Delete acts on what was just placed. */
export function place(session: EditorSession, spec: PlaceNoteSpec): EditorSession {
  const { state, note } = placeNote(session.chart, spec);
  return { ...session, chart: state, chartDirty: true, selectedNoteId: note.id };
}

export function remove(session: EditorSession, noteId: string): EditorSession {
  const chart = deleteNote(session.chart, noteId);
  return {
    ...session,
    chart,
    chartDirty: true,
    selectedNoteId: session.selectedNoteId === noteId ? null : session.selectedNoteId,
  };
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

export function select(session: EditorSession, noteId: string | null): EditorSession {
  if (noteId === session.selectedNoteId) return session;
  return { ...session, selectedNoteId: noteId };
}

/** Select whatever note is at this point, or clear the selection when there is none. */
export function selectAt(
  session: EditorSession,
  timeSec: number,
  lane: number,
  toleranceSec: number,
): { readonly session: EditorSession; readonly hit: ChartNote | null } {
  const hit = noteAt(session.chart, timeSec, lane, toleranceSec);
  return { session: select(session, hit?.id ?? null), hit };
}

/** Both documents now match the disk. Called only after a save fully succeeded. */
export function markSaved(session: EditorSession): EditorSession {
  if (!session.chartDirty && !session.projectDirty) return session;
  return { ...session, chartDirty: false, projectDirty: false };
}

/**
 * The chart reached disk but the project did not.
 *
 * The one partial outcome the save order can produce: the chart is written first, so a
 * failure updating the project afterwards leaves a complete chart and a project that
 * does not yet reference it or still holds the previous settings. Saying the chart is
 * clean is the truth; the project stays dirty and the next save finishes the job.
 */
export function markChartSaved(session: EditorSession): EditorSession {
  return { ...session, chartDirty: false, projectDirty: true };
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
