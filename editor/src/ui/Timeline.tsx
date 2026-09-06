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

import type { AnalysisProjection, LaneId, ProjectedEvent } from "../core/analysis";
import {
  travelsBetweenLanes,
  type ChartNote, type ChartState, type EditorMode, type PlaceableType,
} from "../core/chart";
import {
  hitTestAnalysisEvent, pitchRangesFor, type LaneHitTarget, type PitchRanges,
} from "../core/eventGeometry";
import {
  hitTestNote, hitTestRunConnector, notesInRect, rectFromCorners, runConnectors,
  type SelectionRect,
} from "../core/noteGeometry";
import { findRow, laneAtY, layoutRows, rowsForChart, type RowId } from "../core/lanes";
import { pointerIntent } from "../core/pointerIntent";
import {
  resolvePlacementTime, type SnapMode, type SnapSettings,
} from "../core/snap";
import { buildGuideAnchors, type GuideAnchor } from "../core/guideAnchors";
import {
  clampViewportStart,
  panBySeconds,
  startSecAfterZoom,
  viewportEndSec,
  visibleSlice,
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
import { TimelineScrollbar } from "./TimelineScrollbar";

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
  readonly snapMode: SnapMode;
  /**
   * The analysis lanes that are switched on.
   *
   * Passed down rather than worked out here so that Guide Snap and the arrow-key event
   * navigation read exactly the same answer: what you can walk to is what you can snap to.
   */
  readonly visibleLanes: ReadonlySet<LaneId>;
  /** Told what a placement snapped to, so the status line can say why it moved. */
  readonly onSnapped: (anchor: GuideAnchor | null) => void;
  readonly selectedNoteIds: readonly string[];
  /**
   * What the pointer is for: making notes, or choosing them.
   *
   * The mode decides what a drag means, rather than the drag's length deciding what the
   * author meant. In Select a drag rubber-bands; in Edit it draws out the kinds that have
   * a duration and places the ones that do not.
   */
  readonly mode: EditorMode;
  /** The kind Edit Mode places. Ignored in Select Mode, which places nothing. */
  readonly noteType: PlaceableType;
  readonly onPlace: (timeSec: number, lane: number) => void;
  /** Commit a note dragged out. `endLane` is set only for the kinds that travel. */
  readonly onPlaceDragged: (
    startSec: number,
    endSec: number,
    lane: number,
    endLane: number | undefined,
  ) => void;
  readonly onSelect: (noteId: string | null) => void;
  /** Replace the selection with everything a rubber band caught. */
  readonly onSelectMany: (noteIds: readonly string[], add: boolean) => void;
  readonly onToggleSelected: (noteId: string) => void;
  /** Select every note of the run one of them belongs to. */
  readonly onSelectRun: (noteId: string, add: boolean) => void;
  /** Commit a drag that moved the selection. One command for the whole gesture. */
  readonly onMoveSelected: (deltaSec: number, deltaLane: number) => void;
  /** Commit a drag that changed where a held note ends. */
  readonly onResize: (noteId: string, endTimeSec: number) => void;
  /** Playback position, so a zoom can put it back on screen when it leaves. */
  readonly playbackTimeSec: number;
  readonly followPlayhead: boolean;
  /**
   * Report how wide the canvas actually is.
   *
   * The width is a fact about the DOM, so it is measured here - but it is a property of
   * the one viewport, not a second one. Publishing it upwards is what lets Fit, Locate
   * Playhead, the zoom slider and Follow reason about the width the author is actually
   * looking at instead of a guess.
   */
  readonly onMeasuredWidth: (widthPx: number) => void;

  /** Analysis event selection. Read-only consultation of the overlay. */
  readonly selectedEventId: string | null;
  readonly onSelectEvent: (event: ProjectedEvent | null) => void;
}

/**
 * How far a pointer must travel before a press becomes a move.
 *
 * Without it every click on a note would commit a zero-length move, filling the history
 * with edits that changed nothing.
 */
const MOVE_THRESHOLD_PX = 3;

