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

  /** Playback volume, 0-1. Session state: it changes no document and is not undoable. */
  readonly volume: number;
  readonly onVolume: (volume: number) => void;
  readonly muted: boolean;
  readonly onToggleMute: () => void;

  /** The note click. Its level is independent of the music, on purpose. */
  readonly hitSoundOn: boolean;
  readonly onToggleHitSound: () => void;

  readonly playbackRate: number;
  readonly onPlaybackRate: (rate: number) => void;

  readonly onLocatePlayhead: () => void;
  readonly followPlayhead: boolean;
  readonly onToggleFollow: () => void;
  /** Whether an arrow-key seek plays a moment of the song. Session only. */
  readonly auditionOn: boolean;
  readonly onToggleAudition: () => void;
}

/** Rates a transcriber actually wants: slow enough to hear placement, plus a nudge up. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25] as const;

export function Toolbar(props: ToolbarProps): React.JSX.Element {
  const {
    onOpen, busy, canPlay, playing, onPlayPause, playheadSec, durationSec,
    view, onZoom, onFit, status, volume, onVolume, muted, onToggleMute,
    hitSoundOn, onToggleHitSound, playbackRate, onPlaybackRate,
    onLocatePlayhead, followPlayhead, onToggleFollow, auditionOn, onToggleAudition,
  } = props;

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

      {/* Mute is the element's own `muted`, not volume zero, so unmuting comes back to
          the level that was set without anyone remembering it separately. */}
      <button
        type="button"
        className="icon"
        onClick={onToggleMute}
        disabled={!canPlay}
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute" : "Mute"}
        aria-pressed={muted}
      >
        {muted ? "\u{1F507}" : "\u{1F509}"}
      </button>

      <label className="volume" title="Playback volume">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(volume * 100)}
          disabled={!canPlay}
          onChange={(event) => onVolume(Number(event.target.value) / 100)}
          aria-label="Volume"
        />
        <span className="volume-value">{muted ? "muted" : `${Math.round(volume * 100)}%`}</span>
      </label>

      {/* The note click has its own switch because charting is done with the music
          turned down and the clicks kept audible. */}
      <button
        type="button"
        className={hitSoundOn ? "icon on" : "icon"}
        onClick={onToggleHitSound}
        title={hitSoundOn ? "Note click: on" : "Note click: off"}
        aria-label="Note click"
        aria-pressed={hitSoundOn}
      >
        {"\u266A"}
      </button>

      <label className="field" title="Playback speed">
        <select
          value={playbackRate}
          disabled={!canPlay}
          onChange={(event) => onPlaybackRate(Number(event.target.value))}
          aria-label="Playback speed"
        >
          {PLAYBACK_RATES.map((rate) => (
            <option key={rate} value={rate}>{`${rate}x`}</option>
          ))}
        </select>
      </label>

      <span className="spacer" />

      <button
        type="button"
        className="icon"
        onClick={onLocatePlayhead}
        title="Scroll the timeline to the playhead"
        aria-label="Locate playhead"
      >
        {"\u2316"}
      </button>

      <button
        type="button"
        className={followPlayhead ? "icon on" : "icon"}
        onClick={onToggleFollow}
        title={
          followPlayhead
            ? "Following the playhead; scrolling by hand turns this off"
            : "Follow the playhead during playback"
        }
        aria-label="Follow playhead"
        aria-pressed={followPlayhead}
      >
        {"\u21E5"}
      </button>

      <button
        type="button"
        className={auditionOn ? "icon on" : "icon"}
        onClick={onToggleAudition}
        title={
          auditionOn
            ? "Arrow keys play a moment of the song where they land"
            : "Arrow keys move silently"
        }
        aria-label="Navigation audition"
        aria-pressed={auditionOn}
      >
        {"♫"}
      </button>

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
