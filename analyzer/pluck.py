"""Onset detection for plucked and struck strings: guitar, and piano.

`onset.py` runs librosa's detector with librosa's own defaults, deliberately untuned. That
is right for the drums stem, where the defaults were fitted on exactly that kind of
material, and for the catch-all `other` stem, where there is nothing specific to tune
*for*. It is not right here, and this module exists because of what a guitar actually does.

## Why the default picker is not enough

A guitar is not one instrument to a transient detector. In one song it plays:

    single-note picking      a clean, isolated transient
    chord strumming          six transients smeared over 20-40 ms, which is ONE event
    muted cutting            very quiet transients, very close together, all of them real
    arpeggios                clean transients at speed
    distorted power chords   a compressed envelope where the attack barely rises
    long sustains            no transient at all for seconds
    hammer-ons, pull-offs    a pitch change with almost no attack
    slides                   a pitch change with no attack whatsoever

Two failures follow, and they pull in opposite directions. A strummed chord arrives as a
cluster - 12.100, 12.107, 12.116, 12.125 - and reported as four events it is worse than
useless: the author has to pick one, and the Editor's magnet has four things to catch on a
few milliseconds apart. Meanwhile a fast muted cutting figure is genuinely four events in
the same span, and collapsing those would remove the very thing being charted.

Nothing distinguishes those two cases by spacing alone, so the picker below does not try
to be clever about it. It uses one spacing rule, chosen at the boundary of what a player
can physically produce, and lets everything above it through.

## What it does

A local maximum, above an adaptive local threshold, no closer than a fixed spacing to the
last one kept. Three plain ideas, each with a number that can be argued about:

    local peak     higher than every frame within PEAK_WINDOW_SEC either side, so a
                   slow swell does not register as an onset at every frame on the way up;
    threshold      far enough above the local background, where the background is a
                   *median* over a window of seconds - so a quiet passage keeps its
                   sensitivity and a loud one does not fire continuously;
    spacing        at least MIN_SPACING_SEC after the last one kept.

Everything is a pure function of an envelope and a hop, so the awkward cases - a strummed
cluster, a fast cutting figure, a silent stem, a single spike - are testable directly,
without audio and without a GPU.

## Confidence

Unlike the other branches, this one emits `confidence`, and it means one stated thing:

    confidence = (peak - local background) / peak

the fraction of the peak's height that stands above the local background. It is 0 for a
peak level with its surroundings and approaches 1 for a transient rising out of silence,
it is bounded, and it is comparable between two guitar events in the same document and
between documents. The Analyzer's standing policy of omitting `confidence` is about scores
that have no such definition - Beat This! logits, torchcrepe periodicity - and it is kept
for those. Absent still means unknown.
"""

from __future__ import annotations

import math
import time
from typing import NamedTuple

import numpy as np

PACKAGE = "librosa"
VERSION = "0.11.0"

#: Frames per second of the envelope: 44100 / 512 = 86 Hz, one frame every 11.6 ms.
#:
#: Twice the hop `onset.py` uses. A guitar transient is not as sharp as a drum's, the
#: spacing rule below is an order of magnitude coarser than the frame, and halving the
#: frame count halves the cost of a stage that now runs on two more stems.
HOP_LENGTH = 512

#: How close two events may be, in seconds.
#:
#: The number that decides both failure modes, so it is set from what a player can do
#: rather than from what looks tidy. Sixteenth notes at 200 BPM are 75 ms apart; thirty-
#: seconds at 150 BPM are 50 ms. Below about 40 ms a listener stops hearing two events and
#: starts hearing one thicker one, and a strummed chord - the thing that must collapse -
#: spans 20-40 ms. So 40 ms keeps every rhythm a guitarist can play and still collapses a
#: strum into the single event it is heard as.
MIN_SPACING_SEC = 0.04

#: Half-width of the window a peak must be the maximum of.
#:
#: Deliberately smaller than the spacing: this rejects the slope of a swell, while the
#: spacing rule does the work of thinning a cluster. Making it as wide as the spacing
#: would silently drop the second event of a fast pair whose first was louder.
PEAK_WINDOW_SEC = 0.02

#: Half-width of the window the local background is taken over.
#:
#: Long enough to average across a bar or so, so that the background is "how loud this
#: passage is" rather than "how loud this note is". A short window tracks the transients
#: themselves and the threshold chases what it is trying to measure.
BACKGROUND_WINDOW_SEC = 0.75

#: A floor under the background, as a fraction of the whole stem's mean envelope.
#:
#: Without it, silence has a background of zero, every trace of numerical noise clears the
#: ratio test, and a silent stem produces thousands of events. With it, a passage quieter
#: than a fortieth of the track's average cannot generate onsets at all.
SILENCE_FLOOR_RATIO = 0.025

