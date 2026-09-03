# Terminology

Shared vocabulary for Chart Forge. These terms are used consistently in the README, the
documentation, the schemas and the field names. If a term here changes, all four change
together.

## Core distinction

### Analysis Event

An observation about the audio, produced by the Analyzer. "A kick drum starts at 1.502
seconds." "A vocal note of about A4 runs from 3.1 to 4.85 seconds, confidence 0.64."

An event has a time, usually a type, and whatever else the Analyzer could determine. It
has **no lane, no gameplay type and no difficulty**. It is a measurement, and it can
always be regenerated from the audio.

### Chart Note

A gameplay object, placed by a human in the Editor. "A hold in lane 0, from 1.0 to 2.75
seconds."

A note has a time, a lane, a gameplay type, and for held notes an end. It carries **no
confidence and no pitch**: it is a decision, not a measurement, and it cannot be
regenerated from the audio.

**Events and notes are never the same object.** They live in different documents, under
different schemas, and no code converts one into the other. A note may record which
event inspired it (`sourceEventId`), but that is provenance, not derivation.

## Documents

| Term | Meaning |
| --- | --- |
| **Analysis** / Analysis JSON | Analyzer output. Guide information about the audio. `schemas/analysis.schema.json`. |
| **Chart** / Chart JSON | Editor output, Player input. The notes of a playable chart. `schemas/chart.schema.json`. |
| **Project** / Project JSON | The Editor's working unit: audio + analysis + chart + editor state. `schemas/project.schema.json`. |
| **Guide layer** | The analysis as displayed in the Editor, drawn over the timeline so a human can author against it. |

## Components

| Term | Meaning |
| --- | --- |
| **Analyzer** | Turns audio into an Analysis document. Makes no gameplay decisions. |
| **Editor** | Where a human authors a Chart with the analysis shown as a guide layer. |
| **Player** | Plays a Chart against its audio for verification. |

## Musical terms

| Term | Meaning |
| --- | --- |
| **Tempo / BPM** | Beats per minute. May vary over time, described by a tempo map. |
| **Beat** | A pulse position in the music. |
| **Downbeat** | The first beat of a bar. In the Analysis document, a beat with `isDownbeat` true. |
| **Bar** | A group of beats, of length `beatsPerBar`. |
| **Beat grid** | The grid of beat and bar lines drawn in the Editor, derived from tempo and offset. |
| **Onset** | The moment a sound starts. |
| **Duration** | How long an event sounds, from its start to its end. |
| **Pitch** | The perceived frequency of a pitched sound, expressed as MIDI number, hertz or name. |
| **Percussion** | An unpitched hit, such as a kick, snare or hi-hat. |
| **Loudness** | Level of a sound, in decibels. |
| **Stem** | One separated part of a mix (vocals, drums, bass, ...), produced by source separation. |
| **Source separation** | Splitting a mixed recording into stems. |
| **Confidence** | The Analyzer's own estimate of how much a value can be trusted, from 0 to 1. Absent means unknown, which is not the same as 0. |
| **Section** | A coarse structural segment of a track, such as intro or chorus. |

## Gameplay terms

| Term | Meaning |
| --- | --- |
| **Lane** | A horizontal position a note can occupy, indexed from 0 at the left. |
| **Playfield** | The geometry notes are placed on, primarily `laneCount`. |
| **Tap** | A note hit once, instantaneously. |
| **Hold** | A note held from its time to its `endTimeSec`. |
| **Flick** | A note hit with a directional swipe. |
| **Slide** | A held note whose lane may move, ending at `endLane`. |
| **Profile** | The name of the gameplay ruleset a chart targets, e.g. `generic` or `deresute`. |
| **Extension** | Game-specific chart data, stored under `extensions` and keyed by profile name. A chart must stay playable when extensions are ignored. |

## Conventions

| Term | Meaning |
| --- | --- |
| **Time in seconds** | Every time value is seconds from the start of the audio, as a floating-point number. Field names carry the unit: `startSec`, `endSec`, `timeSec`, `durationSec`, `offsetSec`. |
| **Offset** | `timing.offsetSec`: the audio time at which musical time zero (bar 1, beat 1) falls. |
| **Open vocabulary** | A string field whose listed values are examples, not an exhaustive enum. Consumers must tolerate unknown values instead of rejecting the document. |
| **Reference vs. inline** | A document may point at another document by path (`kind: "file"`) or embed it (`kind: "inline"`). Audio is always referenced, never embedded. |
| **id** | A string identifier, unique within its own document and stable across edits. |
