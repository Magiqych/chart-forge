/**
 * The Editor's read-only projection of an Analysis document.
 *
 * The Analysis is never mutated and never adopted into the editor's own model. It is a
 * guide layer: regenerable, disposable, and conceptually distinct from the Chart the
 * author is writing. The only sanctioned bridge back is `chartNote.sourceEventId`, which
 * records what the author was looking at - not that a note was derived from an event.
 *
 * Only the stable contract fields are carried across. `metadata.experimental` is dropped
 * on purpose: it is roughly 60% of a real document's bytes, it is declared undependable
 * by the contract, and the overlay needs none of it.
 */

/** Event ends are described by `endKind`, never inferred from a missing `endSec`. */
export type EndKind = "instantaneous" | "unknown" | "bounded";

/** Which lane an event is drawn in. Derived from `source.stemId`. */
export type LaneId = "drums" | "other" | "bass" | "vocals";

export const LANE_IDS: readonly LaneId[] = ["drums", "other", "bass", "vocals"];

export interface ProjectedBeat {
  readonly timeSec: number;
  readonly isDownbeat: boolean;
}

export interface ProjectedPitch {
  readonly hz: number;
  readonly midi: number;
  readonly name: string;
}

export interface ProjectedEvent {
  readonly id: string;
  readonly type: string;
  readonly startSec: number;
  /** Present only when endKind is "bounded". */
  readonly endSec?: number;
  readonly endKind: EndKind;
  readonly detectorId: string;
  readonly stemId: string;
  readonly lane: LaneId | null;
  readonly pitch?: ProjectedPitch;
}

/**
 * A stem the Analyzer separated out of the recording.
 *
 * Carried across because the Editor lets an author listen to one - `path` is where the
 * audio was said to be, relative to the Analysis document, and only the Rust side can
 * turn that into something playable. The projection stays honest about what the document
 * said; whether the file is actually there is a separate question, answered on load.
 */
export interface ProjectedStem {
  readonly id: string;
  /** Open vocabulary: `bass`, `vocals`, `piano`, anything the separator produced. */
  readonly kind: string;
  readonly path?: string;
}

export interface ProjectedDetector {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
}

export interface AnalysisProjection {
  readonly version: string;
  readonly audio: {
    readonly path: string;
    readonly sha256?: string;
    readonly durationSec: number;
    readonly sampleRate?: number;
    readonly channels?: number;
  };
  readonly tempoBpm?: number;
  /** Empty for an analysis run without separation, which is not an error. */
  readonly stems: readonly ProjectedStem[];
  readonly beats: readonly ProjectedBeat[];
  readonly detectors: readonly ProjectedDetector[];
  /** Sorted by (startSec, id), as the Analysis contract guarantees. */
  readonly events: readonly ProjectedEvent[];
  /** Event ids per lane, for cheap per-lane range queries. */
  readonly eventsByLane: Readonly<Record<LaneId, readonly ProjectedEvent[]>>;
  readonly counts: {
    readonly beats: number;
    readonly downbeats: number;
    readonly events: number;
    readonly byLane: Readonly<Record<LaneId, number>>;
  };
}

const STEM_TO_LANE: Readonly<Record<string, LaneId>> = {
  "stem-drums": "drums",
  "stem-other": "other",
  "stem-bass": "bass",
  "stem-vocals": "vocals",
};

/** Unknown stems are kept but laneless, per the contract's open-vocabulary rule. */
export function laneForStem(stemId: string | undefined): LaneId | null {
  if (stemId === undefined) return null;
  return STEM_TO_LANE[stemId] ?? null;
}

export class AnalysisProjectionError extends Error {}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AnalysisProjectionError(`${what} must be a finite number`);
  }
  return value;
}

function isEndKind(value: unknown): value is EndKind {
  return value === "instantaneous" || value === "unknown" || value === "bounded";
}

/**
 * Build the Editor's projection from a parsed Analysis document.
 *
 * Deliberately tolerant in the way the contract asks for: unknown event types, stem
 * kinds and detector ids are carried through rather than rejected. Deliberately strict
 * about the few things the renderer cannot guess at - a missing `endKind`, or a
 * `bounded` event with no `endSec`.
 */
