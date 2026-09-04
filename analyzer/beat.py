"""Beat and downbeat tracking with Beat This!.

Runs on the FULL MIX, never on a stem: separation smears transients, and beat trackers
are trained on complete mixes. This is an independent branch of the pipeline, not a
consumer of the separation stage.

DBN post-processing stays off. Beyond the published finding that its tempo-continuity
prior hurts on expressive material, enabling it would pull in madmom, whose pretrained
models are non-commercially licensed while the rest of this stack is permissive.
"""

from __future__ import annotations

import time
from typing import NamedTuple

import numpy as np
import torch

PACKAGE = "beat-this"
VERSION = "1.1.0"
CHECKPOINT = "final0"
USE_DBN = False


class BeatResult(NamedTuple):
    beat_times: np.ndarray
    downbeat_times: np.ndarray
    beat_logits: np.ndarray
    downbeat_logits: np.ndarray
    frame_hop_sec: float
    seconds: float
    max_cuda_allocated: int
    max_cuda_reserved: int


def track(audio_path, duration_sec, device="cuda") -> BeatResult:
    """Return beat and downbeat times plus the raw framewise logits behind them."""
    from beat_this.inference import Audio2Frames, File2Beats
    from beat_this.preprocessing import load_audio

    file2beats = File2Beats(checkpoint_path=CHECKPOINT, device=device, dbn=USE_DBN)

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    started = time.perf_counter()
    beats, downbeats = file2beats(str(audio_path))
    torch.cuda.synchronize()
    seconds = time.perf_counter() - started

    # The framewise logits are the only honest confidence material this stage has, so
    # they are extracted even though the timestamps alone would satisfy the schema.
    signal, sample_rate = load_audio(str(audio_path))
    audio2frames = Audio2Frames(checkpoint_path=CHECKPOINT, device=device, float16=False)
    beat_logits, downbeat_logits = audio2frames(signal, sample_rate)
    beat_logits = beat_logits.detach().float().cpu().numpy()
    downbeat_logits = downbeat_logits.detach().float().cpu().numpy()

    result = BeatResult(
        beat_times=np.asarray(beats, dtype=float),
        downbeat_times=np.asarray(downbeats, dtype=float),
        beat_logits=beat_logits,
        downbeat_logits=downbeat_logits,
        frame_hop_sec=float(duration_sec) / beat_logits.size,
        seconds=seconds,
        max_cuda_allocated=torch.cuda.max_memory_allocated(),
        max_cuda_reserved=torch.cuda.max_memory_reserved(),
    )
    del file2beats, audio2frames, signal
    torch.cuda.empty_cache()
    return result


def representative_bpm(beat_times) -> float:
    """Tempo derived from beats, not the other way round.

    The beat list is the primary observation; tempo is a summary of it. Using the median
    inter-beat interval keeps a handful of spurious intro beats from dragging the figure,
    and no tempo map is produced because a real track's interval outliers are not
    reliably tempo changes.
    """
    beat_times = np.asarray(beat_times, dtype=float)
    if beat_times.size < 2:
        raise ValueError("need at least two beats to derive a tempo")
    intervals = np.diff(beat_times)
    median = float(np.median(intervals))
    if median <= 0:
        raise ValueError("median inter-beat interval is not positive")
    return 60.0 / median


def downbeat_flags(beat_times, downbeat_times, tolerance=1e-6):
    """Mark which beats are downbeats, matching on time rather than on index."""
    downbeats = np.asarray(downbeat_times, dtype=float)
    flags = []
    for time_sec in np.asarray(beat_times, dtype=float):
        if downbeats.size == 0:
            flags.append(False)
        else:
            flags.append(bool(np.min(np.abs(downbeats - time_sec)) <= tolerance))
    return flags
