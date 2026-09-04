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
import { SNAP_DIVISIONS, type SnapSettings } from "../core/snap";

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
  readonly snapAvailable: boolean;

  readonly selectedNoteId: string | null;
  readonly onDeleteSelected: () => void;

  /** Where Save will write. Shown so the author knows before pressing it. */
  readonly targetPath: string;
}

export function ChartBar(props: ChartBarProps): React.JSX.Element {
  const {
    enabled, noteCount, dirty, saving, onSave, saveMessage,
    noteType, onNoteType, direction, onDirection,
    snap, onSnap, snapAvailable, selectedNoteId, onDeleteSelected, targetPath,
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

      <label className="field checkbox">
        <input
          type="checkbox"
          checked={snap.enabled}
          disabled={!enabled || !snapAvailable}
          onChange={(event) => onSnap({ ...snap, enabled: event.target.checked })}
        />
        Snap
      </label>

      <label className="field">
        Division
        <select
          value={snap.division}
          disabled={!enabled || !snap.enabled || !snapAvailable}
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
