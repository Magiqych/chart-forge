/**
 * Which of the separated sources the author is listening to, and how loudly.
 *
 * The Analyzer already writes the stems it separated - `analysis.stems[]` names them and
 * points at the audio - so this is not about producing anything. It is about *listening*:
 * an author placing notes on a bassline wants to hear the bass, and an author checking a
 * vocal entry wants the vocal alone. That is a property of the session, not of the chart,
 * and nothing here reaches any document.
 *
 * Three things are kept apart on purpose, and the separation is the whole design:
 *
 *   transport state    where playback is, whether it is running, how fast - and that
 *                      lives where it always did, on the audio element;
 *   stem availability  which stems this project actually has on disk;
 *   mixer state        what this module holds: a fader, a mute and a solo per track.
 *
 * **The playhead is deliberately not here.** A mixer that also knew the time would be a
 * second clock, and two clocks over one recording drift - which for stems of the same
 * song means audible comb filtering rather than a small error. There is one clock, and
 * the mixer only ever answers "how loud is this track right now".
 *
 * Everything is a pure function of the state, so the rules that matter - what Solo does,
 * what Mute does, when the original steps aside - are arithmetic that can be tested
 * without an audio device.
 */

/**
 * The original recording, as a track in the mixer.
 *
 * It is listed beside the stems rather than treated as a mode, because an author thinks
 * of it as one more thing they might be listening to - and because that is what makes
 * "listen to the song again" the same gesture as "listen to the bass". Its id can never
 * collide with a stem's: the Analyzer names those `stem-drums`, `stem-vocals` and so on.
 */
export const ORIGINAL_TRACK_ID = "original";

export interface StemTrackState {
  readonly id: string;
  /** 0 to 1. A fader, not an on/off - `muted` is the on/off. */
  readonly volume: number;
  readonly muted: boolean;
  /** "This is one of the things I am listening to." */
  readonly solo: boolean;
}

/**
 * The balance between the sources, and nothing else.
 *
 * Deliberately holds no master volume: the transport already has one, on the toolbar,
 * and a second would be a second answer to "how loud is this". What comes out of this
 * module is a *relative* gain, which the caller multiplies by the master it already has.
 */
export interface MixerState {
  /** Every track, by id, in no particular order. Order is a UI question. */
  readonly tracks: Readonly<Record<string, StemTrackState>>;
}

/** A track the Editor could offer, whether or not its audio turned out to be loadable. */
export interface StemAvailability {
  readonly id: string;
  /** What to call it. From the stem's `kind`, capitalised, or the id as a fallback. */
  readonly label: string;
  /** Absent when the file could not be resolved; the row is shown but disabled. */
  readonly url: string | null;
}

export const DEFAULT_TRACK_VOLUME = 1;

function newTrack(id: string, solo: boolean): StemTrackState {
  return { id, volume: DEFAULT_TRACK_VOLUME, muted: false, solo };
}

/**
 * A mixer for a set of stems, with the original alongside them.
 *
 * **The original starts soloed**, which is the whole of why a project opens sounding
 * exactly as it did before any of this existed. Solo here reads as "this is what I am
 * listening to", so the resting state is a true statement rather than a special case,
 * and switching to the bass is the same gesture as switching back.
 *
 * The alternative - stems muted, original merely unmuted - was written first and is
 * worse: with a stem muted, Solo on it is `solo && !muted` and therefore silent, so the
 * one button the whole feature exists for would do nothing on a freshly opened project.
 */
export function openMixer(stemIds: readonly string[]): MixerState {
  const tracks: Record<string, StemTrackState> = {
    [ORIGINAL_TRACK_ID]: newTrack(ORIGINAL_TRACK_ID, true),
  };
  for (const id of stemIds) tracks[id] = newTrack(id, false);
  return { tracks };
}

export const EMPTY_MIXER: MixerState = openMixer([]);

/**
 * Keep the mixer in step with what the project actually has.
 *
 * Called when a project opens or its stems change. Tracks that are still there keep the
 * state the author set - so reopening the panel does not undo their work - and ones that
 * have gone are dropped rather than left behind to solo something that is not there.
 */
export function withStems(state: MixerState, stemIds: readonly string[]): MixerState {
  const tracks: Record<string, StemTrackState> = {};
  for (const id of [ORIGINAL_TRACK_ID, ...stemIds]) {
    tracks[id] = state.tracks[id] ?? newTrack(id, false);
  }
  return settled({ tracks });
}

/**
 * The one invariant: something is always being listened to.
 *
 * With nothing soloed at all, the audibility rule below routes every unmuted track -
 * which for a project with four stems means four stems at once, four decodes, and an
 * author who asked for none of it. Rather than special-casing that state everywhere, it
 * is simply never reached: dropping the last solo hands the original back.
 *
 * The rule itself stays completely general, so it is still correct for a state built
 * directly in a test; this is only about which states the Editor can get into.
 */
