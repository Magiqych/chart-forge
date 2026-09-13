/**
 * The Player, assembled.
 *
 * This file owns the loop and the wiring and nothing else: the chart is read in chart.js,
 * positions come from layout.js, judgement from judge.js, input from input.js, and the
 * picture from render.js. Everything it does per frame is in `tick`, and the order of the
 * three lines in it is the only subtle thing in the module:
 *
 *   1. read the clock,
 *   2. let autoplay press what was due,
 *   3. advance the judge.
 *
 * Autoplay before the judge, because a press that was due inside this frame has to be
 * judged before the point it belongs to is considered late. Reverse those two and
 * autoplay misses every note at low frame rates - which is exactly the kind of bug that
 * makes a verification tool worse than useless, because it blames the chart.
 */

import { readChart, chartSummary } from "./chart.js";
import { createAudioClock, createHitSound } from "./clock.js";
import { createJudge } from "./judge.js";
import { createAutoplay } from "./autoplay.js";
import { createScoreboard, formatJudgement, suggestedOffsetSec } from "./score.js";
import { playfieldGeometry, travelSecFor } from "./layout.js";
import { createRenderer } from "./render.js";
import { createKeyboardSource, createPointerSource, defaultBindings, KEY_LABELS } from "./input.js";
import { loadSettings, saveSettings, OFFSET_LIMIT_MS } from "./settings.js";

const $ = (id) => document.getElementById(id);

/** Where the last opened document's path is remembered, for the start screen's box. */
const LAST_OPENED_KEY = "chart-forge-player/last-opened";

const canvas = $("stage");
const renderer = createRenderer(canvas);

/**
 * The flight overlay, for tuning the geometry rather than for playing.
 *
 * Opened with `?debug=1` on the Player's own URL and off in every other case, because a
 * tool that draws its own scaffolding over the thing it is meant to show is a tool nobody
 * can judge a chart with. It prints nothing to the console: a Player whose job is to
 * surface real problems should not be filling the console with its own chatter.
 */
const DEBUG_OVERLAY = new URLSearchParams(window.location.search).get("debug") === "1";

const state = {
  session: null,
  chart: null,
  judge: null,
  autoplay: null,
  scoreboard: null,
  clock: null,
  hitSound: null,
  settings: loadSettings(window.localStorage),
  bindings: [],
  geometry: playfieldGeometry(window.innerWidth, window.innerHeight, 5),
  feedback: [],
  running: false,
  started: false,
  finished: false,
  loop: { a: null, b: null },
  lastDrawnSec: 0,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

let toastTimer = 0;
function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    element.hidden = true;
  }, 1800);
}

/** Chart time: the audio's position, corrected for this machine's latency. */
function chartNow() {
  return (state.clock ? state.clock.now() : 0) - state.settings.offsetMs / 1000;
}

function offsetSec() {
  return state.settings.offsetMs / 1000;
}

function persist() {
  saveSettings(window.localStorage, state.settings);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function fetchSession() {
  const response = await fetch("/api/session", { cache: "no-store" });
  return await response.json();
}

function describeChart(chart, payload) {
  const summary = chartSummary(chart);
  const facts = $("start-facts");
  const rows = [
    ["Title", chart.title || payload.projectName || "(untitled)"],
    ["Chart", payload.chartPath ?? payload.openedPath],
    ["Audio", payload.audio ? payload.audio.path : "(not found)"],
    ["Notes", `${summary.noteCount}  ·  tap ${summary.counts.tap} · long ${summary.counts.hold} · slide ${summary.counts.slide} · flick ${summary.counts.flick}`],
    ["Judged", `${summary.pointCount} points  ·  ${summary.connectionCount} connections  ·  ${summary.decorationCount} decorations`],
    ["Lanes", String(chart.laneCount)],
  ];
  facts.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );

  const problems = [...(payload.warnings ?? []), ...chart.problems];
  if (chart.unknownNoteTypes.length > 0) {
    problems.push(
      `note types this Player has not met: ${chart.unknownNoteTypes.join(", ")} ` +
        "(each is read from its own fields, then drawn and judged as the kind it turns out to be)",
    );
  }
  const box = $("start-problems");
  box.hidden = problems.length === 0;
  box.replaceChildren(
    ...problems.map((text) => {
      const div = document.createElement("div");
      div.textContent = `• ${text}`;
      return div;
    }),
  );
}

