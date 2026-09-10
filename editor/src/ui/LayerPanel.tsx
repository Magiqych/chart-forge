/**
 * Layer visibility.
 *
 * There is deliberately no confidence control here, not even a disabled one: Analysis
 * 0.2 emits no `confidence`, so offering the affordance would promise something the data
 * cannot deliver.
 */

import {
  LANE_IDS,
  type AnalysisProjection, type LaneId, type ProjectedEvent,
} from "../core/analysis";
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
  /**
   * The decoration inspector, when a decoration is selected.
   *
   * Passed in as an element rather than built here, because it needs a dozen callbacks
   * this panel has no other use for. What the panel decides is *where* it goes - beside
   * the note inspector, in the same column - and that a selection of one kind never
   * shows the other's panel.
   */
  readonly decorationInspector: React.ReactNode;
  /**
   * The stem mixer, for a project that has stems.
   *
   * Passed in for the same reason as the inspector above. It goes above the detector
   * list rather than at the foot of the column, because it is reached for constantly
   * while charting and the detectors are reference material - at the foot, on an
   * ordinary window, its controls sat below the fold.
   */
  readonly stemMixer: React.ReactNode;
}

interface LayerRow {
  readonly key: LayerKey;
  readonly label: string;
  readonly swatch?: string;
  /** Marks structure rather than an observation lane. */
  readonly structural?: boolean;
}

/** Sentence case for a lane id, so the list is not another place they are spelled out. */
function laneLabel(lane: LaneId): string {
  return lane.charAt(0).toUpperCase() + lane.slice(1);
}

const LAYERS: readonly LayerRow[] = [
  { key: "grid", label: "Beat grid", swatch: theme.grid.downbeat, structural: true },
  { key: "waveform", label: "Waveform", swatch: theme.waveform, structural: true },
  // Every lane the Editor knows, in the timeline's own order, so turning one on in the
  // panel and finding it in the timeline are the same list read twice.
  ...LANE_IDS.map((lane) => ({
    key: lane as LayerKey,
    label: laneLabel(lane),
    swatch: theme.lanes[lane],
  })),
  { key: "notes", label: "Notes", swatch: "#8899aa", structural: true },
  { key: "decorations", label: "Text", swatch: theme.decoration.border, structural: true },
];

function countFor(projection: AnalysisProjection | null, key: LayerKey): string {
  if (!projection) return "";
  if (key === "grid") return `${projection.counts.beats}`;
  // Asked of LANE_IDS rather than spelled out: listing the four by hand is what left
  // Guitar and Piano showing a blank count while every other lane showed a number.
  if ((LANE_IDS as readonly string[]).includes(key)) {
    return `${projection.counts.byLane[key as LaneId]}`;
  }
  return "";
}

export function LayerPanel(
  {
    projection, visible, onToggle, selectedEvent, selectedNotes, onDeleteNote,
    canConnect, connectHint, onConnect, onDisconnect, onEndAction, onFlickDirection,
    runSize, decorationInspector, stemMixer,
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

      {decorationInspector}

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

      {stemMixer}

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
