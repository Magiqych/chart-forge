/**
 * The rules that decide what an author hears.
 *
 * All of it is arithmetic over a plain state object, which is the point of keeping the
 * mixer separate from the audio engine: the questions that actually cause confusion -
 * does Solo beat Mute, what happens to the original when a stem comes in, does pulling a
 * fader to zero bring the full mix back - are answered here, without an audio device and
 * without a clock.
 *
 * The case that gets the most attention is the one the feature exists for: soloing Bass
 * to place notes against the bassline.
 */

import { describe, expect, it } from "vitest";

import {
  ORIGINAL_TRACK_ID, anySolo, anyStemRouted, describeListening, effectiveGain,
  isOriginalAudible, isRouted, listenToOriginal, openMixer, routedStemIds, setMuted,
  setSolo, setVolume, toggleMuted, toggleSolo, withStems,
} from "./stemMixer";

const STEMS = ["stem-drums", "stem-bass", "stem-other", "stem-vocals"];
const fresh = () => openMixer(STEMS);

const LABELS = {
  [ORIGINAL_TRACK_ID]: "Original",
  "stem-drums": "Drums",
  "stem-bass": "Bass",
  "stem-other": "Other",
  "stem-vocals": "Vocals",
};

describe("how a project opens", () => {
  it("sounds exactly as it did before the mixer existed", () => {
    const state = fresh();
    expect(isOriginalAudible(state)).toBe(true);
    expect(routedStemIds(state)).toEqual([]);
    expect(effectiveGain(state, ORIGINAL_TRACK_ID)).toBe(1);
  });

  it("has every stem present but silent, so nothing is heard twice on open", () => {
    // Silent matters twice over: the original is not doubled, and a stem nobody asked
    // for is never decoded, which is where the memory would have gone.
    const state = fresh();
    for (const id of STEMS) {
      expect(state.tracks[id]).toBeDefined();
      expect(effectiveGain(state, id)).toBe(0);
    }
    expect(routedStemIds(state)).toEqual([]);
  });

  it("is a mixer with nothing but the original when the project has no stems", () => {
    // Every project analysed before separation existed takes this path.
    const state = openMixer([]);
    expect(Object.keys(state.tracks)).toEqual([ORIGINAL_TRACK_ID]);
    expect(isOriginalAudible(state)).toBe(true);
  });
});

describe("soloing the bass, which is what this is for", () => {
  it("plays the bass and nothing else", () => {
    const state = setSolo(fresh(), "stem-bass", true);

    expect(routedStemIds(state)).toEqual(["stem-bass"]);
    expect(effectiveGain(state, "stem-bass")).toBe(1);
    for (const id of ["stem-drums", "stem-other", "stem-vocals"]) {
      expect(effectiveGain(state, id)).toBe(0);
    }
  });

  it("silences the original, so the bass is not heard under the whole mix", () => {
    // The clause that matters most: stems are the same recording taken apart, so leaving
    // the original playing would double the bass and comb-filter it.
    const state = setSolo(fresh(), "stem-bass", true);
    expect(isOriginalAudible(state)).toBe(false);
    expect(effectiveGain(state, ORIGINAL_TRACK_ID)).toBe(0);
  });

  it("says what is being listened to", () => {
    expect(describeListening(setSolo(fresh(), "stem-bass", true), LABELS)).toBe("Bass");
  });

  it("gives the original back the moment the solo is dropped", () => {
    // Dropping the last solo must land somewhere sensible rather than on "nothing
    // selected", which would route every unmuted stem at once.
    const soloed = setSolo(fresh(), "stem-bass", true);
    const back = setSolo(soloed, "stem-bass", false);

    expect(isOriginalAudible(back)).toBe(true);
    expect(routedStemIds(back)).toEqual([]);
    expect(describeListening(back, LABELS)).toBe("Original");
  });

  it("keeps playing the bass alone when its fader is moved", () => {
    // A fader is loudness, never a routing decision - turning the bass down must not
    // bring the full mix back underneath it.
    let state = setSolo(fresh(), "stem-bass", true);
    state = setVolume(state, "stem-bass", 0.35);

    expect(effectiveGain(state, "stem-bass")).toBeCloseTo(0.35);
    expect(isOriginalAudible(state)).toBe(false);
  });

  it("stays silent rather than falling back when the bass is turned all the way down", () => {
    let state = setSolo(fresh(), "stem-bass", true);
    state = setVolume(state, "stem-bass", 0);

    expect(effectiveGain(state, "stem-bass")).toBe(0);
    expect(isOriginalAudible(state)).toBe(false);
    expect(anyStemRouted(state)).toBe(true);
  });
});