async function boot() {
  const status = $("start-status");
  let payload;
  try {
    payload = await fetchSession();
  } catch (error) {
    status.textContent = `The Player's own server did not answer: ${error.message}`;
    return;
  }

  if (!payload.ok) {
    status.textContent = payload.message ?? "No chart is open.";
    if (payload.detail) {
      const box = $("start-problems");
      box.hidden = false;
      box.textContent = payload.detail;
    }
    $("start-open").open = true;
    return;
  }

  // What was opened last time, so double-clicking the launcher with nothing to open is
  // one click away from the project you were working on rather than a path to retype.
  try {
    window.localStorage.setItem(LAST_OPENED_KEY, payload.openedPath);
  } catch {
    // Storage refused; the box simply starts empty.
  }

  let chart;
  try {
    chart = readChart(payload.chart);
  } catch (error) {
    status.textContent = `This chart cannot be played: ${error.message}`;
    return;
  }

  state.session = payload;
  state.chart = chart;
  state.bindings = defaultBindings(chart.laneCount);
  $("key-hint").textContent = state.bindings.map((code) => KEY_LABELS[code] ?? code).join(" ");
  describeChart(chart, payload);

  document.title = `${chart.title || "Chart"} — Chart Forge Player`;
  $("hud-title").textContent = chart.title || payload.projectName || "Chart";
  const difficulty = chart.difficulty
    ? `${chart.difficulty.name ?? ""} ${chart.difficulty.level ?? ""}`.trim()
    : "";
  $("hud-sub").textContent = [chart.artist, difficulty, `${chart.notes.length} notes`].filter(Boolean).join(" · ");

  state.judge = createJudge(chart, { strictFlickDirection: state.settings.strictFlickDirection });
  state.autoplay = createAutoplay(chart);
  state.scoreboard = createScoreboard(state.judge.totalJudgeable());

  if (!payload.audio) {
    status.textContent = "The chart loaded, but its audio could not be found. Nothing to play against.";
    return;
  }

  status.textContent = "Decoding audio…";
  try {
    state.clock = createAudioClock();
    const duration = await state.clock.load("/media/audio", (stage) => {
      status.textContent = stage === "fetching" ? "Reading the audio file…" : stage === "decoding" ? "Decoding audio…" : "Ready.";
    });
    state.clock.setVolume(state.settings.musicVolume);
    state.clock.onEnded(() => finish("the song ended"));
    state.hitSound = createHitSound(state.clock.context);
    state.hitSound.setGain(state.settings.hitSoundVolume);
    status.textContent = `Ready — ${formatTime(duration)} of audio, ${chart.notes.length} notes.`;
  } catch (error) {
    status.textContent = `The audio could not be decoded: ${error.message}`;
    return;
  }

  $("start-play").disabled = false;
  $("start-autoplay").disabled = false;
  applySettingsToControls();
  resize();
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function resetRun(fromSec = 0) {
  state.judge.reset(fromSec - offsetSec());
  state.autoplay.reset(fromSec - offsetSec());
  state.scoreboard = createScoreboard(state.judge.totalJudgeable());
  state.feedback.length = 0;
  state.finished = false;
}

async function startRun(fromSec = 0, { autoplay = null } = {}) {
  if (autoplay !== null) {
    state.settings.autoplay = autoplay;
    $("c-autoplay").checked = autoplay;
    persist();
  }
  state.judge.settings.strictFlickDirection = state.settings.strictFlickDirection;
  resetRun(fromSec);
  state.clock.setRate(state.settings.playbackRate);
  state.clock.seek(fromSec);
  await state.clock.play(fromSec);
  state.started = true;
  state.running = true;
  $("start").hidden = true;
  $("pause").hidden = true;
  $("result").hidden = true;
  $("hud").hidden = false;
}

function pause() {
  if (!state.started || !state.running) return;
  state.clock.pause();
  state.running = false;
  $("pause").hidden = false;
}

async function resume() {
  if (!state.started || state.running || state.finished) return;
  $("pause").hidden = true;
  // The judge is put back where the playhead is, so nothing that went by while the game
  // was stopped is counted as missed.
  state.judge.reset(chartNow());
  state.autoplay.reset(chartNow());
  await state.clock.play();
  state.running = true;
}

async function seekTo(audioSec) {
  const target = Math.min(state.clock.duration, Math.max(0, audioSec));
  state.clock.seek(target);
  resetRun(target);
  state.lastDrawnSec = target - offsetSec();
  if (state.running) await state.clock.play(target);
}

function finish(reason) {
  if (state.finished || !state.started) return;
  state.finished = true;
  state.running = false;
  state.clock.pause();
  showResult(reason);
}

function showResult(reason) {
  const snapshot = state.scoreboard.snapshot();
  $("result-title").textContent = snapshot.fullCombo ? "Full Combo" : "Result";
  $("result-score").textContent = snapshot.score.toLocaleString();
  const cells = [
    ["Perfect", snapshot.counts.perfect],
    ["Great", snapshot.counts.great],
    ["Good", snapshot.counts.good],
    ["Miss", snapshot.counts.miss],
    ["Max combo", snapshot.maxCombo],
    ["Judged", `${snapshot.judged}/${snapshot.total}`],
  ];
  $("result-grid").replaceChildren(
    ...cells.map(([label, value]) => {
      const cell = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = String(value);
      const span = document.createElement("span");
      span.textContent = label;
      cell.append(b, span);
      return cell;
    }),
  );
  const mean = Math.round(snapshot.meanDeltaSec * 1000);
  $("result-timing").textContent =
    snapshot.sampleCount > 0
      ? `${reason}. Your hits averaged ${mean > 0 ? `${mean} ms late` : mean < 0 ? `${Math.abs(mean)} ms early` : "dead on"} ` +
        `over ${snapshot.sampleCount} of them (earliest ${Math.round(snapshot.earliestDeltaSec * 1000)} ms, ` +
        `latest +${Math.round(snapshot.latestDeltaSec * 1000)} ms).`
      : `${reason}. No hits of your own to measure - autoplay and held notes are left out of the timing average.`;
  $("result").hidden = false;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function handleJudgements(judgements) {
  for (const judgement of judgements) {
    state.scoreboard.apply(judgement);
    state.feedback.push({
      lane: judgement.lane,
      timeSec: judgement.timeSec + judgement.deltaSec,
      result: judgement.result,
      text: judgement.wrongDirection ? `${formatJudgement(judgement)} ✗dir` : formatJudgement(judgement),
    });
    if (state.settings.hitSound && state.hitSound && judgement.result !== "miss" && !judgement.autoHold) {
      state.hitSound.play(judgement.kind);
    }
  }
  if (state.feedback.length > 48) state.feedback.splice(0, state.feedback.length - 48);
}

function dispatchInput(event) {
  if (!state.running || !state.judge) return;
  handleJudgements(state.judge.input(event));
}

function tick() {
  requestAnimationFrame(tick);
  if (!state.chart) return;

  const chartTimeSec = state.started ? chartNow() : -travelSecFor(state.settings.noteSpeed);

  if (state.running) {
    if (state.settings.autoplay) state.autoplay.emitUntil(chartTimeSec, (event) => dispatchInput(event));
    handleJudgements(state.judge.update(chartTimeSec));

    const { a, b } = state.loop;
    if (a !== null && b !== null && b > a && chartTimeSec >= b) {
      void seekTo(a + offsetSec());
    } else if (state.clock.duration > 0 && state.clock.now() >= state.clock.duration - 0.01) {
      finish("the song ended");
    } else if (state.judge.isComplete() && chartTimeSec > state.chart.lastPointSec + 1.5) {
      finish("the last note has gone by");
    }
  }

  state.lastDrawnSec = chartTimeSec;
  renderer.draw({
    geometry: state.geometry,
    chart: state.chart,
    chartTimeSec,
    travelSec: travelSecFor(state.settings.noteSpeed),
    judge: state.judge,
    feedback: state.feedback,
    laneDepth: state.judge ? state.judge.laneDepth : [],
    showDecorations: state.settings.showDecorations,
    debug: DEBUG_OVERLAY,
  });

  updateHud(chartTimeSec);
}

let hudFrame = 0;
function updateHud(chartTimeSec) {
  // The score is a number people read, not one they watch move; a third of the frames is
  // plenty and keeps the layout out of the hot path.
  hudFrame += 1;
  if (hudFrame % 3 !== 0 || !state.started) return;
  const snapshot = state.scoreboard.snapshot();
  $("hud-score").textContent = snapshot.score.toLocaleString();
  $("hud-combo").textContent = snapshot.combo > 2 ? `${snapshot.combo} combo` : "";
  const position = state.clock.now();
  $("hud-time").textContent = `${formatTime(position)} / ${formatTime(state.clock.duration)}`;
  $("hud-counts").textContent =
    `P ${snapshot.counts.perfect} · G ${snapshot.counts.great} · ` +
    `g ${snapshot.counts.good} · M ${snapshot.counts.miss}`;
  $("hud-progress-bar").style.width =
    `${state.clock.duration > 0 ? (position / state.clock.duration) * 100 : 0}%`;

  if (!$("controls").hidden) updateControlsReadout(chartTimeSec, snapshot);
}

// ---------------------------------------------------------------------------
// Screen and input wiring
// ---------------------------------------------------------------------------

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  renderer.resize(width, height, window.devicePixelRatio);
  state.geometry = playfieldGeometry(width, height, state.chart ? state.chart.laneCount : 5);
}

window.addEventListener("resize", resize);

createKeyboardSource(window, {
  bindings: () => state.bindings,
  nowSec: () => chartNow(),
  emit: dispatchInput,
});

createPointerSource(canvas, {
  geometry: () => state.geometry,
  nowSec: () => chartNow(),
  emit: dispatchInput,
});

/**
 * The keys that are not lanes.
 *
 * Space is a lane - it is the middle one, and the thumb belongs there - so it cannot also
 * be pause. Esc is pause, which is where a player's hand goes anyway when they want to
 * stop.
 */
window.addEventListener("keydown", (event) => {
  if (event.code === "Tab") {
    event.preventDefault();
    toggleControls();
    return;
  }
  if (event.code === "Escape") {
    event.preventDefault();
    if (!state.started) return;
    if (state.running) pause();
    else void resume();
    return;
  }
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.code === "KeyR" && state.started) {
    event.preventDefault();
    void startRun(0);
  }
  if (event.code === "KeyP") {
    event.preventDefault();
    setAutoplay(!state.settings.autoplay);
  }
  if (event.code === "F11" || (event.code === "KeyF" && event.shiftKey)) {
    event.preventDefault();
    toggleFullscreen();
  }
});

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.();
}