#: How far below the full mix a stem may sit and still be worth reporting attacks for.
#:
#: Six-source separation always produces six files, whether or not the song contains all
#: six instruments. A song with no piano still gets a piano stem: what lands in it is bleed
#: from everything else, which has real transient structure and sails through every test
#: below - the first real run produced **2156 piano attacks for a song with no piano in
#: it**, which is worse than useless as a guide layer.
#:
#: What separates a bleed stem from a played one is how loud it is against the recording it
#: came from. Measured on that run:
#:
#:     vocals -6.0 dB   drums -8.1 dB   bass -7.3 dB
#:     guitar -10.2 dB  other -13.9 dB  piano -26.0 dB
#:
#: -20 dB is the round number between them, and it is not chosen only to fit: a stem 20 dB
#: down contributes about one percent of the mix's power, so nobody is charting to it -
#: they cannot hear it. The margin either side is about 6 dB.
#:
#: The stem is still separated and still playable in the mixer, so an author who wants to
#: listen to what little is there still can. Only the guide layer is withheld, and the run
#: says so rather than quietly reporting nothing.
PRESENCE_FLOOR_DB = -20.0

#: The dynamic range a stem must have before it is searched at all.
#:
#: Every other test here is a *ratio* against a local background, and ratios cannot tell
#: music from noise: uniform numerical noise has peaks about twice its own median, which
#: clears a threshold ratio and a confidence floor just as a real transient does. A silent
#: guitar stem - a song with no guitar in it, which is common - produced seven hundred
#: events this way, all of them at the tenth decimal place of nothing.
#:
#: What separates the two is dynamic range over the whole stem. Noise is flat; a stem with
#: playing in it has peaks many times its median. Below this ratio there is nothing to
#: detect, whatever the local arithmetic says, so the search does not run.
MIN_DYNAMIC_RANGE = 4.0

#: How far above its local background a peak must stand to count at all.
#:
#: Expressed as a confidence, which is the same test as a threshold ratio and not a second
#: one. Requiring a peak to be `r` times louder than its background is exactly requiring a
#: confidence above `r / (1 + r)`, because confidence *is* `(peak - background) / peak` -
#: the module carried both for a while and they were one rule written twice.
#:
#: 0.23 is "a third louder than the passage around it". Low, on purpose: its job is to
#: remove peaks that barely register, not to curate. An author can see a weak marker and
#: ignore it, but cannot see one that was never emitted - and the Editor draws a marker
#: at a height that follows this number, so a weak event looks weak rather than shouting.
MIN_CONFIDENCE = 0.23


class PluckOnset(NamedTuple):
    """One detected attack."""

    time_sec: float
    #: Envelope height at the peak. Uncalibrated, like every other onset strength here.
    strength: float
    #: 0..1, as defined in the module docstring. Calibrated and comparable.
    confidence: float


class PluckResult(NamedTuple):
    onsets: tuple           # of PluckOnset
    envelope: np.ndarray
    frame_hop_sec: float
    seconds: float

    @property
    def times(self) -> np.ndarray:
        return np.array([o.time_sec for o in self.onsets], dtype=float)


def rms(samples) -> float:
    """Root mean square of a signal. Zero for an empty one rather than a NaN."""
    values = np.asarray(samples, dtype=float)
    if values.size == 0:
        return 0.0
    values = np.where(np.isfinite(values), values, 0.0)
    return float(np.sqrt(np.mean(np.square(values))))


def relative_level_db(stem_rms: float, mix_rms: float) -> float:
    """How far below the mix a stem sits, in dB. `-inf` for a silent stem."""
    if not np.isfinite(stem_rms) or stem_rms <= 0:
        return float("-inf")
    if not np.isfinite(mix_rms) or mix_rms <= 0:
        return float("-inf")
    return float(20.0 * np.log10(stem_rms / mix_rms))


def is_present(stem_rms: float, mix_rms: float,
               floor_db: float = PRESENCE_FLOOR_DB) -> bool:
    """Whether this stem holds a played instrument rather than bleed.

    Separated on its own so the one judgement that decides whether a whole guide layer
    exists can be read, argued with and tested without any audio.
    """
    return relative_level_db(stem_rms, mix_rms) >= floor_db


def detect(samples, sample_rate) -> PluckResult:
    """Find the attacks in a mono stem."""
    import librosa

    if np.ndim(samples) != 1:
        raise ValueError("onset detection needs a mono signal; downmix the stem first")

    started = time.perf_counter()
    envelope = librosa.onset.onset_strength(
        y=np.ascontiguousarray(samples, dtype=np.float32),
        sr=sample_rate, hop_length=HOP_LENGTH, center=True,
    )
    frame_hop_sec = HOP_LENGTH / float(sample_rate)
    onsets = pick_onsets(envelope, frame_hop_sec)
    seconds = time.perf_counter() - started

    return PluckResult(
        onsets=onsets,
        envelope=np.asarray(envelope, dtype=float),
        frame_hop_sec=frame_hop_sec,
        seconds=seconds,
    )


