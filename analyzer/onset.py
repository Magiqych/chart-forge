"""Onset detection with librosa.

librosa's own beat tracker and tempo estimator are deliberately unused - beat and
downbeat are Beat This!'s responsibility. This module produces onsets and the
spectral-flux envelope behind them, nothing else.

The peak-picking parameters are librosa's defaults, which the project chose not to tune:
they were fitted by the library's authors on real material, and tuning them against one
synthetic signal would have been overfitting.
"""

from __future__ import annotations

import time
from typing import NamedTuple

import numpy as np

PACKAGE = "librosa"
VERSION = "0.11.0"
HOP_LENGTH = 256
BACKTRACK = False


class OnsetResult(NamedTuple):
    onset_times: np.ndarray
    onset_strength: np.ndarray     # the envelope value at each detected onset
    envelope: np.ndarray           # the full framewise envelope
    frame_hop_sec: float
    seconds: float


def detect(samples, sample_rate) -> OnsetResult:
    """Return detected onsets plus the envelope they were picked from."""
    import librosa

    if np.ndim(samples) != 1:
        raise ValueError("onset detection needs a mono signal; downmix the stem first")

    started = time.perf_counter()
    envelope = librosa.onset.onset_strength(
        y=np.ascontiguousarray(samples, dtype=np.float32),
        sr=sample_rate, hop_length=HOP_LENGTH, center=True,
    )
    onsets = librosa.onset.onset_detect(
        onset_envelope=envelope, sr=sample_rate, hop_length=HOP_LENGTH,
        units="time", backtrack=BACKTRACK,
    )
    seconds = time.perf_counter() - started

    frame_hop_sec = HOP_LENGTH / float(sample_rate)
    return OnsetResult(
        onset_times=np.asarray(onsets, dtype=float),
        onset_strength=peak_strengths(envelope, onsets, frame_hop_sec),
        envelope=envelope,
        frame_hop_sec=frame_hop_sec,
        seconds=seconds,
    )


def peak_strengths(envelope, onset_times, frame_hop_sec, half_window=2) -> np.ndarray:
    """Envelope height at each onset, taken as the local maximum around its frame.

    The detected time is quantised to the frame grid, so reading a single frame can miss
    the peak by one; a small window is more representative of the transient's height.
    Pure function so it is testable without running a detector.
    """
    envelope = np.asarray(envelope, dtype=float)
    times = np.asarray(onset_times, dtype=float)
    if times.size == 0:
        return np.zeros(0, dtype=float)
    indices = np.clip(np.round(times / frame_hop_sec).astype(int), 0, envelope.size - 1)
    return np.array([
        envelope[max(0, i - half_window):min(envelope.size, i + half_window + 1)].max()
        for i in indices
    ], dtype=float)
