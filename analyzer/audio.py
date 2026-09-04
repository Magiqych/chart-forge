"""Audio ingest: hashing, metadata and decoding.

The source audio is read-only. Nothing here writes to it or to its directory.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import NamedTuple

import numpy as np
import soundfile as sf

_HASH_BLOCK = 1 << 20


class AudioInfo(NamedTuple):
    """What the Analysis document needs to say about a piece of audio."""

    path: Path
    sha256: str
    duration_sec: float
    sample_rate: int
    channels: int


def sha256_file(path) -> str:
    """Hash a file in blocks, so a 40 MB stem does not become a 40 MB allocation."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(_HASH_BLOCK), b""):
            digest.update(block)
    return digest.hexdigest()


def probe(path) -> AudioInfo:
    """Read an audio file's metadata and hash it. Never modifies the file."""
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError("audio file does not exist: {0}".format(path))
    info = sf.info(str(path))
    return AudioInfo(
        path=path,
        sha256=sha256_file(path),
        duration_sec=float(info.duration),
        sample_rate=int(info.samplerate),
        channels=int(info.channels),
    )


def downmix_to_mono(samples: np.ndarray) -> np.ndarray:
    """Average channels into one.

    torchcrepe and librosa's onset detector both assume a single channel, and passing
    stereo silently produces something meaningless. The downmix is therefore explicit
    everywhere rather than left to a library default.
    """
    if samples.ndim == 1:
        return samples
    if samples.ndim != 2:
        raise ValueError("expected 1-D or 2-D samples, got shape {0}".format(samples.shape))
    return samples.mean(axis=1)


def read_mono(path):
    """Decode an audio file to a mono float32 array. Returns (samples, sample_rate)."""
    samples, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    return downmix_to_mono(samples), int(sample_rate)
