/**
 * The Player's local host process.
 *
 * The Player is a browser application, and a browser cannot open `C:\Users\...\song.flac`
 * or a chart sitting on another drive. This process is the only thing that touches the
 * filesystem: it resolves a Project or a Chart document, finds the audio that document
 * refers to, and serves exactly those two files plus the Player's own static assets to
 * `127.0.0.1`. Nothing else is reachable.
 *
 * Node's standard library only, deliberately. The repository has no dependency manifest
 * and CLAUDE.md asks that none be invented; a Player that needs `npm install` before it
 * runs is a Player that does not run tomorrow morning.
 *
 * The Player reads a Chart and its audio. It accepts a Project document as a
 * *convenience for finding those two things* - the Project is where the author's files
 * are actually associated - and immediately forgets everything else in it. No project
 * field reaches gameplay, and nothing here is ever written back: every open is
 * read-only.
 *
 * Usage:
 *   node player/server.mjs [path-to-.project.json | path-to-.chart.json]
 *                          [--audio PATH] [--port N] [--no-open] [--host H]
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, "web");
const DEFAULT_PORT = 5273;

/** Extensions the static handler will serve, and what to call them. */
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * Audio container types a browser may be handed.
 *
 * FLAC is first because that is what the Analyzer's projects actually reference. An
 * extension that is not here is still served, as `application/octet-stream`: guessing
 * wrongly is better than refusing to play a file the user can hear in every other
 * program.
 */
const AUDIO_TYPES = {
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".webm": "audio/webm",
};

// ---------------------------------------------------------------------------
// Document resolution
// ---------------------------------------------------------------------------

/**
 * Where a reference in a document actually lives.
 *
 * `path.resolve` does the ordinary work. The rescue afterwards exists because of a real
 * case in a real project: a reference written as `../../../../Users/me/Music/song.flac`
 * from `D:\10.repo\...` climbs past the root of D: and lands on `D:\Users\...`, while the
 * file is on C:. Windows clamps at the drive root rather than crossing to another drive,
 * so the honest resolution is a path that does not exist.
 *
 * Rather than guess at what the author meant, the same tail is offered against the other
 * drive roots that exist on this machine, and the caller is told which candidate was
 * used. Nothing is written back to the document - the reference on disk stays exactly as
 * the author wrote it.
 */
export function candidatePaths(baseDir, reference) {
  if (typeof reference !== "string" || reference.length === 0) return [];
  const direct = path.resolve(baseDir, reference);
  const out = [direct];

  const parsed = path.parse(direct);
  if (parsed.root && /^[A-Za-z]:[\\/]$/.test(parsed.root)) {
    const tail = direct.slice(parsed.root.length);
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZAB") {
      const root = `${letter}:\\`;
      if (root.toLowerCase() === parsed.root.toLowerCase()) continue;
      out.push(root + tail);
    }
  }
  return out;
}

/** The first candidate that is a readable file, or null. */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // An unreadable drive is simply not a candidate.
    }
  }
  return null;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What kind of document this is.
 *
 * Decided by shape rather than by file name, because `.project.json` and `.chart.json`
 * are a convention of one author's directory and not part of any contract. A Chart is the
 * document that has a playfield and notes; a Project is the one that associates files.
 */
export function classifyDocument(document) {
  if (!isPlainObject(document)) return "unknown";
  if (isPlainObject(document.playfield) && Array.isArray(document.notes)) return "chart";
  if (isPlainObject(document.audio)) return "project";
  return "unknown";
}

class LoadError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "LoadError";
    this.detail = detail ?? null;
  }
}

async function readJson(file, what) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new LoadError(`The ${what} could not be read.`, `${file}\n${error.message}`);
  }
  try {
    // A BOM is legal in a file and fatal to JSON.parse.
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new LoadError(`The ${what} is not valid JSON.`, `${file}\n${error.message}`);
  }
}

/**
 * Resolve a chosen file into everything the Player needs: a Chart document and a path to
 * the audio it is played against.
 *
 * Accepts either document. Given a Project, the chart reference is followed - `file` or
 * `inline`, both of which the Project contract defines - and the audio is looked for
 * first where the *chart* says it is, then where the project says it is. The chart's own
 * reference comes first on purpose: the chart is the document the Player is contracted
 * to read, and it is the one that travels with the notes.
 */
