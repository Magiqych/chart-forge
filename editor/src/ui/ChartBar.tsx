/**
 * Chart editing controls.
 *
 * Deliberately the loudest bar in the window. The Analysis overlay is guide material and
 * lives in a quiet sidebar; this is where the author actually writes the chart, so Save,
 * the dirty state and the placement settings sit together on their own row above the
 * timeline.
 */

import {
  EDITOR_MODES, FLICK_DIRECTIONS, isBoundedPlaceable, PLACEABLE_TYPES, PLACE_TARGETS,
  type EditorMode, type FlickDirection, type PlaceableType, type PlaceTarget,
} from "../core/chart";

/**
 * What each note kind is called in the toolbar.
 *
 * The stored words are the Chart contract's: `tap`, `hold`, `slide`, `flick`. These are
 * what an author calls them. `Long` in particular is the same `hold` the contract has -
 * no second name for it was invented on disk.
 */
const NOTE_LABELS: Readonly<Record<PlaceableType, string>> = {
  tap: "Single",
  hold: "Long",
  slide: "Slide",
  flick: "Flick",
};

const NOTE_HINTS: Readonly<Record<PlaceableType, string>> = {
  tap: "Click a lane to place",
  hold: "Drag along a lane to set how long it is held",
  slide: "Drag to another lane to set where it travels to",
  flick: "Click a lane to place",
};

const MODE_LABELS: Readonly<Record<EditorMode, string>> = {
  edit: "Edit",
  select: "Select",
};

const MODE_HINTS: Readonly<Record<EditorMode, string>> = {
  edit: "Place notes. Clicking a note that is already there does nothing.",
  select: "Choose notes: click, shift-click, or drag a rectangle. Delete removes them.",
};


/**
 * How a Long or a Slide finishes.
 *
 * Shown as three states rather than a checkbox plus a direction, because those are the
 * three things an author actually picks between. The arrows follow the same screen
 * convention as a standalone Flick: left is drawn up and right is drawn down, because on
 * this timeline the horizontal axis is time.
 */
const END_ACTION_CHOICES = [
  { value: null, label: "Normal", hint: "Released at the end" },
  { value: "left" as const, label: "\u2191 Flick", hint: "Ends in a left flick, drawn up" },
  { value: "right" as const, label: "\u2193 Flick", hint: "Ends in a right flick, drawn down" },
];

const DIRECTION_LABELS: Readonly<Record<FlickDirection, string>> = {
  left: "\u2190 Left",
  right: "Right \u2192",
};

import { SNAP_DIVISIONS, type SnapMode, type SnapSettings } from "../core/snap";

const PLACE_TARGET_LABELS: Readonly<Record<PlaceTarget, string>> = {
  note: "Note",
  text: "Text",
};

const PLACE_TARGET_HINTS: Readonly<Record<PlaceTarget, string>> = {
  note: "Click a lane to place a note",
  text: "Click the timeline or the stage to add a text decoration",
};

export interface ChartBarProps {
  readonly enabled: boolean;
  readonly noteCount: number;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly saveMessage: string;

  /** Undo history. Chart authoring only; tool settings are not undoable. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;

  readonly mode: EditorMode;
  readonly onMode: (mode: EditorMode) => void;
  readonly noteType: PlaceableType;
  readonly onNoteType: (type: PlaceableType) => void;
  /**
   * What Edit Mode makes: a note, or a text decoration.
   *
   * Beside the note kind rather than inside it. A decoration is not a fifth kind of note,
   * and putting it in the same dropdown would have said that it was.
   */
  readonly placeTarget: PlaceTarget;
  readonly onPlaceTarget: (target: PlaceTarget) => void;
  readonly direction: FlickDirection;
  readonly onDirection: (direction: FlickDirection) => void;
  /** How the next Long or Slide will finish. `null` is an ordinary release. */
  readonly endFlick: FlickDirection | null;
  readonly onEndFlick: (direction: FlickDirection | null) => void;

  readonly snap: SnapSettings;
  readonly onSnap: (snap: SnapSettings) => void;
  readonly snapMode: SnapMode;
  readonly onSnapMode: (mode: SnapMode) => void;
  readonly snapAvailable: boolean;

  /** Placing from the selected Analysis Event. The lane is always the author's choice. */
  readonly selectedEventLabel: string | null;
  readonly eventLane: number;
  readonly onEventLane: (lane: number) => void;
  readonly laneCount: number;
  readonly onPlaceAtEvent: () => void;

