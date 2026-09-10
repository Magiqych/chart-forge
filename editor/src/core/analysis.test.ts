import { describe, expect, it } from "vitest";

import {
  AnalysisProjectionError,
  LANE_IDS,
  laneForStem,
  projectAnalysis,
  type AnalysisProjection,
} from "./analysis";

/** A minimal but contract-shaped Analysis 0.2 document. */
function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "0.2.0",
    generator: { name: "chart-forge-analyzer", version: "0.1.0" },
    audio: {
      path: "C:/music/song.flac",
      sha256: "a".repeat(64),
      durationSec: 12.5,
      sampleRate: 44100,
      channels: 2,
    },
    detectors: [
      { id: "det-beat-this", name: "beat-this", version: "1.1.0" },
      { id: "det-librosa-onset", name: "librosa.onset", version: "0.11.0" },
      { id: "det-torchcrepe", name: "torchcrepe", version: "0.0.24" },
    ],
    tempo: { bpm: 142.8571 },
    beats: [
      { timeSec: 0.5, detectorId: "det-beat-this", isDownbeat: true },
      { timeSec: 0.92, detectorId: "det-beat-this", isDownbeat: false },
      { timeSec: 1.34, detectorId: "det-beat-this", isDownbeat: false },
      { timeSec: 1.76, detectorId: "det-beat-this", isDownbeat: true },
    ],
    stems: [
      { id: "stem-drums", kind: "drums", path: "stems/drums.wav" },
      { id: "stem-bass", kind: "bass", path: "stems/bass.wav" },
      { id: "stem-other", kind: "other", path: "stems/other.wav" },
      { id: "stem-vocals", kind: "vocals", path: "stems/vocals.wav" },
    ],
    events: [
      {
        id: "ev-drums-000001",
        type: "percussion",
        detectorId: "det-librosa-onset",
        endKind: "instantaneous",
        startSec: 0.5,
        source: { stemId: "stem-drums" },
        metadata: { rawScore: { kind: "onset-strength", value: 4.2 } },
      },
      {
        id: "ev-bass-000001",
        type: "pitch-run",
        detectorId: "det-torchcrepe",
        endKind: "bounded",
        startSec: 0.7,
        endSec: 1.2,
        durationSec: 0.5,
        source: { stemId: "stem-bass", instrument: "bass" },
        pitch: { hz: 82.41, midi: 40.0, name: "E2" },
      },
      {
        id: "ev-other-000001",
        type: "onset",
        detectorId: "det-librosa-onset",
        endKind: "instantaneous",
        startSec: 0.9,
        source: { stemId: "stem-other" },
      },
      {
        id: "ev-vocals-000001",
        type: "pitch-run",
        detectorId: "det-torchcrepe",
        endKind: "bounded",
        startSec: 1.1,
        endSec: 2.45,
        durationSec: 1.35,
        source: { stemId: "stem-vocals", instrument: "vocal" },
        pitch: { hz: 495.0, midi: 71.4, name: "B4" },
      },
    ],
    metadata: {
      experimental: {
        disclaimer: "consumers must not depend on it",
        beatThis: { beatLogits: [1, 2, 3, 4, 5] },
        torchcrepe: { bass: { pitchHz: [80, 81, 82] } },
        librosa: { drums: { onsetStrength: [0.1, 4.2, 0.3] } },
      },
    },
    ...overrides,
  };
}

describe("stem to lane mapping", () => {
  it("maps every stem the Editor draws a lane for", () => {
    for (const lane of LANE_IDS) {
      expect(laneForStem(`stem-${lane}`)).toBe(lane);
    }
  });

  it("covers the six a six-source separation produces", () => {
    // Named rather than derived, so that dropping one from LANE_IDS is a failure here
    // and not a silent narrowing of what the Editor can show.
    expect([...LANE_IDS].sort()).toEqual(
      ["bass", "drums", "guitar", "other", "piano", "vocals"],
    );
  });

  it("tolerates an unknown stem rather than rejecting it", () => {
    // `stem-guitar` used to be the example here. It is a lane now, so the case needs a
    // stem that really is outside the vocabulary - the contract says an open one, and a
    // separator that emits `synth` must not break the projection.
    expect(laneForStem("stem-synth")).toBeNull();
    expect(laneForStem("stem-accompaniment")).toBeNull();
    expect(laneForStem(undefined)).toBeNull();
  });
});

