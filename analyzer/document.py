"""Assembly of the Analysis document: stable ids, ordering, and the JSON write.

Everything here is a pure transformation of already-computed detector output, so the
whole module is testable without a GPU or a model.

Two rules from the contract are enforced here rather than left to callers:

* every event's `endKind` follows from its type, and an `endSec` may only exist when the
  kind is `bounded`;
* `events[]` is ordered by (startSec, id) - a total order, whose tie-break carries no
  musical meaning and exists only so the document is reproducible.

`confidence` is deliberately never emitted. Beat This! logits, torchcrepe periodicity and
librosa onset strength are three uncalibrated and mutually incomparable scales; writing
any of them into one `confidence` field would make a filter like `confidence > 0.5` mean
something different for every event type. Absent means unknown, which is honest.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List

ANALYSIS_VERSION = "0.2.0"
GENERATOR_NAME = "chart-forge-analyzer"

DETECTOR_BEAT = "det-beat-this"
DETECTOR_PITCH = "det-torchcrepe"
DETECTOR_ONSET = "det-librosa-onset"

#: An event's end semantics follow from what kind of thing it is.
END_KIND_BY_TYPE = {
    "percussion": "instantaneous",   # a drum hit has a decay, not an end
    "onset": "instantaneous",        # a generic onset is a moment, not a span
    "pitch-run": "bounded",          # a voiced run has a determined start and end
}

EXPERIMENTAL_DISCLAIMER = (
    "This data is retained for calibration and schema evaluation. It is not part of the "
    "stable Analysis contract and consumers must not depend on it."
)

_ROUND_TIME = 6
_ROUND_SCORE = 4
_ROUND_HZ = 3


def event_id(branch: str, index: int) -> str:
    """Deterministic id: branch plus a 1-based position in that branch's time order."""
    if index < 1:
        raise ValueError("event index is 1-based, got {0}".format(index))
    return "ev-{0}-{1:06d}".format(branch, index)


def sort_events(events: Iterable[dict]) -> List[dict]:
    """Order by (startSec, id), the total order the Analysis contract requires."""
    return sorted(events, key=lambda event: (event["startSec"], event["id"]))


def _round(value, digits):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("refusing to emit a non-finite number: {0!r}".format(value))
    return round(number, digits)


def _round_all(values, digits):
    return [_round(value, digits) for value in values]


def hz_to_midi(hz: float) -> float:
    """Fractional MIDI, the standard conversion: 69 + 12 * log2(hz / 440)."""
    if hz <= 0:
        raise ValueError("frequency must be positive, got {0!r}".format(hz))
    return 69.0 + 12.0 * math.log2(float(hz) / 440.0)


def hz_to_note_name(hz: float) -> str:
    """Nearest-semitone name, using librosa's convention so the two agree."""
    import librosa

    return str(librosa.hz_to_note(float(hz)))


def make_onset_event(branch, index, event_type, start_sec, stem_id, strength) -> dict:
    """A point-like event: percussion from the drums stem, or a generic onset."""
    kind = END_KIND_BY_TYPE[event_type]
    if kind != "instantaneous":
        raise ValueError("{0!r} is not a point-like event type".format(event_type))
    return {
        "id": event_id(branch, index),
        "type": event_type,
        "detectorId": DETECTOR_ONSET,
        "endKind": kind,
        "startSec": _round(start_sec, _ROUND_TIME),
        "source": {"stemId": stem_id},
        "metadata": {
            "rawScore": {"kind": "onset-strength", "value": _round(strength, _ROUND_SCORE)},
        },
    }


def make_pitch_run_event(branch, index, start_sec, end_sec, stem_id, instrument,
                         pitch_segment, periodicity_segment) -> dict:
    """A bounded event covering one provisional voiced run."""
    import numpy as np

    pitch_segment = np.asarray(pitch_segment, dtype=float)
    periodicity_segment = np.asarray(periodicity_segment, dtype=float)
    if pitch_segment.size == 0:
        raise ValueError("a pitch run must cover at least one frame")

    start = _round(start_sec, _ROUND_TIME)
    end = _round(end_sec, _ROUND_TIME)
    if end < start:
        raise ValueError("pitch run ends before it starts")

    median_hz = float(np.median(pitch_segment))
    lowest = float(pitch_segment.min())
    highest = float(pitch_segment.max())

    return {
        "id": event_id(branch, index),
        "type": "pitch-run",
        "detectorId": DETECTOR_PITCH,
        "endKind": END_KIND_BY_TYPE["pitch-run"],
        "startSec": start,
        "endSec": end,
        "durationSec": _round(end - start, _ROUND_TIME),
        "source": {"stemId": stem_id, "instrument": instrument},
        "pitch": {
            "hz": _round(median_hz, _ROUND_SCORE),
            "midi": _round(hz_to_midi(median_hz), _ROUND_SCORE),
            "name": hz_to_note_name(median_hz),
        },
        "metadata": {
            "rawScore": {
                "kind": "periodicity-median",
                "value": _round(np.median(periodicity_segment), _ROUND_SCORE),
            },
            "segmentation": {
                "method": "periodicity-run",
                "threshold": 0.5,
                "minimumFrames": 5,
                "experimental": True,
            },
            "frameCount": int(pitch_segment.size),
            "pitchSummary": {
                "minHz": _round(lowest, _ROUND_HZ),
                "medianHz": _round(median_hz, _ROUND_HZ),
                "maxHz": _round(highest, _ROUND_HZ),
                "spreadCents": _round(1200.0 * math.log2(highest / lowest), 2)
                if lowest > 0 else 0.0,
            },
        },
    }


