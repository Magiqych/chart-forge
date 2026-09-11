/**
 * Finding the documents on disk.
 *
 * The Player is handed a path and has to end up with a chart and a playable audio file,
 * across two Windows drives, through a Project or without one. That resolution is the
 * part most likely to be wrong on someone else's machine, so it is tested directly
 * rather than through a running server.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { candidatePaths, classifyDocument, loadSession } from "../server.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const CHART = path.join(FIXTURES, "mini.chart.json");
const PROJECT = path.join(FIXTURES, "mini.project.json");

function tempFile(name, contents) {
  const directory = mkdtempSync(path.join(tmpdir(), "chart-forge-player-"));
  const file = path.join(directory, name);
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return file;
}

describe("classifying a document", () => {
  it("knows a chart by its playfield and its notes", () => {
    assert.equal(classifyDocument({ playfield: { laneCount: 5 }, notes: [] }), "chart");
  });

  it("knows a project by the audio it associates", () => {
    assert.equal(classifyDocument({ audio: { path: "x.wav" }, chart: { kind: "file", path: "c.json" } }), "project");
  });

  it("refuses to guess at anything else", () => {
    assert.equal(classifyDocument({ version: "0.1.0" }), "unknown");
    assert.equal(classifyDocument(null), "unknown");
    assert.equal(classifyDocument([1, 2, 3]), "unknown");
  });
});

describe("resolving a reference", () => {
  it("resolves a relative path against the document that made it", () => {
    const candidates = candidatePaths("D:\\projects\\song", "chart.json");
    assert.equal(candidates[0], path.resolve("D:\\projects\\song", "chart.json"));
  });

  it("leaves an absolute path alone", () => {
    const candidates = candidatePaths("D:\\projects", "C:\\Users\\me\\Music\\song.flac");
    assert.equal(candidates[0], path.resolve("C:\\Users\\me\\Music\\song.flac"));
  });

  it("offers the other drives when a reference climbed past the root of its own", () => {
    // The case this exists for: `../../../../Users/me/Music/song.flac` written from
    // D:\10.repo\... lands on D:\Users\... because Windows clamps at the drive root,
    // while the file is on C:.
    const candidates = candidatePaths("D:\\10.repo\\work\\projects", "../../../../Users/me/Music/song.flac");
    if (process.platform !== "win32") return; // drive letters are a Windows idea
    assert.equal(candidates[0], "D:\\Users\\me\\Music\\song.flac");
    assert.ok(candidates.includes("C:\\Users\\me\\Music\\song.flac"), "C: is among the candidates");
    assert.ok(candidates.every((candidate) => candidate.endsWith("Users\\me\\Music\\song.flac")));
  });

  it("has nothing to offer for a reference that is not there", () => {
    assert.deepEqual(candidatePaths("D:\\x", ""), []);
    assert.deepEqual(candidatePaths("D:\\x", undefined), []);
  });
});

describe("opening a chart directly", () => {
  it("loads it and reports where it came from", async () => {
    const session = await loadSession(CHART);
    assert.equal(session.openedKind, "chart");
    assert.equal(session.chartPath, CHART);
    assert.equal(session.chart.notes.length, 9);
    assert.equal(session.projectPath, null);
  });

  it("says so when the audio the chart names is not there, instead of refusing to open", async () => {
    const session = await loadSession(CHART);
    assert.equal(session.audio, null);
    assert.match(session.warnings.join(" "), /no audio file was found/);
  });
});

describe("opening a project", () => {
  it("follows the chart reference and keeps the project's name", async () => {
    const session = await loadSession(PROJECT);
    assert.equal(session.openedKind, "project");
    assert.equal(session.projectName, "Player test project");
    assert.equal(path.resolve(session.chartPath), CHART);
    assert.equal(session.chart.notes.length, 9);
  });

  it("reads a chart the project embedded inline", async () => {
    const file = tempFile("inline.project.json", {
      version: "0.1.0",
      audio: { path: "nowhere.wav" },
      chart: {
        kind: "inline",
        data: {
          version: "0.1.0",
          audio: { path: "nowhere.wav" },
          timing: { offsetSec: 0 },
          playfield: { laneCount: 4 },
          notes: [{ id: "n-1", type: "tap", timeSec: 0.5, lane: 1 }],
        },
      },
    });
    const session = await loadSession(file);
    assert.equal(session.chart.playfield.laneCount, 4);
    assert.equal(session.chartPath, null, "an inline chart has no file of its own");
  });

  it("plays the audio a caller names, over anything the documents say", async () => {
    const session = await loadSession(PROJECT, { audio: CHART });
    assert.ok(session.audio, "the override is used even though it is not really audio");
    assert.equal(session.audio.path, CHART);
  });

  it("refuses a project with no chart, and says why", async () => {
    const file = tempFile("empty.project.json", { version: "0.1.0", audio: { path: "a.wav" } });
    await assert.rejects(() => loadSession(file), /does not reference a chart/);
  });

  it("refuses a project whose chart is not where it says", async () => {
    const file = tempFile("lost.project.json", {
      version: "0.1.0",
      audio: { path: "a.wav" },
      chart: { kind: "file", path: "not-here.chart.json" },
    });
    await assert.rejects(() => loadSession(file), /could not be found/);
  });
});

describe("opening something else entirely", () => {
  it("refuses a file that is neither", async () => {
    const file = tempFile("notes.json", { hello: "world" });
    await assert.rejects(() => loadSession(file), /neither a Chart nor a Project/);
  });

  it("refuses a file that is not JSON", async () => {
    const file = tempFile("broken.json", "{ this is not json");
    await assert.rejects(() => loadSession(file), /not valid JSON/);
  });

  it("reads a file that begins with a byte order mark", async () => {
    const file = tempFile("bom.chart.json", `\uFEFF${JSON.stringify({
      version: "0.1.0",
      audio: { path: "a.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [],
    })}`);
    const session = await loadSession(file);
    assert.equal(session.openedKind, "chart");
  });

  it("warns rather than refuses when the chart version is one it does not know", async () => {
    const file = tempFile("future.chart.json", {
      version: "9.9.9",
      audio: { path: "a.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [],
    });
    const session = await loadSession(file);
    assert.match(session.warnings.join(" "), /not 0\.1\.x/);
  });
});
