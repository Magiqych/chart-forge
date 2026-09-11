# Player

Plays a chart against its audio so the result can be verified — as a game, with input,
judgement, combo and a result screen, not as a viewer.

- **Input:** a Chart document conforming to
  [`../schemas/chart.schema.json`](../schemas/chart.schema.json), and the audio it
  references.
- **Output:** none. The Player writes no document, and never modifies the ones it reads.
- **Example input:** [`../examples/chart.example.json`](../examples/chart.example.json).

## Running it

From the repository root, on Windows:

```text
start-player.cmd "D:\path\to\song-v2.project.json"
```

or drag a `.project.json` or `.chart.json` onto `start-player.cmd`, or double-click it
and open a document from the start screen — the last one opened is filled in for you.

Anywhere else, or from a terminal:

```text
node player/server.mjs "path/to/song.chart.json"
```

A browser opens on `http://127.0.0.1:5273/`. `--port N` moves it, `--host 0.0.0.0` makes
it reachable from a phone on the same network, `--audio PATH` overrides the audio the
documents name, and `--no-open` skips launching a browser.

**There is nothing to install and nothing to build.** Node's standard library and a
browser are the whole of it. That is deliberate: this repository has no dependency
manifest and [`../CLAUDE.md`](../CLAUDE.md) asks that none be invented, and a Player that
needs `npm install` before it runs is a Player that does not run when it is wanted.

## Playing

| | |
| --- | --- |
| Lanes (5-lane chart) | `D` `F` `Space` `J` `K` |
| Flick direction | hold `←` or `→` while pressing a lane |
| Pause / resume | `Esc` — **not** Space, which is a lane |
| Controls panel | `Tab` |
| Restart | `R` |
| Autoplay | `P` |
| Fullscreen | `F11` or `Shift`+`F` |

Mouse and touch work too: press a lane, drag across lanes to slide, flick to swipe. The
lane keys are generated from the chart's own `playfield.laneCount`, centred on the middle
of the keyboard, so a chart with a different number of lanes is playable without
configuring anything.

## What it plays

Everything in the 0.1 Chart contract that affects play:

| Chart feature | How it is played |
| --- | --- |
| `tap` | one press in the lane |
| `hold` | pressed at `timeSec`, held, released at `endTimeSec` |
| `slide` | pressed, then the press moved through every `waypoint` lane in turn |
| `flick` | a swipe, or a press with a direction held |
| `endAction: {type: "flick"}` | the note's end is a swipe rather than a release |
| `waypoints` | each one is judged in its own right |
| `connections` | drawn as a line between the linked notes; they are played as the run the chart says they are |
| `decorations` | text decorations are drawn over the playfield, with their style, gradient, glow and enter/exit animation |
| `extensions` | ignored, as the contract requires |

A note `type` the Player has never seen is still played, from its own fields — an end
time makes it a held note, a direction makes it a flick — and is reported on the start
screen rather than silently turned into a tap. A decoration kind it does not know is
skipped, and the chart plays exactly the same, which is what makes decorations optional.

## Judgement

A chart is not judged note by note; it is judged at **points**. A note may be several:

| Point | Where it comes from |
| --- | --- |
| `tap` | an instantaneous note with no direction |
| `flick` | an instantaneous note with a direction |
| `hold-start` | the beginning of any note with an end |
| `waypoint` | each entry of `waypoints` |
| `release` | the end of a held note |
| `flick-end` | the end of a note whose `endAction` is a flick |

The windows are **±60 ms Perfect, ±110 ms Great, ±160 ms Good**, and past that a Miss.
They are the Player's own numbers, not the contract's: the schema says when a note is,
not how forgiving the game is about it. They are a little generous on purpose, because a
window so tight that a good chart feels broken hides the thing this tool exists to show.
They live in one place, `DEFAULT_WINDOWS` in [`web/judge.js`](web/judge.js).

Two rules the engine is built around:

- **One input consumes at most one point.** A press picks the single closest point it is
  allowed to satisfy, so a chord is several presses and one key can never set off two
  notes at once.
- **Every point is judged exactly once.** Anything never played is missed when its window
  closes, so `hits + misses` always equals the number of points and the result screen
  adds up.

A few judgements are the Player's decisions rather than the contract's, and are worth
knowing when reading a result:

- A plain long note is scored at **both** ends. Releasing it at the right moment is
  something the game asks of the player. (The Editor's hit-sound scheduler deliberately
  stays *silent* at that end — a release is not a hit to announce. Same document,
  different question.)
- Holding a long note past its end completes it rather than punishing it. A chart cannot
  be verified against the exact instant of letting go.
- A hold or slide that is dropped loses the rest of its points, all of them counted. A
  dropped four-point slide really did cost four things.
- A flick swiped the wrong way still hits, capped at Good and marked `✗dir`. Turn on
  **Strict flick direction** in the controls to have it miss instead — which is the
  honest setting for checking that a chart's flicks read the way they were meant to.

## Practice and debugging

