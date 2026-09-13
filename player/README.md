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

## What it looks like

Five circular targets sit along the bottom of the screen, threaded by a single pale line,
and the notes fly in from the distance and land exactly on them. There is nothing inside
a target: in the game this playfield is modelled on there is a portrait there, but a
Player whose job is to show a chart should not put anything behind the notes that
competes with them — and that artwork is not ours to use. Everything on the playfield is
drawn from arcs, gradients and strokes written out as numbers; no image is loaded and
nothing is traced from anyone else's art.

Every note is a circle: a coloured disc, a pale rim, a thin dark edge so the rim survives
a bright decoration behind it, and a mark in the middle. The four kinds are told apart
three times over — by hue, by that mark, and by the band they trail — because a player
falling towards a note has no time to study it:

| | hue | centre | band |
| --- | --- | --- | --- |
| `tap` | rose red, ~350° | nothing | — |
| `hold` | amber, ~35° | a white disc | wide, amber |
| `slide` | teal, ~170° | a white bar | narrower, teal, with a lit edge |
| `flick` | violet, ~255–295° | an arrowhead | — |

The four hues are kept at least ~45° apart, and all of them are kept out of the pale blue
around 215° that the stage furniture is drawn in — the tap targets, the lane edges and the
stars. A note sharing that hue would be competing with the floor it lands on. Each band
carries its own note's hue for a related reason: a band is visible from further away than
a head is legible, so it is the playfield's earliest warning and it should say the same
thing the heads will.

**A flick's two sides are two violets.** A leftward swipe — `left`, `upLeft`, `downLeft` —
is a warm, light orchid with a **dark** arrowhead; a rightward one — `right`, `upRight`,
`downRight` — is a cool, deep indigo with a **white** arrowhead. Forty degrees of violet
is not much to judge at speed, and it is exactly the difference a red-green colour vision
difference flattens, so three more things carry it: a gap of roughly 19 L\* in lightness, a
rim tinted pink-white against one tinted blue-white, and that flip of the arrowhead from
dark-on-light to light-on-deep — which is the fastest-read difference on the note and
needs no colour at all. A flick with no side to take (`up`, `down`, or no direction) keeps
the neutral violet between the two.

A note whose `endAction` is a flick has a **violet flick at its end**, in the side the end
action names, with its arrow. Nothing else on the playfield would tell a player that the
last thing they must do with a four-second hold is swipe it, and the contract is explicit
that the end action describes the end rather than the note. A `direction` on the note
itself belongs to its *start* and is never borrowed by its end.

A type this Player has never seen keeps a grey style of its own — the one style with no
hue at all, so it cannot be read as any of the four — and is still drawn.

The bands are not rectangles stretched down the screen. The visible part of the note's
flight is sampled, every sample is projected through the same perspective the heads go
through, and the band is filled between the resulting edges — so it is narrow and faint in
the distance, widens as it comes, and a slide crossing three lanes bends the way its notes
will actually travel. Its far edge is cut at the spawn line and faded out; its near edge
is the playhead, so the part of a hold that has already been played is not left hanging
below the targets. A note the judge has retired — everything before the point you seeked
to, for instance — has no band either, because a band for a note that is not in the run
would be the playfield disagreeing with the scoreboard.

Everything is a fraction of the canvas, so the same playfield appears on a phone and on a
4K monitor with nothing hard-coded, and the backing store is sized to `devicePixelRatio`.
The **visible** target is smaller than the lane a press is read from: a thumb landing a
little off still counts, and the lanes still never overlap.

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
│  ├─ note-space.js    the 3D world notes fly through, and the projection onto a screen
│  ├─ layout.js        which notes are worth drawing, and how long they are in the air
│  ├─ note-theme.js    every colour, radius, stroke and glow, in one place
│  ├─ note-renderer.js tap targets, note heads, ribbons, connections
│  ├─ judge.js         the judgement engine
│  ├─ input.js         keyboard, mouse and touch → one event shape
│  ├─ autoplay.js      a perfect player, made of ordinary input events
│  ├─ score.js         score, combo, timing statistics
│  ├─ decorations.js   drawing the chart's decorations
│  └─ render.js        the frame: the background, and the order everything is painted in
└─ tests/              node --test; pure logic only
```

Three things hold the design together:

**The audio is the clock.** Position is derived from an `AudioBufferSourceNode` started
at a known point on the audio context's own clock, so it is exact between frames and
correct at any playback rate. Nothing counts frames and nothing keeps a second idea of
how far the song has got.

**Position is a function of time.** A note travels through a small three-dimensional
world — a lane across, a depth into the picture, a height above the playfield — and what
is drawn is that world through a pinhole. All of it is evaluated from one number, the
*phase* of the flight:

```text
phase    = 1 − (noteTime − chartTime) / approach      0 as it appears, 1 as it arrives
depth(p) = spawnDepth  + (tapDepth  − spawnDepth)  × p      constant velocity
height(p)= spawnHeight + (tapHeight − spawnHeight)  × p²    falling from a standstill
scale    = tapDepth / depth(p)                              exactly 1 at the tap line
```

Nothing is integrated frame by frame — there is no `position += velocity × dt` anywhere,
and no state carried between frames at all. A dropped frame puts a note where it should
be rather than leaving it behind; a seek is correct immediately because the position at
40 s is computed *from* 40 s and never fast-forwarded to; a pause stops the notes because
it stops the clock they are read from; and two machines at different frame rates draw the
same chart identically. It is all one subtraction on the audio clock.

The constants live in `WORLD` in [`web/note-space.js`](web/note-space.js) and are not
pixels — only their ratios matter, because the projection is normalised onto whatever
viewport it is given. A note is born at 0.45 of its final size and grows without a break
to exactly 1 at the tap line, where it is the same size and in the same place as the
target it lands on. Because the note is born a little above eye level it drifts very
slightly *upward* for the first tenth of its flight before the fall takes over — a couple
of pixels, felt rather than seen.

That lift and the readability of a dense passage pull against each other: the deeper the
lift, the more of the flight is crowded into the top of the screen, where notes a
sixteenth apart begin to overlap. The values chosen sit where a stream of sixteenths
still reads as separate notes, and the trade is written out where the constants are.

`?debug=1` on the Player's URL draws the spawn and tap lines and the projected trajectory
of every lane, which is how the geometry was tuned rather than guessed at. It is off
everywhere else and prints nothing.

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
autoplay, scoring, settings, document resolution, and the geometry — the flight model, the
projection, the sampling of a band, and which style each point of a note is drawn in, all
of which are pure functions with no canvas in them. Most of the geometry tests are one
idea in different clothes: the same chart time always produces the same position, at any
frame rate, after a seek, while paused, and at any playback speed. The real chart this
Player was built
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
- **The playfield is not a copy of any game's.** It borrows the *shape* of the idea — five
  round targets, round notes told apart by colour, a pseudo-3D approach — and none of the
  rest: no portraits in the targets, no background video, no HUD layout, no hit burst, no
  scoring curve. The flight is the physics written down in `note-space.js` tuned until it
  reads right, which is a different thing from matching another game frame for frame.
