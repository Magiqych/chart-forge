# Data flow

How data moves through Chart Forge, what each document means, and what must be true at
each boundary.

## The pipeline

```text
[1] audio file
       |
       |  Analyzer reads the audio
       v
[2] Analysis JSON  -----------------+
       |                            |
       |  Editor loads it as        |  Project JSON records which
       |  the guide layer           |  audio, analysis and chart
       v                            |  belong together
[3] human authoring in the Editor   |
       |                            |
       v                            |
[4] Chart JSON  --------------------+
       |
       |  Player loads it
       v
[5] playback and verification
```

## Stage 1 — Audio

The input is an audio file. It is the only large binary in the system, and it is
**never embedded** in any document: every document refers to it by path, optionally with
a `sha256` so a consumer can tell that the audio changed after a document was written.

Audio files are not committed to this repository (see `.gitignore`).

## Stage 2 — Analysis JSON

Produced by the Analyzer, consumed by the Editor.

It answers: **what is happening in the music, and when?**

It contains tempo, beats and downbeats, optional structural sections, optional stem
references, and a list of **Analysis Events**. An event is an observation: a sound
starts here, this pitched note runs from here to here, this is a snare, the Analyzer is
72% confident.

Properties this stage must have:

- **Fields are optional.** Analyzers differ in what they can extract, and a field is
  omitted when it could not be determined. A consumer must render a document that has
  beats but no pitches, or events but no stems. Only `version`, `audio` and `events` are
  required.
- **Absence is not zero.** A missing `confidence` means unknown, not no confidence.
- **No gameplay.** There are no lanes, note types, difficulties or positions here.
- **Reproducible and disposable.** An analysis can always be regenerated from the audio.
  Nothing that a human authored may live only in an Analysis document.

## Stage 3 — Authoring

The Editor draws the analysis on a timeline as guide layers over the audio: waveform,
spectrogram, beat grid, onsets, note durations, stems, and the events themselves.

The human places notes against that guide. **This is the only step where a chart comes
into existence**, and it is a human step. Nothing in the pipeline converts an event into
a note automatically.

A note may carry `sourceEventId`, recording which event the author was looking at when
they placed it. This is provenance for tooling — for example, re-running the Analyzer
and highlighting notes whose underlying event moved. It is not a derivation: the note is
the author's decision, and the Player ignores this field entirely.

## Stage 4 — Chart JSON

Produced by the Editor, consumed by the Player.

It answers: **where does the game place notes?**

It contains chart metadata, the audio reference, timing (offset and tempo), the
playfield geometry, and the list of **Chart Notes**. A note is a gameplay object: a type,
a time, a lane, and for held notes an end.

Properties this stage must have:

- **Self-sufficient.** A chart plus its audio is everything the Player needs. The Player
  never reads the Analysis or Project document.
- **No analysis data.** Confidence, pitch estimates, stems and onsets do not appear in a
  chart. If a value from the analysis matters for playback, it was the author's job to
  express it as chart data.
- **Core-first.** Game-specific data lives under `extensions`; the chart must remain
  playable when extensions are ignored.

## Stage 5 — Playback

The Player plays the chart against the audio for verification. Its input is the Chart
document; it produces no document of its own, and it modifies nothing it reads.

It is a game and not a viewer: the chart is flattened into **judgement points** — a tap
is one, a long note is two, a slide is one per waypoint plus its ends — and each is
played and judged. A Project document may be handed to it in place of a chart, purely so
that the chart and the audio can be found; nothing else in the project reaches playback.

How forgiving the judgement is, how fast the notes travel, which keys play which lane and
how much this machine's audio lags are all **Player session settings**. None of them is
chart data and none of them has a field in the contract: a chart carrying one machine's
audio latency would be a chart that plays wrong on the next one.

## The Project document

The Project document is the Editor's own bookkeeping. It records:

- which audio file the project is about,
- which analysis is being used as the guide layer,
- which chart is being authored,
- editor state such as zoom, playhead, snapping and layer visibility.

Analysis and chart are held as a `documentRef`, which is either

```json
{ "kind": "file", "path": "analysis.json", "sha256": "..." }
```

or

```json
{ "kind": "inline", "data": { "...": "the document itself" } }
```

**File references are the default.** An analysis of a full song can contain thousands of
events and become far larger than everything else in the project; embedding it forces
the Editor to rewrite the whole blob on every state change, and makes the project file
unreadable in a diff. The inline form exists so that a small, self-contained project can
be moved or shared as one file.

The `editor` section is advisory in the strongest sense: an Editor must work correctly
when it is missing, and must not fail on keys it does not recognise. No meaning that
affects the analysis or the chart may be stored there.

## Time

All time values in all three documents are **seconds, as a floating-point number,
measured from the start of the audio file**. Field names carry the unit — `startSec`,
`endSec`, `timeSec`, `durationSec` — so that a value's unit can never be misread across a
language boundary.

Musical time (bars and beats) is derived, not stored on notes: `timing.offsetSec` gives
the audio time of musical zero, and `timing.bpm` with `timing.bpmChanges` describes the
tempo from there. An Editor uses this to draw a beat grid and to snap; a Player needs
only the seconds.

## Compatibility at the boundaries

Each document carries a `version`. Because the documents are the contract:

- New **optional** fields and new members of an open vocabulary (event types, note
  types, stem kinds, layer ids) are backward-compatible additions. Consumers must
  tolerate values they do not know rather than reject the document.
- Making a field required, removing it, renaming it, or changing its type or unit is
  breaking, and requires a version bump plus a matching update to `examples/`, `tests/`
  and the documentation.