describe("solo and mute together", () => {
  it("lets several stems be soloed at once", () => {
    let state = setSolo(fresh(), "stem-bass", true);
    state = setSolo(state, "stem-drums", true);

    expect(routedStemIds(state)).toEqual(["stem-bass", "stem-drums"]);
    expect(describeListening(state, LABELS)).toBe("Bass + Drums");
  });

  it("lets Mute beat Solo, as a mixing desk does", () => {
    let state = setSolo(fresh(), "stem-bass", true);
    state = setSolo(state, "stem-drums", true);
    state = setMuted(state, "stem-drums", true);

    expect(isRouted(state, "stem-bass")).toBe(true);
    expect(isRouted(state, "stem-drums")).toBe(false);
  });

  it("silences everything when the only soloed track is also muted", () => {
    let state = setSolo(fresh(), "stem-bass", true);
    state = setMuted(state, "stem-bass", true);

    expect(anyStemRouted(state)).toBe(false);
    // No stem is routed, so the original is not being doubled and comes back.
    expect(isOriginalAudible(state)).toBe(true);
  });

  it("keeps a muted stem silent even after it is soloed", () => {
    let state = setMuted(fresh(), "stem-vocals", true);
    state = setSolo(state, "stem-vocals", true);

    expect(isRouted(state, "stem-vocals")).toBe(false);
    expect(isOriginalAudible(state)).toBe(true);
  });

  it("steps the original aside even though it is still in the solo group", () => {
    // The original opens soloed, so adding the bass leaves both selected. The routing
    // rule says the original is routed; the extra clause is what stops it sounding, and
    // the two are kept apart because only the second is about doubling.
    const state = setSolo(fresh(), "stem-bass", true);

    expect(state.tracks[ORIGINAL_TRACK_ID]?.solo).toBe(true);
    expect(isRouted(state, ORIGINAL_TRACK_ID)).toBe(true);
    expect(isOriginalAudible(state)).toBe(false);
    expect(effectiveGain(state, ORIGINAL_TRACK_ID)).toBe(0);
  });

  it("keeps the original away even when the author explicitly re-solos it", () => {
    let state = setSolo(fresh(), "stem-bass", true);
    state = setSolo(state, ORIGINAL_TRACK_ID, false);
    state = setSolo(state, ORIGINAL_TRACK_ID, true);

    expect(routedStemIds(state)).toEqual(["stem-bass"]);
    expect(effectiveGain(state, ORIGINAL_TRACK_ID)).toBe(0);
  });

  it("gets back to the song in one gesture, however it was got into", () => {
    let state = setSolo(fresh(), "stem-bass", true);
    state = setSolo(state, "stem-vocals", true);
    state = setSolo(state, ORIGINAL_TRACK_ID, false);
    state = setVolume(state, "stem-bass", 0.3);
    state = listenToOriginal(state);

    expect(isOriginalAudible(state)).toBe(true);
    expect(routedStemIds(state)).toEqual([]);
    // A balance the author took trouble over survives; only the listening changes.
    expect(state.tracks["stem-bass"]?.volume).toBeCloseTo(0.3);
  });

  it("reports silence when the author has muted their way to nothing", () => {
    const state = setMuted(fresh(), ORIGINAL_TRACK_ID, true);
    expect(describeListening(state, LABELS)).toBe("Silent");
  });
});

