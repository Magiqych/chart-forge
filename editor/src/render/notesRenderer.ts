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

import type { ChartNote, ChartState, Direction } from "../core/chart";
import { findRow, laneBand, type Layout } from "../core/lanes";
import { isTextDecoration, type ChartDecoration } from "../core/decoration";
import {
  decorationRowGeometry, type DecorationRowGeometry,
} from "../core/decorationGeometry";
import {
  isNoteVisible, noteGeometry, noteMarginSec, runConnectors,
  type NoteArrow, type NoteBody, type NoteBox, type NoteConnector, type NoteGeometry,
  type NoteMarker, type NoteRow, type SelectionRect,
} from "../core/noteGeometry";
import { timeToX, viewportEndSec, type Viewport } from "../core/viewport";
import { theme } from "./theme";

/** Transient interaction state. Deliberately not part of the Chart document. */
export interface PlacementPreview {
  readonly timeSec: number;
  readonly lane: number;
  readonly snapped: boolean;
  /** The kind about to be placed, so the preview is coloured like the result. */
  readonly type: string;
  /** Set while dragging out a note with a duration, so the preview has its shape. */
  readonly endTimeSec?: number;
  /** Set while dragging out a slide, so the lane it is travelling to is visible. */
  readonly endLane?: number;
  /** The way a flick would point, so its preview is the arrow and not a bar. */
  readonly direction?: Direction;
}

/**
 * A move being dragged out, in seconds and whole lanes.
 *
 * Applied to the selected notes for drawing only. The chart itself is untouched until the
 * pointer comes up, so what is on screen during the drag is the same geometry the
 * committed notes will have - and nothing has entered the history yet.
 */
export interface MoveDelta {
  readonly seconds: number;
  readonly lanes: number;
}

/**
 * A held note whose start or end is being dragged.
 *
 * Both times, always, rather than only the one that is moving. The renderer then draws
 * the note from a pair of numbers without having to know which grip was taken, and the
 * two grips cannot end up drawn by two slightly different rules.
 */
export interface ResizePreview {
  readonly noteId: string;
  readonly timeSec: number;
  readonly endTimeSec: number;
}

