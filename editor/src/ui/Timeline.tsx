/**
 * The canvas host.
 *
 * React owns two stacked <canvas> elements and the interaction handlers. It never
 * renders an Analysis event or a Chart note as a DOM node: the analysis overlay is drawn
 * by TimelineRenderer and the chart layer by NotesRenderer, neither of which knows about
 * React.
 *
 * Two canvases rather than one because they change at different rates. Moving the
 * pointer across a lane repaints only the foreground; the 2258-event overlay behind it
 * is left alone until the viewport itself changes.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AnalysisProjection, LaneId } from "../core/analysis";
import { noteAt, type ChartState } from "../core/chart";
import { findRow, laneAtY, layoutRows, rowsForChart, type RowId } from "../core/lanes";
import { snapTime, type SnapSettings } from "../core/snap";
import {
  clampViewportStart,
  panBySeconds,
  xToTime,
  zoomAtAnchor,
  type Viewport,
} from "../core/viewport";
import {
  NotesRenderer,
  type NotesRenderStats,
  type NotesScene,
  type PlacementPreview,
} from "../render/notesRenderer";
import { TimelineRenderer, type RenderStats, type Scene } from "../render/timelineRenderer";

/** How close a click has to be to a note to select it instead of placing a new one. */
const HIT_TOLERANCE_PX = 12;

export interface TimelineProps {
  readonly projection: AnalysisProjection | null;
  readonly view: Viewport;
  readonly onViewChange: (view: Viewport) => void;
  readonly playheadSec: number;
  readonly onSeek: (timeSec: number) => void;
  readonly visibleRows: ReadonlySet<RowId>;
  /** The beat grid is an overlay across the lanes, not a row of its own. */
  readonly showGrid: boolean;
  readonly waveform: Float32Array | null;
  readonly waveformDurationSec: number;
  readonly maxEventDurationSec: number;
  readonly onStats: (stats: RenderStats) => void;
  /** Foreground paint cost, reported separately so the two layers stay distinguishable. */
  readonly onNotesStats: (stats: NotesRenderStats) => void;

  /** Chart editing. Absent until a project is open. */
  readonly chart: ChartState | null;
  readonly snapGrid: readonly number[];
  readonly snap: SnapSettings;
  readonly selectedNoteId: string | null;
  readonly onPlace: (timeSec: number, lane: number) => void;
  readonly onSelect: (noteId: string | null) => void;
}

