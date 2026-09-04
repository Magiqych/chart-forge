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
import { findRow, pitchRange, pitchToY, type Layout } from "../core/lanes";
import { timeToX, viewportEndSec, visibleSlice, type Viewport } from "../core/viewport";
import { theme } from "./theme";

export interface Scene {
  readonly view: Viewport;
  readonly layout: Layout;
  readonly projection: AnalysisProjection | null;
  readonly playheadSec: number;
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
  private pitchRanges = new Map<LaneId, { minMidi: number; maxMidi: number }>();
  private pitchRangeSource: AnalysisProjection | null = null;

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
    this.drawPlayhead(scene);

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

    this.refreshPitchRanges(projection);

    const from = scene.view.startSec;
    const to = viewportEndSec(scene.view);
    let drawn = 0;

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
    }
    return drawn;
  }

  private drawLane(
    scene: Scene,
    events: readonly ProjectedEvent[],
    lane: LaneId,
    row: { topPx: number; heightPx: number },
  ): number {
    const { ctx } = this;
    const colour = theme.lanes[lane];
    const range = this.pitchRanges.get(lane) ?? { minMidi: 36, maxMidi: 84 };
    let drawn = 0;

    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = theme.event.tickWidth;

    for (const event of events) {
      const x = timeToX(event.startSec, scene.view);

      // The switch is on endKind, never on "does endSec exist". A future "unknown"
      // must not silently fall into either of the other two shapes.
      switch (event.endKind) {
        case "instantaneous": {
          if (x < -4 || x > scene.view.widthPx + 4) continue;
          const inset = theme.event.tickInsetPx;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, row.topPx + inset);
          ctx.lineTo(Math.round(x) + 0.5, row.topPx + row.heightPx - inset);
          ctx.stroke();
          drawn += 1;
          break;
        }
        case "bounded": {
          const endX = timeToX(event.endSec ?? event.startSec, scene.view);
          if (endX < -4 || x > scene.view.widthPx + 4) continue;
          const y = event.pitch
            ? pitchToY(event.pitch.midi, row, range)
            : row.topPx + row.heightPx / 2;
          const width = Math.max(theme.event.minSpanWidthPx, endX - x);
          ctx.fillRect(x, y - theme.event.spanHeightPx / 2, width, theme.event.spanHeightPx);
          drawn += 1;
          break;
        }
        case "unknown": {
          // Deliberately distinct: a mark for the known start, then a fading tail so
          // it never reads as a measured end.
          if (x < -4 || x > scene.view.widthPx + 4) continue;
          const y = row.topPx + row.heightPx / 2;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, row.topPx + theme.event.tickInsetPx);
          ctx.lineTo(Math.round(x) + 0.5, row.topPx + row.heightPx - theme.event.tickInsetPx);
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

  /** Bass and vocals occupy very different registers, so each lane gets its own scale. */
  private refreshPitchRanges(projection: AnalysisProjection): void {
    if (this.pitchRangeSource === projection) return;
    this.pitchRanges.clear();
    for (const lane of ["bass", "vocals"] as const) {
      this.pitchRanges.set(lane, pitchRange(projection.eventsByLane[lane]));
    }
    this.pitchRangeSource = projection;
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

  private drawPlayhead(scene: Scene): void {
    const x = timeToX(scene.playheadSec, scene.view);
    if (x < 0 || x > scene.view.widthPx) return;
    const { ctx } = this;
    ctx.strokeStyle = theme.playhead;
    ctx.lineWidth = theme.playheadWidth;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, scene.layout.totalHeightPx);
    ctx.stroke();
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