export function Timeline(props: TimelineProps): React.JSX.Element {
  const {
    projection, view, onViewChange, playheadSec, onSeek,
    visibleRows, showGrid, waveform, waveformDurationSec, maxEventDurationSec, onStats,
    onNotesStats, chart, snapGrid, snap, snapMode, visibleLanes, onSnapped,
    selectedNoteIds, mode, noteType,
    onPlace, onPlaceDragged, onSelect, onSelectMany, onToggleSelected, onSelectRun,
    onMoveSelected, onResize,
    playbackTimeSec, followPlayhead, onMeasuredWidth, selectedEventId, onSelectEvent,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const notesCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TimelineRenderer | null>(null);
  const notesRendererRef = useRef<NotesRenderer | null>(null);
  const [widthPx, setWidthPx] = useState(1000);
  const [preview, setPreview] = useState<PlacementPreview | null>(null);
  const dragRef = useRef<{ x: number; startSec: number } | null>(null);
  /**
   * A held note being dragged out.
   *
   * Only the lane the drag started in is remembered: moving the pointer to another lane
   * during the drag does not make this a slide. Authoring a lane change is a different
   * gesture and is not offered here.
   */
  const longRef = useRef<{ pointerId: number; startSec: number; lane: number } | null>(null);
  /**
   * A rubber band being dragged out, in canvas pixels.
   *
   * Kept as transient React state and drawn on the foreground canvas. Nothing about it
   * reaches the chart or the history until the pointer comes up: dragging a rectangle is
   * not an edit, and recording one per pointer move would fill undo with noise.
   */
  const [marquee, setMarquee] = useState<SelectionRect | null>(null);
  const marqueeRef = useRef<{ pointerId: number; x: number; y: number; add: boolean } | null>(null);

  /**
   * A move or a resize in progress.
   *
   * Both are transient exactly like the rubber band: the chart and the history are not
   * touched until the pointer comes up, so undo reverses the edit the author made rather
   * than the hundred pointer events it was made of. The offsets are handed to the
   * renderer so the notes are drawn where they are going, from the same geometry they
   * will have once committed.
   */
  const [moveDelta, setMoveDelta] = useState<{ seconds: number; lanes: number } | null>(null);
  const moveRef = useRef<
    { pointerId: number; x: number; y: number; timeSec: number; lane: number; moved: boolean } | null
  >(null);

  const [resizePreview, setResizePreview] =
    useState<{ noteId: string; endTimeSec: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; noteId: string; endTimeSec: number } | null>(null);

  /** True while the pointer is over a selected Long's grip, so the cursor can say so. */
  const [overHandle, setOverHandle] = useState(false);

  /**
   * Drop any gesture in progress when the mode changes.
   *
   * The meaning of a drag is fixed when it starts, so a rubber band or a half-drawn note
   * left over from the other mode would finish under rules nobody chose. Clearing the
   * transient state is enough: none of it has touched the chart or the history.
   */
  useEffect(() => {
    marqueeRef.current = null;
    longRef.current = null;
    moveRef.current = null;
    resizeRef.current = null;
    setMarquee(null);
    setPreview(null);
    setMoveDelta(null);
    setResizePreview(null);
  }, [mode]);

  const pitchRanges = useMemo<PitchRanges | null>(
    () => (projection ? pitchRangesFor(projection) : null),
    [projection],
  );

  const rows = useMemo(() => rowsForChart(chart?.laneCount ?? 0), [chart?.laneCount]);
  const layout = useMemo(
    () => layoutRows(rows, (id) => visibleRows.has(id)),
    [rows, visibleRows],
  );
  const durationSec = projection?.audio.durationSec ?? 0;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = (px: number) => {
      const next = Math.max(1, Math.floor(px));
      setWidthPx(next);
      onMeasuredWidth(next);
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(host);
    measure(host.clientWidth);
    return () => observer.disconnect();
  }, [onMeasuredWidth]);

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
        pitchRanges,
        selectedEventId,
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
    view, widthPx, layout, projection, pitchRanges, selectedEventId, showGrid, visibleRows,
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
        selectedNoteIds,
        preview,
        marquee,
        moveDelta,
        resizePreview,
        playheadSec,
      };
      onNotesStats(renderer.render(scene));
    });
    return () => cancelAnimationFrame(frame);
  }, [
    view, widthPx, layout, chart, selectedNoteIds, preview, marquee, moveDelta,
    resizePreview, playheadSec, onNotesStats,
  ]);

  const current = useMemo(() => ({ ...view, widthPx }), [view, widthPx]);

  /**
   * The events a click can reach: the visible slice of each *visible* lane.
   *
   * Built from the same range index the renderer uses, so a click never scans all 2258
   * events, and a lane whose layer is switched off simply is not among the targets -
   * which is what makes a hidden event unselectable without a special case for it.
   */
  const hitTargets = useCallback((): readonly LaneHitTarget[] => {
    if (!projection || !pitchRanges) return [];
    const from = current.startSec;
    const to = viewportEndSec(current);
    const targets: LaneHitTarget[] = [];
    for (const lane of ["drums", "other", "bass", "vocals"] as const) {
      if (!visibleRows.has(lane)) continue;
      const row = findRow(layout, lane);
      if (!row) continue;
      targets.push({
        lane,
        row,
        range: pitchRanges[lane],
        events: visibleSlice(projection.eventsByLane[lane], from, to, maxEventDurationSec),
      });
    }
    return targets;
  }, [projection, pitchRanges, current, visibleRows, layout, maxEventDurationSec]);

  /**
   * Where a note may snap to, from the layers that are switched on.
   *
   * Two sets, because the question differs. Placing a note asks "when did a sound start",
   * so only starts are candidates. Dragging the end of a Long asks "when did a sound
   * stop", so ends are candidates too - which is exactly what the author is looking at
   * when they pull the end of a hold out to meet a sustained note.
   */
  const placementAnchors = useMemo(
    () => buildGuideAnchors(projection?.events ?? [], visibleLanes),
    [projection, visibleLanes],
  );
  const endAnchors = useMemo(
    () => buildGuideAnchors(projection?.events ?? [], visibleLanes, { includeEnds: true }),
    [projection, visibleLanes],
  );

  /**
   * Apply whichever snapping the author asked for.
   *
   * Every placement time in the Editor goes through this, and it goes through the one
   * pure resolver: a kind that took a different route would be a kind that snapped
   * differently, and the author would have no way to know which. `Place Note at Event`
   * is the one exception and does not come through here at all - it uses the event's
   * measured start verbatim, which is the whole point of that button.
   */
  const resolveTime = useCallback(
    (rawSec: number, anchors: readonly GuideAnchor[]) =>
      resolvePlacementTime({
        rawTimeSec: rawSec,
        snapMode,
        snap,
        grid: snapGrid,
        anchors,
        pixelsPerSecond: current.pixelsPerSecond,
      }),
    [snapMode, snap, snapGrid, current.pixelsPerSecond],
  );

  /** The same, for the end of a held note, where a sound's end is a target too. */
  const snapEndTime = useCallback(
    (rawSec: number) => resolveTime(rawSec, endAnchors),
    [resolveTime, endAnchors],
  );

  /** Where the pointer is, in chart terms. Null outside the notes row. */
  const chartTargetAt = useCallback(
    (
      x: number,
      y: number,
    ): { timeSec: number; rawSec: number; lane: number; anchor: GuideAnchor | null } | null => {
      if (!chart) return null;
      const row = findRow(layout, "notes");
      if (!row) return null;
      const lane = laneAtY(row, chart.laneCount, y);
      if (lane === null) return null;
      const rawSec = Math.max(0, xToTime(x, current));
      const resolved = resolveTime(rawSec, placementAnchors);
      return { timeSec: Math.max(0, resolved.timeSec), rawSec, lane, anchor: resolved.anchor };
    },
    [chart, layout, current, resolveTime, placementAnchors],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;

      // Shift means scroll sideways, whichever axis the platform reports it on. Some
      // send it as deltaX already, others leave it on deltaY and only set shiftKey.
      if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
        const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
        onViewChange(panBySeconds(current, delta / current.pixelsPerSecond, durationSec));
        return;
      }

      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        const factor = Math.exp(-event.deltaY * 0.0015);
        const zoomed = zoomAtAnchor(current, current.pixelsPerSecond * factor, x);
        onViewChange(withPlayheadInView({
          ...zoomed,
          startSec: clampViewportStart(zoomed.startSec, zoomed, durationSec),
        }));
      } else {
        // A trackpad's horizontal swipe arrives here as deltaX with no modifier.
        const deltaSec = event.deltaX / current.pixelsPerSecond;
        onViewChange(panBySeconds(current, deltaSec, durationSec));
      }
    },
    [current, durationSec, onViewChange],
  );

  /**
   * Keep the playhead reachable after a zoom.
   *
   * Zooming anchors on the pointer, which is right, but at a close zoom that can carry
   * the playback position off the edge. While it is still on screen the view is left
   * exactly where the anchor put it - jumping on every zoom would be worse than the
   * problem. When it has gone, Follow puts it where Follow wants it and otherwise it is
   * brought back to the middle, so the next zoom does not immediately lose it again.
   */
  const withPlayheadInView = useCallback(
    (next: Viewport): Viewport => {
      const startSec = startSecAfterZoom(next, playbackTimeSec, durationSec, followPlayhead);
      return startSec === null ? next : { ...next, startSec };
    },
    [followPlayhead, playbackTimeSec, durationSec],
  );

  /**
   * Move the left edge of the view.
   *
   * The scrollbar's only output. It goes through the same clamp as every other way of
   * moving the view, so the scrollbar cannot put the timeline anywhere a drag could not.
   */
  const handleScrollTo = useCallback(
    (startSec: number) => {
      onViewChange({ ...current, startSec: clampViewportStart(startSec, current, durationSec) });
    },
    [current, durationSec, onViewChange, withPlayheadInView],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // Inside the notes row the click is chart editing; everywhere else it seeks.
      const target = chartTargetAt(x, y);

      // Dragging the view around. The middle button does it anywhere; Shift does it
      // everywhere except the lanes, where Shift now means "and this one too" and a
      // modifier cannot mean two things at once.
      if (event.button === 1 || (event.shiftKey && !target)) {
        dragRef.current = { x, startSec: view.startSec };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }

      if (target && chart) {
        const row = findRow(layout, "notes");
        const hit = row
          ? hitTestNote(x, y, chart.notes, row, chart.laneCount, current)
          : null;

        // A press on the line between two flicks, and not on either of them, means the
        // run. Tested after the notes on purpose: pressing an arrow reaches that one
        // flick, which is the whole reason the flicks stayed separate notes.
        if (mode === "select" && !hit && row) {
          const link = hitTestRunConnector(
            x, y, runConnectors(chart, row, chart.laneCount, current),
          );
          if (link) {
            onSelectRun(link.fromNoteId, event.shiftKey);
            return;
          }
        }

        // What this press means is decided once, from the mode, by a rule that lives
        // outside this component. Nothing below re-reads the gesture.
        const intent = pointerIntent({
          mode,
          noteType,
          hitNoteId: hit?.note.id ?? null,
          hitPart: hit?.part ?? null,
          hitSelected: hit ? selectedNoteIds.includes(hit.note.id) : false,
          shiftKey: event.shiftKey,
        });

        switch (intent.kind) {
          case "selectOne":
            onSelect(intent.noteId);
            // Arm a move. Whether this becomes one is decided by whether the pointer
            // actually travels, not by anything about the mode.
            moveRef.current = {
              pointerId: event.pointerId,
              x, y,
              timeSec: target.timeSec,
              lane: target.lane,
              moved: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            return;
          case "startResize": {
            const note = chart.notes.find((candidate) => candidate.id === intent.noteId);
            if (!note || note.endTimeSec === undefined) return;
            resizeRef.current = {
              pointerId: event.pointerId,
              noteId: intent.noteId,
              endTimeSec: note.endTimeSec,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizePreview({ noteId: intent.noteId, endTimeSec: note.endTimeSec });
            return;
          }
          case "toggleSelected":
            onToggleSelected(intent.noteId);
            return;
          case "startMarquee":
            marqueeRef.current = {
              pointerId: event.pointerId, x, y, add: intent.add,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setMarquee(rectFromCorners(x, y, x, y));
            if (!intent.add) onSelect(null);
            return;
          case "startDrag":
            longRef.current = {
              pointerId: event.pointerId,
              startSec: target.timeSec,
              lane: target.lane,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setPreview({
              timeSec: target.timeSec,
              lane: target.lane,
              snapped: snapMode !== "off",
              type: intent.type,
              endTimeSec: target.timeSec,
              ...(travelsBetweenLanes(intent.type) ? { endLane: target.lane } : {}),
            });
            return;
          case "place":
            onSnapped(target.anchor);
            onPlace(target.timeSec, target.lane);
            return;
          case "ignore":
            return;
        }
      }

      // Outside the notes row the click lands on the analysis overlay. Hitting an event
      // selects it - a read-only consultation that creates nothing - and anything else
      // is a seek, so empty space still moves the playhead as it always did.
      const eventHit = hitTestAnalysisEvent(x, y, current, hitTargets());
      if (eventHit) {
        onSelectEvent(eventHit.event);
        return;
      }

      onSelect(null);
      onSelectEvent(null);
      onSeek(Math.max(0, xToTime(x, current)));
    },
    [
      view.startSec, current, chart, layout, onSeek, chartTargetAt, onPlace, onSelect,
      hitTargets, onSelectEvent, mode, noteType, snapMode, onToggleSelected,
      selectedNoteIds, onSnapped, onSelectRun,
    ],
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

      const band = marqueeRef.current;
      if (band) {
        setMarquee(rectFromCorners(band.x, band.y, x, y));
        return;
      }

      // Stretching a held note. Only the end moves, and it goes through the same snap a
      // placement would, so a resized end lands where a placed one would have.
      const resizing = resizeRef.current;
      if (resizing) {
        // The end of a Long is where a sound stops as often as where one starts, so both
        // edges are candidates here.
        const resolved = snapEndTime(Math.max(0, xToTime(x, current)));
        const endTimeSec = Math.max(0, resolved.timeSec);
        resizeRef.current = { ...resizing, endTimeSec };
        setResizePreview({ noteId: resizing.noteId, endTimeSec });
        onSnapped(resolved.anchor);
        return;
      }

      // Moving the selection. The delta is worked out in snapped time and whole lanes, so
      // what is previewed is exactly what will be committed.
      const moving = moveRef.current;
      if (moving) {
        const row = findRow(layout, "notes");
        const target = chartTargetAt(x, y);
        const travelled = Math.hypot(x - moving.x, y - moving.y);
        if (!moving.moved && travelled < MOVE_THRESHOLD_PX) return;

        const lane = row && chart
          ? (laneAtY(row, chart.laneCount, y) ?? moving.lane)
          : moving.lane;
        const seconds = (target ? target.timeSec : moving.timeSec) - moving.timeSec;
        const lanes = lane - moving.lane;
        moveRef.current = { ...moving, moved: true };
        setMoveDelta({ seconds, lanes });
        return;
      }

      // Dragging out a note with a duration. A Long keeps the lane it started in; a
      // Slide will take its end lane from wherever the pointer comes up.
      const long = longRef.current;
      if (long) {
        const endSec = Math.max(0, snapEndTime(Math.max(0, xToTime(x, current))).timeSec);
        setPreview({
          timeSec: Math.min(long.startSec, endSec),
          lane: long.lane,
          snapped: snapMode !== "off",
          type: noteType,
          endTimeSec: Math.max(long.startSec, endSec),
          ...(travelsBetweenLanes(noteType)
            ? { endLane: laneAtY(findRow(layout, "notes") ?? { topPx: 0, heightPx: 0 },
                                 chart?.laneCount ?? 1, y) ?? long.lane }
            : {}),
        });
        return;
      }

      const target = chartTargetAt(x, y);
      // The cursor says when the end of a selected Long can be dragged, so the grip is
      // discoverable without being drawn on every note in the chart.
      if (mode === "select" && chart) {
        const row = findRow(layout, "notes");
        const hover = row
          ? hitTestNote(x, y, chart.notes, row, chart.laneCount, current)
          : null;
        setOverHandle(
          hover?.part === "resizeHandle" && selectedNoteIds.includes(hover.note.id),
        );
      } else if (overHandle) {
        setOverHandle(false);
      }

      setPreview(
        target && mode === "edit"
          ? {
              timeSec: target.timeSec,
              lane: target.lane,
              snapped: snapMode !== "off",
              type: noteType,
            }
          : null,
      );
    },
    [
      view.pixelsPerSecond, current, durationSec, onViewChange, chartTargetAt, snapMode,
      noteType, snapEndTime, layout, chart, mode, selectedNoteIds, overHandle, onSnapped,
    ],
  );

  /**
   * Finish whatever gesture was in progress.
   *
   * A held note is committed here. The two times are normalised, so dragging leftwards
   * works as well as rightwards, and a drag that snapped both ends onto the same grid
   * line commits nothing: a zero-length hold is not a hold, and storing one would put a
   * note in the chart that no player could ever be asked to hold.
   */
  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      dragRef.current = null;

      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // Commit the rubber band: one selection change, at the end, rather than one per
      // pointer move.
      const band = marqueeRef.current;
      if (band) {
        marqueeRef.current = null;
        setMarquee(null);
        const row = findRow(layout, "notes");
        if (row && chart) {
          const caught = notesInRect(
            rectFromCorners(band.x, band.y, x, y),
            chart.notes,
            row,
            chart.laneCount,
            current,
          );
          onSelectMany(caught.map((note: ChartNote) => note.id), band.add);
        }
        return;
      }

      const resizing = resizeRef.current;
      if (resizing) {
        resizeRef.current = null;
        setResizePreview(null);
        onResize(resizing.noteId, resizing.endTimeSec);
        return;
      }

      const moving = moveRef.current;
      if (moving) {
        moveRef.current = null;
        const delta = moveDelta;
        setMoveDelta(null);
        // A click that never travelled has already done its job: it selected the note.
        if (moving.moved && delta && (delta.seconds !== 0 || delta.lanes !== 0)) {
          onMoveSelected(delta.seconds, delta.lanes);
        }
        return;
      }

      const long = longRef.current;
      if (long) {
        longRef.current = null;
        setPreview(null);
        const resolvedEnd = snapEndTime(Math.max(0, xToTime(x, current)));
        onSnapped(resolvedEnd.anchor);
        const endSec = Math.max(0, resolvedEnd.timeSec);
        const startSec = Math.min(long.startSec, endSec);
        const stopSec = Math.max(long.startSec, endSec);
        if (stopSec > startSec) {
          const row = findRow(layout, "notes");
          const endLane = travelsBetweenLanes(noteType) && row && chart
            ? (laneAtY(row, chart.laneCount, y) ?? long.lane)
            : undefined;
          onPlaceDragged(startSec, stopSec, long.lane, endLane);
        }
      }
    },
    [
      current, snapEndTime, onPlaceDragged, onSelectMany, layout, chart, noteType,
      onResize, onMoveSelected, moveDelta, onSnapped,
    ],
  );

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
          style={overHandle ? { cursor: "ew-resize" } : undefined}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={handlePointerLeave}
        />
      </div>
      <TimelineScrollbar view={current} durationSec={durationSec} onScrollTo={handleScrollTo} />
    </div>
  );
}
