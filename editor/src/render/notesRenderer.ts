/**
 * The foreground layer: chart notes, the placement preview, and the playhead.
 *
 * A separate canvas from the analysis timeline on purpose. Placing a note repaints only
 * this layer, so a document with a couple of thousand Analysis Events is not redrawn
 * every time the pointer moves across a lane. It also fixes the stacking order the
 * Editor needs, from back to front:
 *
 *   beat grid -> Analysis overlay -> Chart notes -> playhead and live interaction
 *
 * which is why the playhead is drawn here rather than by the timeline renderer: it has
 * to stay visible over the notes.
 *
 * Like the timeline renderer this is plain TypeScript with no React in it, and notes are
 * never DOM nodes.
 */

import type { ChartNote, ChartState } from "../core/chart";
import { findRow, laneBand, type Layout } from "../core/lanes";
import { timeToX, viewportEndSec, type Viewport } from "../core/viewport";
import { theme } from "./theme";

/** Transient interaction state. Deliberately not part of the Chart document. */
export interface PlacementPreview {
  readonly timeSec: number;
  readonly lane: number;
  readonly snapped: boolean;
}

export interface NotesScene {
  readonly view: Viewport;
  readonly layout: Layout;
  readonly chart: ChartState | null;
  readonly selectedNoteId: string | null;
  readonly preview: PlacementPreview | null;
  readonly playheadSec: number;
}

export interface NotesRenderStats {
  readonly drawnNotes: number;
  readonly millis: number;
}

export class NotesRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // Transparent, unlike the timeline canvas: this layer sits over it.
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    this.ctx = ctx;
  }

  resize(widthCss: number, heightCss: number, devicePixelRatio: number): void {
    this.dpr = devicePixelRatio;
    this.canvas.width = Math.max(1, Math.floor(widthCss * devicePixelRatio));
    this.canvas.height = Math.max(1, Math.floor(heightCss * devicePixelRatio));
    this.canvas.style.width = `${widthCss}px`;
    this.canvas.style.height = `${heightCss}px`;
  }

  render(scene: NotesScene): NotesRenderStats {
    const started = performance.now();
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, scene.view.widthPx, scene.layout.totalHeightPx);

    const row = findRow(scene.layout, "notes");
    let drawnNotes = 0;
    if (row && scene.chart) {
      this.drawLaneBands(scene, row);
      drawnNotes = this.drawNotes(scene, row);
      this.drawPreview(scene, row);
    }
    this.drawPlayhead(scene);

    return { drawnNotes, millis: performance.now() - started };
  }

  /** Lane separators and labels, so a lane is something the author can aim at. */
  private drawLaneBands(
    scene: NotesScene,
    row: { topPx: number; heightPx: number },
  ): void {
    const { ctx } = this;
    const laneCount = scene.chart?.laneCount ?? 0;
    const width = scene.view.widthPx;

    if (scene.preview) {
      const band = laneBand(row, laneCount, scene.preview.lane);
      ctx.fillStyle = theme.preview.laneHighlight;
      ctx.fillRect(0, band.topPx, width, band.heightPx);
    }

    ctx.strokeStyle = theme.noteLaneBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lane = 1; lane < laneCount; lane += 1) {
      const y = Math.round(laneBand(row, laneCount, lane).topPx) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();

    ctx.fillStyle = theme.noteLaneLabel;
    ctx.font = theme.label.font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (let lane = 0; lane < laneCount; lane += 1) {
      const band = laneBand(row, laneCount, lane);
      ctx.fillText(`L${lane + 1}`, 4, band.centreYPx);
    }
  }

  private drawNotes(
    scene: NotesScene,
    row: { topPx: number; heightPx: number },
  ): number {
    const chart = scene.chart;
    if (!chart) return 0;

    const from = scene.view.startSec;
    const to = viewportEndSec(scene.view);
    // A note's own width spills a little past its time, so widen the window slightly.
    const marginSec = (theme.note.widthPx / scene.view.pixelsPerSecond) * 2;

    let drawn = 0;
    for (const note of chart.notes) {
      const end = note.endTimeSec ?? note.timeSec;
      if (end < from - marginSec || note.timeSec > to + marginSec) continue;
      this.drawNote(scene, row, note, note.id === scene.selectedNoteId);
      drawn += 1;
    }
    return drawn;
  }

  private drawNote(
    scene: NotesScene,
    row: { topPx: number; heightPx: number },
    note: ChartNote,
    selected: boolean,
  ): void {
    const { ctx } = this;
    const laneCount = scene.chart?.laneCount ?? 1;
    const band = laneBand(row, laneCount, note.lane);
    const height = Math.min(theme.note.heightPx, band.heightPx - 4);
    const y = band.centreYPx - height / 2;
    const x = timeToX(note.timeSec, scene.view);

    // A held note is drawn to its end time. The Editor cannot author one yet, but a
    // chart written elsewhere may contain them and they must not render as taps.
    const endX =
      note.endTimeSec !== undefined ? timeToX(note.endTimeSec, scene.view) : x;
    const left = x - theme.note.widthPx / 2;
    const width = Math.max(theme.note.widthPx, endX - left + theme.note.widthPx / 2);

    ctx.beginPath();
    ctx.roundRect(left, y, width, height, theme.note.radiusPx);
    ctx.fillStyle = selected ? theme.note.selectedFill : theme.note.fill;
    ctx.fill();
    ctx.strokeStyle = selected ? theme.note.selectedBorder : theme.note.border;
    ctx.lineWidth = selected ? theme.note.borderWidth + 1 : theme.note.borderWidth;
    ctx.stroke();

    // Directional notes carry their direction as a mark rather than a separate colour.
    if (note.direction) {
      ctx.fillStyle = theme.note.flickMarker;
      ctx.font = theme.label.font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(arrowFor(note.direction), left + width / 2, band.centreYPx);
    }
  }

  /** Where a click would put a note, drawn as an outline so it reads as not-yet-real. */
  private drawPreview(
    scene: NotesScene,
    row: { topPx: number; heightPx: number },
  ): void {
    const preview = scene.preview;
    if (!preview) return;

    const { ctx } = this;
    const laneCount = scene.chart?.laneCount ?? 1;
    const band = laneBand(row, laneCount, preview.lane);
    const height = Math.min(theme.note.heightPx, band.heightPx - 4);
    const x = timeToX(preview.timeSec, scene.view);

    if (preview.snapped) {
      ctx.strokeStyle = theme.preview.guide;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, scene.layout.gridTopPx);
      ctx.lineTo(Math.round(x) + 0.5, scene.layout.gridBottomPx);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.roundRect(
      x - theme.note.widthPx / 2,
      band.centreYPx - height / 2,
      theme.note.widthPx,
      height,
      theme.note.radiusPx,
    );
    ctx.fillStyle = theme.preview.fill;
    ctx.fill();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = theme.preview.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawPlayhead(scene: NotesScene): void {
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

function arrowFor(direction: string): string {
  switch (direction) {
    case "left": return "←";
    case "right": return "→";
    case "up": return "↑";
    case "down": return "↓";
    case "upLeft": return "↖";
    case "upRight": return "↗";
    case "downLeft": return "↙";
    case "downRight": return "↘";
    default: return "";
  }
}