export async function loadSession(chosenPath, overrides = {}) {
  const absolute = path.resolve(chosenPath);
  const document = await readJson(absolute, "document");
  const kind = classifyDocument(document);
  const warnings = [];

  let chart;
  let chartPath = null;
  let projectPath = null;
  let projectName = null;
  const audioReferences = [];

  if (kind === "chart") {
    chart = document;
    chartPath = absolute;
    audioReferences.push({ from: "chart", baseDir: path.dirname(absolute), reference: document.audio?.path });
  } else if (kind === "project") {
    projectPath = absolute;
    projectName = typeof document.name === "string" ? document.name : null;
    const reference = document.chart;
    if (!isPlainObject(reference)) {
      throw new LoadError(
        "This project does not reference a chart yet.",
        "A Player needs notes to play; open the project in the Editor and save a chart first.",
      );
    }
    if (reference.kind === "inline") {
      if (!isPlainObject(reference.data)) {
        throw new LoadError("This project embeds a chart that is not an object.", absolute);
      }
      chart = reference.data;
      audioReferences.push({ from: "chart", baseDir: path.dirname(absolute), reference: chart.audio?.path });
    } else {
      const resolved = firstExisting(candidatePaths(path.dirname(absolute), reference.path));
      if (!resolved) {
        throw new LoadError(
          "The chart this project points at could not be found.",
          `${reference.path}\nresolved against ${path.dirname(absolute)}`,
        );
      }
      chartPath = resolved;
      chart = await readJson(resolved, "chart document");
      audioReferences.push({ from: "chart", baseDir: path.dirname(resolved), reference: chart.audio?.path });
    }
    audioReferences.push({ from: "project", baseDir: path.dirname(absolute), reference: document.audio?.path });
  } else {
    throw new LoadError(
      "That file is neither a Chart nor a Project document.",
      `${absolute}\nA Chart has 'playfield' and 'notes'; a Project has 'audio'.`,
    );
  }

  if (classifyDocument(chart) !== "chart") {
    throw new LoadError("The chart document has no playfield or no notes.", chartPath ?? absolute);
  }

  // The Player reads 0.1.x charts. Refusing a version it does not know is the contract's
  // own advice - a newer chart read with older assumptions mis-plays rather than fails.
  const version = typeof chart.version === "string" ? chart.version : "";
  if (!version.startsWith("0.1.")) {
    warnings.push(
      `chart version ${version || "(missing)"} is not 0.1.x; this Player reads 0.1.x and is guessing.`,
    );
  }

  let audioPath = null;
  const audioTried = [];
  if (typeof overrides.audio === "string" && overrides.audio.length > 0) {
    const forced = firstExisting(candidatePaths(process.cwd(), overrides.audio));
    if (forced) audioPath = forced;
    else audioTried.push(path.resolve(overrides.audio));
  }
  if (!audioPath) {
    for (const reference of audioReferences) {
      if (typeof reference.reference !== "string") continue;
      const candidates = candidatePaths(reference.baseDir, reference.reference);
      audioTried.push(...candidates.slice(0, 1));
      const found = firstExisting(candidates);
      if (found) {
        audioPath = found;
        if (found !== candidates[0]) {
          warnings.push(
            `the ${reference.from}'s audio reference resolves to a file that does not exist; ` +
              `playing ${found} instead. The document was not changed.`,
          );
        }
        break;
      }
    }
  }
  if (!audioPath) {
    warnings.push(
      audioTried.length > 0
        ? `no audio file was found. Tried: ${audioTried.join(", ")}`
        : "this chart names no audio file.",
    );
  }

  let audioSizeBytes = 0;
  if (audioPath) {
    try {
      audioSizeBytes = statSync(audioPath).size;
    } catch {
      audioSizeBytes = 0;
    }
  }

  return {
    openedPath: absolute,
    openedKind: kind,
    projectPath,
    projectName,
    chartPath,
    chart,
    audio: audioPath
      ? {
          path: audioPath,
          name: path.basename(audioPath),
          type: AUDIO_TYPES[path.extname(audioPath).toLowerCase()] ?? "application/octet-stream",
          sizeBytes: audioSizeBytes,
        }
      : null,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function sessionPayload(session) {
  return {
    ok: true,
    openedPath: session.openedPath,
    openedKind: session.openedKind,
    projectPath: session.projectPath,
    projectName: session.projectName,
    chartPath: session.chartPath,
    chart: session.chart,
    audio: session.audio
      ? { name: session.audio.name, type: session.audio.type, sizeBytes: session.audio.sizeBytes, path: session.audio.path }
      : null,
    warnings: session.warnings,
  };
}

/** Serve one of the Player's own files. Nothing outside `player/web` is reachable. */
async function serveStatic(request, response, urlPath) {
  const relative = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.replace(/^\/+/, ""));
  const resolved = path.resolve(WEB_ROOT, relative);
  if (resolved !== WEB_ROOT && !resolved.startsWith(WEB_ROOT + path.sep)) {
    sendJson(response, 403, { ok: false, message: "outside the Player's asset directory" });
    return;
  }
  const type = STATIC_TYPES[path.extname(resolved).toLowerCase()];
  if (!type) {
    sendJson(response, 404, { ok: false, message: "not a Player asset" });
    return;
  }
  let body;
  try {
    body = await readFile(resolved);
  } catch {
    sendJson(response, 404, { ok: false, message: `no such asset: ${relative}` });
    return;
  }
  response.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    // The app is edited and reloaded constantly while it is being built; a cached copy
    // of yesterday's bundle is the least useful thing a local server can offer.
    "cache-control": "no-store",
  });
  response.end(body);
}

/**
 * Stream the session's audio, honouring Range.
 *
 * Range matters even for a local file: a browser asks for one before it will let the
 * element seek, and `decodeAudioData` on a 30 MB FLAC is happier with a normal streamed
 * response than with one enormous buffer written in a single chunk.
 */
