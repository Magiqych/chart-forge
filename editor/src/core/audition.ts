/**
 * Hearing the recording while stepping through it from the keyboard.
 *
 * Moving the playhead with the arrow keys tells the eye where it is; this tells the ear.
 * After a keyboard seek the song is played for about a tenth of a second and stopped
 * again, so an author frame-advancing through a bar can hear *this is the kick*, *this is
 * where the vocal enters* without starting playback and hunting for the pause key.
 *
 * This is the **song**, not a note click. The hitsounds an author hears during playback,
 * and the click a placement makes, are separate features with their own settings; nothing
 * here touches them.
 *
 * The module is split deliberately. `planNavigationAudition` is the whole decision and is
 * pure. `createAuditionController` owns the one genuinely stateful part - making sure a
 * burst of key presses cannot have an old timer stop the newest sound - and takes its
 * timers and its media as arguments, so that too can be tested without a browser.
 */

/**
 * How long the song plays after a keyboard seek.
 *
 * Long enough to hear a transient and what kind of sound it is; short enough that it
 * never feels like playback has started and needs stopping. A tenth of a second is about
 * two cycles of the slowest musically useful pitch, and comfortably past the attack of
 * anything percussive.
 */
export const NAVIGATION_AUDITION_MS = 110;

export interface AuditionPlan {
  /** Whether to start the song at all. */
  readonly play: boolean;
  /** Stop after this long, or null to leave playback alone. */
  readonly stopAfterMs: number | null;
  /**
   * Where to put the clock when stopping.
   *
   * The audition advances `currentTime` by its own duration, and leaving it there would
   * make five presses of the arrow key move five steps *plus* half a second. Restoring the
   * target keeps one press worth exactly one step.
   */
  readonly restoreTimeSec: number | null;
}

const SILENT: AuditionPlan = { play: false, stopAfterMs: null, restoreTimeSec: null };

export interface AuditionRequest {
  /** Where the navigation landed. */
  readonly targetSec: number;
  /** Whether the recording was already playing when the key was pressed. */
  readonly wasPlaying: boolean;
  /** Whether the author wants auditioning at all. */
  readonly enabled: boolean;
}

/**
 * What a keyboard seek should do about sound.
 *
 * While the recording is already playing there is nothing to do: the author is listening
 * already, and the seek has taken them somewhere new. Stopping after a tenth of a second
 * would be this feature reaching in and pausing playback the author started, which it has
 * no business doing - so an audition only ever auto-pauses something it started itself.
 */
export function planNavigationAudition(request: AuditionRequest): AuditionPlan {
  if (!request.enabled) return SILENT;
  if (request.wasPlaying) return SILENT;
  return {
    play: true,
    stopAfterMs: NAVIGATION_AUDITION_MS,
    restoreTimeSec: request.targetSec,
  };
}

/** The bit of a media element an audition needs. Narrow, so a test can supply one. */
export interface AuditionMedia {
  play(): Promise<void>;
  pause(): void;
  setCurrentTime(timeSec: number): void;
}

/** Injectable timers, so cancellation can be tested without waiting for real time. */
export interface AuditionTimers {
  set(callback: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface AuditionController {
  /** Run the plan for one navigation. Cancels whatever the last one had pending. */
  readonly run: (media: AuditionMedia, plan: AuditionPlan) => void;
  /** Abandon any pending stop without stopping. */
  readonly cancel: () => void;
  /** Whether a stop is currently pending. For tests and for reasoning about state. */
  readonly pending: () => boolean;
}

/**
 * Serialise auditions so only the newest one can stop the sound.
 *
 * Holding an arrow key down produces a stream of navigations, each starting a sound and
 * asking for it to stop a tenth of a second later. Without this, the stop belonging to
 * the third press would arrive while the fifth press's sound was playing and cut it off -
 * so holding the key would produce silence with occasional blips, which is the opposite
 * of the point.
 *
 * Two mechanisms, because either alone leaves a gap. The pending timer is cleared, which
 * handles the common case; and every run takes a generation number, so a callback that
 * was already in flight when the next run started finds itself stale and does nothing.
 */
export function createAuditionController(timers: AuditionTimers): AuditionController {
  let generation = 0;
  let handle: number | null = null;

  const clearPending = () => {
    if (handle !== null) {
      timers.clear(handle);
      handle = null;
    }
  };

  return {
    run(media, plan) {
      generation += 1;
      const mine = generation;
      clearPending();

      if (!plan.play) return;

      // The promise is deliberately handled rather than awaited: a rejection here - a
      // browser declining to play, a seek interrupting the start - is a reason for this
      // one audition to be silent, never a reason for an unhandled rejection or for the
      // Editor to stop working.
      void media.play().catch(() => {
        if (mine === generation) clearPending();
      });

      if (plan.stopAfterMs === null) return;
      handle = timers.set(() => {
        handle = null;
        // A newer navigation has taken over; its sound is not this one's to stop.
        if (mine !== generation) return;
        media.pause();
        if (plan.restoreTimeSec !== null) media.setCurrentTime(plan.restoreTimeSec);
      }, plan.stopAfterMs);
    },

    cancel() {
      generation += 1;
      clearPending();
    },

    pending() {
      return handle !== null;
    },
  };
}
