/**
 * Undo history for the Chart document.
 *
 * A past/present/future triple over whole `ChartState` values. That is affordable
 * because a chart state is immutable and every command already returns a new one: the
 * entries share all the notes that did not change, so a step of history costs one small
 * object rather than a copy of the document.
 *
 * Storing states rather than commands is also what makes redo *restore* rather than
 * *re-run*. Replaying a `place` would mint a fresh note id; putting the previous state
 * back returns the note that existed, with its id, its time and its `sourceEventId`
 * intact - which is the whole point of being able to undo a misplacement.
 *
 * Two things deliberately do not rewind with the rest:
 *
 *  - `saved` is the state that matches the disk, held by reference. Whether the chart is
 *    dirty is then an identity comparison, so undoing back to what was saved reports
 *    clean without anyone having to track edit counts.
 *  - `issuedIdSeq` is a high-water mark for note ids. Undo puts the counter back, but an
 *    id that was once handed out must never be handed out again, or a note the author
 *    undid and a note they placed afterwards would share an identity.
 *
 * Nothing here knows about React, and no renderer ever sees this: the canvas is given
 * `present` and nothing else.
 */

import type { ChartState } from "./chart";

export interface ChartHistory {
  /** Older states, oldest first. */
  readonly past: readonly ChartState[];
  readonly present: ChartState;
  /** Undone states, nearest-to-present first. */
  readonly future: readonly ChartState[];
  /** The state last written to disk, or last loaded from it. */
  readonly saved: ChartState | null;
  /** The highest note-id sequence handed out this session. Never rewound. */
  readonly issuedIdSeq: number;
}

/**
 * How many steps back the author can go.
 *
 * Bounded so a long session cannot grow without limit. Trimming can drop the saved
 * state out of `past`, which only means it is no longer reachable by undo - `saved` is
 * held separately, so the dirty indicator stays correct either way.
 */
export const MAX_HISTORY = 200;

/** A freshly loaded or created chart: nothing to undo, and it matches the disk. */
export function openHistory(chart: ChartState): ChartHistory {
  return {
    past: [],
    present: chart,
    future: [],
    saved: chart,
    issuedIdSeq: chart.nextIdSeq,
  };
}

export function canUndo(history: ChartHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: ChartHistory): boolean {
  return history.future.length > 0;
}

/** True when the chart in memory differs from the one on disk. */
export function isChartDirty(history: ChartHistory): boolean {
  return history.present !== history.saved;
}

/**
 * The state a command should build on.
 *
 * Identical to `present` except after an undo, when the id counter it carries has gone
 * backwards. Bumping it here means a new edit made after undoing continues past every id
 * ever issued, rather than reusing one that a discarded redo branch had already used.
 */
export function baseForCommand(history: ChartHistory): ChartState {
  const { present, issuedIdSeq } = history;
  if (present.nextIdSeq >= issuedIdSeq) return present;
  return { ...present, nextIdSeq: issuedIdSeq };
}

/**
 * Record the result of a successful command.
 *
 * A command that changed nothing returns the same state and is not recorded: pressing
 * undo should step over the author's real edits, not over their no-ops.
 *
 * Recording discards the redo branch. Once the author edits from an undone position,
 * the states they had undone are no longer reachable - that is what makes undo a line
 * rather than a tree, and it is what everyone expects.
 */
export function record(history: ChartHistory, next: ChartState): ChartHistory {
  if (next === history.present) return history;

  const past = [...history.past, history.present];
  return {
    past: past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past,
    present: next,
    future: [],
    saved: history.saved,
    issuedIdSeq: Math.max(history.issuedIdSeq, next.nextIdSeq),
  };
}

export function undo(history: ChartHistory): ChartHistory {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: ChartHistory): ChartHistory {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    ...history,
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

/**
 * The present state is now what is on disk.
 *
 * History is deliberately left alone. Saving is not a barrier the author has to work
 * forwards from: after saving they can still undo the edits that went into it, and the
 * chart will simply report itself dirty again because `present` no longer matches
 * `saved`.
 */
export function markSaved(history: ChartHistory): ChartHistory {
  if (history.saved === history.present) return history;
  return { ...history, saved: history.present };
}
