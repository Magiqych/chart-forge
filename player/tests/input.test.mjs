/**
 * The input layer's pure half: what a key is, what a drag means, where a finger landed.
 *
 * The sources themselves need a DOM and are exercised by playing the game; these are the
 * decisions they make, which do not.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { defaultBindings, laneForKey, swipeDirection, laneAtX, DIRECTION_KEYS } from "../web/input.js";
import { playfieldGeometry, laneCentreX } from "../web/layout.js";

describe("key bindings", () => {
  it("puts five lanes under two hands with the thumb in the middle", () => {
    assert.deepEqual(defaultBindings(5), ["KeyD", "KeyF", "Space", "KeyJ", "KeyK"]);
  });

  it("centres whatever number of lanes the chart actually has", () => {
    assert.equal(defaultBindings(3).length, 3);
    assert.equal(defaultBindings(1).length, 1);
    assert.equal(defaultBindings(9).length, 9);
    assert.equal(new Set(defaultBindings(9)).size, 9, "no key serves two lanes");
  });

  it("keeps going past the keys it has names for", () => {
    const many = defaultBindings(12);
    assert.equal(many.length, 12);
    assert.equal(new Set(many).size, 12);
  });

  it("maps a key back to its lane, and everything else to nothing", () => {
    const bindings = defaultBindings(5);
    assert.equal(laneForKey("KeyD", bindings), 0);
    assert.equal(laneForKey("Space", bindings), 2);
    assert.equal(laneForKey("KeyK", bindings), 4);
    assert.equal(laneForKey("Escape", bindings), null);
  });

  it("keeps the arrow keys out of the lanes, so they can mean a direction", () => {
    const bindings = defaultBindings(5);
    for (const code of Object.keys(DIRECTION_KEYS)) {
      assert.equal(laneForKey(code, bindings), null);
    }
  });
});

describe("swipes", () => {
  it("ignores a drag too short to be meant", () => {
    assert.equal(swipeDirection(3, 2), null);
    assert.equal(swipeDirection(0, 0), null);
  });

  it("names the eight compass points, with the screen's y flipped", () => {
    assert.equal(swipeDirection(50, 0), "right");
    assert.equal(swipeDirection(-50, 0), "left");
    assert.equal(swipeDirection(0, -50), "up");
    assert.equal(swipeDirection(0, 50), "down");
    assert.equal(swipeDirection(50, -50), "upRight");
    assert.equal(swipeDirection(-50, 50), "downLeft");
  });

  it("takes the threshold it is given", () => {
    assert.equal(swipeDirection(30, 0, 40), null);
    assert.equal(swipeDirection(30, 0, 10), "right");
  });
});

describe("where a finger landed", () => {
  const geometry = playfieldGeometry(1280, 720, 5);

  it("gives back the lane whose centre it is nearest", () => {
    for (let lane = 0; lane < 5; lane += 1) {
      assert.equal(laneAtX(geometry, laneCentreX(geometry, lane)), lane);
    }
  });

  it("clamps outside the playfield to the edge lane rather than missing", () => {
    assert.equal(laneAtX(geometry, -500), 0);
    assert.equal(laneAtX(geometry, 99999), 4);
  });
});
