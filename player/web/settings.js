/**
 * Player session settings.
 *
 * None of this belongs in a chart. How fast the notes come towards *this* player, how
 * much *this* machine's audio lags, which keys *these* hands use - a chart that carried
 * any of it would be a chart that played differently on the next computer. The Chart
 * contract has no field for any of it and should not grow one, so it lives here, in the
 * browser's own storage, keyed per Player rather than per chart.
 *
 * Stored settings are read defensively: the whole thing is one key, the browser may
 * refuse to give it back, and a value that has gone strange is replaced by its default
 * rather than being trusted into the game loop.
 */

const STORAGE_KEY = "chart-forge-player/session/v1";

export const DEFAULTS = Object.freeze({
  /** Note speed: how quickly notes travel, not how fast the song plays. */
  noteSpeed: 1.4,
  /** Latency correction, in milliseconds. Chart time is audio time minus this. */
  offsetMs: 0,
  /** Playback rate of the song itself. Practice speeds are below 1. */
  playbackRate: 1,
  autoplay: false,
  hitSound: true,
  /** Whether a swipe the wrong way may satisfy a flick at all. */
  strictFlickDirection: false,
  showDecorations: true,
  musicVolume: 0.85,
  hitSoundVolume: 0.35,
});

export const OFFSET_LIMIT_MS = 200;

function clampNumber(value, low, high, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
}

export function sanitize(raw) {
  const source = typeof raw === "object" && raw !== null ? raw : {};
  return {
    noteSpeed: clampNumber(source.noteSpeed, 0.5, 4, DEFAULTS.noteSpeed),
    offsetMs: Math.round(clampNumber(source.offsetMs, -OFFSET_LIMIT_MS, OFFSET_LIMIT_MS, DEFAULTS.offsetMs)),
    playbackRate: clampNumber(source.playbackRate, 0.25, 2, DEFAULTS.playbackRate),
    autoplay: source.autoplay === true,
    hitSound: source.hitSound !== false,
    strictFlickDirection: source.strictFlickDirection === true,
    showDecorations: source.showDecorations !== false,
    musicVolume: clampNumber(source.musicVolume, 0, 1, DEFAULTS.musicVolume),
    hitSoundVolume: clampNumber(source.hitSoundVolume, 0, 1, DEFAULTS.hitSoundVolume),
  };
}

export function loadSettings(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return sanitize(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(storage, settings) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(sanitize(settings)));
  } catch {
    // A browser with storage switched off still plays; it just forgets the offset.
  }
}
