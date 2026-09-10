/**
 * Choosing what to listen to while charting.
 *
 * One row per source, the original first and then whatever the Analyzer separated. Each
 * row has the three controls a mixing desk has - a fader, Mute, Solo - because that is
 * what they are, and inventing new names for them would only make an author guess.
 *
 * The panel changes no document, holds no time and owns no playback. It reports a click
 * upwards and draws the mixer state it is handed, so the transport it is sitting next to
 * remains the only thing that knows where the music is.
 */

import {
  ORIGINAL_TRACK_ID, describeListening, isRouted,
  type MixerState, type StemAvailability,
} from "../core/stemMixer";
import type { StemLoadStatus } from "../audio/stemEngine";

export interface StemMixerProps {
  /** The stems this project has, in the Analyzer's order. Empty hides the panel. */
  readonly stems: readonly StemAvailability[];
  readonly mixer: MixerState;
  readonly statuses: Readonly<Record<string, StemLoadStatus>>;
  /** The transport's rate, only so the panel can own up to the varispeed. */
  readonly playbackRate: number;
  readonly onVolume: (id: string, volume: number) => void;
  readonly onToggleMuted: (id: string) => void;
  readonly onToggleSolo: (id: string) => void;
  readonly onListenToOriginal: () => void;
}

/**
 * What a row should say about itself when it is not simply playing.
 *
 * Only ever shown for a row the author has actually asked for: a stem sitting quietly
 * unloaded is not news, but one that was clicked and is taking a moment - or one whose
 * file has gone - very much is.
 */
function noteFor(
  hasUrl: boolean,
  status: StemLoadStatus | undefined,
  routed: boolean,
): string | null {
  // Availability is known the moment the project opens, and is said then. The engine
  // does not exist until something is first listened to, so a row that waited for a
  // status would sit struck through with no explanation.
  if (!hasUrl || status === "unavailable") return "file missing";
  if (status === "failed") return "could not load";
  if (routed && (status === "loading" || status === "idle")) return "loading…";
  return null;
}

function Row(
  {
    id, label, mixer, note, disabled, onVolume, onToggleMuted, onToggleSolo,
  }: {
    id: string;
    label: string;
    mixer: MixerState;
    note: string | null;
    disabled: boolean;
    onVolume: (id: string, volume: number) => void;
    onToggleMuted: (id: string) => void;
    onToggleSolo: (id: string) => void;
  },
): React.JSX.Element {
  const track = mixer.tracks[id];
  const soloed = track?.solo === true;
  const muted = track?.muted === true;
  // What is audible, not merely what is selected: the original is routed while a stem
  // plays, and showing it lit would be the panel contradicting the loudspeakers.
  const audible =
    id === ORIGINAL_TRACK_ID
      ? isRouted(mixer, id) && !Object.keys(mixer.tracks).some(
          (other) => other !== ORIGINAL_TRACK_ID && isRouted(mixer, other),
        )
      : isRouted(mixer, id);

  return (
    <li className={`stem-row${audible ? " audible" : ""}${disabled ? " disabled" : ""}`}>
      <div className="stem-head">
        <span className="stem-name" title={id}>{label}</span>
        {note ? <span className="stem-note">{note}</span> : null}
        <button
          type="button"
          className={`stem-toggle${muted ? " on" : ""}`}
          onClick={() => onToggleMuted(id)}
          disabled={disabled}
          title={`Mute ${label}`}
          aria-pressed={muted}
        >
          M
        </button>
        <button
          type="button"
          className={`stem-toggle solo${soloed ? " on" : ""}`}
          onClick={() => onToggleSolo(id)}
          disabled={disabled}
          title={`Listen to ${label}`}
          aria-pressed={soloed}
        >
          S
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={track?.volume ?? 1}
        disabled={disabled}
        aria-label={`${label} volume`}
        onChange={(event) => onVolume(id, Number(event.target.value))}
      />
    </li>
  );
}

export function StemMixer(
  {
    stems, mixer, statuses, playbackRate,
    onVolume, onToggleMuted, onToggleSolo, onListenToOriginal,
  }: StemMixerProps,
): React.JSX.Element | null {
  // A project analysed without separation - which is every project written before stems
  // existed - simply has no mixer, rather than an empty one to explain.
  if (stems.length === 0) return null;

  const labels: Record<string, string> = { [ORIGINAL_TRACK_ID]: "Original" };
  for (const stem of stems) labels[stem.id] = stem.label;

  const listening = describeListening(mixer, labels);
  const onlyOriginal = listening === "Original";

  return (
    <div className="stem-mixer">
      <h2>Listening</h2>
      <p className="stem-listening" title="What you are hearing right now">
        {listening}
      </p>

      <ul>
        <Row
          id={ORIGINAL_TRACK_ID}
          label="Original"
          mixer={mixer}
          note={null}
          disabled={false}
          onVolume={onVolume}
          onToggleMuted={onToggleMuted}
          onToggleSolo={onToggleSolo}
        />
        {stems.map((stem) => (
          <Row
            key={stem.id}
            id={stem.id}
            label={stem.label}
            mixer={mixer}
            note={noteFor(stem.url !== null, statuses[stem.id], isRouted(mixer, stem.id))}
            disabled={stem.url === null || statuses[stem.id] === "failed"}
            onVolume={onVolume}
            onToggleMuted={onToggleMuted}
            onToggleSolo={onToggleSolo}
          />
        ))}
      </ul>

      <button
        type="button"
        className="stem-reset"
        onClick={onListenToOriginal}
        disabled={onlyOriginal}
      >
        Back to the song
      </button>

      {/* Owning up to the one thing the engine cannot do, where it is noticed rather
          than in a document nobody reads. Only while it is actually true. */}
      {playbackRate !== 1 && !onlyOriginal ? (
        <p className="stem-warning">
          Stems follow the speed by resampling, so they play {playbackRate}× pitch.
        </p>
      ) : null}
    </div>
  );
}
