# Player

> **Not implemented.** This directory currently holds only its responsibility statement.

Plays a chart against its audio so the result can be verified.

- **Input:** a Chart document conforming to
  [`../schemas/chart.schema.json`](../schemas/chart.schema.json), and the audio it
  references.
- **Output:** none. The Player writes no document.
- **Example input:** [`../examples/chart.example.json`](../examples/chart.example.json).

## Scope

Render and play the chart in sync with the audio: lanes, taps, holds, flicks and slides
scrolling to a judgement line, with accurate timing, seeking and playback control. The
long-term goal is that a Deresute-compatible chart can be played and judged here.

## Out of scope

- **Editing.** The Player does not modify charts. Problems found while playing are
  reported to the author, who fixes them in the Editor.
- **Reading analysis or project documents.** The Player sees a chart and its audio, and
  nothing else. If a value matters for playback it must be expressed as chart data.

## Design notes

- **Core first.** Implement the game-neutral model - `playfield.laneCount`, taps, holds,
  flicks, slides, `timing.offsetSec` - before anything game-specific. A chart must be
  playable while every `extensions` entry is ignored.
- **Report, do not guess.** On an unknown note type or an unsupported profile, surface
  it clearly instead of silently substituting a tap.
- **Audio is the clock.** Visuals follow the audio position, not a frame counter, or
  timing drifts.
- Times are seconds from the start of the audio, in fields named `...Sec`.

## Implementation status

Nothing has been chosen, and the Deresute chart format is not defined in this repository
yet. Nothing outside this directory may import from it; the Chart document is the only
interface.
