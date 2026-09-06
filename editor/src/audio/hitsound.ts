/**
 * The click that marks a chart note during playback.
 *
 * Synthesised with Web Audio rather than loaded from a file: the sound is a few
 * milliseconds of shaped noise and a short tone, which is cheaper to generate than to
 * ship, and it keeps the Editor free of binary assets.
 *
 * Its gain is deliberately separate from the music. Charting is done with the track
 * turned down and the clicks kept audible, so tying one to the other would make the
 * useful configuration impossible.
 */

import type { HitVoice } from "../core/hitScheduler";

export interface HitSoundEngine {
  /** Play one click now. */
  play(voice: HitVoice): void;
  /** 0-1. Independent of the music element's volume. */
  setGain(gain: number): void;
  close(): void;
}

interface VoiceShape {
  /** Frequency of the body tone, in Hz. */
  readonly frequency: number;
  /** How long the click rings, in seconds. */
  readonly decaySec: number;
  /** Relative loudness, so one voice does not drown the others. */
  readonly level: number;
}

/**
 * Per-voice shapes.
 *
 * All of them are the same short click, distinguished only by pitch, so a chord of mixed
 * kinds still reads as one event rather than as four instruments. Having the table at all
 * is what makes giving any of them a genuinely different character a one-file change.
 */
const VOICES: Readonly<Record<HitVoice, VoiceShape>> = {
  tap: { frequency: 1400, decaySec: 0.045, level: 1 },
  flick: { frequency: 1900, decaySec: 0.05, level: 0.95 },
  holdStart: { frequency: 1100, decaySec: 0.06, level: 1 },
};

/**
 * Build an engine over a Web Audio context.
 *
 * The context is created lazily by the caller and resumed on a user gesture, because
 * browsers refuse to start one otherwise.
 */
export function createHitSoundEngine(context: AudioContext): HitSoundEngine {
  const master = context.createGain();
  master.gain.value = 0.6;
  master.connect(context.destination);

  return {
    play(voice: HitVoice): void {
      const shape = VOICES[voice] ?? VOICES.tap;
      const now = context.currentTime;

      // A tone for the body of the click.
      const oscillator = context.createOscillator();
      oscillator.type = "square";
      oscillator.frequency.value = shape.frequency;

      // An envelope that opens immediately and closes fast: anything slower reads as a
      // blip with its own duration rather than as a mark on a moment.
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0.0001, now);
      envelope.gain.exponentialRampToValueAtTime(shape.level, now + 0.001);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + shape.decaySec);

      oscillator.connect(envelope);
      envelope.connect(master);
      oscillator.start(now);
      oscillator.stop(now + shape.decaySec + 0.01);
      oscillator.onended = () => {
        oscillator.disconnect();
        envelope.disconnect();
      };
    },

    setGain(gain: number): void {
      master.gain.value = Math.min(1, Math.max(0, gain));
    },

    close(): void {
      master.disconnect();
      void context.close();
    },
  };
}
