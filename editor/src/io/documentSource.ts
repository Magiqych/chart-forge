/**
 * The frontend's only route to documents.
 *
 * There is no general filesystem plugin: the frontend calls one Rust command with a
 * project path the user chose through the OS dialog, and receives exactly the documents
 * that project references. Nothing here can widen that.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { projectAnalysis, type AnalysisProjection } from "../core/analysis";
import { ProjectLoadError, type LoadFailureKind, type ProjectSummary } from "../core/project";

/** Shape returned by the Rust loader. Mirrors loader::LoadedProject. */
interface RawLoadedProject {
  projectPath: string;
  project: Record<string, unknown>;
  analysisPath: string | null;
  analysis: unknown;
  analysisHashVerified: boolean;
  audioPath: string | null;
}

interface RawLoadError {
  kind: string;
  message: string;
  detail: string | null;
}

/** Rust reports camelCase kinds; the UI's union is kebab-case. */
const KIND_MAP: Readonly<Record<string, LoadFailureKind>> = {
  projectUnreadable: "project-unreadable",
  projectMalformed: "project-malformed",
  projectUnsupportedVersion: "project-unsupported-version",
  analysisMissingReference: "analysis-missing-reference",
  analysisUnreadable: "analysis-unreadable",
  analysisMalformed: "analysis-malformed",
  analysisUnsupportedVersion: "analysis-unsupported-version",
  analysisHashMismatch: "analysis-hash-mismatch",
  audioUnreadable: "audio-unreadable",
};

export function toLoadError(raw: unknown): ProjectLoadError {
  if (typeof raw === "object" && raw !== null && "kind" in raw) {
    const error = raw as RawLoadError;
    const kind = KIND_MAP[error.kind] ?? "project-unreadable";
    return new ProjectLoadError(kind, error.message, error.detail ?? undefined);
  }
  return new ProjectLoadError("project-unreadable", String(raw));
}

export interface OpenedProject {
  readonly summary: ProjectSummary;
  readonly projection: AnalysisProjection;
  /** Playable URL for the source audio, when the loader could resolve one. */
  readonly audioUrl: string | null;
}

/** Show the OS dialog. Returns null when the user cancels. */
export async function chooseProjectFile(): Promise<string | null> {
  const chosen = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Chart Forge project", extensions: ["json"] }],
  });
  return typeof chosen === "string" ? chosen : null;
}

export async function openProject(projectPath: string): Promise<OpenedProject> {
  let loaded: RawLoadedProject;
  try {
    loaded = await invoke<RawLoadedProject>("load_project", { path: projectPath });
  } catch (raw) {
    throw toLoadError(raw);
  }

  if (loaded.analysis === null || loaded.analysis === undefined) {
    throw new ProjectLoadError(
      "analysis-missing-reference",
      "this project does not reference an Analysis document yet",
    );
  }

  let projection: AnalysisProjection;
  try {
    projection = projectAnalysis(loaded.analysis);
  } catch (error) {
    throw new ProjectLoadError(
      "analysis-unsupported-version",
      error instanceof Error ? error.message : String(error),
    );
  }

  // The asset scope starts empty and is widened only to this one resolved file. The
  // command returns the granted path; convertFileSrc builds the platform's asset URL -
  // hand-building it produced an unplayable URL on Windows.
  let audioUrl: string | null = null;
  if (loaded.audioPath) {
    try {
      const granted = await invoke<string>("allow_audio", { path: loaded.audioPath });
      audioUrl = convertFileSrc(granted);
    } catch {
      audioUrl = null;
    }
  }

  const summary: ProjectSummary = {
    ...(typeof loaded.project["name"] === "string" ? { name: loaded.project["name"] } : {}),
    version: String(loaded.project["version"] ?? ""),
    projectPath: loaded.projectPath,
    ...(loaded.analysisPath ? { analysisPath: loaded.analysisPath } : {}),
    ...(loaded.audioPath ? { audioPath: loaded.audioPath } : {}),
    analysisHashVerified: loaded.analysisHashVerified,
  };

  return { summary, projection, audioUrl };
}
