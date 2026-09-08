/**
 * Copy and paste, for whatever is selected.
 *
 * There was no clipboard in this Editor before decorations arrived, for notes or for
 * anything else. One is added here rather than a decorations-only clipboard because a
 * clipboard that copied captions but not the notes beside them would be a worse thing to
 * have than none: an author who selected a bar's worth of work and pressed Ctrl+C would
 * get half of it, silently.
 *
 * What is copied is a *description*, not the objects. Every id is dropped on the way in
 * and minted fresh on the way out, so pasting can never produce two objects with one
 * identity - and pasting twice produces two independent copies rather than the same one
 * twice. Times are stored relative to the earliest thing in the selection, so a paste
 * lands where the author asks and keeps the shape of what they copied.
 *
 * Connections come along when both of the notes they join were copied, and are dropped
 * when only one was. A run is a relation between two notes; half a run is not a run, and
 * inventing a link to a note that was not copied would put a claim in the document the
 * author never made.
 *
 * Pure and free of React, so the whole of it can be tested without a keyboard.
 */

import {
  placeDecoration, placeNote,
  type ChartConnection, type ChartNote, type ChartState,
} from "./chart";
import type { ChartDecoration } from "./decoration";

/** One copied note, with its time expressed relative to the selection. */
interface CopiedNote {
  readonly offsetSec: number;
  readonly note: ChartNote;
}

interface CopiedDecoration {
  readonly offsetSec: number;
  readonly decoration: ChartDecoration;
}

/**
 * What the clipboard holds.
 *
 * Held by the application rather than by the session: copying changes no document, makes
 * nothing dirty, and must survive an undo. It is plain data so it can be handed straight
 * back to `pasteInto`.
 */
export interface Clipboard {
  readonly notes: readonly CopiedNote[];
  readonly decorations: readonly CopiedDecoration[];
  /** Links whose two notes were both copied, by index into `notes`. */
  readonly connections: readonly {
    readonly type: string;
    readonly from: number;
    readonly to: number;
  }[];
}

export const EMPTY_CLIPBOARD: Clipboard = { notes: [], decorations: [], connections: [] };

export function isClipboardEmpty(clipboard: Clipboard): boolean {
  return clipboard.notes.length === 0 && clipboard.decorations.length === 0;
}

/** How many objects a clipboard holds. */
export function clipboardSize(clipboard: Clipboard): number {
  return clipboard.notes.length + clipboard.decorations.length;
}

/**
 * Take a copy of a selection.
 *
 * The anchor is the earliest moment anything in the selection occupies, so every offset
 * is at or after zero and a paste at time t puts the earliest object exactly at t. That
 * is the behaviour an author can predict: what they paste starts where they asked.
 */
export function copySelection(
  state: ChartState,
  noteIds: readonly string[],
  decorationIds: readonly string[],
): Clipboard {
  const wantedNotes = new Set(noteIds);
  const wantedDecorations = new Set(decorationIds);
  const notes = state.notes.filter((note) => wantedNotes.has(note.id));
  const decorations = state.decorations.filter((d) => wantedDecorations.has(d.id));
  if (notes.length === 0 && decorations.length === 0) return EMPTY_CLIPBOARD;

  let anchor = Number.POSITIVE_INFINITY;
  for (const note of notes) anchor = Math.min(anchor, note.timeSec);
  for (const decoration of decorations) anchor = Math.min(anchor, decoration.startTimeSec);

  const index = new Map(notes.map((note, at) => [note.id, at]));
  const connections = state.connections.flatMap((connection: ChartConnection) => {
    const from = index.get(connection.fromNoteId);
    const to = index.get(connection.toNoteId);
    if (from === undefined || to === undefined) return [];
    return [{ type: connection.type, from, to }];
  });

  return {
    notes: notes.map((note) => ({ offsetSec: note.timeSec - anchor, note })),
    decorations: decorations.map((decoration) => ({
      offsetSec: decoration.startTimeSec - anchor,
      decoration,
    })),
    connections,
  };
}

export interface PasteResult {
  readonly state: ChartState;
  readonly noteIds: readonly string[];
  readonly decorationIds: readonly string[];
}

