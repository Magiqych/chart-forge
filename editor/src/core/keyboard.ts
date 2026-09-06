/**
 * Whether a key press belongs to the page or to something the browser is already
 * editing.
 *
 * The Editor has one keyboard listener on the window, which means it sees every key the
 * application gets - including the ones typed into a text field or used to operate a
 * select. Taking Space or an arrow away from those would break them, so every binding
 * checks here first.
 *
 * A pure function of the three facts that matter, so it can be tested without a DOM.
 */

/**
 * Input types that do nothing with an arrow key or the space bar being *held for
 * editing*, so the Editor may keep its shortcuts while one of them has focus.
 *
 * The distinction matters in practice: clicking a layer checkbox leaves that checkbox
 * focused, and if a checkbox counted as editable then toggling a layer would silently
 * turn off keyboard navigation until the author clicked somewhere else. A text box, a
 * number, a range and a radio group all genuinely use the arrows, and are not listed.
 */
const NON_EDITING_INPUT_TYPES: ReadonlySet<string> = new Set([
  "checkbox",
  "button",
  "submit",
  "reset",
]);

export function isEditableTarget(
  tagName: string | null | undefined,
  isContentEditable = false,
  inputType: string | null | undefined = undefined,
): boolean {
  if (isContentEditable) return true;
  switch ((tagName ?? "").toUpperCase()) {
    case "INPUT":
      return !NON_EDITING_INPUT_TYPES.has((inputType ?? "text").toLowerCase());
    case "SELECT":
    case "TEXTAREA":
      return true;
    default:
      return false;
  }
}
