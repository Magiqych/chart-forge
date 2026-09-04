/**
 * Chart editing controls.
 *
 * Deliberately the loudest bar in the window. The Analysis overlay is guide material and
 * lives in a quiet sidebar; this is where the author actually writes the chart, so Save,
 * the dirty state and the placement settings sit together on their own row above the
 * timeline.
 */

import {
  DIRECTIONS, PLACEABLE_TYPES, type Direction, type PlaceableType,
} from "../core/chart";
import { SNAP_DIVISIONS, type SnapMode, type SnapSettings } from "../core/snap";

export interface ChartBarProps {
  readonly enabled: boolean;
  readonly noteCount: number;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly saveMessage: string;

  readonly noteType: PlaceableType;
  readonly onNoteType: (type: PlaceableType) => void;
  readonly direction: Direction;
  readonly onDirection: (direction: Direction) => void;

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

  readonly selectedNoteId: string | null;
  readonly onDeleteSelected: () => void;

  /** Where Save will write. Shown so the author knows before pressing it. */
  readonly targetPath: string;
}

export function ChartBar(props: ChartBarProps): React.JSX.Element {
  const {
    enabled, noteCount, dirty, saving, onSave, saveMessage,
    noteType, onNoteType, direction, onDirection,
    snap, onSnap, snapMode, onSnapMode, snapAvailable,
    selectedNoteId, onDeleteSelected, targetPath,
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

      <span className="chartbar-sep" />

      <label className="field">
        Note
        <select
          value={noteType}
          disabled={!enabled}
          onChange={(event) => onNoteType(event.target.value as PlaceableType)}
        >
          {PLACEABLE_TYPES.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </label>

      {noteType === "flick" && (
        <label className="field">
          Direction
          <select
            value={direction}
            disabled={!enabled}
            onChange={(event) => onDirection(event.target.value as Direction)}
          >
            {DIRECTIONS.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
      )}

      {/* Only Off and Beat correspond to something the Project can store, so the third
          option says so rather than quietly resetting after a reload. */}
      <label
        className="field"
        title={
          snapMode === "event"
            ? "Analysis event snapping is experimental and lasts for this session only"
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
          <option value="event">Event (session)</option>
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
          ? `Place a ${noteType} at the exact start of ${selectedEventLabel}`
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

      <span className="chartbar-sep" />

      <button
        type="button"
        onClick={onDeleteSelected}
        disabled={!enabled || selectedNoteId === null}
        title={selectedNoteId ? `Delete ${selectedNoteId}` : "Select a note first"}
      >
        Delete note
      </button>

      <span className="chartbar-count">
        {noteCount} note{noteCount === 1 ? "" : "s"}
        {selectedNoteId ? ` · ${selectedNoteId} selected` : ""}
      </span>

      <span className="spacer" />
      <span className="chartbar-message">{saveMessage}</span>
    </div>
  );
}