  /** How many notes are selected. The delete button acts on all of them at once. */
  readonly selectionCount: number;
  readonly onDeleteSelected: () => void;
  /** Whether the selection is two slide points that could be joined. */
  readonly canConnect: boolean;
  /** Why it can or cannot, so a disabled button explains itself. */
  readonly connectHint: string;
  readonly onConnect: () => void;

  /** Where Save will write. Shown so the author knows before pressing it. */
  readonly targetPath: string;
}

export function ChartBar(props: ChartBarProps): React.JSX.Element {
  const {
    enabled, noteCount, dirty, saving, onSave, saveMessage,
    canUndo, canRedo, onUndo, onRedo,
    mode, onMode, noteType, onNoteType, placeTarget, onPlaceTarget,
    direction, onDirection, endFlick, onEndFlick,
    snap, onSnap, snapMode, onSnapMode, snapAvailable,
    selectionCount, onDeleteSelected, canConnect, connectHint, onConnect, targetPath,
    selectedEventLabel, eventLane, onEventLane, laneCount, onPlaceAtEvent,
  } = props;

  return (
    <div className="chartbar">
      <span className="chartbar-title">CHART</span>

      <button
        type="button"
        className="primary"
        onClick={onSave}
        disabled={!enabled || saving || !dirty}
        title={targetPath ? `Save to ${targetPath}` : "Save the chart"}
      >
        {saving ? "Saving..." : "Save"}
      </button>

      <span className={dirty ? "dirty dirty-on" : "dirty"}>
        {dirty ? "● modified" : "○ saved"}
      </span>

      {/* Kept narrow: this bar sits above the timeline, and a bar that wraps moves the
          canvas and every lane band with it. */}
      <button
        type="button"
        className="icon"
        onClick={onUndo}
        disabled={!enabled || !canUndo}
        title="Undo the last note edit (Ctrl+Z)"
        aria-label="Undo"
      >
        ↶
      </button>
      <button
        type="button"
        className="icon"
        onClick={onRedo}
        disabled={!enabled || !canRedo}
        title="Redo (Ctrl+Y)"
        aria-label="Redo"
      >
        ↷
      </button>

      <span className="chartbar-sep" />

      {/* The top-level split. A segmented pair rather than a dropdown: there are two of
          them, and which one is active has to be readable at a glance, because it
          changes what every click in the lanes means. */}
      <div className="segmented" role="group" aria-label="Mode">
        {EDITOR_MODES.map((value) => (
          <button
            key={value}
            type="button"
            className={value === mode ? "seg on" : "seg"}
            onClick={() => onMode(value)}
            disabled={!enabled}
            title={MODE_HINTS[value]}
            aria-pressed={value === mode}
          >
            {MODE_LABELS[value]}
          </button>
        ))}
      </div>

      {/* Which of the two things Edit Mode makes. A segmented pair for the same reason
          the mode is one: it changes what every click means, so it has to be readable at
          a glance rather than hidden inside a dropdown of note kinds. */}
      {mode === "edit" && (
        <div className="segmented" role="group" aria-label="Place">
          {PLACE_TARGETS.map((value) => (
            <button
              key={value}
              type="button"
              className={value === placeTarget ? "seg on" : "seg"}
              onClick={() => onPlaceTarget(value)}
              disabled={!enabled}
              title={PLACE_TARGET_HINTS[value]}
              aria-pressed={value === placeTarget}
            >
              {PLACE_TARGET_LABELS[value]}
            </button>
          ))}
        </div>
      )}

      {/* What Edit Mode places. Hidden rather than disabled in Select Mode: a control
          that cannot do anything is noise, and Select has nothing to say about which
          kind of note it is not placing. */}
      {mode === "edit" && placeTarget === "note" && (
        <label className="field" title={NOTE_HINTS[noteType]}>
          Note
          <select
            value={noteType}
            disabled={!enabled}
            onChange={(event) => onNoteType(event.target.value as PlaceableType)}
          >
            {PLACEABLE_TYPES.map((value) => (
              <option key={value} value={value}>{NOTE_LABELS[value]}</option>
            ))}
          </select>
        </label>
      )}

      {mode === "edit" && placeTarget === "note" && noteType === "flick" && (
        <div className="segmented" role="group" aria-label="Flick direction">
          {FLICK_DIRECTIONS.map((value) => (
            <button
              key={value}
              type="button"
              className={value === direction ? "seg on" : "seg"}
              onClick={() => onDirection(value)}
              disabled={!enabled}
              aria-pressed={value === direction}
              title={`Flick ${value}`}
            >
              {DIRECTION_LABELS[value]}
            </button>
          ))}
        </div>
      )}

      {/* Only a note with an end can finish with anything other than a release. */}
      {mode === "edit" && placeTarget === "note" && isBoundedPlaceable(noteType) && (
        <div className="segmented" role="group" aria-label="End action">
          {END_ACTION_CHOICES.map((choice) => (
            <button
              key={choice.label}
              type="button"
              className={choice.value === endFlick ? "seg on" : "seg"}
              onClick={() => onEndFlick(choice.value)}
              disabled={!enabled}
              aria-pressed={choice.value === endFlick}
              title={choice.hint}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}

      {mode === "edit" && (
        <>
        {/* Only Off and Beat correspond to something the Project can store, so the third
            option says so rather than quietly resetting after a reload. */}
        <label
          className="field"
          title={
            snapMode === "guide"
              ? "Snaps to the Analysis Events in the layers that are switched on - the " +
                "same events the up and down arrows walk. Session only: the Project " +
                "contract has nowhere to record it, so it reads back as Off."
              : "What a click on the timeline snaps to"
          }
        >
          Snap
          <select
            value={snapMode}
            disabled={!enabled || !snapAvailable}
            onChange={(event) => onSnapMode(event.target.value as SnapMode)}
          >
            <option value="off">Off</option>
            <option value="beat">Beat</option>
            <option value="guide">Guide (session)</option>
          </select>
        </label>

        <label className="field">
          Division
          <select
            value={snap.division}
            disabled={!enabled || snapMode !== "beat" || !snapAvailable}
            onChange={(event) => onSnap({ ...snap, division: Number(event.target.value) })}
          >
            {SNAP_DIVISIONS.map((division) => (
              <option key={division} value={division}>
                {division === 1 ? "beat" : `1/${division} beat`}
              </option>
            ))}
          </select>
        </label>

        <span className="chartbar-sep" />

        {/* Placing from an event is a separate, deliberate action. Selecting an event in
            the overlay creates nothing; this button is the authoring step, and the lane
            beside it is chosen by the author - never derived from the event's stem. */}
        <span className="chartbar-group" title={
          selectedEventLabel
            ? `Place a ${NOTE_LABELS[noteType]} at the exact start of ${selectedEventLabel}`
            : "Select an event in the overlay first"
        }>
          <span className="chartbar-grouplabel">At event</span>
          <select
            value={eventLane}
            disabled={!enabled}
            onChange={(event) => onEventLane(Number(event.target.value))}
          >
            {Array.from({ length: laneCount }, (_, lane) => (
              <option key={lane} value={lane}>{`L${lane + 1}`}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={onPlaceAtEvent}
            disabled={!enabled || selectedEventLabel === null}
          >
            Place Note at Event
          </button>
        </span>
        </>
      )}

      {/* Deleting belongs to Select Mode, and goes through the same command the
          keyboard and the inspector use. */}
      {mode === "select" && (
        <>
          <span className="chartbar-sep" />
          <span className="chartbar-selection">
            {selectionCount === 0
              ? "nothing selected"
              : `${selectionCount} object${selectionCount === 1 ? "" : "s"} selected`}
          </span>
          {/* Joining two points into a slide. Shown whenever two notes are selected, and
              enabled only when they are two points that can actually be joined - with the
              reason in the tooltip either way, so a disabled button is never a mystery. */}
          {selectionCount === 2 && (
            <button
              type="button"
              className={canConnect ? "primary" : undefined}
              onClick={onConnect}
              disabled={!enabled || !canConnect}
              title={connectHint}
            >
              Connect
            </button>
          )}
          <button
            type="button"
            onClick={onDeleteSelected}
            disabled={!enabled || selectionCount === 0}
            title={
              selectionCount === 0
                ? "Click or drag over notes or text first"
                : `Delete ${selectionCount} selected object${selectionCount === 1 ? "" : "s"} (Delete)`
            }
          >
            Delete Selected
          </button>
        </>
      )}

      <span className="chartbar-sep" />

      <span className="chartbar-count">
        {noteCount} note{noteCount === 1 ? "" : "s"}
      </span>

      <span className="spacer" />
      <span className="chartbar-message">{saveMessage}</span>
    </div>
  );
}
