/**
 * Canvas 2D timeline renderer.
 *
 * Independent of React by design: it owns a canvas, it is handed a scene, and it draws.
 * It holds no application state and dispatches no events, so the 2258 events of a real
 * document never become DOM nodes and never pass through React's reconciler.
 *
 * The drawing code is deliberately thin. Every decision that can be expressed as
 * arithmetic - what is visible, where a pitch sits, how a zoom anchors - lives in
 * src/core and is unit tested there.
 */

import type { AnalysisProjection, LaneId, ProjectedEvent } from "../core/analysis";
import { eventBox, type PitchRange, type PitchRanges } from "../core/eventGeometry";
import { findRow, type Layout } from "../core/lanes";
import { timeToX, viewportEndSec, visibleSlice, type Viewport } from "../core/viewport";
import { theme } from "./theme";

export interface Scene {
  readonly view: Viewport;
  readonly layout: Layout;
  readonly projection: AnalysisProjection | null;
  /**
   * Per-lane pitch scales, computed by the caller so that the hit test and the renderer
   * position a pitched event identically. Working them out separately is how a click
   * ends up selecting an event other than the one under the pointer.
   */
  readonly pitchRanges: PitchRanges | null;
  /** The Analysis Event the author has selected, if any. Drawn, never modified. */
  readonly selectedEventId: string | null;
  readonly showGrid: boolean;
  readonly visibleLanes: ReadonlySet<LaneId>;
  /** Display envelope, not playback data: min/max pairs per pixel column. */
  readonly waveform: Float32Array | null;
  readonly waveformDurationSec: number;
  /** Longest bounded event, so the range query starts early enough. */
  readonly maxEventDurationSec: number;
}

export interface RenderStats {
  readonly drawnEvents: number;
  readonly drawnBeats: number;
  readonly millis: number;
}