describe("projection", () => {
  // The projection is immutable, so one is enough for the whole block.
  const projection: AnalysisProjection = projectAnalysis(fixture());

  it("keeps the audio identity and duration", () => {
    expect(projection.audio.durationSec).toBe(12.5);
    expect(projection.audio.sha256).toBe("a".repeat(64));
    expect(projection.audio.sampleRate).toBe(44100);
  });

  it("keeps the tempo", () => {
    expect(projection.tempoBpm).toBeCloseTo(142.8571, 4);
  });

  it("preserves beats and downbeat flags", () => {
    expect(projection.beats).toHaveLength(4);
    expect(projection.beats.map((b) => b.isDownbeat)).toEqual([true, false, false, true]);
    expect(projection.counts.downbeats).toBe(2);
  });

  it("preserves detectors for labelling", () => {
    expect(projection.detectors.map((d) => d.id)).toEqual([
      "det-beat-this",
      "det-librosa-onset",
      "det-torchcrepe",
    ]);
    expect(projection.detectors[1]?.name).toBe("librosa.onset");
  });

  it("projects instantaneous events without an end", () => {
    const drum = projection.events.find((e) => e.id === "ev-drums-000001");
    expect(drum?.endKind).toBe("instantaneous");
    expect(drum?.endSec).toBeUndefined();
    expect(drum?.lane).toBe("drums");
  });

  it("projects bounded events with their end", () => {
    const bass = projection.events.find((e) => e.id === "ev-bass-000001");
    expect(bass?.endKind).toBe("bounded");
    expect(bass?.endSec).toBe(1.2);
    expect(bass?.startSec).toBe(0.7);
  });

  it("preserves pitch where present and omits it where absent", () => {
    const vocal = projection.events.find((e) => e.id === "ev-vocals-000001");
    expect(vocal?.pitch?.midi).toBeCloseTo(71.4, 6);
    expect(vocal?.pitch?.name).toBe("B4");
    const other = projection.events.find((e) => e.id === "ev-other-000001");
    expect(other?.pitch).toBeUndefined();
  });

  it("maps every event to its lane via source.stemId", () => {
    expect(projection.counts.byLane).toEqual({
      drums: 1, bass: 1, guitar: 0, piano: 0, other: 1, vocals: 1,
    });
    expect(projection.eventsByLane.vocals[0]?.id).toBe("ev-vocals-000001");
  });

  it("gives a lane with nothing in it an empty list rather than leaving it out", () => {
    // A four-stem document has no guitar; everything downstream indexes by lane and
    // must find a list there, not undefined.
    for (const lane of LANE_IDS) {
      expect(Array.isArray(projection.eventsByLane[lane])).toBe(true);
    }
    expect(projection.eventsByLane.guitar).toEqual([]);
  });

  it("preserves the document's event ordering", () => {
    expect(projection.events.map((e) => e.id)).toEqual([
      "ev-drums-000001",
      "ev-bass-000001",
      "ev-other-000001",
      "ev-vocals-000001",
    ]);
    const starts = projection.events.map((e) => e.startSec);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("carries the detectorId through to every event", () => {
    for (const event of projection.events) {
      expect(event.detectorId).not.toBe("");
      expect(projection.detectors.map((d) => d.id)).toContain(event.detectorId);
    }
  });

  it("does NOT carry metadata.experimental into the projection", () => {
    const serialised = JSON.stringify(projection);
    expect(serialised).not.toContain("experimental");
    expect(serialised).not.toContain("beatLogits");
    expect(serialised).not.toContain("onsetStrength");
    expect(serialised).not.toContain("pitchHz");
  });

  it("does not carry per-event metadata either", () => {
    expect(JSON.stringify(projection)).not.toContain("rawScore");
  });

  it("does not mutate the source document", () => {
    const source = fixture();
    const before = JSON.stringify(source);
    projectAnalysis(source);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("exposes no confidence, because Analysis 0.2 emits none", () => {
    expect(JSON.stringify(projection)).not.toContain("confidence");
  });
});

describe("projection rejects what it cannot draw", () => {
  it("rejects an unsupported document version", () => {
    expect(() => projectAnalysis(fixture({ version: "0.1.0" }))).toThrow(AnalysisProjectionError);
    expect(() => projectAnalysis(fixture({ version: "0.3.0" }))).toThrow(/0\.2\.x/);
  });

  it("accepts any 0.2.x patch level", () => {
    expect(() => projectAnalysis(fixture({ version: "0.2.7" }))).not.toThrow();
  });

  it("rejects a bounded event with no endSec", () => {
    const broken = fixture({
      events: [
        {
          id: "ev-bass-000001",
          type: "pitch-run",
          detectorId: "det-torchcrepe",
          endKind: "bounded",
          startSec: 1,
          source: { stemId: "stem-bass" },
        },
      ],
    });
    expect(() => projectAnalysis(broken)).toThrow(/endSec/);
  });

  it("rejects an event with an unusable endKind", () => {
    const broken = fixture({
      events: [
        {
          id: "ev-x",
          type: "onset",
          detectorId: "det-librosa-onset",
          endKind: "measured",
          startSec: 1,
          source: { stemId: "stem-other" },
        },
      ],
    });
    expect(() => projectAnalysis(broken)).toThrow(/endKind/);
  });

  it("accepts the future 'unknown' endKind without breaking", () => {
    const forward = fixture({
      events: [
        {
          id: "ev-x",
          type: "sustain",
          detectorId: "det-librosa-onset",
          endKind: "unknown",
          startSec: 1,
          source: { stemId: "stem-other" },
        },
      ],
    });
    const p = projectAnalysis(forward);
    expect(p.events[0]?.endKind).toBe("unknown");
    expect(p.events[0]?.endSec).toBeUndefined();
  });

  it("tolerates an unknown event type", () => {
    const odd = fixture({
      events: [
        {
          id: "ev-x",
          type: "some-future-type",
          detectorId: "det-librosa-onset",
          endKind: "instantaneous",
          startSec: 1,
          source: { stemId: "stem-drums" },
        },
      ],
    });
    expect(projectAnalysis(odd).events[0]?.type).toBe("some-future-type");
  });

  it("rejects a non-object document", () => {
    expect(() => projectAnalysis(null)).toThrow(AnalysisProjectionError);
    expect(() => projectAnalysis("{}")).toThrow(AnalysisProjectionError);
  });

  it("degrades gracefully when optional sections are absent", () => {
    const sparse = {
      version: "0.2.0",
      audio: { path: "a.wav", durationSec: 5 },
      events: [],
    };
    const p = projectAnalysis(sparse);
    expect(p.beats).toHaveLength(0);
    expect(p.detectors).toHaveLength(0);
    expect(p.tempoBpm).toBeUndefined();
    expect(p.counts.events).toBe(0);
  });
});
