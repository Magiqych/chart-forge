# Analyzer

> **Not implemented.** This directory currently holds only its responsibility statement.

Turns an audio file into an **Analysis document** - guide information about what happens
in the music and when.

- **Input:** an audio file.
- **Output:** an Analysis JSON document conforming to
  [`../schemas/analysis.schema.json`](../schemas/analysis.schema.json).
- **Example output:** [`../examples/analysis.example.json`](../examples/analysis.example.json).

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

## Implementation status

The Analyzer stack is being validated as a Python 3.11 / PyTorch CUDA pipeline. Source
separation, beat/downbeat tracking, monophonic pitch extraction and onset extraction have
now been verified independently on the target Windows / CUDA environment.

The stages have not yet been integrated into an Analyzer implementation, and the first
real Analysis document has not yet been emitted.

See [`../docs/analyzer-stack.md`](../docs/analyzer-stack.md) for the selected stack,
verified environment, measurements, open design questions and next steps.

This choice of stack stays inside this directory. No other component may assume it, and
nothing outside this directory may import from it; the Analysis document is the only
interface.
