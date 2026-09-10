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

import {
  LANE_IDS,
  type AnalysisProjection, type LaneId, type ProjectedEvent,
} from "../core/analysis";
import {
  slidePoints, travelsBetweenLanes, MIN_HELD_DURATION_SEC,
  type ChartNote, type ChartState, type EditorMode, type PlaceableType,
  type PlaceTarget,
} from "../core/chart";
import {
  hitTestAnalysisEvent, pitchRangesFor, type LaneHitTarget, type PitchRanges,
} from "../core/eventGeometry";
import {
  hitTestNote, hitTestRunConnector, notesInRect, rectFromCorners, runConnectors,
  type SelectionRect,
} from "../core/noteGeometry";
import { findRow, laneAtY, layoutRows, rowsForChart, type RowId } from "../core/lanes";
import {
  MIN_DECORATION_DURATION_SEC, displayWindow, type ChartDecoration,
} from "../core/decoration";
import {
  decorationsInRect, hitTestDecoration, type DecorationPart,
} from "../core/decorationGeometry";
import { pointerIntent, type ResizeEdge } from "../core/pointerIntent";
import {
  resolvePlacementTime, type SnapMode, type SnapSettings,
} from "../core/snap";
import { buildGuideAnchors, type GuideAnchor } from "../core/guideAnchors";
import {
  buildMagnetCandidates, magnetSnapDelta, magnetSnapEdge,
  type MagnetEdgeHold, type MagnetHold, type SnapCandidate,
} from "../core/magnetSnap";
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
  type MoveDelta,
  type NotesRenderStats,
  type NotesScene,
  type PlacementPreview,
  type ResizePreview,
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
  /** Commit a drag that changed where a held note starts. Its end is untouched. */
  readonly onResizeStart: (noteId: string, timeSec: number) => void;

  /**
   * The decorations, and what is selected among them.
   *
   * Passed beside the notes rather than inside the chart prop because the notes row can
   * be switched off on its own, and a decoration is not hidden by hiding the notes.
   */
  readonly decorations: readonly ChartDecoration[];
  readonly selectedDecorationIds: readonly string[];
  /** What Edit Mode makes: a note of the chosen kind, or a text decoration. */
  readonly placeTarget: PlaceTarget;
  readonly onPlaceDecoration: (startTimeSec: number) => void;
  readonly onSelectDecoration: (id: string | null) => void;
  readonly onToggleDecorationSelected: (id: string) => void;
  /** Replace, or extend, a selection that may hold both kinds. What a rubber band does. */
  readonly onSelectObjects: (
    noteIds: readonly string[],
    decorationIds: readonly string[],
    add: boolean,
  ) => void;
  readonly onResizeDecorationStart: (id: string, startTimeSec: number) => void;
  readonly onResizeDecorationEnd: (id: string, endTimeSec: number) => void;
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