/**
 * Paste a clipboard so that its earliest object lands at `atSec`.
 *
 * Everything goes in through the ordinary place commands, so a pasted object is minted
 * and validated exactly as a placed one is - it gets the next id in sequence, it is
 * rejected if it would fall outside the playfield, and the state that comes back is a
 * state the rest of the Editor already knows how to handle.
 *
 * Relative time and relative lane are preserved; the lane is shifted only if the paste
 * would otherwise leave the playfield, and then by the least that fixes it, so a chord
 * keeps its shape. A decoration's position is copied unchanged: it is a place on the
 * playfield rather than an offset from anything, and moving it because the author pasted
 * at a different second would be moving it for no reason they could see.
 */
export function pasteInto(
  state: ChartState,
  clipboard: Clipboard,
  atSec: number,
): PasteResult {
  if (isClipboardEmpty(clipboard)) {
    return { state, noteIds: [], decorationIds: [] };
  }
  const start = Math.max(0, atSec);

  // Keep a chord's shape when it would otherwise be pasted off the edge.
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const { note } of clipboard.notes) {
    for (const lane of [note.lane, note.endLane ?? note.lane]) {
      lowest = Math.min(lowest, lane);
      highest = Math.max(highest, lane);
    }
    for (const point of note.waypoints ?? []) {
      lowest = Math.min(lowest, point.lane);
      highest = Math.max(highest, point.lane);
    }
  }
  let laneShift = 0;
  if (Number.isFinite(lowest)) {
    if (highest > state.laneCount - 1) laneShift = state.laneCount - 1 - highest;
    if (lowest + laneShift < 0) laneShift = -lowest;
  }

  let next = state;
  const noteIds: string[] = [];
  for (const { offsetSec, note } of clipboard.notes) {
    const placed = placeNote(next, {
      timeSec: start + offsetSec,
      lane: note.lane + laneShift,
      // The kind is carried through verbatim, including one this Editor cannot author:
      // copying a chart's own notes must not quietly change what they are.
      type: note.type as never,
      ...(note.endTimeSec !== undefined
        ? { endTimeSec: start + offsetSec + (note.endTimeSec - note.timeSec) }
        : {}),
      ...(note.endLane !== undefined ? { endLane: note.endLane + laneShift } : {}),
      ...(note.direction !== undefined ? { direction: note.direction } : {}),
      ...(note.endAction !== undefined ? { endAction: note.endAction } : {}),
      ...(note.waypoints !== undefined
        ? {
            waypoints: note.waypoints.map((point) => ({
              timeSec: start + offsetSec + (point.timeSec - note.timeSec),
              lane: point.lane + laneShift,
            })),
          }
        : {}),
      // `sourceEventId` is deliberately not copied. It records the event the author was
      // looking at when they placed *that* note; a copy was not placed by looking at
      // anything, and claiming otherwise would put provenance in the document that never
      // happened.
    });
    next = placed.state;
    noteIds.push(placed.note.id);
  }

  const decorationIds: string[] = [];
  for (const { offsetSec, decoration } of clipboard.decorations) {
    const placed = placeDecoration(next, {
      type: decoration.type,
      startTimeSec: start + offsetSec,
      ...(decoration.endTimeSec !== undefined
        ? {
            endTimeSec:
              start + offsetSec + (decoration.endTimeSec - decoration.startTimeSec),
          }
        : {}),
      position: decoration.position,
      ...(decoration.text !== undefined ? { text: decoration.text } : {}),
      ...(decoration.style !== undefined ? { style: decoration.style } : {}),
      ...(decoration.animation !== undefined ? { animation: decoration.animation } : {}),
      ...(decoration.zIndex !== undefined ? { zIndex: decoration.zIndex } : {}),
    });
    next = placed.state;
    decorationIds.push(placed.decoration.id);
  }

  // Rebuilt against the new ids, so a copied run is a run between the copies rather than
  // a second link to the originals.
  if (clipboard.connections.length > 0) {
    const rebuilt = clipboard.connections.flatMap((link) => {
      const from = noteIds[link.from];
      const to = noteIds[link.to];
      return from !== undefined && to !== undefined
        ? [{ type: link.type, fromNoteId: from, toNoteId: to }]
        : [];
    });
    if (rebuilt.length > 0) {
      next = { ...next, connections: [...next.connections, ...rebuilt] };
    }
  }

  return { state: next, noteIds, decorationIds };
}