export class TimelineRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    this.ctx = ctx;
  }

  /** Size the backing store to the device pixel ratio so lines stay crisp. */
  resize(widthCss: number, heightCss: number, devicePixelRatio: number): void {
    this.dpr = devicePixelRatio;
    this.canvas.width = Math.max(1, Math.floor(widthCss * devicePixelRatio));
    this.canvas.height = Math.max(1, Math.floor(heightCss * devicePixelRatio));
    this.canvas.style.width = `${widthCss}px`;
    this.canvas.style.height = `${heightCss}px`;
  }

  render(scene: Scene): RenderStats {
    const started = performance.now();
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const width = scene.view.widthPx;
    const height = scene.layout.totalHeightPx;

    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);

    this.drawRowBands(scene);
    const drawnBeats = scene.showGrid ? this.drawBeatGrid(scene) : 0;
    this.drawWaveform(scene);
    const drawnEvents = this.drawEvents(scene);
    this.drawRuler(scene);
    // The playhead is drawn by the foreground NotesRenderer, so that it stays above the
    // chart notes: beat grid -> analysis overlay -> chart notes -> playhead.

    return { drawnEvents, drawnBeats, millis: performance.now() - started };
  }

  private drawRowBands(scene: Scene): void {
    const { ctx } = this;
    let alternate = false;
    for (const row of scene.layout.rows) {
      if (row.id !== "ruler") {
        if (alternate) {
          ctx.fillStyle = theme.rowAlt;
          ctx.fillRect(0, row.topPx, scene.view.widthPx, row.heightPx);
        }
        alternate = !alternate;
      }
      ctx.strokeStyle = theme.rowBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, row.bottomPx - 0.5);
      ctx.lineTo(scene.view.widthPx, row.bottomPx - 0.5);
      ctx.stroke();
    }
  }

  /**
   * Beats are drawn from the real `beats[]` array, never synthesised from tempo.bpm:
   * the Analyzer emits no tempo map, and a real track's intervals are not uniform.
   */
  private drawBeatGrid(scene: Scene): number {
    const beats = scene.projection?.beats;
    if (!beats || beats.length === 0) return 0;

    const { ctx } = this;
    const from = scene.view.startSec;
    const to = viewportEndSec(scene.view);
    const top = scene.layout.gridTopPx;
    const bottom = scene.layout.gridBottomPx;

    const slice = visibleSlice(
      beats.map((b) => ({ startSec: b.timeSec, isDownbeat: b.isDownbeat })),
      from,
      to,
    );

    // Two passes so every downbeat sits above every beat, regardless of order.
    ctx.strokeStyle = theme.grid.beat;
    ctx.lineWidth = theme.grid.beatWidth;
    ctx.beginPath();
    for (const beat of slice) {
      if (beat.isDownbeat) continue;
      const x = Math.round(timeToX(beat.startSec, scene.view)) + 0.5;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    ctx.stroke();

    ctx.strokeStyle = theme.grid.downbeat;
    ctx.lineWidth = theme.grid.downbeatWidth;
    ctx.beginPath();
    for (const beat of slice) {
      if (!beat.isDownbeat) continue;
      const x = Math.round(timeToX(beat.startSec, scene.view)) + 0.5;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    ctx.stroke();

    return slice.length;
  }

  private drawWaveform(scene: Scene): void {
    const row = findRow(scene.layout, "waveform");
    if (!row || !scene.waveform || scene.waveformDurationSec <= 0) return;

    const { ctx } = this;
    const envelope = scene.waveform;
    const buckets = envelope.length / 2;
    const midY = row.topPx + row.heightPx / 2;
    const halfHeight = row.heightPx / 2 - 4;

    ctx.strokeStyle = theme.waveformCentre;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY + 0.5);
    ctx.lineTo(scene.view.widthPx, midY + 0.5);
    ctx.stroke();

    ctx.fillStyle = theme.waveform;
    for (let x = 0; x < scene.view.widthPx; x += 1) {
      const timeSec = scene.view.startSec + x / scene.view.pixelsPerSecond;
      const bucket = Math.floor((timeSec / scene.waveformDurationSec) * buckets);
      if (bucket < 0 || bucket >= buckets) continue;
      const min = envelope[bucket * 2] ?? 0;
      const max = envelope[bucket * 2 + 1] ?? 0;
      const top = midY - max * halfHeight;
      const height = Math.max(1, (max - min) * halfHeight);
      ctx.fillRect(x, top, 1, height);
    }
  }

  private drawEvents(scene: Scene): number {
    const projection = scene.projection;
    if (!projection) return 0;

    const from = scene.view.startSec;
    const to = viewportEndSec(scene.view);
    let drawn = 0;
    let selection: {
      event: ProjectedEvent;
      row: { topPx: number; heightPx: number };
      range: PitchRange;
    } | null = null;

    for (const lane of ["drums", "other", "bass", "vocals"] as const) {
      if (!scene.visibleLanes.has(lane)) continue;
      const row = findRow(scene.layout, lane);
      if (!row) continue;

      const events = visibleSlice(
        projection.eventsByLane[lane],
        from,
        to,
        scene.maxEventDurationSec,
      );
      drawn += this.drawLane(scene, events, lane, row);

      // Drawn after all the lanes so the marks are never covered by a later lane.
      if (scene.selectedEventId !== null) {
        const selected = events.find((event) => event.id === scene.selectedEventId);
        if (selected) {
          const range = scene.pitchRanges?.[lane] ?? { minMidi: 36, maxMidi: 84 };
          selection = { event: selected, row, range };
        }
      }
    }

    if (selection) {
      this.drawSelectedEvent(scene, selection.event, selection.row, selection.range);
    }
    return drawn;
  }

  /**
   * Call out the selected event without restyling it.
   *
   * A bracket around it and a caret above, in white, drawn in the space beside the event
   * rather than on it. The event keeps its lane colour and its own shape, because it is
   * a measurement and looks the same whether or not anyone is looking at it - and
   * because a selected Chart Note is exactly the opposite treatment, a filled block that
   * brightens and gains a heavy border. The two can never be mistaken for each other.
   */
  private drawSelectedEvent(
    scene: Scene,
    event: ProjectedEvent,
    row: { topPx: number; heightPx: number },
    range: PitchRange,
  ): void {
    const { ctx } = this;
    const box = eventBox(event, row, scene.view, range);
    const pad = theme.selectedEvent.bracketPadPx;
    const left = box.leftPx - pad;
    const right = box.rightPx + pad;
    const top = box.topPx - pad;
    const bottom = box.bottomPx + pad;
    if (right < 0 || left > scene.view.widthPx) return;

    ctx.fillStyle = theme.selectedEvent.halo;
    ctx.fillRect(left, top, right - left, bottom - top);

    ctx.strokeStyle = theme.selectedEvent.marker;
    ctx.lineWidth = theme.selectedEvent.bracketWidth;
    const arm = Math.min(6, (bottom - top) / 2);
    ctx.beginPath();
    // Corner brackets rather than a full rectangle, so a dense drums lane does not turn
    // into a wall of boxes when the selection sits among its neighbours.
    ctx.moveTo(left, top + arm); ctx.lineTo(left, top); ctx.lineTo(left + arm, top);
    ctx.moveTo(right - arm, top); ctx.lineTo(right, top); ctx.lineTo(right, top + arm);
    ctx.moveTo(left, bottom - arm); ctx.lineTo(left, bottom); ctx.lineTo(left + arm, bottom);
    ctx.moveTo(right - arm, bottom); ctx.lineTo(right, bottom); ctx.lineTo(right, bottom - arm);
    ctx.stroke();

    // A caret at the event's start, which is the only moment "place a note here" uses.
    const caretX = box.leftPx;
    const caretTop = row.topPx + 1;
    ctx.fillStyle = theme.selectedEvent.marker;
    ctx.beginPath();
    ctx.moveTo(caretX, caretTop + theme.selectedEvent.caretHeightPx);
    ctx.lineTo(caretX - theme.selectedEvent.caretHalfWidthPx, caretTop);
    ctx.lineTo(caretX + theme.selectedEvent.caretHalfWidthPx, caretTop);
    ctx.closePath();
    ctx.fill();
  }

  private drawLane(
    scene: Scene,
    events: readonly ProjectedEvent[],
    lane: LaneId,
    row: { topPx: number; heightPx: number },
  ): number {
    const { ctx } = this;
    const colour = theme.lanes[lane];
    const range: PitchRange = scene.pitchRanges?.[lane] ?? { minMidi: 36, maxMidi: 84 };
    let drawn = 0;

    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = theme.event.tickWidth;

    for (const event of events) {
      // One source of geometry, shared with the hit test: an event is drawn exactly
      // where a click will find it.
      const box = eventBox(event, row, scene.view, range);
      if (box.rightPx < -4 || box.leftPx > scene.view.widthPx + 4) continue;

      // The switch is on endKind, never on "does endSec exist". A future "unknown"
      // must not silently fall into either of the other two shapes.
      switch (event.endKind) {
        case "instantaneous": {
          ctx.beginPath();
          ctx.moveTo(Math.round(box.leftPx) + 0.5, box.topPx);
          ctx.lineTo(Math.round(box.leftPx) + 0.5, box.bottomPx);
          ctx.stroke();
          drawn += 1;
          break;
        }
        case "bounded": {
          ctx.fillRect(
            box.leftPx,
            box.topPx,
            box.rightPx - box.leftPx,
            box.bottomPx - box.topPx,
          );
          drawn += 1;
          break;
        }
        case "unknown": {
          // Deliberately distinct: a mark for the known start, then a fading tail so
          // it never reads as a measured end.
          const x = box.leftPx;
          const y = row.topPx + row.heightPx / 2;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, box.topPx);
          ctx.lineTo(Math.round(x) + 0.5, box.bottomPx);
          ctx.stroke();
          const gradient = ctx.createLinearGradient(x, 0, x + 24, 0);
          gradient.addColorStop(0, colour);
          gradient.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = gradient;
          ctx.fillRect(x, y - 1, 24, 2);
          ctx.fillStyle = colour;
          drawn += 1;
          break;
        }
      }
    }
    return drawn;
  }

  private drawRuler(scene: Scene): void {
    const row = findRow(scene.layout, "ruler");
    if (!row) return;

    const { ctx } = this;
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, row.topPx, scene.view.widthPx, row.heightPx);

    const step = chooseRulerStep(scene.view.pixelsPerSecond);
    const first = Math.floor(scene.view.startSec / step) * step;
    const end = viewportEndSec(scene.view);

    ctx.strokeStyle = theme.ruler.tick;
    ctx.fillStyle = theme.ruler.text;
    ctx.font = theme.ruler.font;
    ctx.textBaseline = "middle";

    for (let t = first; t <= end; t += step) {
      const x = Math.round(timeToX(t, scene.view)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, row.bottomPx - 6);
      ctx.lineTo(x, row.bottomPx);
      ctx.stroke();
      ctx.fillText(formatTime(t), x + 4, row.topPx + row.heightPx / 2);
    }
  }

}

/** Ruler step in seconds, chosen so labels never collide. */
export function chooseRulerStep(pixelsPerSecond: number): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const minSpacingPx = 70;
  for (const step of candidates) {
    if (step * pixelsPerSecond >= minSpacingPx) return step;
  }
  return candidates[candidates.length - 1] as number;
}

export function formatTime(seconds: number): string {
  // Fixed width and fixed precision: ruler labels sit in one row, so a label whose
  // digit count depends on its own value makes neighbours disagree ("2:09.00" beside
  // "2:10.0") and shifts the text away from its tick. Rounding to centiseconds before
  // splitting also keeps 59.999 s from formatting as ":60.00".
  const total = Math.round(Math.max(0, seconds) * 100) / 100;
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}