/** Shared empty set, so a default argument does not allocate on every drag. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export function Timeline(props: TimelineProps): React.JSX.Element {
  const {
    projection, view, onViewChange, playheadSec, onSeek,
    visibleRows, showGrid, waveform, waveformDurationSec, maxEventDurationSec, onStats,
    onNotesStats, chart, snapGrid, snap, snapMode, visibleLanes, onSnapped,
    selectedNoteIds, mode, noteType,
    onPlace, onPlaceDragged, onSelect, onSelectMany, onToggleSelected, onSelectRun,
    onMoveSelected, onResize, onResizeStart,
    decorations, selectedDecorationIds, placeTarget, onPlaceDecoration,
    onSelectDecoration, onToggleDecorationSelected, onSelectObjects,
    onResizeDecorationStart, onResizeDecorationEnd,
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
   *
   * The magnet guide is carried inside the same value, so it cannot outlive the drag that
   * produced it: every path that clears the move clears the line with it.
   */
  const [moveDelta, setMoveDelta] = useState<MoveDelta | null>(null);
  /**
   * Where the magnet has taken whatever is being dragged.
   *
   * One piece of state for every gesture that has a magnet, so the dotted line is drawn
   * by one rule and a beat, an Analysis Event and another note's edge all produce the
   * same line. It is cleared everywhere a gesture is cleared, which is what keeps it from
   * outliving the drag it belongs to.
   */
  const [snapGuideSec, setSnapGuideSec] = useState<number | null>(null);
  const moveRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    /** Pointer time when the press landed, unsnapped, so the drag tracks the hand. */
    rawSec: number;
    lane: number;
    /**
     * The dragged note's own edges before the drag, and the earliest time in the moving
     * set. What the magnet lines up, as opposed to where the pointer is.
     */
    baseEdgesSec: readonly number[];
    earliestMovingSec: number;
    /**
     * Everything the note may be lined up with, built once here.
     *
     * A real song offers a few thousand candidates, and rebuilding and re-sorting them on
     * every pointer move is the one thing that would make dragging feel heavy. The chart
     * cannot change under a drag - the preview never touches it - so the list stays true
     * for the whole gesture. Empty when the author has snapping switched off, which is
     * also how the magnet is kept out of the way entirely.
     */
    candidates: readonly SnapCandidate[];
    /**
     * The candidate currently holding the note, carried from move to move.
     *
     * The magnet's whole memory, and it lives here rather than inside the resolver so
     * that resolver stays pure: it is created by the press and dies with the gesture.
     */
    hold: MagnetHold | null;
    moved: boolean;
    /**
     * Whether this drag may change lanes at all.
     *
     * Set for a drag begun in the decorations row. A decoration has no lane, and a
     * vertical wobble there must not quietly move whatever notes are in the selection to
     * another one - the author is looking at a row where lanes are not drawn.
     */
    lanesLocked: boolean;
  } | null>(null);

  const [resizePreview, setResizePreview] = useState<ResizePreview | null>(null);
  /**
   * A decoration's window being dragged.
   *
   * Its own preview rather than a widened `resizePreview`, because the renderer draws the
   * two in different rows by different rules and a shared value would have to be
   * unpacked with a question about which kind it held.
   */
  const [decorationResize, setDecorationResize] = useState<{
    decorationId: string;
    startTimeSec: number;
    endTimeSec: number;
  } | null>(null);
  /**
   * A grip being dragged.
   *
   * Carries the same three things the move does - the candidates, the magnet's memory and
   * the times as they stand - because it is the same gesture asked about one edge instead
   * of a whole note. `edge` says which grip was taken; `fixedSec` is the other end, which
   * this gesture must not move, and which bounds where this one may go.
   */
  const resizeRef = useRef<{
    pointerId: number;
    /** Which object's window is being dragged. Exactly one of the two is set. */
    noteId: string | null;
    decorationId: string | null;
    edge: ResizeEdge;
    fixedSec: number;
    timeSec: number;
    endTimeSec: number;
    candidates: readonly SnapCandidate[];
    hold: MagnetEdgeHold | null;
  } | null>(null);

  /** True while the pointer is over a selected Long's grip, so the cursor can say so. */
  const [overHandle, setOverHandle] = useState(false);

  /**
   * Abandon whatever gesture is in progress.
   *
   * Safe to call at any moment, because none of this state has touched the chart or the
   * history: dropping it loses an edit that was never made rather than one that was. One
   * function rather than the same eight lines in two places, so a gesture added later
   * cannot be forgotten by one of them.
   */
  const abandonGesture = useCallback(() => {
    dragRef.current = null;
    marqueeRef.current = null;
    longRef.current = null;
    moveRef.current = null;
    resizeRef.current = null;
    setMarquee(null);
    setPreview(null);
    setMoveDelta(null);
    setResizePreview(null);
    setDecorationResize(null);
    setSnapGuideSec(null);
  }, []);

  /**
   * Drop any gesture in progress when the mode changes.
   *
   * The meaning of a drag is fixed when it starts, so a rubber band or a half-drawn note
   * left over from the other mode would finish under rules nobody chose.
   */
  useEffect(() => {
    abandonGesture();
  }, [mode, abandonGesture]);

  /**
   * A gesture whose end this canvas will never see.
   *
   * If the window loses focus while the button is down - the author switches application,
   * or something else takes the foreground - the release happens somewhere else and
   * neither `pointerup` nor `pointercancel` arrives here. Whatever was in progress would
   * then stay armed indefinitely: the next press would be intercepted by a rubber band
   * that ended minutes ago and quietly refuse to move anything, and a magnet guide would
   * be left painted down the timeline pointing at nothing.
   *
   * So losing focus ends the gesture. Element blur does not bubble, so this listener sees
   * the window's own blur and not a click moving between the toolbar's controls.
   */
  useEffect(() => {
    window.addEventListener("blur", abandonGesture);
    return () => window.removeEventListener("blur", abandonGesture);
  }, [abandonGesture]);

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
        LANE_IDS.filter((lane) => visibleRows.has(lane)),
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
        snapGuideTimeSec: snapGuideSec,
        decorations,
        selectedDecorationIds,
        decorationResizePreview: decorationResize,
        playheadSec,
      };
      onNotesStats(renderer.render(scene));
    });
    return () => cancelAnimationFrame(frame);
  }, [
    view, widthPx, layout, chart, selectedNoteIds, preview, marquee, moveDelta,
    resizePreview, snapGuideSec, playheadSec, onNotesStats,
    decorations, selectedDecorationIds, decorationResize,
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
    for (const lane of LANE_IDS) {
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

  /**
   * Everything a gesture in Select Mode may line a note up with.
   *
   * The one place the magnet's targets are decided, and every drag goes through it - the
   * whole-note move and both grips alike. That is deliberate: the bug this replaced was
   * one gesture assembling its own sources and quietly leaving the Analysis Events out,
   * which is invisible from the outside because the beat grid still worked.
   *
   * The Analysis side arrives already converted. `buildGuideAnchors` is the single place
   * the overlay becomes timings, so the magnet inherits its rules for free: the layers
   * that are switched on are the ones you can snap to, an event's kind is never tested by
   * name, and an end is only offered by an event that actually has one. Ends are included
   * because a note being carried has ends of its own, and lining a hold up with where a
   * sung note stopped is exactly what the author is looking at when they do it.
   *
   * Unrelated to the Snap control, which governs where a *click places* a new note. This
   * is about carrying something that already exists, and tying the two together made the
   * magnet silently dead for any project saved with snapping off.
   */
  const dragCandidates = useCallback(
    (
      excludeNoteIds: ReadonlySet<string>,
      excludeDecorationIds: ReadonlySet<string> = EMPTY_IDS,
    ) =>
      buildMagnetCandidates({
        beatGrid: snapGrid,
        notes: chart?.notes ?? [],
        excludeNoteIds,
        decorations,
        excludeDecorationIds,
        eventAnchors: endAnchors,
      }),
    [snapGrid, chart, decorations, endAnchors],
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

      // The decorations row, before anything else, because it is a row of its own and a
      // press in it can never mean a note. Handling it here rather than teaching the note
      // path about decorations keeps the two gestures from having to test what they are
      // looking at on every branch.
      const decorationRow = findRow(layout, "decorations");
      if (decorationRow && y >= decorationRow.topPx && y < decorationRow.bottomPx) {
        const pressSec = Math.max(0, xToTime(x, current));
        if (mode === "edit") {
          if (placeTarget === "text") onPlaceDecoration(pressSec);
          return;
        }

        const hit = hitTestDecoration(x, y, decorations, decorationRow, current);
        if (!hit) {
          marqueeRef.current = { pointerId: event.pointerId, x, y, add: event.shiftKey };
          event.currentTarget.setPointerCapture(event.pointerId);
          setMarquee(rectFromCorners(x, y, x, y));
          if (!event.shiftKey) onSelectObjects([], [], false);
          return;
        }
        if (event.shiftKey) {
          onToggleDecorationSelected(hit.decoration.id);
          return;
        }

        const selected = selectedDecorationIds.includes(hit.decoration.id);
        const grip: DecorationPart | null =
          selected && hit.part !== "body" ? hit.part : null;
        if (grip) {
          const window = displayWindow(hit.decoration);
          resizeRef.current = {
            pointerId: event.pointerId,
            noteId: null,
            decorationId: hit.decoration.id,
            edge: grip === "startHandle" ? "start" : "end",
            fixedSec: grip === "startHandle" ? window.endSec : window.startSec,
            timeSec: window.startSec,
            endTimeSec: window.endSec,
            candidates: dragCandidates(EMPTY_IDS, new Set([hit.decoration.id])),
            hold: null,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDecorationResize({
            decorationId: hit.decoration.id,
            startTimeSec: window.startSec,
            endTimeSec: window.endSec,
          });
          return;
        }

        // Pressing something already selected carries the whole selection, which is what
        // makes a mixed set of notes and decorations draggable as one. Pressing anything
        // else selects it first, exactly as pressing a note does.
        const movingNotes = selected ? selectedNoteIds : [];
        const movingDecorations = selected
          ? selectedDecorationIds
          : [hit.decoration.id];
        if (!selected) onSelectDecoration(hit.decoration.id);

        const edges: number[] = [];
        let earliest = Number.POSITIVE_INFINITY;
        for (const id of movingDecorations) {
          const found = decorations.find((candidate) => candidate.id === id);
          if (!found) continue;
          const window = displayWindow(found);
          edges.push(window.startSec, window.endSec);
          earliest = Math.min(earliest, window.startSec);
        }
        for (const id of movingNotes) {
          const found = chart?.notes.find((candidate) => candidate.id === id);
          if (!found) continue;
          // Every timing point the note has, not just its two ends: a slide is judged
          // at each of its points, so any of them is a thing an author lines up with.
          for (const point of slidePoints(found)) edges.push(point.timeSec);
          earliest = Math.min(earliest, found.timeSec);
        }

        moveRef.current = {
          pointerId: event.pointerId,
          x, y,
          rawSec: pressSec,
          lane: 0,
          baseEdgesSec: edges,
          earliestMovingSec: Number.isFinite(earliest) ? earliest : 0,
          candidates: dragCandidates(
            new Set(movingNotes),
            new Set(movingDecorations),
          ),
          hold: null,
          moved: false,
          // A decoration has no lane, so a vertical drag in this row must not become one.
          lanesLocked: true,
        };
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

        // Text is not a note kind, so it never reaches `pointerIntent`. A press with the
        // text tool held makes a decoration wherever in the chart area it lands, which
        // saves the author aiming at a thirty-pixel row to start one.
        if (mode === "edit" && placeTarget === "text") {
          onPlaceDecoration(target.rawSec);
          return;
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
          case "selectOne": {
            // `hit` is what `pointerIntent` was told about, so this is the note the author
            // pressed rather than a second search that could disagree with it.
            const held = hit?.note;
            if (!held) return;

            // Pressing something already selected keeps the selection and carries all of
            // it, which is the only way a set built with shift - notes and decorations
            // together - can be dragged as one. Pressing anything else replaces the
            // selection with it first, which is what it has always done.
            const alreadySelected = selectedNoteIds.includes(held.id);
            if (!alreadySelected) onSelect(held.id);
            const movingNoteIds = alreadySelected ? selectedNoteIds : [held.id];
            const movingDecorationIds = alreadySelected ? selectedDecorationIds : [];

            // The magnet must exclude every object that moves, or a group would catch on
            // its own members and be pulled apart.
            const moving = new Set(movingNoteIds);
            const edges: number[] = [];
            let earliestMoving = Number.POSITIVE_INFINITY;
            for (const id of movingNoteIds) {
              const found = chart.notes.find((candidate) => candidate.id === id);
              if (!found) continue;
              // Every timing point, so a slide can be aligned by any of its points and
              // not only by the two ends of it.
              for (const point of slidePoints(found)) edges.push(point.timeSec);
              earliestMoving = Math.min(earliestMoving, found.timeSec);
            }
            for (const id of movingDecorationIds) {
              const found = decorations.find((candidate) => candidate.id === id);
              if (!found) continue;
              const window = displayWindow(found);
              edges.push(window.startSec, window.endSec);
              earliestMoving = Math.min(earliestMoving, window.startSec);
            }
            // Arm a move. Whether this becomes one is decided by whether the pointer
            // actually travels, not by anything about the mode.
            moveRef.current = {
              pointerId: event.pointerId,
              x, y,
              rawSec: target.rawSec,
              lane: target.lane,
              baseEdgesSec: edges,
              earliestMovingSec: Number.isFinite(earliestMoving)
                ? earliestMoving
                : held.timeSec,
              /**
               * Deliberately not conditioned on the Snap control.
               *
               * That control's own tooltip says what it governs: "what a click on the
               * timeline snaps to". It is about placing a new note. Moving one that is
               * already written is a different question with different targets, and
               * tying the two together made the magnet silently dead for any project
               * saved with snapping off - with no way to find out why, because the Snap
               * control is only drawn in Edit Mode and this gesture only exists in
               * Select Mode.
               *
               * So the magnet is always live during a drag, and Alt suspends it. The
               * targets themselves come from `dragCandidates`, which every gesture in
               * this mode shares.
               */
              candidates: dragCandidates(moving, new Set(movingDecorationIds)),
              hold: null,
              moved: false,
              lanesLocked: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            return;
          }
          case "startResize": {
            const note = chart.notes.find((candidate) => candidate.id === intent.noteId);
            if (!note || note.endTimeSec === undefined) return;
            // The note being resized is excluded from its own targets, exactly as a moving
            // one is: a grip that snapped to the edge it was dragging would never move,
            // and a grip that snapped to the other edge would collapse the note.
            resizeRef.current = {
              pointerId: event.pointerId,
              noteId: intent.noteId,
              decorationId: null,
              edge: intent.edge,
              fixedSec: intent.edge === "start" ? note.endTimeSec : note.timeSec,
              timeSec: note.timeSec,
              endTimeSec: note.endTimeSec,
              candidates: dragCandidates(new Set([note.id])),
              hold: null,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizePreview({
              noteId: intent.noteId,
              timeSec: note.timeSec,
              endTimeSec: note.endTimeSec,
            });
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
      selectedNoteIds, onSnapped, onSelectRun, dragCandidates,
      decorations, selectedDecorationIds, placeTarget, onPlaceDecoration,
      onSelectDecoration, onToggleDecorationSelected, onSelectObjects,
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

      // Stretching a held note from one of its grips. The edge being dragged goes through
      // the same magnet the whole-note move uses, against the same candidates, so a grip
      // lands on a beat, an Analysis Event or another note's edge indifferently - and
      // draws the same dotted guide when it does.
      const resizing = resizeRef.current;
      if (resizing) {
        // The other end is fixed, and it is what bounds this one: a hold has to last at
        // least `MIN_HELD_DURATION_SEC`, so the grip is never offered a candidate that
        // would invert the note or collapse it to nothing.
        const snapped = magnetSnapEdge({
          candidates: resizing.candidates,
          rawTimeSec: Math.max(0, xToTime(x, current)),
          ...(() => {
            const minimum =
              resizing.decorationId !== null
                ? MIN_DECORATION_DURATION_SEC
                : MIN_HELD_DURATION_SEC;
            return resizing.edge === "start"
              ? { maxTimeSec: resizing.fixedSec - minimum }
              : { minTimeSec: resizing.fixedSec + minimum };
          })(),
          pixelsPerSecond: current.pixelsPerSecond,
          // Alt suspends the magnet here for the same reason it does during a move.
          enabled: !event.altKey,
          held: resizing.hold,
        });
        const next =
          resizing.edge === "start"
            ? { timeSec: snapped.timeSec, endTimeSec: resizing.fixedSec }
            : { timeSec: resizing.fixedSec, endTimeSec: snapped.timeSec };
        resizeRef.current = { ...resizing, ...next, hold: snapped.hold };
        if (resizing.decorationId !== null) {
          setDecorationResize({
            decorationId: resizing.decorationId,
            startTimeSec: next.timeSec,
            endTimeSec: next.endTimeSec,
          });
        } else if (resizing.noteId !== null) {
          setResizePreview({ noteId: resizing.noteId, ...next });
        }
        setSnapGuideSec(snapped.guideTimeSec);
        return;
      }

      // Moving the selection. The delta is worked out in seconds and whole lanes, so what
      // is previewed is exactly what will be committed.
      const moving = moveRef.current;
      if (moving) {
        const row = findRow(layout, "notes");
        const travelled = Math.hypot(x - moving.x, y - moving.y);
        if (!moving.moved && travelled < MOVE_THRESHOLD_PX) return;

        const lane =
          moving.lanesLocked || !row || !chart
            ? moving.lane
            : (laneAtY(row, chart.laneCount, y) ?? moving.lane);
        // The magnet works on the note, not on the pointer: it is offered how far the
        // hand has travelled and answers with how far the note should go, which is what
        // lets it put an edge *on* something instead of quantising the journey there.
        const snapped = magnetSnapDelta({
          candidates: moving.candidates,
          baseEdgesSec: moving.baseEdgesSec,
          rawDeltaSec: xToTime(x, current) - moving.rawSec,
          earliestMovingSec: moving.earliestMovingSec,
          pixelsPerSecond: current.pixelsPerSecond,
          // Alt suspends the magnet for as long as it is held, so an author can put a
          // note just off a beat without reaching for a switch. Read here rather than
          // latched at the press, so it can be taken and released mid-drag.
          enabled: !event.altKey,
          // What the last move was holding, so a captured candidate keeps the note
          // through small movements instead of letting go at the distance that took it.
          held: moving.hold,
        });
        const lanes = lane - moving.lane;
        moveRef.current = { ...moving, hold: snapped.hold, moved: true };
        setMoveDelta({ seconds: snapped.deltaSec, lanes });
        setSnapGuideSec(snapped.guideTimeSec);
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
      // The cursor says when a grip can be dragged, so a grip is discoverable without
      // being drawn on every object in the chart. The same answer for both kinds, because
      // it is the same gesture and the same cursor.
      if (mode === "select") {
        const row = chart ? findRow(layout, "notes") : undefined;
        const hover =
          row && chart
            ? hitTestNote(x, y, chart.notes, row, chart.laneCount, current)
            : null;
        const overNoteGrip =
          (hover?.part === "resizeHandle" || hover?.part === "startHandle") &&
          selectedNoteIds.includes(hover.note.id);

        const decorationRow = findRow(layout, "decorations");
        const overDecoration = decorationRow
          ? hitTestDecoration(x, y, decorations, decorationRow, current)
          : null;
        const overDecorationGrip =
          overDecoration !== null &&
          overDecoration.part !== "body" &&
          selectedDecorationIds.includes(overDecoration.decoration.id);

        setOverHandle(overNoteGrip || overDecorationGrip);
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
      decorations, selectedDecorationIds,
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
        const rect = rectFromCorners(band.x, band.y, x, y);
        const row = findRow(layout, "notes");
        const caughtNotes =
          row && chart
            ? notesInRect(rect, chart.notes, row, chart.laneCount, current)
            : [];
        // The band is one rectangle over one canvas, so a drag that crosses both rows
        // catches what is in both. Anything else would mean the author had to know which
        // row they started in, which is not a thing a rubber band should be about.
        const decorationRow = findRow(layout, "decorations");
        const caughtDecorations = decorationRow
          ? decorationsInRect(rect, decorations, decorationRow, current)
          : [];
        onSelectObjects(
          caughtNotes.map((note: ChartNote) => note.id),
          caughtDecorations.map((decoration: ChartDecoration) => decoration.id),
          band.add,
        );
        return;
      }

      const resizing = resizeRef.current;
      if (resizing) {
        resizeRef.current = null;
        setResizePreview(null);
        setDecorationResize(null);
        setSnapGuideSec(null);
        // One command for the whole gesture, so the drag is one step in the history
        // rather than one per pointer move - and the command names the edge that moved,
        // so undo puts back the end the author actually pulled.
        if (resizing.decorationId !== null) {
          if (resizing.edge === "start") {
            onResizeDecorationStart(resizing.decorationId, resizing.timeSec);
          } else {
            onResizeDecorationEnd(resizing.decorationId, resizing.endTimeSec);
          }
        } else if (resizing.noteId !== null) {
          if (resizing.edge === "start") onResizeStart(resizing.noteId, resizing.timeSec);
          else onResize(resizing.noteId, resizing.endTimeSec);
        }
        return;
      }

      const moving = moveRef.current;
      if (moving) {
        moveRef.current = null;
        const delta = moveDelta;
        setMoveDelta(null);
        setSnapGuideSec(null);
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
      onResize, onResizeStart, onMoveSelected, moveDelta, onSnapped,
      decorations, onResizeDecorationStart, onResizeDecorationEnd, onSelectObjects,
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
