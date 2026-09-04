"""Monophonic pitch tracking with torchcrepe, and provisional voiced-run segmentation.

torchcrepe assumes a monophonic signal, so stems are downmixed explicitly before they
get here. The segmentation below is deliberately the simplest rule that produced usable
runs in the proof of concept - a periodicity threshold and a minimum length. It is
experimental, and one run is NOT necessarily one musical note.
"""

from __future__ import annotations

import time
from typing import List, NamedTuple, Sequence, Tuple

import numpy as np
import torch

PACKAGE = "torchcrepe"
VERSION = "0.0.24"
MODEL = "full"
DECODER = "viterbi"
FMIN = 50.0
FMAX = 1000.0
HOP_LENGTH = 441
BATCH_SIZE = 512

#: Provisional segmentation policy. Not calibrated, not a production policy.
PERIODICITY_THRESHOLD = 0.50
MINIMUM_RUN_FRAMES = 5


class PitchResult(NamedTuple):
    pitch_hz: np.ndarray
    periodicity: np.ndarray
    frame_hop_sec: float
    seconds: float
    max_cuda_allocated: int
    max_cuda_reserved: int


def preload_model(device="cuda:0"):
    """Bind the model once so several stems do not each pay the load and warm-up cost."""
    import torchcrepe

    torchcrepe.load.model(device, MODEL)


def track(samples, sample_rate, device="cuda:0") -> PitchResult:
    """Run torchcrepe over one mono signal, returning f0 and periodicity per frame."""
    import torchcrepe

    if np.ndim(samples) != 1:
        raise ValueError("torchcrepe needs a mono signal; downmix the stem first")

    tensor = torch.from_numpy(np.ascontiguousarray(samples, dtype=np.float32)).unsqueeze(0)

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    started = time.perf_counter()
    pitch, periodicity = torchcrepe.predict(
        tensor, sample_rate, hop_length=HOP_LENGTH, fmin=FMIN, fmax=FMAX,
        model=MODEL, return_periodicity=True, batch_size=BATCH_SIZE, device=device,
    )
    torch.cuda.synchronize()
    seconds = time.perf_counter() - started

    result = PitchResult(
        pitch_hz=pitch.detach().float().cpu().numpy().squeeze(),
        periodicity=periodicity.detach().float().cpu().numpy().squeeze(),
        frame_hop_sec=HOP_LENGTH / float(sample_rate),
        seconds=seconds,
        max_cuda_allocated=torch.cuda.max_memory_allocated(),
        max_cuda_reserved=torch.cuda.max_memory_reserved(),
    )
    del pitch, periodicity, tensor
    torch.cuda.empty_cache()
    return result


def segment_runs(
    periodicity: Sequence[float],
    threshold: float = PERIODICITY_THRESHOLD,
    minimum_frames: int = MINIMUM_RUN_FRAMES,
) -> List[Tuple[int, int]]:
    """Contiguous frames whose periodicity reaches `threshold`, as inclusive index pairs.

    Runs shorter than `minimum_frames` are dropped: below that length the segment is more
    likely to be a transition artefact than an event worth showing an author. Pure
    function over an array so it can be tested without touching a model.
    """
    values = np.asarray(periodicity, dtype=float)
    if values.ndim != 1:
        raise ValueError("periodicity must be one-dimensional")

    runs: List[Tuple[int, int]] = []
    start = None
    for index, voiced in enumerate(values >= threshold):
        if voiced and start is None:
            start = index
        elif not voiced and start is not None:
            runs.append((start, index - 1))
            start = None
    if start is not None:
        runs.append((start, values.size - 1))

    return [run for run in runs if (run[1] - run[0] + 1) >= minimum_frames]