def build_detectors(pitch_module, onset_module, beat_module) -> List[dict]:
    """The registry every beat and event refers to, instead of repeating itself."""
    return [
        {
            "id": DETECTOR_BEAT,
            "name": beat_module.PACKAGE,
            "version": beat_module.VERSION,
            "parameters": {
                "checkpoint": beat_module.CHECKPOINT,
                "dbn": beat_module.USE_DBN,
                "device": "cuda:0",
                "input": "full mix",
            },
        },
        {
            "id": DETECTOR_PITCH,
            "name": pitch_module.PACKAGE,
            "version": pitch_module.VERSION,
            "parameters": {
                "model": pitch_module.MODEL,
                "decoder": pitch_module.DECODER,
                "fmin": pitch_module.FMIN,
                "fmax": pitch_module.FMAX,
                "hopLength": pitch_module.HOP_LENGTH,
                "batchSize": pitch_module.BATCH_SIZE,
                "device": "cuda:0",
                "stemDownmix": "mean of channels",
                "segmentation": {
                    "method": "periodicity-run",
                    "threshold": pitch_module.PERIODICITY_THRESHOLD,
                    "minimumFrames": pitch_module.MINIMUM_RUN_FRAMES,
                    "experimental": True,
                    "caveat": "one pitch-run is NOT necessarily one musical note",
                },
            },
        },
        {
            "id": DETECTOR_ONSET,
            "name": "librosa.onset",
            "version": onset_module.VERSION,
            "parameters": {
                "hopLength": onset_module.HOP_LENGTH,
                "backtrack": onset_module.BACKTRACK,
                "peakPicking": "librosa {0} defaults".format(onset_module.VERSION),
                "stemDownmix": "mean of channels",
            },
        },
    ]


def build_separation_provenance(separation_result, separation_module) -> dict:
    """Machine-readable record of where this run's stems came from.

    `stems[].method` says the same thing in prose, and `stems[].sha256` identifies the
    exact bytes; this is the structured form a consumer can branch on. It lives in
    `generator.parameters`, which the schema declares free-form, so recording it needs no
    contract change - and `stems[]` itself forbids additional properties, so this is the
    correct home rather than a convenient one.
    """
    if separation_result.mode == "supplied":
        return {
            "mode": "supplied",
            "stemsDir": str(separation_result.stems_dir),
            "separationRun": False,
            "note": "stems were pinned and reused; htdemucs did not run, and the "
                    "Analyzer cannot verify which tool produced them",
        }
    return {
        "mode": "generated",
        "separationRun": True,
        "package": separation_module.PACKAGE,
        "version": separation_module.VERSION,
        "model": separation_module.MODEL,
        "device": "cuda:0",
        "note": "htdemucs is not bit-reproducible on the same GPU with the same input; "
                "pin the stems to remove that variable",
    }