export function Timeline(props: TimelineProps): React.JSX.Element {
  const {
    projection, view, onViewChange, playheadSec, onSeek,
    visibleRows, showGrid, waveform, waveformDurationSec, maxEventDurationSec, onStats,
    onNotesStats, chart, snapGrid, snap, selectedNoteId, onPlace, onSelect,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const notesCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TimelineRenderer | null>(null);
  const notesRendererRef = useRef<NotesRenderer | null>(null);
  const [widthPx, setWidthPx] = useState(1000);
  const [preview, setPreview] = useState<PlacementPreview | null>(null);
  const dragRef = useRef<{ x: number; startSec: number } | null>(null);

  const rows = useMemo(() => rowsForChart(chart?.laneCount ?? 0), [chart?.laneCount]);
  const layout = useMemo(
    () => layoutRows(rows, (id) => visibleRows.has(id)),
    [rows, visibleRows],
  );
  const durationSec = projection?.audio.durationSec ?? 0;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidthPx(Math.max(1, Math.floor(entry.contentRect.width)));
    });
    observer.observe(host);
    setWidthPx(Math.max(1, Math.floor(host.clientWidth)));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const notesCanvas = notesCanvasRef.current;
    if (!canvas || !notesCanvas) return;
    if (!rendererRef.current) rendererRef.current = new TimelineRenderer(canvas);
    if (!notesRendererRef.current) notesRendererRef.current = new NotesRenderer(notesCanvas);
    const dpr = window.devicePixelRatio || 1;
    rendererRef.current.resize(widthPx, layout.totalHeightPx, dpr);
    notesRendererRef.current.resize(widthPx, layout.totalHeightPx, dpr);
  }, [widthPx, layout.totalHeightPx]);

  // One draw per state change, on an animation frame, so a burst of wheel events
  // coalesces into a single paint.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    let frame = 0;
    frame = requestAnimationFrame(() => {
      const visibleLanes = new Set<LaneId>(
        (["drums", "other", "bass", "vocals"] as const).filter((lane) => visibleRows.has(lane)),
      );
      const scene: Scene = {
        view: { ...view, widthPx },
        layout,
        projection,
        showGrid,
        visibleLanes,
        waveform,
        waveformDurationSec,
        maxEventDurationSec,
      };
      onStats(renderer.render(scene));
    });
    return () => cancelAnimationFrame(frame);
  }, [
    view, widthPx, layout, projection, showGrid, visibleRows,
    waveform, waveformDurationSec, maxEventDurationSec, onStats,
  ]);

  // The foreground repaints on its own schedule: the playhead moves every frame during
  // playback, and the preview follows the pointer, neither of which should redraw 2258
  // analysis events.
  useEffect(() => {
    const renderer = notesRendererRef.current;
    if (!renderer) return;
    let frame = 0;
    frame = requestAnimationFrame(() => {
      const scene: NotesScene = {
        view: { ...view, widthPx },
        layout,
        chart,
        selectedNoteId,
        preview,
        playheadSec,
      };
      onNotesStats(renderer.render(scene));
    });
    return () => cancelAnimationFrame(frame);
  }, [view, widthPx, layout, chart, selectedNoteId, preview, playheadSec, onNotesStats]);

  const current = useMemo(() => ({ ...view, widthPx }), [view, widthPx]);

  /** Where the pointer is, in chart terms. Null outside the notes row. */
  const chartTargetAt = useCallback(
    (x: number, y: number): { timeSec: number; rawSec: number; lane: number } | null => {
      if (!chart) return null;
      const row = findRow(layout, "notes");
      if (!row) return null;
      const lane = laneAtY(row, chart.laneCount, y);
      if (lane === null) return null;
      const rawSec = Math.max(0, xToTime(x, current));
      return { timeSec: Math.max(0, snapTime(rawSec, snapGrid, snap)), rawSec, lane };
    },
    [chart, layout, current, snapGrid, snap],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        const factor = Math.exp(-event.deltaY * 0.0015);
        const zoomed = zoomAtAnchor(current, current.pixelsPerSecond * factor, x);
        onViewChange({
          ...zoomed,
          startSec: clampViewportStart(zoomed.startSec, zoomed, durationSec),
        });
      } else {
        const deltaSec = event.deltaX / current.pixelsPerSecond;
        onViewChange(panBySeconds(current, deltaSec, durationSec));
      }
    },
    [current, durationSec, onViewChange],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (event.shiftKey || event.button === 1) {
        dragRef.current = { x, startSec: view.startSec };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }

      // Inside the notes row the click is chart editing; everywhere else it seeks.
      const target = chartTargetAt(x, y);
      if (target && chart) {
        // Landing on an existing note selects it rather than stacking another on top.
        // The tolerance is expressed in pixels and converted, so it stays the same
        // physical target size at every zoom level.
        const toleranceSec = HIT_TOLERANCE_PX / current.pixelsPerSecond;
        const hit = noteAt(chart, target.rawSec, target.lane, toleranceSec);
        if (hit) {
          onSelect(hit.id);
          return;
        }
        onPlace(target.timeSec, target.lane);
        return;
      }
      onSelect(null);
      onSeek(Math.max(0, xToTime(x, current)));
    },
    [view.startSec, current, chart, onSeek, chartTargetAt, onPlace, onSelect],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const drag = dragRef.current;
      if (drag) {
        const deltaSec = (drag.x - x) / view.pixelsPerSecond;
        onViewChange({
          ...current,
          startSec: clampViewportStart(drag.startSec + deltaSec, current, durationSec),
        });
        return;
      }

      const target = chartTargetAt(x, y);
      setPreview(
        target
          ? { timeSec: target.timeSec, lane: target.lane, snapped: snap.enabled }
          : null,
      );
    },
    [view.pixelsPerSecond, current, durationSec, onViewChange, chartTargetAt, snap.enabled],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handlePointerLeave = useCallback(() => {
    dragRef.current = null;
    setPreview(null);
  }, []);

  return (
    <div className="timeline-host" ref={hostRef}>
      <div className="timeline-stack" style={{ height: layout.totalHeightPx }}>
        <canvas ref={canvasRef} className="timeline-canvas" />
        <canvas
          ref={notesCanvasRef}
          className="notes-canvas"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={handlePointerLeave}
        />
      </div>
    </div>
  );
}