function serveAudio(request, response, session) {
  const audio = session?.audio;
  if (!audio) {
    sendJson(response, 404, { ok: false, message: "this session has no audio" });
    return;
  }

  let size;
  try {
    size = statSync(audio.path).size;
  } catch (error) {
    sendJson(response, 404, { ok: false, message: `audio unreadable: ${error.message}` });
    return;
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (range) {
    const start = range[1] === "" ? Math.max(0, size - Number(range[2] || 0)) : Number(range[1]);
    const end = range[1] === "" ? size - 1 : range[2] === "" ? size - 1 : Math.min(size - 1, Number(range[2]));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      response.writeHead(416, { "content-range": `bytes */${size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      "content-type": audio.type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    createReadStream(audio.path, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "content-type": audio.type,
    "content-length": size,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });
  createReadStream(audio.path).pipe(response);
}

function readBody(request, limitBytes = 1 << 16) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Strip a pair of quotes a shell left behind.
 *
 * A path dropped on a `.cmd` file, or passed through one layer of shell too many, can
 * arrive with its quotes still attached. `"D:\a b\c.json"` is never a real file name, so
 * taking them off is unambiguous and saves a puzzling "no such file" over a path that is
 * printed back looking perfectly correct.
 */
function unquote(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function parseArgs(argv) {
  const options = { path: null, audio: null, port: DEFAULT_PORT, host: "127.0.0.1", open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === "--audio") options.audio = unquote(argv[++i]) ?? null;
    else if (argument === "--port") options.port = Number(argv[++i] ?? DEFAULT_PORT) || DEFAULT_PORT;
    else if (argument === "--host") options.host = argv[++i] ?? "127.0.0.1";
    else if (argument === "--no-open") options.open = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--")) options.unknown = argument;
    else if (options.path === null) options.path = unquote(argument);
  }
  return options;
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      // The empty string is the window title `start` insists on when the URL is quoted.
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Not being able to open a browser is not a reason to stop serving.
  }
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(
      "Chart Forge Player\n\n" +
        "  node player/server.mjs [PROJECT-OR-CHART.json] [--audio PATH] [--port N] [--host H] [--no-open]\n\n" +
        "Opens a Chart document - directly, or through the Project that references one -\n" +
        "and serves it to a browser on 127.0.0.1. Nothing is ever written.\n",
    );
    return 0;
  }
  if (options.unknown) {
    process.stderr.write(`[player] unknown option ${options.unknown}\n`);
    return 2;
  }

  let session = null;
  let sessionError = null;
  if (options.path) {
    try {
      session = await loadSession(options.path, { audio: options.audio });
    } catch (error) {
      sessionError = { message: error.message, detail: error.detail ?? null };
      process.stderr.write(`[player] ${error.message}\n${error.detail ?? ""}\n`);
    }
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const route = url.pathname;

    if (route === "/api/session" && request.method === "GET") {
      if (session) sendJson(response, 200, sessionPayload(session));
      else sendJson(response, 200, { ok: false, ...(sessionError ?? { message: "No chart opened yet." }) });
      return;
    }

    if (route === "/api/open" && request.method === "POST") {
      readBody(request)
        .then(async (body) => {
          const requested = JSON.parse(body || "{}");
          if (typeof requested.path !== "string" || requested.path.length === 0) {
            sendJson(response, 400, { ok: false, message: "no path given" });
            return;
          }
          try {
            session = await loadSession(requested.path, { audio: requested.audio ?? null });
            sessionError = null;
            process.stdout.write(`[player] opened ${session.openedPath}\n`);
            sendJson(response, 200, sessionPayload(session));
          } catch (error) {
            sendJson(response, 200, { ok: false, message: error.message, detail: error.detail ?? null });
          }
        })
        .catch((error) => sendJson(response, 400, { ok: false, message: error.message }));
      return;
    }

    if (route === "/media/audio" && (request.method === "GET" || request.method === "HEAD")) {
      serveAudio(request, response, session);
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { ok: false, message: "method not allowed" });
      return;
    }

    void serveStatic(request, response, route);
  });

  return await new Promise((resolve) => {
    server.on("error", (error) => {
      process.stderr.write(`[player] cannot listen on ${options.host}:${options.port}: ${error.message}\n`);
      if (error.code === "EADDRINUSE") {
        process.stderr.write("[player] another Player may already be running; try --port 5274\n");
      }
      resolve(1);
    });
    server.listen(options.port, options.host, () => {
      const url = `http://${options.host}:${options.port}/`;
      process.stdout.write(`[player] Chart Forge Player is serving ${url}\n`);
      if (session) {
        process.stdout.write(`[player] chart: ${session.chartPath ?? session.openedPath}\n`);
        process.stdout.write(`[player] audio: ${session.audio?.path ?? "(none found)"}\n`);
        for (const warning of session.warnings) process.stdout.write(`[player] note: ${warning}\n`);
      } else {
        process.stdout.write("[player] no document given; open one from the Player's start screen.\n");
      }
      process.stdout.write("[player] press Ctrl+C to stop.\n");
      if (options.open) openBrowser(url);
    });
  });
}

// Only when run as a program, so the tests can import the resolver without a server.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const code = await main(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
