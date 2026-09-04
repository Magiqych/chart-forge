"""Command line entry point: orchestration, progress and reporting.

    python -m analyzer <audio-file> --output-dir <directory>

The pipeline is CUDA-only by design. A silent fall back to CPU would turn a fifty second
run into something far longer without saying so, so an unavailable GPU is a hard error
rather than a slower path.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from . import __version__, audio, beat, document, onset, pitch, separation

DEVICE = "cuda:0"
STAGES = 7

#: Which stem feeds which branch, and what the resulting events are called.
ONSET_BRANCHES = (("drums", "percussion"), ("other", "onset"))
PITCH_BRANCHES = (("bass", "bass"), ("vocals", "vocal"))

TARGET_FILES = ("analysis.json", "stems/drums.wav", "stems/bass.wav",
                "stems/other.wav", "stems/vocals.wav")

#: With pinned stems the run writes only the document; the stems stay where they are.
TARGET_FILES_SUPPLIED = ("analysis.json",)


class StageTimer:
    """Prints stage progress and keeps the wall-clock the final report needs."""

    def __init__(self, audio_duration):
        self.audio_duration = audio_duration
        self.seconds = {}
        self._index = 0
        self._started = time.perf_counter()

    def stage(self, key, label):
        """Announce a stage; on exit record its wall-clock under `key`."""
        self._index += 1
        print("[{0}/{1}] {2}".format(self._index, STAGES, label), flush=True)
        return _StageContext(self, key)

    def record(self, key, seconds):
        self.seconds[key] = seconds
        print("        {0:.3f} s   (RTF {1:.5f})".format(
            seconds, seconds / self.audio_duration), flush=True)

    @property
    def total(self):
        return time.perf_counter() - self._started


class _StageContext:
    def __init__(self, timer, key):
        self.timer, self.key = timer, key

    def __enter__(self):
        self._started = time.perf_counter()
        return self

    def __exit__(self, *exc):
        self.timer.record(self.key, time.perf_counter() - self._started)
        return False


def check_output_targets(output_dir: Path, supplied_stems=False):
    """Refuse to start if anything we would write already exists.

    With pinned stems only the document is written, so only the document is checked -
    the guard covers what this run would actually touch, nothing wider.
    """
    targets = TARGET_FILES_SUPPLIED if supplied_stems else TARGET_FILES
    existing = [name for name in targets if (output_dir / name).exists()]
    if existing:
        raise FileExistsError(
            "output directory already contains files this run would write: {0}\n"
            "Refusing to overwrite them. Use a new --output-dir.".format(
                ", ".join(sorted(existing))
            )
        )


def stem_reference_path(stem_path: Path, output_dir: Path) -> str:
    """How a stem is addressed from analysis.json.

    The schema wants a path relative to the document, which works whenever the stems sit
    on the same drive. Pinned stems on another drive have no relative form, so an
    absolute path is used rather than an invented one.
    """
    try:
        return Path(os.path.relpath(stem_path, output_dir)).as_posix()
    except ValueError:
        return str(stem_path)


def require_cuda():
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA is not available. The Analyzer is a CUDA pipeline and will not fall "
            "back to CPU silently; fix the GPU environment and try again."
        )
    return torch.cuda.get_device_name(0)


def run(audio_path, output_dir, supplied_stems_dir=None) -> int:
    output_dir = Path(output_dir).expanduser().resolve()
    stems_dir = output_dir / "stems"
    analysis_path = output_dir / "analysis.json"
    use_supplied = supplied_stems_dir is not None

    output_dir.mkdir(parents=True, exist_ok=True)
    check_output_targets(output_dir, supplied_stems=use_supplied)

    device_name = require_cuda()
    print("chart-forge-analyzer {0}   device: {1}".format(__version__, device_name))
    print("input:  {0}".format(audio_path))
    print("output: {0}".format(output_dir))
    if use_supplied:
        print("stems:  {0}   (pinned, read only - separation skipped)".format(
            supplied_stems_dir))
    print()

    # -- 1. ingest ---------------------------------------------------------------
    started = time.perf_counter()
    info = audio.probe(audio_path)
    ingest_seconds = time.perf_counter() - started
    timer = StageTimer(info.duration_sec)
    print("[1/{0}] ingest".format(STAGES), flush=True)
    print("        {0:.3f} s   {1:.3f} s audio, {2} Hz, {3} ch".format(
        ingest_seconds, info.duration_sec, info.sample_rate, info.channels), flush=True)
    timer.seconds["ingest"] = ingest_seconds
    timer._index = 1

    stems_written = False
    try:
        # -- 2. stems: separate, or adopt the pinned ones ------------------------
        if use_supplied:
            with timer.stage("stems", "stems (pinned - skipping htdemucs)"):
                sep = separation.load_supplied(supplied_stems_dir, info.duration_sec)
        else:
            with timer.stage("separate", "separate (htdemucs)"):
                sep = separation.separate(info.path, stems_dir, device="cuda")
            stems_written = True

        # The hash is computed from the bytes actually read this run, whichever mode
        # produced them: it is the identity of what the detectors saw.
        stems = [
            {
                "id": "stem-{0}".format(name),
                "kind": name,
                "path": stem_reference_path(sep.stem_paths[name], output_dir),
                "sha256": audio.sha256_file(sep.stem_paths[name]),
                "method": separation.SUPPLIED_METHOD if use_supplied else separation.METHOD,
            }
            for name in separation.STEM_NAMES
        ]

        # -- 3. beat / downbeat --------------------------------------------------
        with timer.stage("beat", "beat/downbeat (Beat This!)"):
            beat_result = beat.track(info.path, info.duration_sec, device="cuda")

        tempo_bpm = beat.representative_bpm(beat_result.beat_times)
        flags = beat.downbeat_flags(beat_result.beat_times, beat_result.downbeat_times)

        # -- 4/5. pitch branches -------------------------------------------------
        pitch.preload_model(DEVICE)     # once, not per stem
        events = []
        pitch_results = {}
        for stem_name, instrument in PITCH_BRANCHES:
            with timer.stage("{0} pitch".format(stem_name),
                             "{0} pitch (torchcrepe)".format(stem_name)):
                samples, sample_rate = audio.read_mono(sep.stem_paths[stem_name])
                result = pitch.track(samples, sample_rate, device=DEVICE)
            pitch_results[stem_name] = result

            runs = pitch.segment_runs(result.periodicity)
            hop = result.frame_hop_sec
            for index, (first, last) in enumerate(runs, 1):
                events.append(document.make_pitch_run_event(
                    branch=stem_name, index=index,
                    start_sec=first * hop, end_sec=last * hop,
                    stem_id="stem-{0}".format(stem_name), instrument=instrument,
                    pitch_segment=result.pitch_hz[first:last + 1],
                    periodicity_segment=result.periodicity[first:last + 1],
                ))

        # -- 6/7. onset branches -------------------------------------------------
        onset_results = {}
        for stem_name, event_type in ONSET_BRANCHES:
            with timer.stage("{0} onset".format(stem_name),
                             "{0} onset (librosa)".format(stem_name)):
                samples, sample_rate = audio.read_mono(sep.stem_paths[stem_name])
                result = onset.detect(samples, sample_rate)
            onset_results[stem_name] = result

            for index, (time_sec, strength) in enumerate(
                    zip(result.onset_times, result.onset_strength), 1):
                events.append(document.make_onset_event(
                    branch=stem_name, index=index, event_type=event_type,
                    start_sec=time_sec, stem_id="stem-{0}".format(stem_name),
                    strength=strength,
                ))

        # -- emit ----------------------------------------------------------------
        print("[emit] analysis.json", flush=True)
        counts = {
            "percussion": len(onset_results["drums"].onset_times),
            "onset": len(onset_results["other"].onset_times),
            "pitch-run-bass": sum(1 for e in events if e["source"]["stemId"] == "stem-bass"),
            "pitch-run-vocals": sum(1 for e in events if e["source"]["stemId"] == "stem-vocals"),
        }
        doc = document.build_document(
            analyzer_version=__version__,
            audio_info=info,
            stems=stems,
            detectors=document.build_detectors(pitch, onset, beat),
            beat_times=beat_result.beat_times,
            downbeat_flags=flags,
            tempo_bpm=tempo_bpm,
            events=events,
            experimental=document.build_experimental(
                beat_result=beat_result,
                pitch_results=pitch_results,
                onset_results=onset_results,
                event_counts=counts,
                stage_seconds=timer.seconds,
            ),
            separation_provenance=document.build_separation_provenance(sep, separation),
        )
        document.write_atomic(doc, analysis_path)
    except Exception:
        print(file=sys.stderr)
        if stems_written:
            print("Stems completed before the failure are retained at: {0}".format(stems_dir),
                  file=sys.stderr)
        print("No analysis.json was written; any partial temporary file was removed.",
              file=sys.stderr)
        print("The source audio and the repository are unchanged.", file=sys.stderr)
        raise

    _report(doc, info, timer, sep, beat_result, pitch_results, analysis_path)
    return 0


def _report(doc, info, timer, sep, beat_result, pitch_results, analysis_path):
    total = timer.total
    print()
    print("wrote {0}   ({1:,} bytes)".format(analysis_path, analysis_path.stat().st_size))
    print()
    print("audio duration     {0:9.3f} s".format(info.duration_sec))
    print("total wall-clock   {0:9.3f} s".format(total))
    print("total RTF          {0:9.5f}".format(total / info.duration_sec))
    print()
    print("{0:<20}{1:>10}  {2:>9}".format("stage", "seconds", "RTF"))
    for name in ("ingest", "separate", "stems", "beat", "bass pitch", "vocals pitch",
                 "drums onset", "other onset"):
        if name in timer.seconds:
            seconds = timer.seconds[name]
            print("{0:<20}{1:>10.3f}  {2:>9.5f}".format(
                name, seconds, seconds / info.duration_sec))
    if sep.mode == "supplied":
        print("  (separation skipped: stems pinned from {0})".format(sep.stems_dir))
    print()
    print("GPU peak memory (bytes)")
    if sep.mode == "generated":
        print("  separation   allocated {0:>13,}  reserved {1:>13,}".format(
            sep.max_cuda_allocated, sep.max_cuda_reserved))
    print("  beat         allocated {0:>13,}  reserved {1:>13,}".format(
        beat_result.max_cuda_allocated, beat_result.max_cuda_reserved))
    for stem, result in pitch_results.items():
        print("  pitch {0:<7}allocated {1:>13,}  reserved {2:>13,}".format(
            stem, result.max_cuda_allocated, result.max_cuda_reserved))
    print()
    counts = doc["metadata"]["experimental"]["eventCounts"]
    print("beats {0}  (downbeats {1})   tempo {2} BPM".format(
        len(doc["beats"]), sum(1 for b in doc["beats"] if b["isDownbeat"]),
        doc["tempo"]["bpm"]))
    print("events {0}   percussion {1}  onset {2}  bass pitch-run {3}  "
          "vocal pitch-run {4}".format(
              len(doc["events"]), counts["percussion"], counts["onset"],
              counts["pitch-run-bass"], counts["pitch-run-vocals"]))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m analyzer",
        description="Analyse an audio file into a Chart Forge Analysis document.",
        epilog="Writes <output-dir>/analysis.json, plus <output-dir>/stems/*.wav unless "
               "--stems-dir supplies them. Refuses to overwrite anything it would write, "
               "so use a fresh --output-dir to re-run. Requires CUDA.",
    )
    parser.add_argument("audio", help="path to the audio file to analyse (read only)")
    parser.add_argument("--output-dir", required=True,
                        help="directory to write analysis.json and stems/ into")
    parser.add_argument("--stems-dir", default=None, metavar="DIR",
                        help="reuse existing htdemucs stems from DIR instead of running "
                             "separation. DIR must contain drums.wav, bass.wav, "
                             "other.wav and vocals.wav, and is treated as read only. "
                             "The audio argument is still required and still feeds the "
                             "beat branch.")
    parser.add_argument("--version", action="version",
                        version="chart-forge-analyzer {0} (Analysis document {1})".format(
                            __version__, document.ANALYSIS_VERSION))
    args = parser.parse_args(argv)

    try:
        return run(args.audio, args.output_dir, args.stems_dir)
    except FileExistsError as error:
        print("error: {0}".format(error), file=sys.stderr)
        return 2
    except separation.StemValidationError as error:
        print("error: supplied stems cannot be used: {0}".format(error), file=sys.stderr)
        print("Not falling back to separation; fix --stems-dir or omit it.",
              file=sys.stderr)
        return 3
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print("error: {0}".format(error), file=sys.stderr)
        raise
