/** Transport, zoom and the Open Project action. */

import { formatTime } from "../render/timelineRenderer";
import type { Viewport } from "../core/viewport";

export interface ToolbarProps {
  readonly onOpen: () => void;
  readonly busy: boolean;
  readonly canPlay: boolean;
  readonly playing: boolean;
  readonly onPlayPause: () => void;
  readonly playheadSec: number;
  readonly durationSec: number;
  readonly view: Viewport;
  readonly onZoom: (pixelsPerSecond: number) => void;
  readonly onFit: () => void;
  readonly status: string;
}

export function Toolbar(props: ToolbarProps): React.JSX.Element {
  const { onOpen, busy, canPlay, playing, onPlayPause, playheadSec, durationSec, view, onZoom, onFit, status } = props;

  return (
    <header className="toolbar">
      <button type="button" onClick={onOpen} disabled={busy}>
        {busy ? "Opening..." : "Open Project"}
      </button>

      <button type="button" onClick={onPlayPause} disabled={!canPlay}>
        {playing ? "Pause" : "Play"}
      </button>

      <span className="time" title="playhead / duration">
        {formatTime(playheadSec)} / {formatTime(durationSec)}
      </span>

      <span className="spacer" />

      <label className="zoom">
        Zoom
        <input
          type="range"
          min={Math.log(5)}
          max={Math.log(2000)}
          step={0.01}
          value={Math.log(view.pixelsPerSecond)}
          onChange={(event) => onZoom(Math.exp(Number(event.target.value)))}
        />
        <span className="zoom-value">{view.pixelsPerSecond.toFixed(0)} px/s</span>
      </label>

      <button type="button" onClick={onFit}>Fit</button>

      <span className="status">{status}</span>
    </header>
  );
}