def rolling_median(values: np.ndarray, half_window: int) -> np.ndarray:
    """Median over a centred window, edges included rather than padded.

    A median and not a mean: the envelope is mostly background with occasional spikes, and
    a mean is pulled up by the very spikes the background is supposed to be measured
    against. Written out rather than taken from scipy so the Analyzer keeps its dependency
    list; the arrays are a few thousand frames, and this is not the expensive stage.
    """
    values = np.asarray(values, dtype=float)
    if values.size == 0:
        return values
    half_window = max(0, int(half_window))
    if half_window == 0:
        return values.copy()

    out = np.empty(values.size, dtype=float)
    for i in range(values.size):
        low = max(0, i - half_window)
        high = min(values.size, i + half_window + 1)
        out[i] = np.median(values[low:high])
    return out


def is_local_peak(values: np.ndarray, index: int, half_window: int) -> bool:
    """Whether `index` is at least as high as every frame within `half_window`.

    `>=` rather than `>` so a flat-topped peak is not rejected outright; the spacing rule
    then keeps only the first frame of that plateau, which is the attack.
    """
    low = max(0, index - half_window)
    high = min(values.size, index + half_window + 1)
    return bool(values[index] >= values[low:high].max())


def confidence_of(peak: float, background: float) -> float:
    """The fraction of a peak that stands above its local background, 0..1.

    Defined here on its own so the one number this branch asks anyone to trust can be
    tested directly against the sentence that describes it.
    """
    if not np.isfinite(peak) or peak <= 0:
        return 0.0
    if not np.isfinite(background) or background < 0:
        background = 0.0
    if background >= peak:
        return 0.0
    return float((peak - background) / peak)


def pick_onsets(
    envelope,
    frame_hop_sec: float,
    *,
    min_spacing_sec: float = MIN_SPACING_SEC,
    peak_window_sec: float = PEAK_WINDOW_SEC,
    background_window_sec: float = BACKGROUND_WINDOW_SEC,
    silence_floor_ratio: float = SILENCE_FLOOR_RATIO,
    min_confidence: float = MIN_CONFIDENCE,
    min_dynamic_range: float = MIN_DYNAMIC_RANGE,
) -> tuple:
    """Pick attacks out of an onset-strength envelope.

    Pure, and the whole of the detector's judgement. Frames are visited in time order and
    a candidate is kept only if it is a local peak, clears the adaptive threshold, carries
    enough confidence, and is far enough from the last one kept - so the result is
    ascending, spaced, and identical for identical input.
    """
    envelope = np.asarray(envelope, dtype=float)
    if envelope.size == 0 or not np.isfinite(frame_hop_sec) or frame_hop_sec <= 0:
        return ()

    # A non-finite frame is a broken decode, not quiet music; treated as absent so one bad
    # frame cannot poison the background of a whole passage or emit a NaN timestamp.
    envelope = np.where(np.isfinite(envelope), envelope, 0.0)
    envelope = np.maximum(envelope, 0.0)

    peak_half = max(1, int(round(peak_window_sec / frame_hop_sec)))
    background_half = max(1, int(round(background_window_sec / frame_hop_sec)))
    # Rounded *up*, so the spacing actually enforced is never shorter than the one this
    # module documents. Rounding to nearest turned a stated 40 ms into 34.8 ms at the real
    # frame rate, which let a little more of a strum through than the constant claimed.
    spacing_frames = max(1, int(math.ceil(min_spacing_sec / frame_hop_sec - 1e-9)))

    # Nothing to find in a stem with no dynamic range. Checked before anything local,
    # because no local rule can distinguish flat noise from flat music.
    overall = float(np.median(envelope))
    if float(envelope.max()) <= overall * min_dynamic_range:
        return ()

    background = rolling_median(envelope, background_half)
    floor = float(envelope.mean()) * silence_floor_ratio
    background = np.maximum(background, floor)

    onsets = []
    last_kept = -(10 ** 9)
    for index in range(envelope.size):
        if index - last_kept < spacing_frames:
            continue
        peak = envelope[index]
        local = background[index]
        confidence = confidence_of(peak, local)
        if confidence < min_confidence:
            continue
        if not is_local_peak(envelope, index, peak_half):
            continue
        onsets.append(
            PluckOnset(
                time_sec=index * frame_hop_sec,
                strength=float(peak),
                confidence=confidence,
            )
        )
        last_kept = index

    return tuple(onsets)


def parameters() -> dict:
    """What the detector registry records, so a document says how it was tuned."""
    return {
        "hopLength": HOP_LENGTH,
        "minSpacingSec": MIN_SPACING_SEC,
        "peakWindowSec": PEAK_WINDOW_SEC,
        "backgroundWindowSec": BACKGROUND_WINDOW_SEC,
        "silenceFloorRatio": SILENCE_FLOOR_RATIO,
        "minConfidence": MIN_CONFIDENCE,
        "minDynamicRange": MIN_DYNAMIC_RANGE,
        "presenceFloorDb": PRESENCE_FLOOR_DB,
        "presence": "a stem more than this far below the mix is treated as bleed and "
                    "reported no attacks; it is still separated and still playable",
        "peakPicking": "local peak over a rolling-median background, then minimum spacing",
        "stemDownmix": "mean of channels",
        "confidence": "(peak - local median background) / peak, in 0..1",
    }
