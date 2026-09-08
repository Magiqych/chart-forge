/**
 * What a press in the chart lanes means.
 *
 * The rule lives here, as a pure function, rather than inside the timeline component,
 * for two reasons. It is the one place the Edit/Select split is actually decided, so it
 * is the one place that has to be right; and a decision made from arguments can be tested
 * exhaustively, where the same decision made halfway through a pointer handler can only
 * be tested by driving a canvas.
 *
 * The decision is taken on pointer *down*, from the mode the author chose, and never
 * revisited. Nothing here looks at how far the pointer subsequently moved: a drag means
 * "rubber-band" in Select and "draw this note out" in Edit because of the mode, not
 * because of its length. Inferring the intent from the gesture is what makes the same
 * movement mean different things on different days.
 */

import { isBoundedPlaceable, type EditorMode, type PlaceableType } from "./chart";
import type { NotePart } from "./noteGeometry";

/** Which end of a held note a grip belongs to. */
export type ResizeEdge = "start" | "end";

export type PointerIntent =
  /**
   * Replace the selection with this one note, and be ready to move it.
   *
   * Selecting happens immediately; moving happens only if the pointer actually travels.
   * That is direct manipulation rather than a guess about modes: the note is already
   * selected either way, and a drag simply carries the selection with it.
   */
  | { readonly kind: "selectOne"; readonly noteId: string }
  /**
   * Take hold of one of the grips on a held note.
   *
   * Which end is carried in `edge` rather than split into two intents, because everything
   * downstream does the same thing with either: it snaps one time and leaves the other
   * alone. Two intents would be two paths through the same gesture, and the second one
   * would be the one that stopped snapping.
   */
  | { readonly kind: "startResize"; readonly noteId: string; readonly edge: ResizeEdge }
  /** Add this note to the selection, or drop it if it was already there. */
  | { readonly kind: "toggleSelected"; readonly noteId: string }
  /** Begin a rubber band. `add` keeps whatever was already selected. */
  | { readonly kind: "startMarquee"; readonly add: boolean }
  /** Begin drawing out a note that has a duration. */
  | { readonly kind: "startDrag"; readonly type: PlaceableType }
  /** Place a note here and now. */
  | { readonly kind: "place"; readonly type: PlaceableType }
  /** Do nothing at all. */
  | { readonly kind: "ignore" };

export interface PointerContext {
  readonly mode: EditorMode;
  /** The kind Edit Mode would place. Ignored entirely in Select Mode. */
  readonly noteType: PlaceableType;
  /** The note under the pointer, if any. */
  readonly hitNoteId: string | null;
  /** Which part of that note the pointer is nearest. */
  readonly hitPart: NotePart | null;
  /**
   * Whether that note is already selected.
   *
   * The resize grips are only drawn on a selected note, so they are only grippable on
   * one: a handle you cannot see must not be a handle you can accidentally grab.
   */
  readonly hitSelected: boolean;
  readonly shiftKey: boolean;
}

export function pointerIntent(context: PointerContext): PointerIntent {
  const { mode, noteType, hitNoteId, hitPart, hitSelected, shiftKey } = context;

  if (mode === "select") {
    // Select Mode chooses and edits what is already there. It never creates a note,
    // however far the pointer travels.
    if (hitNoteId !== null) {
      if (shiftKey) return { kind: "toggleSelected", noteId: hitNoteId };
      if (hitSelected && (hitPart === "resizeHandle" || hitPart === "startHandle")) {
        return {
          kind: "startResize",
          noteId: hitNoteId,
          edge: hitPart === "startHandle" ? "start" : "end",
        };
      }
      return { kind: "selectOne", noteId: hitNoteId };
    }
    return { kind: "startMarquee", add: shiftKey };
  }

  // Edit Mode makes things. Landing on a note that is already there does nothing:
  // stacking a second note on top of the first is a mistake every time, and quietly
  // selecting it instead would mix the two modes back together - which is the confusion
  // the modes exist to remove.
  if (hitNoteId !== null) return { kind: "ignore" };

  return isBoundedPlaceable(noteType)
    ? { kind: "startDrag", type: noteType }
    : { kind: "place", type: noteType };
}
