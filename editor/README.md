# Editor

> **Not implemented.** This directory currently holds only its responsibility statement.

Where a human authors a chart, with the analysis displayed as a guide layer.

- **Input:** a Project document ([`../schemas/project.schema.json`](../schemas/project.schema.json)),
  which references the audio and an Analysis document
  ([`../schemas/analysis.schema.json`](../schemas/analysis.schema.json)).
- **Output:** a Chart document conforming to
  [`../schemas/chart.schema.json`](../schemas/chart.schema.json), plus the updated
  Project document.
- **Examples:** [`../examples/project.example.json`](../examples/project.example.json),
  [`../examples/chart.example.json`](../examples/chart.example.json).

## Scope

Show the song on a timeline, with guide layers drawn over it:

- waveform
- spectrogram
- beat grid, derived from tempo and offset
- onsets
- note starts, ends and durations
- stems, individually viewable
- analysis events, filterable by type, source and confidence

and let the author place, move, retime and delete notes against that guide - with
snapping to the beat grid, playback with a moving playhead, and audition of the result.

Layer visibility, zoom, playhead position and snap settings are saved in the `editor`
section of the Project document, purely so a session can be restored.

## Out of scope

- **Analysing audio.** If the guide information is not good enough, the Analyzer is run
  again with different settings. The Editor does not grow its own analysis code.
- **Deciding notes.** The Editor may make placement *easy* - snapping, aligning to a
  nearby event, bulk operations on a selection - but the author chooses. There is no
  one-click conversion of events into notes that stands in for authoring.

## Design notes

- **Degrade gracefully.** An analysis may lack pitch, stems, sections or confidence, or
  may be missing entirely. Every layer must handle its data being absent.
- **Tolerate unknown values.** Event types, stem kinds and layer ids are open
  vocabularies: display what you do not recognise, do not reject the document.
- **Keep the chart clean.** Analysis values do not leak into the Chart document. The
  only bridge is the optional `sourceEventId` on a note, which records what the author
  was looking at and has no effect on playback.
- **Prefer file references.** Analysis documents get large; reference them from the
  project rather than embedding them, so editor state can be saved without rewriting
  the analysis.
- Times are seconds from the start of the audio, in fields named `...Sec`.

## Implementation status

No UI framework, desktop shell or dependency has been chosen. TypeScript on the web
platform is a plausible fit, but no other part of the repository may assume it. Nothing
outside this directory may import from it; the JSON documents are the only interface.