def build_document(*, analyzer_version, audio_info, stems, detectors, beat_times,
                   downbeat_flags, tempo_bpm, events, experimental,
                   separation_provenance) -> dict:
    """Assemble a complete Analysis 0.2 document."""
    return {
        "version": ANALYSIS_VERSION,
        "generator": {
            "name": GENERATOR_NAME,
            "version": analyzer_version,
            "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "parameters": {
                "separation": separation_provenance,
                "confidencePolicy": {
                    "emitted": False,
                    "reason": "Beat This! logits, torchcrepe periodicity and librosa "
                              "onset strength are incommensurate uncalibrated scales; "
                              "absent means unknown per the schema",
                },
                "eventOrdering": {
                    "policy": "ascending startSec, then id lexicographically ascending",
                    "note": "the tie-break carries no musical priority",
                },
                "idPolicy": "ev-<branch>-<6-digit 1-based index in ascending time "
                            "within that branch>; deterministic, no UUIDs",
                "notGenerated": [
                    "tempo.map", "beats[].barIndex", "beats[].beatInBar", "sections",
                ],
                "notGeneratedReason": "meter phase was unreliable in real material and "
                                      "interval outliers are not reliably tempo changes",
            },
        },
        "audio": {
            "path": str(audio_info.path),
            "sha256": audio_info.sha256,
            "durationSec": _round(audio_info.duration_sec, _ROUND_TIME),
            "sampleRate": audio_info.sample_rate,
            "channels": audio_info.channels,
        },
        "detectors": detectors,
        "tempo": {"bpm": _round(tempo_bpm, _ROUND_SCORE)},
        "beats": [
            {
                "timeSec": _round(time_sec, _ROUND_TIME),
                "detectorId": DETECTOR_BEAT,
                "isDownbeat": bool(is_downbeat),
            }
            for time_sec, is_downbeat in zip(beat_times, downbeat_flags)
        ],
        "stems": stems,
        "events": sort_events(events),
        "metadata": {"experimental": experimental},
    }


def build_experimental(*, beat_result, pitch_results, onset_results, event_counts,
                       stage_seconds) -> dict:
    """Raw framewise curves and run bookkeeping.

    These live under metadata.experimental because the contract has no home for
    frame-level data yet (gap G7). They are kept rather than dropped because the
    calibration question the project has not answered cannot be answered without them.
    """
    return {
        "disclaimer": EXPERIMENTAL_DISCLAIMER,
        "rounding": {
            "logits": _ROUND_SCORE, "periodicity": _ROUND_SCORE,
            "onsetStrength": _ROUND_SCORE, "pitchHz": _ROUND_HZ, "times": _ROUND_TIME,
            "note": "frame arrays are rounded for size; no frames are removed",
        },
        "beatThis": {
            "frameHopSec": _round(beat_result.frame_hop_sec, 8),
            "framesPerSecond": _round(1.0 / beat_result.frame_hop_sec, 4),
            "detectedBeats": _detected_beats(beat_result),
            "beatLogits": _round_all(beat_result.beat_logits, _ROUND_SCORE),
            "downbeatLogits": _round_all(beat_result.downbeat_logits, _ROUND_SCORE),
        },
        "torchcrepe": {
            stem: {
                "frameHopSec": _round(result.frame_hop_sec, 8),
                "pitchHz": _round_all(result.pitch_hz, _ROUND_HZ),
                "periodicity": _round_all(result.periodicity, _ROUND_SCORE),
            }
            for stem, result in pitch_results.items()
        },
        "librosa": {
            stem: {
                "frameHopSec": _round(result.frame_hop_sec, 8),
                "onsetStrength": _round_all(result.envelope, _ROUND_SCORE),
            }
            for stem, result in onset_results.items()
        },
        "tempoDerivation": {
            "method": "60 / median inter-beat interval",
            "note": "tempo.map omitted; interval outliers are not treated as tempo change",
        },
        "eventCounts": event_counts,
        "stageSeconds": {name: _round(value, 3) for name, value in stage_seconds.items()},
    }


def _detected_beats(beat_result):
    import numpy as np

    logits = beat_result.beat_logits
    indices = np.clip(
        np.round(beat_result.beat_times / beat_result.frame_hop_sec).astype(int),
        0, logits.size - 1,
    )
    return [
        {
            "timeSec": _round(time_sec, _ROUND_TIME),
            "beatLogit": _round(beat_result.beat_logits[index], _ROUND_SCORE),
            "downbeatLogit": _round(beat_result.downbeat_logits[index], _ROUND_SCORE),
        }
        for time_sec, index in zip(beat_result.beat_times, indices)
    ]


def write_atomic(document: dict, target) -> Path:
    """Serialise fully, then move into place, so no half-written document survives.

    Refuses to replace an existing file: the caller checks up front, and this is the
    second line of defence against destroying someone's previous run.
    """
    target = Path(target)
    if target.exists():
        raise FileExistsError("refusing to overwrite existing file: {0}".format(target))
    target.parent.mkdir(parents=True, exist_ok=True)

    handle, temporary = tempfile.mkstemp(
        dir=str(target.parent), prefix=".{0}.".format(target.name), suffix=".tmp"
    )
    os.close(handle)
    temporary = Path(temporary)
    try:
        with open(temporary, "w", encoding="utf-8") as stream:
            json.dump(document, stream, indent=2, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if target.exists():
            raise FileExistsError("refusing to overwrite existing file: {0}".format(target))
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return target
