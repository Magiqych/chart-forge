/**
 * The canvas host.
 *
 * React owns a single <canvas> element and the interaction handlers. It never renders an
 * Analysis event as a DOM node: the whole overlay is drawn by TimelineRenderer, which
 * knows nothing about React.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AnalysisProjection, LaneId } from "../core/analysis";
import { DEFAULT_ROWS, layoutRows, type RowId } from "../core/lanes";
import {
  clampViewportStart,
  panBySeconds,
  xToTime,
  zoomAtAnchor,
  type Viewport,
} from "../core/viewport";
import { TimelineRenderer, type RenderStats, type Scene } from "../render/timelineRenderer";

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
}

export function Timeline(props: TimelineProps): React.JSX.Element {
  const {
    projection, view, onViewChange, playheadSec, onSeek,
    visibleRows, showGrid, waveform, waveformDurationSec, maxEventDurationSec, onStats,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TimelineRenderer | null>(null);
  const [widthPx, setWidthPx] = useState(1000);
  const dragRef = useRef<{ x: number; startSec: number } | null>(null);

  const layout = layoutRows(DEFAULT_ROWS, (id) => visibleRows.has(id));
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
    if (!canvas) return;
    if (!rendererRef.current) rendererRef.current = new TimelineRenderer(canvas);
    rendererRef.current.resize(widthPx, layout.totalHeightPx, window.devicePixelRatio || 1);
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
        playheadSec,
        showGrid,
        visibleLanes,
        waveform,
        waveformDurationSec,
        maxEventDurationSec,
      };
      onStats(renderer.render(scene));
    });
    return () => cancelAnimationFrame(frame);
  });

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const current = { ...view, widthPx };
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
    [view, widthPx, durationSec, onViewChange],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (event.shiftKey || event.button === 1) {
        dragRef.current = { x, startSec: view.startSec };
        event.currentTarget.setPointerCapture(event.pointerId);
      } else {
        onSeek(Math.max(0, xToTime(x, { ...view, widthPx })));
      }
    },
    [view, widthPx, onSeek],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const deltaSec = (drag.x - x) / view.pixelsPerSecond;
      const current = { ...view, widthPx };
      onViewChange({
        ...current,
        startSec: clampViewportStart(drag.startSec + deltaSec, current, durationSec),
      });
    },
    [view, widthPx, durationSec, onViewChange],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div className="timeline-host" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="timeline-canvas"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}