describe("the state itself", () => {
  it("changes nothing when a toggle would not change anything", () => {
    // Identity is what stops a render loop and what lets the engine skip work.
    const state = fresh();
    expect(setSolo(state, "stem-bass", false)).toBe(state);
    expect(setMuted(state, "stem-bass", false)).toBe(state);
    expect(setVolume(state, "stem-bass", 1)).toBe(state);
    expect(listenToOriginal(state)).toBe(state);
  });

  it("never lets the Editor reach a state with nothing selected", () => {
    // The invariant that stops four stems being routed - and decoded - at once.
    let state = setSolo(fresh(), ORIGINAL_TRACK_ID, false);
    expect(anySolo(state)).toBe(true);
    expect(isOriginalAudible(state)).toBe(true);

    state = setSolo(fresh(), "stem-bass", true);
    state = setSolo(state, ORIGINAL_TRACK_ID, false);
    state = setSolo(state, "stem-bass", false);
    expect(routedStemIds(state)).toEqual([]);
    expect(isOriginalAudible(state)).toBe(true);
  });

  it("ignores a track it does not have rather than inventing one", () => {
    const state = fresh();
    expect(toggleSolo(state, "stem-piano")).toBe(state);
    expect(toggleMuted(state, "stem-piano")).toBe(state);
    expect(effectiveGain(state, "stem-piano")).toBe(0);
  });

  it("clamps a fader to the range a gain can take", () => {
    expect(effectiveGain(setVolume(fresh(), ORIGINAL_TRACK_ID, 4), ORIGINAL_TRACK_ID)).toBe(1);
    expect(effectiveGain(setVolume(fresh(), ORIGINAL_TRACK_ID, -1), ORIGINAL_TRACK_ID)).toBe(0);
    expect(effectiveGain(setVolume(fresh(), ORIGINAL_TRACK_ID, NaN), ORIGINAL_TRACK_ID)).toBe(0);
  });

  it("toggles are their own inverse", () => {
    const state = fresh();
    expect(toggleSolo(toggleSolo(state, "stem-bass"), "stem-bass")).toEqual(state);
    expect(toggleMuted(toggleMuted(state, "stem-bass"), "stem-bass")).toEqual(state);
  });

  it("solos and un-solos the bass all day without wandering", () => {
    // The gesture an author actually repeats: listen to the bass, listen to the song,
    // listen to the bass again. It must land in the same two places every time.
    let state = fresh();
    for (let round = 0; round < 5; round += 1) {
      state = toggleSolo(state, "stem-bass");
      expect(routedStemIds(state)).toEqual(["stem-bass"]);
      expect(isOriginalAudible(state)).toBe(false);

      state = toggleSolo(state, "stem-bass");
      expect(routedStemIds(state)).toEqual([]);
      expect(isOriginalAudible(state)).toBe(true);
    }
  });
});

describe("opening another project", () => {
  it("keeps what the author set for stems that are still there", () => {
    let state = setSolo(fresh(), "stem-bass", true);
    state = setVolume(state, "stem-bass", 0.4);
    const next = withStems(state, STEMS);

    expect(next.tracks["stem-bass"]?.solo).toBe(true);
    expect(next.tracks["stem-bass"]?.volume).toBeCloseTo(0.4);
  });

  it("forgets a stem the new project does not have", () => {
    // Otherwise a leftover solo would silence everything, for a track not on screen.
    const state = setSolo(fresh(), "stem-bass", true);
    const next = withStems(state, ["stem-vocals"]);

    expect(next.tracks["stem-bass"]).toBeUndefined();
    expect(routedStemIds(next)).toEqual([]);
    expect(isOriginalAudible(next)).toBe(true);
  });

  it("starts a newly appearing stem un-soloed, so it is not heard unasked", () => {
    // `piano` is not in the four-stem vocabulary; an open `kind` has to just work.
    const next = withStems(openMixer([]), ["stem-piano"]);
    expect(next.tracks["stem-piano"]?.solo).toBe(false);
    expect(isOriginalAudible(next)).toBe(true);
    expect(routedStemIds(next)).toEqual([]);
  });

  it("always keeps the original, even for a project with no stems at all", () => {
    expect(withStems(fresh(), []).tracks[ORIGINAL_TRACK_ID]).toBeDefined();
  });
});