function settled(state: MixerState): MixerState {
  if (anySolo(state)) return state;
  const original = state.tracks[ORIGINAL_TRACK_ID];
  if (!original) return state;
  return {
    ...state,
    tracks: { ...state.tracks, [ORIGINAL_TRACK_ID]: { ...original, solo: true } },
  };
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function setVolume(state: MixerState, id: string, volume: number): MixerState {
  const track = state.tracks[id];
  if (!track) return state;
  const next = clampUnit(volume);
  if (next === track.volume) return state;
  return { ...state, tracks: { ...state.tracks, [id]: { ...track, volume: next } } };
}

export function setMuted(state: MixerState, id: string, muted: boolean): MixerState {
  const track = state.tracks[id];
  if (!track || track.muted === muted) return state;
  return { ...state, tracks: { ...state.tracks, [id]: { ...track, muted } } };
}

/**
 * Add a track to what is being listened to, or take it away.
 *
 * Several tracks may be soloed at once, which is what makes "bass and drums together" a
 * thing an author can ask for; it is deliberately not a radio button. Taking away the
 * last one hands the original back rather than leaving nothing selected.
 */
export function setSolo(state: MixerState, id: string, solo: boolean): MixerState {
  const track = state.tracks[id];
  if (!track || track.solo === solo) return state;
  return settled({ ...state, tracks: { ...state.tracks, [id]: { ...track, solo } } });
}

export function toggleMuted(state: MixerState, id: string): MixerState {
  const track = state.tracks[id];
  return track ? setMuted(state, id, !track.muted) : state;
}

export function toggleSolo(state: MixerState, id: string): MixerState {
  const track = state.tracks[id];
  return track ? setSolo(state, id, !track.solo) : state;
}

/**
 * Go back to the song: the original, and nothing else.
 *
 * The one gesture that gets an author out of whatever they have set up, however they got
 * there. Faders and mutes are left alone, so it restores what is being listened to
 * without discarding a balance the author took trouble over.
 */
export function listenToOriginal(state: MixerState): MixerState {
  const tracks: Record<string, StemTrackState> = {};
  let changed = false;
  for (const [id, track] of Object.entries(state.tracks)) {
    const solo = id === ORIGINAL_TRACK_ID;
    changed = changed || track.solo !== solo;
    tracks[id] = track.solo === solo ? track : { ...track, solo };
  }
  return changed ? { ...state, tracks } : state;
}

/** Whether anything is soloed at all, which is what switches the rule below. */
export function anySolo(state: MixerState): boolean {
  return Object.values(state.tracks).some((track) => track.solo);
}

/**
 * Whether a track is routed to the output.
 *
 * The ordinary rule every mixer uses, and worth stating exactly because it is the one
 * thing that must not surprise anyone:
 *
 *     with anything soloed:  a track is heard if it is soloed and not muted
 *     with nothing soloed:   a track is heard if it is not muted
 *
 * Mute therefore beats Solo - a soloed track that is also muted stays silent - which is
 * how a mixing desk behaves and what an author reaching for Mute expects.
 *
 * Deliberately says nothing about the fader. A track pulled to zero is routed and simply
 * inaudible; the difference matters for the original below, where a fader must not decide
 * *which source* is playing.
 */
export function isRouted(state: MixerState, id: string): boolean {
  const track = state.tracks[id];
  if (!track) return false;
  return anySolo(state) ? track.solo && !track.muted : !track.muted;
}

/**
 * Whether any separated stem is routed.
 *
 * What makes the original step aside. Only real stems count, never the original itself.
 */
export function anyStemRouted(state: MixerState): boolean {
  return Object.keys(state.tracks).some(
    (id) => id !== ORIGINAL_TRACK_ID && isRouted(state, id),
  );
}

/**
 * Whether the original recording should be heard.
 *
 * The ordinary rule, and then one extra clause: **the original steps aside as soon as a
 * stem is brought in.** Stems are the same music taken apart, so playing the whole mix
 * underneath one of its own parts doubles that part and comb-filters it - a mess, and
 * never what anybody wanted. Rather than making the author remember to silence the
 * original first, bringing a stem in silences it for them, and dropping the stem again
 * brings it back.
 *
 * Gated on *routing* rather than on volume on purpose: pulling a stem's fader to zero
 * gives silence, not a surprise return of the full mix. Which source is playing is a
 * decision made with Mute and Solo, never by moving a slider.
 */
export function isOriginalAudible(state: MixerState): boolean {
  return isRouted(state, ORIGINAL_TRACK_ID) && !anyStemRouted(state);
}

/**
 * How loud a track should be relative to the master, from zero to one.
 *
 * The one number the audio engine needs. Everything above folds into it, so the engine
 * never has to reason about solo or about the original at all - it sets a gain. The
 * transport's own volume multiplies this; it is not folded in here, because the master
 * belongs to the transport and would otherwise be recorded in two places.
 */
export function effectiveGain(state: MixerState, id: string): number {
  const track = state.tracks[id];
  if (!track) return 0;
  const routed =
    id === ORIGINAL_TRACK_ID ? isOriginalAudible(state) : isRouted(state, id);
  return routed ? clampUnit(track.volume) : 0;
}

/**
 * Every stem that should currently be playing.
 *
 * What the engine runs sources for, and therefore what it decodes: a stem nobody has
 * asked for costs nothing. Sorted so the same set is always the same list, which is what
 * lets the engine tell "no change" from "something changed" cheaply.
 */
export function routedStemIds(state: MixerState): readonly string[] {
  return Object.keys(state.tracks)
    .filter((id) => id !== ORIGINAL_TRACK_ID && isRouted(state, id))
    .sort();
}

/**
 * A short phrase describing what is being listened to, for the panel's header.
 *
 * Worth having because "why can I not hear anything" is the question a mixer generates
 * most often, and the answer is usually visible in one line.
 */
export function describeListening(
  state: MixerState,
  labels: Readonly<Record<string, string>>,
): string {
  const stems = routedStemIds(state);
  if (stems.length > 0) return stems.map((id) => labels[id] ?? id).join(" + ");
  return isOriginalAudible(state) ? (labels[ORIGINAL_TRACK_ID] ?? "Original") : "Silent";
}
