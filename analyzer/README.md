# Analyzer

Turns an audio file into an **Analysis document** - guide information about what happens
in the music and when.

- **Input:** an audio file.
- **Output:** an Analysis JSON document conforming to
  [`../schemas/analysis.schema.json`](../schemas/analysis.schema.json).
- **Example output:** [`../examples/analysis.example.json`](../examples/analysis.example.json).

## Usage

```powershell
python -m analyzer <audio-file> --output-dir <directory>
```

Writes `<output-dir>/analysis.json` and `<output-dir>/stems/{drums,bass,other,vocals}.wav`.
It refuses to overwrite either, so re-running means choosing a fresh output directory.

## Current pipeline

```text
full mix       -> Beat This!            beats, downbeats, raw logits
audio          -> htdemucs              four stems
  drums, other -> librosa               onsets
  bass, vocals -> torchcrepe            pitch, periodicity, voiced runs
                                        -> Analysis 0.2
```

Beat tracking runs on the full mix rather than a stem, and is an independent branch of
the pipeline rather than a consumer of separation.

## Scope

Things the Analyzer is meant to extract, as it becomes able to:

- tempo / BPM, including tempo changes
- beats and downbeats
- onsets (when a sound starts)
- note or event starts and ends, and therefore durations
- pitch
- percussive hits
- instrument or source attribution
- loudness
- a confidence value for each of the above
- references to source-separated stems

Source separation (for example with a Demucs-style model) is a legitimate Analyzer
concern; the separated audio is written next to the analysis and referenced from it by
path, never embedded.

## Out of scope

**The Analyzer does not produce charts.** It has no notion of lanes, note types,
difficulty, or which sounds deserve a note. It reports what it hears; a human decides
what to do about it in the Editor.

This is not a temporary limitation to be lifted later. It is the design: the value of
the tool is that it removes the mechanical measurement work from chart authoring while
leaving the creative decisions with the author.

## Design notes

- **Emit what you know, omit what you do not.** Every field except `version`, `audio`
  and `events` is optional. A partial analysis is a valid analysis; a fabricated field
  is not. Absent confidence means unknown, not zero.
- **Be honest about confidence.** The Editor will use it to fade or filter guide
  markers, so a poorly calibrated confidence is worse than none.
- **Stay reproducible.** An analysis must be regenerable from its audio. Nothing
  human-authored may exist only in an Analysis document.
- **Write provenance.** Fill in `generator` with the tool, version and parameters so a
  surprising analysis can be traced.
- Times are seconds from the start of the audio, in fields named `...Sec`.

## Current limitations

Every one of these is a known, deliberate gap rather than an oversight:

- **`confidence` is never emitted.** Beat This! logits, torchcrepe periodicity and
  librosa onset strength are uncalibrated and mutually incomparable, so writing any of
  them into one field would mislead. Absent means unknown.
- **A `pitch-run` is not a musical note.** It is a provisional voiced segment from a
  periodicity threshold; one note can fragment into several runs.
- **No tempo map.** Only a single representative `tempo.bpm`, derived from the median
  inter-beat interval.
- **No meter or bar indexing.** `barIndex` and `beatInBar` are not generated, because
  meter phase proved unreliable at the start of real tracks.
- **`other` onsets include drum bleed.** A large share coincide with drums onsets;
  nothing is deduplicated, suppressed or merged.
- **Raw frame curves live in `metadata.experimental`.** The contract has no home for
  frame-level data yet, and consumers must not depend on that block.
- **CUDA is required.** There is no CPU path; an unavailable GPU is a hard error rather
  than a silent, far slower fallback.

## Implementation status

The Phase-1 Analyzer CLI is implemented: ingest, separation, beat/downbeat, pitch, onset,
merge and emission of an Analysis 0.2 document, verified end to end on a real track on
the target Windows / CUDA environment.

Verified environment: Python 3.11.15 with torch 2.13.0+cu126, torchaudio 2.11.0+cu126,
demucs-infer 4.2.2, beat-this 1.1.0, torchcrepe 0.0.24, librosa 0.11.0, soundfile 0.14.0,
numpy 2.4.6. There is deliberately no dependency manifest yet.

See [`../docs/analyzer-stack.md`](../docs/analyzer-stack.md) for the selected stack,
measurements, open design questions and next steps.

This choice of stack stays inside this directory. No other component may assume it, and
nothing outside this directory may import from it; the Analysis document is the only
interface.

## Tests

```powershell
python -m unittest discover -s analyzer/tests -v
```

They cover the pure logic only - ids, ordering, pitch conversion, segmentation, document
assembly and the overwrite guard. No model is loaded and no GPU is needed.