function toggleControls() {
  const panel = $("controls");
  panel.hidden = !panel.hidden;
}

function setAutoplay(on) {
  state.settings.autoplay = on;
  $("c-autoplay").checked = on;
  persist();
  toast(on ? "Autoplay on" : "Autoplay off");
  // Autoplay's cursor is placed at the playhead, so switching it on mid-song starts
  // pressing from here rather than replaying the first half of the chart at once.
  state.autoplay.reset(chartNow());
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function applySettingsToControls() {
  $("c-speed").value = String(state.settings.noteSpeed);
  $("c-speed-out").textContent = `${state.settings.noteSpeed.toFixed(1)}×`;
  $("c-offset").value = String(state.settings.offsetMs);
  $("c-offset-out").textContent = `${state.settings.offsetMs > 0 ? "+" : ""}${state.settings.offsetMs} ms`;
  $("c-rate").value = String(state.settings.playbackRate);
  $("c-autoplay").checked = state.settings.autoplay;
  $("c-hitsound").checked = state.settings.hitSound;
  $("c-strict").checked = state.settings.strictFlickDirection;
  $("c-decorations").checked = state.settings.showDecorations;
  $("c-volume").value = String(state.settings.musicVolume);
}

function updateControlsReadout(chartTimeSec, snapshot) {
  const duration = state.clock.duration || 1;
  const seek = $("c-seek");
  if (document.activeElement !== seek) seek.value = String(Math.round((state.clock.now() / duration) * 1000));
  $("c-seek-out").textContent = formatTime(state.clock.now());

  const suggestion = suggestedOffsetSec(snapshot, offsetSec());
  const apply = $("c-offset-apply");
  if (suggestion === null) {
    apply.disabled = true;
    $("c-offset-hint").textContent = `${snapshot.sampleCount} hits measured; 20 needed`;
  } else {
    apply.disabled = false;
    apply.dataset.value = String(Math.round(suggestion * 1000));
    $("c-offset-hint").textContent = `your hits suggest ${Math.round(suggestion * 1000)} ms`;
  }

  $("c-report").textContent =
    `chart time   ${chartTimeSec.toFixed(3)} s\n` +
    `audio time   ${state.clock.now().toFixed(3)} s\n` +
    `offset       ${state.settings.offsetMs} ms\n` +
    `note travel  ${travelSecFor(state.settings.noteSpeed).toFixed(2)} s\n` +
    `judged       ${snapshot.judged}/${snapshot.total}\n` +
    `accuracy     ${(snapshot.accuracy * 100).toFixed(1)}%`;
}

function wireControls() {
  $("controls-close").addEventListener("click", toggleControls);
  $("c-play").addEventListener("click", () => (state.running ? pause() : void resume()));
  $("c-restart").addEventListener("click", () => void startRun(0));
  $("c-back").addEventListener("click", () => void seekTo(state.clock.now() - 5));
  $("c-forward").addEventListener("click", () => void seekTo(state.clock.now() + 5));
  $("c-full").addEventListener("click", toggleFullscreen);

  $("c-seek").addEventListener("change", (event) => {
    const fraction = Number(event.target.value) / 1000;
    void seekTo(fraction * (state.clock.duration || 0));
  });

  $("c-rate").addEventListener("change", (event) => {
    state.settings.playbackRate = Number(event.target.value) || 1;
    state.clock.setRate(state.settings.playbackRate);
    persist();
    toast(`Song speed ${state.settings.playbackRate}×`);
  });

  $("c-speed").addEventListener("input", (event) => {
    state.settings.noteSpeed = Number(event.target.value);
    $("c-speed-out").textContent = `${state.settings.noteSpeed.toFixed(1)}×`;
    persist();
  });

  $("c-offset").addEventListener("input", (event) => {
    state.settings.offsetMs = Number(event.target.value);
    $("c-offset-out").textContent = `${state.settings.offsetMs > 0 ? "+" : ""}${state.settings.offsetMs} ms`;
    persist();
  });

  $("c-offset-apply").addEventListener("click", (event) => {
    const value = Number(event.target.dataset.value);
    if (!Number.isFinite(value)) return;
    state.settings.offsetMs = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, Math.round(value)));
    applySettingsToControls();
    persist();
    toast(`Offset set to ${state.settings.offsetMs} ms. The chart file was not touched.`);
  });

  $("c-autoplay").addEventListener("change", (event) => setAutoplay(event.target.checked));
  $("c-hitsound").addEventListener("change", (event) => {
    state.settings.hitSound = event.target.checked;
    persist();
  });
  $("c-strict").addEventListener("change", (event) => {
    state.settings.strictFlickDirection = event.target.checked;
    if (state.judge) state.judge.settings.strictFlickDirection = event.target.checked;
    persist();
  });
  $("c-decorations").addEventListener("change", (event) => {
    state.settings.showDecorations = event.target.checked;
    persist();
  });
  $("c-volume").addEventListener("input", (event) => {
    state.settings.musicVolume = Number(event.target.value);
    state.clock?.setVolume(state.settings.musicVolume);
    persist();
  });

  $("c-loop-a").addEventListener("click", () => {
    state.loop.a = chartNow();
    showLoop();
  });
  $("c-loop-b").addEventListener("click", () => {
    state.loop.b = chartNow();
    showLoop();
  });
  $("c-loop-clear").addEventListener("click", () => {
    state.loop.a = null;
    state.loop.b = null;
    showLoop();
  });
}