The controls panel (`Tab`) has pause, restart, seek, ±5 s, song speed (1×, 0.75×, 0.5×,
0.25×), note speed, an A–B section loop, hit sounds, decorations on and off, and
**autoplay**.

Autoplay is the main verification tool. It is not a separate code path: it produces the
same `{kind, lane, direction, timeSec}` events a keyboard produces and goes through the
same judge, so a chart that autoplay cannot full-combo has something wrong with it — the
chart, the schedule, or the engine — and any of those is worth knowing. Its events are
stamped with the moment they were *due* rather than the frame they were dispatched on, so
it scores identically at any frame rate and at any playback speed.

### Timing offset

Chart time is **audio time minus the offset**, adjustable from −200 ms to +200 ms. If
your hits read late, increase it. After twenty hits of your own, the panel offers the
offset that would have centred them — **Use measured offset** applies it.

This is a session setting and lives in the browser's storage. It is never written to the
chart, and there is no field in the Chart contract for it: a chart carrying one machine's
audio latency would be a chart that plays wrong on the next machine. The same goes for
note speed, key bindings and autoplay.

## How it is built

```text
player/
├─ server.mjs          resolves documents, serves them to 127.0.0.1; the only filesystem access
├─ web/
│  ├─ index.html       the shell, the start screen, the controls, the result screen
│  ├─ style.css
│  ├─ main.js          the loop and the wiring, and nothing else
│  ├─ chart.js         reading a Chart document into judgement points
│  ├─ clock.js         the audio clock, and the hit sound
│  ├─ layout.js        time → position, and which notes are worth drawing
│  ├─ judge.js         the judgement engine
│  ├─ input.js         keyboard, mouse and touch → one event shape
│  ├─ autoplay.js      a perfect player, made of ordinary input events
│  ├─ score.js         score, combo, timing statistics
│  ├─ decorations.js   drawing the chart's decorations
│  └─ render.js        the playfield
└─ tests/              node --test; pure logic only
```

Three things hold the design together:

**The audio is the clock.** Position is derived from an `AudioBufferSourceNode` started
at a known point on the audio context's own clock, so it is exact between frames and
correct at any playback rate. Nothing counts frames and nothing keeps a second idea of
how far the song has got.

**Position is a function of time.** `distance = (noteTime − chartTime) × speed`, projected
through a fixed perspective. Nothing is integrated frame by frame, so a dropped frame
puts a note where it should be rather than leaving it behind, and two machines at
different frame rates draw the same chart identically.

**Input is abstracted at the source.** Keys, pointers and autoplay all produce the same
event, and the judge has never heard of a keyboard. That is what makes autoplay
meaningful, and it is what a phone will need: a new source file and nothing else.

Per frame the loop reads the clock, lets autoplay press what was due, and then advances
the judge — in that order, because a press due inside this frame has to be judged before
the point it belongs to is considered late.

Only the notes between `chartTime − 0.35 s` and `chartTime + travel` are drawn, found by
a binary search plus a running maximum of note end times, so a fourteen-second slide is
still found long after its start has scrolled away without walking the whole chart every
frame.

## Opening a Project

The Player reads **a chart and its audio**. It also accepts a Project document, purely as
a way of *finding* those two things — a project is where an author's files are actually
associated, and requiring them to be dug out by hand would be a worse tool for no gain in
purity. Nothing else in the project reaches gameplay: the analysis is not read, the
editor state is not read, and nothing is written back.

Audio is looked for where the chart says it is, then where the project says it is. When a
reference resolves to a file that is not there, the same path is tried on the machine's
other drive roots — a reference like `../../../../Users/me/Music/song.flac` written from
`D:\` clamps at the drive root and lands on `D:\Users\...` while the file is on `C:` — and
the start screen says which file was actually played. The document on disk is never
changed to match.

## Tests

```text
node --test "player/tests/*.test.mjs"
```

Pure logic only: reading a chart, judgement points, every judgement rule, windowing,
autoplay, scoring, settings and document resolution. The real chart this Player was built
against is **not** in the repository and is never loaded by a test — it is the author's
work, and a test that depended on it would break the moment they moved a note.
[`tests/fixtures/mini.chart.json`](tests/fixtures/mini.chart.json) is a small chart
written for the tests, and it passes `python tests/validate_contracts.py --chart`.

## Not done

- **Real slide tracing.** A slide is judged at its points, and travelling between them is
  not itself checked. The architecture is ready for it: waypoints are already separate
  judgements with lanes and times, and pointer movement between lanes already produces
  the press-and-release pair a trace would build on.
- **Decoration `effects`** — shimmer, sparkle, meteors. Optional and additive; the
  contract says a reader that ignores them draws a still caption, which is a correct
  reading of the chart. Gameplay came first.
- **`bpm` and `bpmChanges`** are read but not used. A Player needs only the seconds.
- **Scoring** is a flat share of a million over the judgement points, not any game's
  formula. A full combo is exactly 1,000,000 and anything less is something to go and
  look at, which is what a verification tool needs from a score.