export function projectAnalysis(raw: unknown): AnalysisProjection {
  if (typeof raw !== "object" || raw === null) {
    throw new AnalysisProjectionError("Analysis document is not an object");
  }
  const doc = raw as Record<string, unknown>;

  const version = typeof doc["version"] === "string" ? doc["version"] : "";
  if (!version.startsWith("0.2.")) {
    throw new AnalysisProjectionError(
      `unsupported Analysis document version ${version || "(missing)"}; this Editor reads 0.2.x`,
    );
  }

  const audioRaw = (doc["audio"] ?? {}) as Record<string, unknown>;
  const audio = {
    path: typeof audioRaw["path"] === "string" ? audioRaw["path"] : "",
    ...(typeof audioRaw["sha256"] === "string" ? { sha256: audioRaw["sha256"] } : {}),
    durationSec: requireNumber(audioRaw["durationSec"], "audio.durationSec"),
    ...(typeof audioRaw["sampleRate"] === "number"
      ? { sampleRate: audioRaw["sampleRate"] }
      : {}),
    ...(typeof audioRaw["channels"] === "number" ? { channels: audioRaw["channels"] } : {}),
  };

  const tempoRaw = (doc["tempo"] ?? {}) as Record<string, unknown>;
  const tempoBpm = typeof tempoRaw["bpm"] === "number" ? tempoRaw["bpm"] : undefined;

  const stemsRaw = Array.isArray(doc["stems"]) ? doc["stems"] : [];
  const stems: ProjectedStem[] = stemsRaw.map((entry) => {
    const s = entry as Record<string, unknown>;
    return {
      id: String(s["id"] ?? ""),
      kind: String(s["kind"] ?? ""),
      ...(typeof s["path"] === "string" ? { path: s["path"] } : {}),
    };
  });

  const beatsRaw = Array.isArray(doc["beats"]) ? doc["beats"] : [];
  const beats: ProjectedBeat[] = beatsRaw.map((entry) => {
    const b = entry as Record<string, unknown>;
    return {
      timeSec: requireNumber(b["timeSec"], "beats[].timeSec"),
      isDownbeat: b["isDownbeat"] === true,
    };
  });

  const detectorsRaw = Array.isArray(doc["detectors"]) ? doc["detectors"] : [];
  const detectors: ProjectedDetector[] = detectorsRaw.map((entry) => {
    const d = entry as Record<string, unknown>;
    return {
      id: String(d["id"] ?? ""),
      name: String(d["name"] ?? ""),
      ...(typeof d["version"] === "string" ? { version: d["version"] } : {}),
    };
  });

  const eventsRaw = Array.isArray(doc["events"]) ? doc["events"] : [];
  const events: ProjectedEvent[] = eventsRaw.map((entry) => {
    const e = entry as Record<string, unknown>;
    const endKind = e["endKind"];
    if (!isEndKind(endKind)) {
      throw new AnalysisProjectionError(
        `event ${String(e["id"])} has unusable endKind ${JSON.stringify(endKind)}`,
      );
    }
    const source = (e["source"] ?? {}) as Record<string, unknown>;
    const stemId = typeof source["stemId"] === "string" ? source["stemId"] : "";

    let endSec: number | undefined;
    if (endKind === "bounded") {
      endSec = requireNumber(e["endSec"], `event ${String(e["id"])} endSec`);
    }

    const pitchRaw = e["pitch"] as Record<string, unknown> | undefined;
    const pitch =
      pitchRaw && typeof pitchRaw["midi"] === "number"
        ? {
            hz: Number(pitchRaw["hz"]),
            midi: pitchRaw["midi"],
            name: String(pitchRaw["name"] ?? ""),
          }
        : undefined;

    return {
      id: String(e["id"] ?? ""),
      type: String(e["type"] ?? ""),
      startSec: requireNumber(e["startSec"], `event ${String(e["id"])} startSec`),
      ...(endSec !== undefined ? { endSec } : {}),
      endKind,
      detectorId: String(e["detectorId"] ?? ""),
      stemId,
      lane: laneForStem(stemId),
      ...(pitch ? { pitch } : {}),
    };
  });

  const eventsByLane = {
    drums: [] as ProjectedEvent[],
    other: [] as ProjectedEvent[],
    bass: [] as ProjectedEvent[],
    vocals: [] as ProjectedEvent[],
  };
  for (const event of events) {
    if (event.lane !== null) eventsByLane[event.lane].push(event);
  }

  return {
    version,
    audio,
    ...(tempoBpm !== undefined ? { tempoBpm } : {}),
    stems,
    beats,
    detectors,
    events,
    eventsByLane,
    counts: {
      beats: beats.length,
      downbeats: beats.reduce((n, b) => n + (b.isDownbeat ? 1 : 0), 0),
      events: events.length,
      byLane: {
        drums: eventsByLane.drums.length,
        other: eventsByLane.other.length,
        bass: eventsByLane.bass.length,
        vocals: eventsByLane.vocals.length,
      },
    },
  };
}