function showLoop() {
  const { a, b } = state.loop;
  $("c-loop-state").textContent =
    a === null && b === null
      ? "Section loop off"
      : `A ${a === null ? "—" : formatTime(a)} → B ${b === null ? "—" : formatTime(b)}` +
        (a !== null && b !== null && b > a ? " (looping)" : " (set both, B after A)");
}

function wireScreens() {
  $("start-play").addEventListener("click", () => void startRun(0, { autoplay: false }));
  $("start-autoplay").addEventListener("click", () => void startRun(0, { autoplay: true }));
  $("pause-resume").addEventListener("click", () => void resume());
  $("pause-restart").addEventListener("click", () => void startRun(0));
  $("pause-quit").addEventListener("click", () => {
    state.clock.pause();
    state.running = false;
    state.started = false;
    $("pause").hidden = true;
    $("hud").hidden = true;
    $("start").hidden = false;
  });
  $("result-again").addEventListener("click", () => void startRun(0));
  $("result-close").addEventListener("click", () => {
    $("result").hidden = true;
    $("hud").hidden = true;
    $("start").hidden = false;
    state.started = false;
  });

  $("open-go").addEventListener("click", async () => {
    const path = $("open-path").value.trim();
    if (path.length === 0) return;
    const error = $("open-error");
    error.hidden = true;
    try {
      const response = await fetch("/api/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        error.hidden = false;
        error.textContent = `${payload.message}\n${payload.detail ?? ""}`.trim();
        return;
      }
      // A new chart is a new everything; reloading is simpler and cannot leave a stale
      // audio buffer or judge behind.
      window.location.reload();
    } catch (failure) {
      error.hidden = false;
      error.textContent = failure.message;
    }
  });
}

wireControls();
wireScreens();
try {
  const last = window.localStorage.getItem(LAST_OPENED_KEY);
  if (last) $("open-path").value = last;
} catch {
  // No storage: the box starts empty, which is only slightly less convenient.
}
showLoop();
resize();
void boot();
