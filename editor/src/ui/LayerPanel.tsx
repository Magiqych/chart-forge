/**
 * Layer visibility.
 *
 * There is deliberately no confidence control here, not even a disabled one: Analysis
 * 0.2 emits no `confidence`, so offering the affordance would promise something the data
 * cannot deliver.
 */

import type { AnalysisProjection, LaneId, ProjectedEvent } from "../core/analysis";
import type { ChartNote, FlickDirection } from "../core/chart";
import type { RowId } from "../core/lanes";
import { theme } from "../render/theme";
import { EventInspector } from "./EventInspector";
import { NoteInspector } from "./NoteInspector";

export type LayerKey = RowId | "grid";

export interface LayerPanelProps {
  readonly projection: AnalysisProjection | null;
  readonly visible: ReadonlySet<LayerKey>;
  readonly onToggle: (key: LayerKey) => void;
  /**
   * The event the author is consulting. It lives in this sidebar with the rest of the
   * analysis information, away from the authoring controls, because reading it is not
   * editing anything.
   */
  readonly selectedEvent: ProjectedEvent | null;
  /**
   * The selected Chart Note. Reported beside the event, never merged with it: one is a
   * measurement the author is consulting, the other is what they wrote.
   */
  readonly selectedNotes: readonly ChartNote[];
  readonly onDeleteNote: () => void;
  readonly canConnect: boolean;
  readonly connectHint: string;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onEndAction: (direction: FlickDirection | null) => void;
  readonly onFlickDirection: (direction: FlickDirection) => void;
  /** How many flicks the selected run has, or 0 when the selection is not one. */
  readonly runSize: number;
}

interface LayerRow {
  readonly key: LayerKey;
  readonly label: string;
  readonly swatch?: string;
  /** Marks structure rather than an observation lane. */
  readonly structural?: boolean;
}

const LAYERS: readonly LayerRow[] = [
  { key: "grid", label: "Beat grid", swatch: theme.grid.downbeat, structural: true },
  { key: "waveform", label: "Waveform", swatch: theme.waveform, structural: true },
  { key: "drums", label: "Drums", swatch: theme.lanes.drums },
  { key: "other", label: "Other", swatch: theme.lanes.other },
  { key: "bass", label: "Bass", swatch: theme.lanes.bass },
  { key: "vocals", label: "Vocals", swatch: theme.lanes.vocals },
  { key: "notes", label: "Notes", swatch: "#8899aa", structural: true },
];

function countFor(projection: AnalysisProjection | null, key: LayerKey): string {
  if (!projection) return "";
  if (key === "grid") return `${projection.counts.beats}`;
  if (key === "drums" || key === "other" || key === "bass" || key === "vocals") {
    return `${projection.counts.byLane[key as LaneId]}`;
  }
  return "";
}

export function LayerPanel(
  {
    projection, visible, onToggle, selectedEvent, selectedNotes, onDeleteNote,
    canConnect, connectHint, onConnect, onDisconnect, onEndAction, onFlickDirection,
    runSize,
  }: LayerPanelProps,
): React.JSX.Element {
  return (
    <aside className="layer-panel">
      <h2>Layers</h2>
      <ul>
        {LAYERS.map((layer) => (
          <li key={layer.key}>
            <label className={layer.structural ? "structural" : "lane"}>
              <input
                type="checkbox"
                checked={visible.has(layer.key)}
                onChange={() => onToggle(layer.key)}
              />
              <span className="swatch" style={{ background: layer.swatch ?? "transparent" }} />
              <span className="name">{layer.label}</span>
              <span className="count">{countFor(projection, layer.key)}</span>
            </label>
          </li>
        ))}
      </ul>

      <NoteInspector
        notes={selectedNotes}
        onDelete={onDeleteNote}
        canConnect={canConnect}
        connectHint={connectHint}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        onEndAction={onEndAction}
        onFlickDirection={onFlickDirection}
        runSize={runSize}
      />

      <EventInspector event={selectedEvent} projection={projection} />

      {projection ? (
        <div className="detector-list">
          <h2>Detectors</h2>
          <ul>
            {projection.detectors.map((detector) => (
              <li key={detector.id} title={detector.id}>
                {detector.name}
                {detector.version ? ` ${detector.version}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}
