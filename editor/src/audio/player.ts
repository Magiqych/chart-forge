/**
 * Audio playback and the waveform display envelope.
 *
 * Two deliberate separations:
 *
 *  - playback uses an <audio> element streaming from the Tauri asset protocol, so a
 *    40 MB file is never marshalled through IPC as base64;
 *  - the waveform is a small min/max envelope derived once from decoded samples. The
 *    decoded AudioBuffer is dropped immediately and never reaches React state, where it
 *    would be tens of megabytes of array copied on every render.
 */

/** Two floats (min, max) per bucket. */
export type WaveformEnvelope = Float32Array;

export const DEFAULT_ENVELOPE_BUCKETS = 8000;

/**
 * Reduce decoded audio to a min/max envelope.
 *
 * Pure over its input so it can be tested with a synthetic buffer.
 */
export function buildEnvelope(
  samples: Float32Array,
  buckets = DEFAULT_ENVELOPE_BUCKETS,
): WaveformEnvelope {
  const out = new Float32Array(buckets * 2);
  if (samples.length === 0) return out;
  const perBucket = samples.length / buckets;

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor(bucket * perBucket);
    const end = Math.min(samples.length, Math.floor((bucket + 1) * perBucket));
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i += 1) {
      const value = samples[i] as number;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    out[bucket * 2] = min;
    out[bucket * 2 + 1] = max;
  }
  return out;
}

export interface LoadedAudio {
  readonly element: HTMLAudioElement;
  readonly envelope: WaveformEnvelope;
  readonly durationSec: number;
}

/**
 * Prepare an audio URL for playback and display.
 *
 * The element streams; the envelope is computed from a one-off decode whose buffer is
 * released as soon as the envelope exists.
 */
export async function loadAudio(url: string, buckets = DEFAULT_ENVELOPE_BUCKETS): Promise<LoadedAudio> {
  const element = new Audio();
  element.preload = "auto";
  element.src = url;

  const ready = new Promise<void>((resolve, reject) => {
    element.addEventListener("loadedmetadata", () => resolve(), { once: true });
    element.addEventListener("error", () => reject(new Error(`cannot load audio: ${url}`)), {
      once: true,
    });
  });

  let envelope: WaveformEnvelope = new Float32Array(buckets * 2);
  let durationSec = 0;
  try {
    await ready;
    durationSec = Number.isFinite(element.duration) ? element.duration : 0;

    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    const context = new OfflineAudioContext(1, 1, 44100);
    const decoded = await context.decodeAudioData(bytes);
    envelope = buildEnvelope(decoded.getChannelData(0), buckets);
    if (durationSec === 0) durationSec = decoded.duration;
    // The decoded buffer goes out of scope here on purpose: only the envelope is kept.
  } catch {
    // Playback can still work without a waveform; an empty envelope draws nothing.
  }

  return { element, envelope, durationSec };
}
