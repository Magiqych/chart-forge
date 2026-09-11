/**
 * Input, and the one place that knows what a key or a finger means.
 *
 * Nothing downstream of here has heard of a keyboard. Every source - keys, mouse,
 * touch - produces the same three events, and the judge sees only those:
 *
 *     key / pointer / touch  ->  { kind, lane, direction, timeSec }  ->  judge
 *
 * That boundary is not tidiness. This Player is meant to end up on a phone, where the
 * only input is a finger and a swipe has a real direction; keeping the game logic behind
 * one small event shape means that day is a new source file and nothing else. It is also
 * what lets autoplay drive the game through the same path a player does, which is the
 * only way autoplay can be trusted to prove anything.
 *
 * The pure half - which lane a key is, which way a drag went - is at the top and has no
 * DOM in it. The sources at the bottom take the elements they listen to as arguments, so
 * importing this module from a test touches nothing.
 */

/**
 * Keys offered to lanes, middle outwards.
 *
 * Five lanes get D F Space J K, which is where two hands already are. Other lane counts
 * take a centred slice of the same row, so the middle lane is always the thumb.
 */
const KEY_POOL = ["KeyA", "KeyS", "KeyD", "KeyF", "Space", "KeyJ", "KeyK", "KeyL", "Semicolon"];

/** Human labels for the keys above, for the help line. */
export const KEY_LABELS = {
  KeyA: "A", KeyS: "S", KeyD: "D", KeyF: "F", Space: "Space",
  KeyJ: "J", KeyK: "K", KeyL: "L", Semicolon: ";",
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
};

export function defaultBindings(laneCount) {
  const count = Math.max(1, laneCount);
  if (count <= KEY_POOL.length) {
    const start = Math.floor((KEY_POOL.length - count) / 2);
    return KEY_POOL.slice(start, start + count);
  }
  const out = KEY_POOL.slice();
  for (let i = KEY_POOL.length; i < count; i += 1) out.push(`Digit${(i - KEY_POOL.length + 1) % 10}`);
  return out;
}

export function laneForKey(code, bindings) {
  const index = bindings.indexOf(code);
  return index === -1 ? null : index;
}

/** Arrow keys give a keyboard player a direction to flick in. */
export const DIRECTION_KEYS = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * Which of the eight compass points a drag went in, or null when it was not a drag.
 *
 * Screen coordinates, so `dy` grows downwards and is negated to get a direction a person
 * would name. The result is one of the eight the Chart contract defines, so a chart that
 * one day asks for `upRight` is already understood.
 */
export function swipeDirection(dx, dy, thresholdPx = 24) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.hypot(dx, dy) < thresholdPx) return null;
  const degrees = (Math.atan2(-dy, dx) * 180) / Math.PI;
  const sector = Math.round(((degrees + 360) % 360) / 45) % 8;
  return ["right", "upRight", "up", "upLeft", "left", "downLeft", "down", "downRight"][sector];
}

/**
 * Which lane a screen x falls in, at the judgement line.
 *
 * The playfield narrows towards the back, but a finger lands at the near end where it is
 * widest, so the lane is read there. Anything outside the playfield clamps to the edge
 * lane rather than missing: aiming past the leftmost lane means the leftmost lane.
 */
export function laneAtX(geometry, x) {
  const left = geometry.centreX - geometry.nearWidth / 2;
  const lane = Math.floor((x - left) / geometry.laneWidth);
  return Math.min(geometry.laneCount - 1, Math.max(0, lane));
}

/**
 * Keyboard.
 *
 * A held arrow key gives the next press a direction, which is how a keyboard plays a
 * flick chain: hold the way the arrows point and tap the lanes. `event.repeat` is
 * dropped - a key that is down is down once, and the operating system's auto-repeat is
 * not the player pressing anything.
 */
export function createKeyboardSource(target, { bindings, nowSec, emit, isDirectionHeld }) {
  const down = new Set();

  function onKeyDown(event) {
    if (event.repeat) return;
    if (DIRECTION_KEYS[event.code]) {
      down.add(event.code);
      return;
    }
    const lane = laneForKey(event.code, bindings());
    if (lane === null) return;
    event.preventDefault();
    down.add(event.code);
    emit({ kind: "down", lane, direction: heldDirection(), timeSec: nowSec(), source: "keyboard" });
  }

  function onKeyUp(event) {
    if (DIRECTION_KEYS[event.code]) {
      down.delete(event.code);
      return;
    }
    const lane = laneForKey(event.code, bindings());
    if (lane === null || !down.has(event.code)) return;
    event.preventDefault();
    down.delete(event.code);
    emit({ kind: "up", lane, timeSec: nowSec(), source: "keyboard" });
  }

  function heldDirection() {
    if (typeof isDirectionHeld === "function") {
      const forced = isDirectionHeld();
      if (forced) return forced;
    }
    for (const code of down) {
      const direction = DIRECTION_KEYS[code];
      if (direction) return direction;
    }
    return null;
  }

  // A window that loses focus mid-hold would otherwise leave the lane pressed forever.
  function onBlur() {
    for (const code of [...down]) {
      const lane = laneForKey(code, bindings());
      down.delete(code);
      if (lane !== null) emit({ kind: "up", lane, timeSec: nowSec(), source: "keyboard" });
    }
  }

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);
  return {
    heldKeys: () => new Set(down),
    dispose() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
    },
  };
}

/**
 * Mouse and touch, through Pointer Events so both are one code path.
 *
 * A press is a lane; a drag past the threshold while down is a swipe in that lane, sent
 * once per gesture. Dragging across lanes while held moves the press, which is what a
 * slide is on a touchscreen - the judge already understands a press moving between lanes,
 * because that is how a keyboard plays a slide too.
 */
export function createPointerSource(element, { geometry, nowSec, emit, swipeThresholdPx = 24 }) {
  const active = new Map();

  function positionIn(event) {
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event) {
    const point = positionIn(event);
    const lane = laneAtX(geometry(), point.x);
    element.setPointerCapture?.(event.pointerId);
    active.set(event.pointerId, { lane, startX: point.x, startY: point.y, swiped: false });
    emit({ kind: "down", lane, timeSec: nowSec(), source: "pointer" });
  }

  function onPointerMove(event) {
    const state = active.get(event.pointerId);
    if (!state) return;
    const point = positionIn(event);
    if (!state.swiped) {
      const direction = swipeDirection(point.x - state.startX, point.y - state.startY, swipeThresholdPx);
      if (direction) {
        state.swiped = true;
        emit({ kind: "flick", lane: state.lane, direction, timeSec: nowSec(), source: "pointer" });
      }
    }
    const lane = laneAtX(geometry(), point.x);
    if (lane !== state.lane) {
      // The finger has travelled into another lane: press there, let go behind it, in
      // that order, so a slide is never momentarily holding nothing.
      emit({ kind: "down", lane, timeSec: nowSec(), source: "pointer" });
      emit({ kind: "up", lane: state.lane, timeSec: nowSec(), source: "pointer" });
      state.lane = lane;
      state.startX = point.x;
      state.startY = point.y;
      state.swiped = false;
    }
  }

  function onPointerUp(event) {
    const state = active.get(event.pointerId);
    if (!state) return;
    active.delete(event.pointerId);
    element.releasePointerCapture?.(event.pointerId);
    emit({ kind: "up", lane: state.lane, timeSec: nowSec(), source: "pointer" });
  }

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerUp);
  return {
    activeLanes: () => [...active.values()].map((state) => state.lane),
    dispose() {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerUp);
    },
  };
}