export interface NotesScene {
  readonly view: Viewport;
  readonly layout: Layout;
  readonly chart: ChartState | null;
  readonly selectedNoteIds: readonly string[];
  /** The rubber band being dragged out, if any. Never part of any document. */
  readonly marquee: SelectionRect | null;
  readonly preview: PlacementPreview | null;
  readonly moveDelta: MoveDelta | null;
  /** A held note whose start or end is being dragged. Drawing only, like `moveDelta`. */
  readonly resizePreview: ResizePreview | null;
  /**
   * Where the magnet has taken whatever is being dragged, or null while it is free.
   *
   * One field for every gesture and every kind of candidate. A beat, an Analysis Event
   * and the edge of another note all arrive here as the same number, so the author is
   * shown the same dotted line whatever they lined up with - and a gesture added later
   * gets the guide by filling this in rather than by teaching the renderer about itself.
   *
   * It lives on the scene rather than inside one gesture's preview because more than one
   * gesture now has a magnet. The caller clears it wherever it clears the gesture, so it
   * still cannot outlive the drag that produced it.
   */
  readonly snapGuideTimeSec: number | null;
  /**
   * The decorations, and which of them are selected.
   *
   * A separate list from the notes on the canvas as well as in the document, because
   * they are drawn in their own row by their own rules and nothing about a decoration is
   * ever mixed into a note's geometry.
   */
  readonly decorations: readonly ChartDecoration[];
  readonly selectedDecorationIds: readonly string[];
  /** A decoration's window being dragged. Drawing only, like `moveDelta`. */
  readonly decorationResizePreview: {
    readonly decorationId: string;
    readonly startTimeSec: number;
    readonly endTimeSec: number;
  } | null;
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
      // Runs go down before the notes: the notes are what is judged, and a line should
      // never sit on top of the arrow whose timing it joins.
      this.drawRuns(scene, row);
      drawnNotes = this.drawNotes(scene, row);
      this.drawPreview(scene, row);
    }
    // After the notes and before everything that explains a gesture. The decorations sit
    // in their own row, so this is an ordering statement rather than an overlap: the row
    // is painted once, in one place, and nothing else on this canvas draws into it.
    this.drawDecorations(scene);
    this.drawMarquee(scene);
    // In front of the notes it is explaining, behind the playhead, which is the one thing
    // on this canvas that must never be obscured.
    this.drawSnapGuide(scene);
    this.drawPlayhead(scene);

    return { drawnNotes, millis: performance.now() - started };
  }

  /**
   * The decorations, as bars along their own row.
   *
   * A bar rather than the styled text the stage shows, because this row answers "when",
   * and a rotated, coloured, half-transparent caption would be answering a question the
   * timeline is not asking. The text is written inside the bar so the row can be read at
   * a glance, and everything about how it will actually look belongs to the stage.
   *
   * A decoration in a kind this Editor cannot draw still gets a bar, labelled with its
   * kind: it is in the document, it occupies that stretch of time, and hiding it would be
   * the surest way for an author to save over something they never knew was there.
   */
  private drawDecorations(scene: NotesScene): number {
    const row = findRow(scene.layout, "decorations");
    if (!row || scene.decorations.length === 0) return 0;

    const { ctx } = this;
    const selected = new Set(scene.selectedDecorationIds);
    let drawn = 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, row.topPx, scene.view.widthPx, row.heightPx);
    ctx.clip();

    for (const decoration of scene.decorations) {
      const shown = pendingDecoration(decoration, scene);
      const geometry = decorationRowGeometry(shown, row, scene.view);
      if (geometry.rightPx < 0 || geometry.leftPx > scene.view.widthPx) continue;
      this.drawDecorationBar(shown, geometry, selected.has(decoration.id));
      drawn += 1;
    }

    ctx.restore();
    return drawn;
  }

  private drawDecorationBar(
    decoration: ChartDecoration,
    geometry: DecorationRowGeometry,
    selected: boolean,
  ): void {
    const { ctx } = this;
    const width = geometry.rightPx - geometry.leftPx;
    const height = geometry.bottomPx - geometry.topPx;

    ctx.fillStyle = selected ? theme.decoration.selectedFill : theme.decoration.fill;
    ctx.fillRect(geometry.leftPx, geometry.topPx, width, height);
    ctx.strokeStyle = selected ? theme.decoration.selectedBorder : theme.decoration.border;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(
      Math.round(geometry.leftPx) + 0.5,
      Math.round(geometry.topPx) + 0.5,
      Math.round(width) - 1,
      Math.round(height) - 1,
    );

    if (selected && geometry.startHandle && geometry.endHandle) {
      ctx.fillStyle = theme.decoration.handle;
      for (const handle of [geometry.startHandle, geometry.endHandle]) {
        ctx.fillRect(
          handle.leftPx,
          handle.topPx,
          handle.rightPx - handle.leftPx,
          handle.bottomPx - handle.topPx,
        );
      }
    }

    // What it says, or what kind it is when this Editor cannot say what it says.
    const label = isTextDecoration(decoration)
      ? (decoration.text ?? "")
      : `<${decoration.type}>`;
    if (label === "" || width < 16) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(geometry.leftPx + 3, geometry.topPx, width - 6, height);
    ctx.clip();
    ctx.fillStyle = selected ? theme.decoration.selectedLabel : theme.decoration.label;
    ctx.font = theme.decoration.labelFont;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(label, geometry.leftPx + 5, (geometry.topPx + geometry.bottomPx) / 2);
    ctx.restore();
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

  private drawNotes(scene: NotesScene, row: NoteRow): number {
    const chart = scene.chart;
    if (!chart) return 0;

    const margin = noteMarginSec(scene.view);
    const from = scene.view.startSec - margin;
    const to = viewportEndSec(scene.view) + margin;
    // One set per frame rather than a scan of the selection per note: a rubber band
    // over a busy bar can select dozens, and this runs for every note on screen.
    const selected = new Set(scene.selectedNoteIds);

    let drawn = 0;
    for (const note of scene.chart?.notes ?? []) {
      // A drag in progress is applied here, before anything else looks at the note, so
      // culling, geometry and drawing all agree about where it currently is.
      const shown = pendingEdit(note, scene, selected.has(note.id));
      const end = shown.endTimeSec ?? shown.timeSec;
      if (end < from || shown.timeSec > to) continue;

      const geometry = noteGeometry(shown, row, scene.chart?.laneCount ?? 1, scene.view);
      if (!isNoteVisible(geometry, scene.view)) continue;

      this.drawNote(shown, geometry, selected.has(note.id));
      drawn += 1;
    }
    return drawn;
  }

  /**
   * The lines joining notes that are played as one run.
   *
   * Drawn for the chart rather than per note, because a connection belongs to neither of
   * the notes it joins. Solid and thin, which is what separates it from a slide's dotted
   * route at a glance.
   */
  private drawRuns(scene: NotesScene, row: NoteRow): void {
    const chart = scene.chart;
    if (!chart) return;
    const connectors = runConnectors(chart, row, chart.laneCount, scene.view);
    if (connectors.length === 0) return;

    const { ctx } = this;
    const selected = new Set(scene.selectedNoteIds);
    ctx.lineCap = "round";
    for (const connector of connectors) {
      const lit = selected.has(connector.fromNoteId) && selected.has(connector.toNoteId);
      ctx.strokeStyle = lit ? theme.note.runConnectorSelected : theme.note.runConnector;
      ctx.lineWidth = lit ? theme.note.runConnectorPx + 1 : theme.note.runConnectorPx;
      ctx.beginPath();
      ctx.moveTo(connector.fromXPx, connector.fromYPx);
      ctx.lineTo(connector.toXPx, connector.toYPx);
      ctx.stroke();
    }
    ctx.lineCap = "butt";
  }

  /**
   * Draw one note from the primitives its shape calls for.
   *
   * The shape comes from `geometry`, which decides it from the fields the note carries -
   * never from its type name, because `chartNote.type` is an open vocabulary and a chart
   * written elsewhere may use a word this Editor has never seen.
   *
   * Order matters: paths and bodies go down first so the judgement markers sit on top of
   * them. The markers are the thing being timed, and nothing should obscure them.
   */
  private drawNote(note: ChartNote, geometry: NoteGeometry, selected: boolean): void {
    // A halo behind each part: at a busy zoom a border alone disappears among the
    // neighbours, and a three-pixel bar with a border is not something you can pick out
    // at a glance. Around the parts rather than the bounding box, so a box around a steep
    // slide does not claim a large empty rectangle as the note.
    if (selected) this.drawSelectionHalo(geometry);

    // Every segment of the path, then the body, then every judgement point on top: a
    // four-point slide is three dotted segments and four bars, not one long shape.
    for (const connector of geometry.connectors) this.drawConnector(connector, selected);
    if (geometry.body) this.drawBody(note, geometry.body, selected);
    if (geometry.resizeHandle) this.drawResizeHandle(geometry.resizeHandle, selected);
    if (geometry.startHandle) this.drawResizeHandle(geometry.startHandle, selected);

    for (const marker of geometry.markers) this.drawMarker(note, marker, selected);
    if (geometry.arrow) this.drawFlickArrow(note, geometry.arrow, selected);
  }

  private drawSelectionHalo(geometry: NoteGeometry): void {
    const { ctx } = this;
    const pad = theme.note.selectedHaloPx;
    ctx.fillStyle = theme.note.selectedHalo;

    const halo = (box: { leftPx: number; rightPx: number; topPx: number; bottomPx: number }) => {
      const left = Math.min(box.leftPx, box.rightPx);
      const right = Math.max(box.leftPx, box.rightPx);
      ctx.fillRect(left - pad, box.topPx - pad, right - left + pad * 2, box.bottomPx - box.topPx + pad * 2);
    };

    for (const marker of geometry.markers) halo(marker);
    if (geometry.arrow) halo(geometry.arrow);
    if (geometry.body) halo(geometry.body);
    if (geometry.connectors.length > 0) {
      // Along each line, not around the box the chain happens to occupy.
      ctx.strokeStyle = theme.note.selectedHalo;
      ctx.lineWidth = theme.note.connectorRibbonPx + pad * 2;
      ctx.lineCap = "round";
      for (const c of geometry.connectors) {
        ctx.beginPath();
        ctx.moveTo(c.fromXPx, c.fromYPx);
        ctx.lineTo(c.toXPx, c.toYPx);
        ctx.stroke();
      }
      ctx.lineCap = "butt";
    }
  }

  /**
   * A judgement point: a thin bar standing across the lane at one moment.
   *
   * The same drawing for a Single, a Purple, a Slide point and both ends of a Long,
   * because they are the same thing - a time the player has to arrive at. Only the colour
   * says which kind it belongs to.
   *
   * Selection thickens the bar rather than boxing it. A three-pixel line has to stay
   * findable when it is selected, and turning it into a rectangle would undo the whole
   * reason it is a line.
   */
  private drawMarker(note: ChartNote, marker: NoteMarker, selected: boolean): void {
    const { ctx } = this;
    const grow = selected ? theme.note.selectedMarkerGrowPx : 0;
    const left = marker.leftPx - grow;
    const width = marker.rightPx - marker.leftPx + grow * 2;

    ctx.fillStyle = selected ? theme.note.selectedFill : fillForType(note.type);
    ctx.fillRect(left, marker.topPx, width, marker.bottomPx - marker.topPx);
  }

  /**
   * A flick: an arrow, and no bar at all.
   *
   * The arrow is centred on `timeToX(timeSec)`, so losing the bar does not lose the
   * moment - the middle of the arrow is the instant, and nothing is offset to one side.
   */
  private drawFlickArrow(note: ChartNote, arrow: NoteArrow, selected: boolean): void {
    drawDirection(
      this.ctx,
      arrow,
      selected ? theme.note.selectedBorder : fillForType(note.type),
      selected ? 3 : 2,
    );
  }

  /**
   * Time held down, between a Long's two markers.
   *
   * Deliberately shorter than the markers and drawn under them: the body is a duration,
   * and the two bars at its ends are the moments that are actually judged.
   */
  private drawBody(note: ChartNote, body: NoteBody, selected: boolean): void {
    const { ctx } = this;
    const left = Math.min(body.leftPx, body.rightPx);
    const right = Math.max(body.leftPx, body.rightPx);
    const height = body.bottomPx - body.topPx;

    ctx.beginPath();
    ctx.roundRect(left, body.topPx, Math.max(1, right - left), height, theme.note.radiusPx);
    ctx.fillStyle = selected ? theme.note.selectedFill : theme.note.boundedBody;
    ctx.fill();
    ctx.strokeStyle = selected ? theme.note.selectedBorder : borderForType(note.type);
    ctx.lineWidth = selected ? theme.note.borderWidth + 1 : theme.note.borderWidth;
    ctx.stroke();
  }

  /**
   * The grip that changes how long a Long is.
   *
   * Quiet until the note is selected: a chart full of grips would be a chart full of
   * clutter, and the cursor already says the end is draggable when the pointer is on it.
   */
  private drawResizeHandle(handle: NoteBox, selected: boolean): void {
    const { ctx } = this;
    ctx.fillStyle = selected ? theme.note.resizeHandleOn : theme.note.resizeHandle;
    ctx.fillRect(
      handle.leftPx,
      handle.topPx,
      handle.rightPx - handle.leftPx,
      handle.bottomPx - handle.topPx,
    );
  }

  /**
   * The path a slide travels between its judgement points.
   *
   * **Dotted**, and that is the point: a Long is a solid body because something is held
   * down for its whole length, and a slide connector is a route between two instants with
   * nothing judged along it. Making the two look alike is exactly the confusion this
   * drawing exists to prevent.
   */
  private drawConnector(connector: NoteConnector, selected: boolean): void {
    const { ctx } = this;

    ctx.lineCap = "round";
    ctx.setLineDash(theme.note.connectorDash);
    ctx.strokeStyle = selected ? theme.note.selectedBorder : theme.note.connector;
    ctx.lineWidth = selected ? theme.note.connectorLinePx + 1 : theme.note.connectorLinePx;
    ctx.beginPath();
    ctx.moveTo(connector.fromXPx, connector.fromYPx);
    ctx.lineTo(connector.toXPx, connector.toYPx);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = "butt";
  }

  private drawPreview(scene: NotesScene, row: NoteRow): void {
    const preview = scene.preview;
    if (!preview) return;

    const { ctx } = this;
    const laneCount = scene.chart?.laneCount ?? 1;
    const geometry = noteGeometry(
      {
        id: "",
        type: preview.type,
        timeSec: preview.timeSec,
        lane: preview.lane,
        ...(preview.endTimeSec !== undefined ? { endTimeSec: preview.endTimeSec } : {}),
        ...(preview.endLane !== undefined ? { endLane: preview.endLane } : {}),
        ...(preview.direction !== undefined ? { direction: preview.direction } : {}),
      },
      row,
      laneCount,
      scene.view,
    );

    const anchorX = geometry.marker?.xPx ?? geometry.arrow?.xPx ?? 0;
    if (preview.snapped) {
      ctx.strokeStyle = theme.preview.guide;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(anchorX) + 0.5, scene.layout.gridTopPx);
      ctx.lineTo(Math.round(anchorX) + 0.5, scene.layout.gridBottomPx);
      ctx.stroke();
    }

    // The same primitives the committed note will have, so what the author sees before
    // letting go is what they get - a preview that fell back to a rectangle would be
    // promising a shape the Editor no longer draws.
    if (geometry.connectors.length > 0) {
      ctx.setLineDash(theme.note.connectorDash);
      ctx.strokeStyle = theme.preview.border;
      ctx.lineWidth = 2;
      for (const c of geometry.connectors) {
        ctx.beginPath();
        ctx.moveTo(c.fromXPx, c.fromYPx);
        ctx.lineTo(c.toXPx, c.toYPx);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    if (geometry.body) {
      const left = Math.min(geometry.body.leftPx, geometry.body.rightPx);
      const width = Math.max(1, Math.abs(geometry.body.rightPx - geometry.body.leftPx));
      ctx.fillStyle = theme.preview.fill;
      ctx.fillRect(left, geometry.body.topPx, width, geometry.body.bottomPx - geometry.body.topPx);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = theme.preview.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.round(left) + 0.5,
        Math.round(geometry.body.topPx) + 0.5,
        Math.max(1, Math.round(width) - 1),
        Math.max(1, Math.round(geometry.body.bottomPx - geometry.body.topPx) - 1),
      );
      ctx.setLineDash([]);
    }

    ctx.fillStyle = theme.preview.border;
    for (const marker of geometry.markers) {
      ctx.fillRect(
        marker.leftPx,
        marker.topPx,
        marker.rightPx - marker.leftPx,
        marker.bottomPx - marker.topPx,
      );
    }

    if (geometry.arrow) {
      drawDirection(ctx, geometry.arrow, theme.preview.border, 2);
    }
  }

  /**
   * The rubber band, drawn on the foreground canvas with everything else it belongs
   * with. A DOM overlay would need its own coordinate system kept in step with the
   * viewport; here it is already in the same pixels as the notes it is selecting.
   */
  private drawMarquee(scene: NotesScene): void {
    const rect = scene.marquee;
    if (!rect) return;
    const { ctx } = this;
    const width = rect.rightPx - rect.leftPx;
    const height = rect.bottomPx - rect.topPx;

    ctx.fillStyle = theme.marquee.fill;
    ctx.fillRect(rect.leftPx, rect.topPx, width, height);
    ctx.strokeStyle = theme.marquee.border;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(
      Math.round(rect.leftPx) + 0.5,
      Math.round(rect.topPx) + 0.5,
      Math.max(1, Math.round(width)),
      Math.max(1, Math.round(height)),
    );
    ctx.setLineDash([]);
  }

  /**
   * The dotted line showing what a dragged note has been lined up with.
   *
   * Drawn from the snapped time itself, put through the same `timeToX` as every note on
   * this canvas. That is the whole reason it cannot drift: the guide is not a second
   * calculation of where the note went, it is the number the note went to. Zooming and
   * scrolling move both through one conversion, so a line that is on the note at one
   * zoom is on it at every zoom.
   *
   * It spans the lanes rather than the ruler, like the placement guide, so the author can
   * follow the alignment down through the analysis overlay to the note itself.
   */
  private drawSnapGuide(scene: NotesScene): void {
    const timeSec = scene.snapGuideTimeSec;
    if (timeSec === null) return;

    const x = timeToX(timeSec, scene.view);
    if (x < 0 || x > scene.view.widthPx) return;

    const { ctx } = this;
    const column = Math.round(x) + 0.5;
    const top = scene.layout.gridTopPx;
    const bottom = scene.layout.gridBottomPx;

    // The wash first, solid and wide, then the dashes over it.
    ctx.strokeStyle = theme.snapGuide.glow;
    ctx.lineWidth = theme.snapGuide.glowWidth;
    ctx.beginPath();
    ctx.moveTo(column, top);
    ctx.lineTo(column, bottom);
    ctx.stroke();

    ctx.strokeStyle = theme.snapGuide.stroke;
    ctx.lineWidth = theme.snapGuide.width;
    ctx.setLineDash(theme.snapGuide.dash);
    ctx.beginPath();
    ctx.moveTo(column, top);
    ctx.lineTo(column, bottom);
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

/** A direction marker large enough to read, drawn beside the note rather than on it. */
function drawDirection(
  ctx: CanvasRenderingContext2D,
  arrow: NoteArrow,
  colour: string,
  lineWidth: number,
): void {
  const vector = DIRECTION_VECTORS[flickScreenDirection(arrow.direction)];
  if (!vector) return;

  const half = arrow.sizePx / 2;
  // Centred on the moment: the tip and the tail are equidistant from `xPx`, so the middle
  // of the arrow is the note's own time.
  const tipX = arrow.xPx + vector.x * half;
  const tipY = arrow.centreYPx + vector.y * half;
  const tailX = arrow.xPx - vector.x * half;
  const tailY = arrow.centreYPx - vector.y * half;

  // The two barbs, swept back from the tip.
  const barb = arrow.sizePx * 0.45;
  const backX = -vector.x * barb;
  const backY = -vector.y * barb;
  const perpX = -vector.y * barb * 0.8;
  const perpY = vector.x * barb * 0.8;

  ctx.strokeStyle = colour;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(tipX + backX + perpX, tipY + backY + perpY);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(tipX + backX - perpX, tipY + backY - perpY);
  ctx.stroke();

  ctx.lineCap = "butt";
}

/**
 * Which way a flick's arrow points on this timeline.
 *
 * The persisted direction is unchanged - `left` and `right` are what the Chart document
 * says and what a round trip preserves. They are *drawn* as up and down because on this
 * screen the horizontal axis is time: a left-pointing arrow beside a note reads as
 * "earlier", which is not what a flick direction means. Mapping the pair onto the axis
 * that is not time keeps the indicator from making a claim about timing.
 *
 * Anything else keeps its own compass direction, so a chart from elsewhere carrying `up`
 * or `downLeft` is drawn as what it says.
 */
export function flickScreenDirection(direction: string): string {
  if (direction === "left") return "up";
  if (direction === "right") return "down";
  return direction;
}

/**
 * Unit vectors for the contract's eight directions.
 *
 * All eight are drawn even though the Editor only authors left and right: a chart may
 * arrive from elsewhere carrying any of them, and drawing what is there beats drawing
 * nothing. Screen coordinates, so "up" is negative y.
 */
export const DIRECTION_VECTORS: Readonly<Record<string, { readonly x: number; readonly y: number }>> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  upLeft: { x: -0.7071, y: -0.7071 },
  upRight: { x: 0.7071, y: -0.7071 },
  downLeft: { x: -0.7071, y: 0.7071 },
  downRight: { x: 0.7071, y: 0.7071 },
};

/**
 * The note as it currently looks, with any drag in progress applied.
 *
 * Returns the note itself when nothing is being dragged, so the common case allocates
 * nothing. A move carries both ends together - dragging a Long moves it rather than
 * stretching it - and a resize moves one end while the other stays exactly where it was,
 * which is the difference between the body and a grip.
 */
function pendingEdit(note: ChartNote, scene: NotesScene, selected: boolean): ChartNote {
  if (scene.resizePreview && scene.resizePreview.noteId === note.id) {
    return {
      ...note,
      timeSec: scene.resizePreview.timeSec,
      endTimeSec: scene.resizePreview.endTimeSec,
    };
  }
  if (!selected || !scene.moveDelta) return note;
  const { seconds, lanes } = scene.moveDelta;
  if (seconds === 0 && lanes === 0) return note;
  return {
    ...note,
    timeSec: note.timeSec + seconds,
    lane: note.lane + lanes,
    ...(note.endTimeSec !== undefined ? { endTimeSec: note.endTimeSec + seconds } : {}),
    ...(note.endLane !== undefined ? { endLane: note.endLane + lanes } : {}),
    ...(note.waypoints !== undefined
      ? {
          waypoints: note.waypoints.map((point) => ({
            timeSec: point.timeSec + seconds,
            lane: point.lane + lanes,
          })),
        }
      : {}),
  };
}

/**
 * The decoration as it currently looks, with any window drag applied.
 *
 * The same arrangement as `pendingEdit` for a note, and separate from it for the same
 * reason the objects are separate: a decoration has no lane and no waypoints, and a
 * function that handled both would have to keep asking which it was looking at.
 */
function pendingDecoration(
  decoration: ChartDecoration,
  scene: NotesScene,
): ChartDecoration {
  const preview = scene.decorationResizePreview;
  if (preview && preview.decorationId === decoration.id) {
    return {
      ...decoration,
      startTimeSec: preview.startTimeSec,
      endTimeSec: preview.endTimeSec,
    };
  }
  if (!scene.moveDelta) return decoration;
  if (!scene.selectedDecorationIds.includes(decoration.id)) return decoration;
  const { seconds } = scene.moveDelta;
  if (seconds === 0) return decoration;
  return {
    ...decoration,
    startTimeSec: decoration.startTimeSec + seconds,
    ...(decoration.endTimeSec !== undefined
      ? { endTimeSec: decoration.endTimeSec + seconds }
      : {}),
  };
}

/**
 * The fill for an authored kind.
 *
 * A lookup with a fallback rather than a switch, because `chartNote.type` is an open
 * vocabulary: a kind this Editor has never heard of still has to be drawn, and drawing
 * it in the default colour is better than not drawing it.
 */
function fillForType(type: string): string {
  return theme.note.byType[type] ?? theme.note.fill;
}

function borderForType(type: string): string {
  return theme.note.borderByType[type] ?? theme.note.border;
}
