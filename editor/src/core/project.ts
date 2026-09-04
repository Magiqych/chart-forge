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
  | "audio-unreadable";

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
