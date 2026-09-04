/**
 * Project document handling: the errors the UI must distinguish, and the pure part of
 * documentRef resolution.
 *
 * The actual filesystem work happens in Rust (see src-tauri/src/loader.rs). The frontend
 * is never granted broad filesystem access: it asks the loader for the documents a
 * Project explicitly references, and gets nothing else.
 */

export type LoadFailureKind =
  | "project-unreadable"
  | "project-malformed"
  | "project-unsupported-version"
  | "analysis-missing-reference"
  | "analysis-unreadable"
  | "analysis-malformed"
  | "analysis-unsupported-version"
  | "analysis-hash-mismatch"
  | "audio-unreadable"
  | "chart-unreadable"
  | "chart-malformed"
  | "chart-unsupported-version"
  | "chart-hash-mismatch"
  | "chart-inline-unsupported"
  | "chart-write-failed"
  | "project-update-failed";

export class ProjectLoadError extends Error {
  readonly kind: LoadFailureKind;
  readonly detail: string | undefined;

  constructor(kind: LoadFailureKind, message: string, detail?: string) {
    super(message);
    this.name = "ProjectLoadError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** Human-facing summary; the UI shows this rather than a raw error string. */
export function describeFailure(error: ProjectLoadError): string {
  switch (error.kind) {
    case "project-unreadable":
      return "The project file could not be read.";
    case "project-malformed":
      return "The project file is not valid JSON, or is not a Project document.";
    case "project-unsupported-version":
      return "This project was written by a newer or older Chart Forge than this Editor reads.";
    case "analysis-missing-reference":
      return "The project does not reference an Analysis document yet.";
    case "analysis-unreadable":
      return "The Analysis document the project points at could not be found or read.";
    case "analysis-malformed":
      return "The Analysis document is not valid JSON.";
    case "analysis-unsupported-version":
      return "The Analysis document uses a version this Editor does not read.";
    case "analysis-hash-mismatch":
      return "The Analysis document has changed since the project recorded its hash.";
    case "audio-unreadable":
      return "The audio file the analysis refers to could not be opened.";
    case "chart-unreadable":
      return "The Chart document the project points at could not be read.";
    case "chart-malformed":
      return "The Chart document is not valid JSON.";
    case "chart-unsupported-version":
      return "The Chart document uses a version this Editor does not read.";
    case "chart-hash-mismatch":
      return "The Chart document has changed since the project recorded its hash.";
    case "chart-inline-unsupported":
      return "This project embeds its chart inline; this Editor saves charts to a file.";
    case "chart-write-failed":
      return "The chart could not be written. The previous chart on disk is unchanged.";
    case "project-update-failed":
      return "The chart was saved, but the project could not be updated to reference it.";
  }
}

export interface ProjectSummary {
  readonly name?: string;
  readonly version: string;
  /** Absolute path of the project file itself. */
  readonly projectPath: string;
  /** Absolute path of the resolved Analysis document, when there is one. */
  readonly analysisPath?: string;
  /** Absolute path of the audio the analysis refers to. */
  readonly audioPath?: string;
  /** True when the project recorded a hash and it matched. */
  readonly analysisHashVerified: boolean;
  /** Absolute path of the resolved Chart document, when one exists on disk. */
  readonly chartPath?: string;
  /** True when the project recorded a chart hash and it matched. */
  readonly chartHashVerified: boolean;
  /**
   * Where a save will write the chart.
   *
   * Derived by the Rust loader, not by the frontend: the Editor shows this so the author
   * knows what Save will touch, but it is never sent back as a path to write to.
   */
  readonly chartTargetPath: string;
  /**
   * `project.editor`, verbatim.
   *
   * The contract calls this "purely a convenience for restoring a session", and says any
   * Editor must work when it is missing or holds keys it does not recognise, so it is
   * carried as-is and read defensively.
   */
  readonly editor?: unknown;
}

/**
 * Whether the Editor understands a document version.
 *
 * Deliberately narrow: reading a 0.3 Analysis with 0.2 assumptions would silently
 * mis-draw rather than fail, which is worse than refusing.
 */
export function isSupportedAnalysisVersion(version: string): boolean {
  return version.startsWith("0.2.");
}

export function isSupportedProjectVersion(version: string): boolean {
  return version.startsWith("0.1.") || version.startsWith("0.2.");
}

/**
 * Resolve a documentRef path against the project file's directory.
 *
 * Pure string logic mirroring what the Rust loader does, kept here so the rule is
 * testable without a filesystem. A leading `..` is entirely legitimate - a project
 * commonly sits beside the runs directory it points into - so segments are normalised
 * rather than rejected.
 */
export function resolveRelativeRef(projectPath: string, ref: string): string {
  if (isAbsolutePath(ref)) return normalizeSeparators(ref);
  const dir = parentDirectory(normalizeSeparators(projectPath));
  return normalizePath(`${dir}/${normalizeSeparators(ref)}`);
}

export function isAbsolutePath(path: string): boolean {
  const p = normalizeSeparators(path);
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

/** Collapse `.` and `..` without touching the filesystem. */
export function normalizePath(path: string): string {
  const normalized = normalizeSeparators(path);
  const driveMatch = /^([A-Za-z]:)\//.exec(normalized);
  const prefix = driveMatch ? `${driveMatch[1]}/` : normalized.startsWith("/") ? "/" : "";
  const body = prefix ? normalized.slice(prefix.length) : normalized;

  const out: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!prefix) out.push("..");
      continue;
    }
    out.push(segment);
  }
  return prefix + out.join("/");
}

/**
 * Express `target` relative to the directory `fromDir`.
 *
 * Used when the Editor writes a Chart: the chart records the audio it is played
 * against, and a relative reference keeps the pair movable, which an absolute one taken
 * from the Analysis would not. Falls back to the absolute path when the two have no
 * common root - different Windows drives, for instance - because a wrong relative path
 * is worse than an honest absolute one.
 */
export function relativePath(fromDir: string, target: string): string {
  const from = normalizePath(fromDir);
  const to = normalizePath(target);

  const driveOf = (path: string): string => (/^[A-Za-z]:\//.exec(path)?.[0] ?? "").toLowerCase();
  if (driveOf(from) !== driveOf(to)) return to;
  if (isAbsolutePath(from) !== isAbsolutePath(to)) return to;

  const fromParts = from.split("/").filter((part) => part.length > 0);
  const toParts = to.split("/").filter((part) => part.length > 0);

  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared]!.toLowerCase() === toParts[shared]!.toLowerCase()
  ) {
    shared += 1;
  }

  const up = new Array(fromParts.length - shared).fill("..");
  const down = toParts.slice(shared);
  const joined = [...up, ...down].join("/");
  return joined.length > 0 ? joined : ".";
}

/** The directory containing a file path. Exposed for callers that need to resolve siblings. */
export function directoryOf(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? normalized : normalized.slice(0, index);
}
