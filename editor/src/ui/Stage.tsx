/**
 * The playfield panel: where a decoration's *position* is seen and edited.
 *
 * The Editor's timeline reads time; this reads space. Splitting them is the whole answer
 * to "I wanted to move the caption sideways and its timing changed": on the timeline a
 * horizontal drag is time and there is no way to express a position, and here there is no
 * time axis at all, so neither gesture can reach the other's coordinates.
 *
 * It shows one instant - wherever the playhead is - so what an author sees during
 * playback is what a player will see, animations included. Decorations outside their
 * window are drawn faintly rather than hidden, because an editor in which an object
 * disappears the moment you are not exactly on it is an editor in which that object
 * cannot be edited.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ChartDecoration } from "../core/decoration";
import {
  hitTestStage, stagePosition, type StageRect,
} from "../core/decorationGeometry";
import { StageRenderer, type StageBox } from "../render/stageRenderer";

export interface StageProps {
  readonly decorations: readonly ChartDecoration[];
  readonly selectedIds: readonly string[];
  readonly timeSec: number;
  /** Select one, add to the selection with shift, or clear it. */
  readonly onSelect: (id: string | null, add: boolean) => void;
  /** Commit a drag across the playfield, once, when the pointer comes up. */
  readonly onMoveBy: (deltaX: number, deltaY: number) => void;
  /** Make one here, at the playhead. Only offered while the text tool is held. */
  readonly onPlaceAt: (x: number, y: number) => void;
  readonly placing: boolean;
  /** True while the recording is playing, so the preview knows to stay out of the way. */
  readonly playing: boolean;
}

/** How far the pointer must travel before a press becomes a drag rather than a click. */
const MOVE_THRESHOLD_PX = 3;

export function Stage(props: StageProps): React.JSX.Element {
  const {
    decorations, selectedIds, timeSec, onSelect, onMoveBy, onPlaceAt, placing, playing,
  } = props;

  /**
   * Whether the machine has asked for less movement.
   *
   * Read from the browser rather than stored anywhere: it is a fact about the person at
   * the screen, not about the chart, and turning it on must never edit a document. The
   * listener keeps it current if they change the setting while the Editor is open.
   */
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    setReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  /**
   * Run the effects while the recording is paused.
   *
   * Effects are a pure function of chart time, so a paused Editor shows one frozen frame
   * - which is right, and is also no way to judge whether a shimmer is too fast. This
   * feeds the renderer a time that walks forward from the playhead while leaving the
   * playhead exactly where it is: nothing is played, nothing is seeked, and the chart is
   * not touched. It is a lens over the same clock rather than a second clock, and it
   * turns itself off the moment real playback starts, which has the real one.
   */
  const [previewing, setPreviewing] = useState(false);
  const [previewSec, setPreviewSec] = useState(0);
  useEffect(() => {
    if (!previewing || playing) return;
    let frame = 0;
    const startedAt = performance.now();
    const from = timeSec;
    const tick = () => {
      setPreviewSec(from + (performance.now() - startedAt) / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // `timeSec` is read once, when the preview starts: restarting on every playhead
    // change would make the preview stutter as the effect re-ran.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewing, playing]);

  const shownSec = previewing && !playing ? previewSec : timeSec;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const [size, setSize] = useState({ widthPx: 240, heightPx: 240 });

  /**
   * What the last frame drew, and where.
   *
   * Hit testing uses the boxes the canvas actually measured, so what an author clicks is
   * exactly what they can see - including a Japanese caption, whose width no estimate
   * gets right.
   */
  const framed = useRef<{ stage: StageRect | null; boxes: readonly StageBox[] }>({
    stage: null,
    boxes: [],
  });

  /** A drag in progress. Nothing reaches the chart until the pointer comes up. */
  const dragRef = useRef<{
    pointerId: number;
    fromX: number;
    fromY: number;
    moved: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<{ dx: number; dy: number } | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      setSize({
        widthPx: Math.max(1, Math.floor(box.width)),
        heightPx: Math.max(1, Math.floor(box.height)),
      });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!rendererRef.current) rendererRef.current = new StageRenderer(canvas);
    const renderer = rendererRef.current;
    renderer.resize(size.widthPx, size.heightPx, window.devicePixelRatio || 1);

    // The drag is applied for drawing only, so the caption follows the hand without the
    // chart being touched until the gesture ends.
    const shown =
      preview === null
        ? decorations
        : decorations.map((decoration) =>
            selectedIds.includes(decoration.id)
              ? {
                  ...decoration,
                  position: {
                    x: Math.min(1, Math.max(0, decoration.position.x + preview.dx)),
                    y: Math.min(1, Math.max(0, decoration.position.y + preview.dy)),
                  },
                }
              : decoration,
          );

    const result = renderer.render({
      widthPx: size.widthPx,
      heightPx: size.heightPx,
      decorations: shown,
      selectedIds,
      timeSec: shownSec,
      showOutOfWindow: true,
      reducedMotion,
    });
    framed.current = { stage: result.stage, boxes: result.boxes };
  }, [decorations, selectedIds, shownSec, size, preview, reducedMotion]);

  const localPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const { x, y } = localPoint(event);
      const stage = framed.current.stage;
      if (!stage) return;

      if (placing) {
        const at = stagePosition(x, y, stage);
        onPlaceAt(at.x, at.y);
        return;
      }

      const hit = hitTestStage(x, y, framed.current.boxes);
      if (!hit) {
        if (!event.shiftKey) onSelect(null, false);
        return;
      }
      if (event.shiftKey) {
        onSelect(hit.id, true);
        return;
      }
      // Pressing something already selected keeps the selection, so several captions can
      // be nudged together; pressing anything else selects it first.
      if (!selectedIds.includes(hit.id)) onSelect(hit.id, false);
      dragRef.current = { pointerId: event.pointerId, fromX: x, fromY: y, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [onSelect, onPlaceAt, placing, selectedIds],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      const stage = framed.current.stage;
      if (!drag || !stage) return;
      const { x, y } = localPoint(event);
      if (!drag.moved && Math.hypot(x - drag.fromX, y - drag.fromY) < MOVE_THRESHOLD_PX) {
        return;
      }
      dragRef.current = { ...drag, moved: true };
      setPreview({
        dx: stage.widthPx === 0 ? 0 : (x - drag.fromX) / stage.widthPx,
        dy: stage.heightPx === 0 ? 0 : (y - drag.fromY) / stage.heightPx,
      });
    },
    [],
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    const pending = preview;
    setPreview(null);
    // One command for the whole gesture, so a drag is one step in the history rather
    // than one per pointer move.
    if (drag?.moved && pending && (pending.dx !== 0 || pending.dy !== 0)) {
      onMoveBy(pending.dx, pending.dy);
    }
  }, [onMoveBy, preview]);

  return (
    <div className="stage-panel" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="stage-canvas"
        style={placing ? { cursor: "crosshair" } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      {!playing && (
        <button
          type="button"
          className={previewing ? "stage-preview on" : "stage-preview"}
          onClick={() => {
            setPreviewSec(timeSec);
            setPreviewing((on) => !on);
          }}
          title={
            reducedMotion
              ? "Effects are held still because this machine asks for reduced motion"
              : "Run the effects without moving the playhead"
          }
        >
          {previewing ? "◼ Preview" : "▶ Preview"}
        </button>
      )}
    </div>
  );
}
