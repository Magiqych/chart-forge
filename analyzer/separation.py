"""Source separation with demucs-infer / htdemucs.

This module knows about Demucs and nothing else. It writes four stems into one flat
directory; the nested per-track hierarchy Demucs' own CLI produces is not part of our
output contract.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import NamedTuple

import torch

PACKAGE = "demucs-infer"
VERSION = "4.2.2"
MODEL = "htdemucs"
METHOD = "{0} {1} / {2}".format(PACKAGE, VERSION, MODEL)

#: Order is Demucs' own source order; we key by name rather than relying on it.
STEM_NAMES = ("drums", "bass", "other", "vocals")


class SeparationResult(NamedTuple):
    stem_paths: dict          # name -> Path
    sample_rate: int
    seconds: float
    max_cuda_allocated: int
    max_cuda_reserved: int


def separate(audio_path, stems_dir, device="cuda") -> SeparationResult:
    """Separate `audio_path` into four stems written directly into `stems_dir`."""
    from demucs_infer.api import AudioFile
    from demucs_infer.apply import apply_model
    from demucs_infer.audio import save_audio
    from demucs_infer.pretrained import get_model

    stems_dir = Path(stems_dir)
    stems_dir.mkdir(parents=True, exist_ok=True)

    model = get_model(MODEL)
    model.eval()
    model.to(torch.device(device))

    wav = AudioFile(audio_path).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    reference = wav.mean(0)
    normalised = (wav - reference.mean()) / reference.std()

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    started = time.perf_counter()
    sources = apply_model(
        model, normalised[None], device=torch.device(device),
        shifts=1, split=True, overlap=0.25, progress=False,
    )[0]
    torch.cuda.synchronize()
    seconds = time.perf_counter() - started

    sources = sources * reference.std() + reference.mean()

    stem_paths = {}
    for name, source in zip(model.sources, sources):
        target = stems_dir / "{0}.wav".format(name)
        save_audio(source.cpu(), target, samplerate=model.samplerate)
        stem_paths[name] = target

    missing = set(STEM_NAMES) - set(stem_paths)
    if missing:
        raise RuntimeError(
            "{0} did not produce the expected stems; missing {1}".format(MODEL, sorted(missing))
        )

    result = SeparationResult(
        stem_paths=stem_paths,
        sample_rate=int(model.samplerate),
        seconds=seconds,
        max_cuda_allocated=torch.cuda.max_memory_allocated(),
        max_cuda_reserved=torch.cuda.max_memory_reserved(),
    )
    del sources, normalised, wav, model
    torch.cuda.empty_cache()
    return result
