/**
 * The frontend's only route to documents.
 *
 * There is no general filesystem plugin: the frontend calls one Rust command with a
 * project path the user chose through the OS dialog, and receives exactly the documents
 * that project references. Nothing here can widen that.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";

import { projectAnalysis, type AnalysisProjection } from "../core/analysis";
import {
  emptyChart, projectChart, serializeChart, ChartError, type ChartState,
} from "../core/chart";
import { readSnapSettings, type SnapSettings } from "../core/snap";
import type { StemAvailability } from "../core/stemMixer";
import {
  directoryOf, relativePath,
  ProjectLoadError, type LoadFailureKind, type ProjectSummary,
} from "../core/project";

/** Shape returned by the Rust loader. Mirrors loader::LoadedProject. */
interface RawLoadedProject {
  projectPath: string;
  project: Record<string, unknown>;
  analysisPath: string | null;
  analysis: unknown;
  analysisHashVerified: boolean;
  audioPath: string | null;
  stems: RawLoadedStem[];
  chartPath: string | null;
  chart: unknown;
  chartHashVerified: boolean;
  chartTargetPath: string;
}

/** One stem the loader resolved. `path` is null when the file is not where it said. */
interface RawLoadedStem {
  id: string;
  kind: string;
  path: string | null;
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
  chartUnreadable: "chart-unreadable",
  chartMalformed: "chart-malformed",
  chartUnsupportedVersion: "chart-unsupported-version",
  chartHashMismatch: "chart-hash-mismatch",
  chartInlineUnsupported: "chart-inline-unsupported",
  chartWriteFailed: "chart-write-failed",
  projectUpdateFailed: "project-update-failed",
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
  /**
   * The Chart being authored.
   *
   * A project may legitimately have no chart yet - the contract says the reference is
   * "Absent for a project where authoring has not started" - so one is created in
   * memory here. Nothing is written to disk until the author asks to save.
   */
  readonly chart: ChartState;
  /** True when the chart came off disk rather than being created empty just now. */
  readonly chartExisted: boolean;
  /**
   * The separated stems this project can offer for audition, in the Analyzer's order.
   *
   * Empty for an analysis run without separation, which is the ordinary case for older
   * projects and must not stop one opening. A stem whose file could not be resolved is
   * still listed, with no url, so the mixer can say so rather than quietly omit it.
   */
  readonly stems: readonly StemAvailability[];
  /** Snap settings restored from `project.editor.snap`, or the defaults. */
  readonly snap: SnapSettings;
}

/**
 * Ask the user to confirm something destructive.
 *
 * The webview's own `window.confirm` is not usable here - it returns without ever
 * showing anything, so a guard built on it silently agrees to whatever it was guarding
 * against. This goes through the OS dialog the shell already has permission for.
 */
export async function confirmDiscard(message: string): Promise<boolean> {
  return ask(message, { title: "Chart Forge Editor", kind: "warning" });
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

  // Each stem is granted separately and by exactly the same route. The scope stays a
  // list of individual files the user's own project pointed at; nothing here widens it
  // to a directory. A stem that cannot be granted becomes a disabled row, not a failure
  // to open the project.
  const stems: StemAvailability[] = [];
  for (const stem of loaded.stems ?? []) {
    let url: string | null = null;
    if (stem.path) {
      try {
        url = convertFileSrc(await invoke<string>("allow_audio", { path: stem.path }));
      } catch {
        url = null;
      }
    }
    stems.push({ id: stem.id, label: stemLabel(stem), url });
  }

  // A project without a chart is a project where authoring has not started, so the
  // Editor starts one in memory. It reaches the disk only when the author saves.
  let chart: ChartState;
  const chartExisted = loaded.chart !== null && loaded.chart !== undefined;
  try {
    chart = chartExisted
      ? projectChart(loaded.chart)
      : emptyChart({
          // Relative to where the chart will live, not the Analyzer's absolute path: a
          // chart that records an absolute C: path stops working the moment the project
          // and its chart are moved anywhere else.
          audioPath: audioReferenceFor(loaded),
          audioDurationSec: projection.audio.durationSec,
          ...(typeof loaded.project["name"] === "string"
            ? { title: loaded.project["name"] }
            : {}),
        });
  } catch (error) {
    throw new ProjectLoadError(
      error instanceof ChartError ? "chart-unsupported-version" : "chart-malformed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const summary: ProjectSummary = {
    ...(typeof loaded.project["name"] === "string" ? { name: loaded.project["name"] } : {}),
    version: String(loaded.project["version"] ?? ""),
    projectPath: loaded.projectPath,
    ...(loaded.analysisPath ? { analysisPath: loaded.analysisPath } : {}),
    ...(loaded.audioPath ? { audioPath: loaded.audioPath } : {}),
    analysisHashVerified: loaded.analysisHashVerified,
    ...(loaded.chartPath ? { chartPath: loaded.chartPath } : {}),
    chartHashVerified: loaded.chartHashVerified,
    chartTargetPath: loaded.chartTargetPath,
    ...(loaded.project["editor"] !== undefined ? { editor: loaded.project["editor"] } : {}),
  };

  return {
    summary,
    projection,
    audioUrl,
    chart,
    chartExisted,
    stems,
    snap: readSnapSettings(loaded.project["editor"]),
  };
}

/**
 * What to call a stem in the mixer.
 *
 * `kind` is an open vocabulary, so this capitalises whatever the separator produced
 * rather than mapping a fixed set - a run that yields `piano` gets Piano without anyone
 * having to add it here. The id is the fallback for a stem with no kind at all.
 */
function stemLabel(stem: RawLoadedStem): string {
  const kind = stem.kind.trim();
  if (kind === "") return stem.id;
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * How a newly created Chart should refer to its audio.
 *
 * The loader resolved an absolute path; the chart wants that expressed relative to the
 * file it is about to be written to. When the audio could not be resolved at all, the
 * Analysis's own reference is carried over unchanged rather than invented.
 */
function audioReferenceFor(loaded: RawLoadedProject): string {
  const analysisPath = (loaded.analysis as { audio?: { path?: unknown } } | null)?.audio?.path;
  const fallback = typeof analysisPath === "string" ? analysisPath : "";
  if (!loaded.audioPath) return fallback;
  return relativePath(directoryOf(loaded.chartTargetPath), loaded.audioPath);
}

export interface SaveOutcome {
  readonly chartPath: string;
  /** True when the project file was rewritten to record or re-hash the reference. */
  readonly projectUpdated: boolean;
  readonly sha256: string;
}

/**
 * Write the chart for an opened project, and the snap settings that go with it.
 *
 * Only the project path crosses the boundary. The destination is derived in Rust from
 * the project on disk, so nothing in the frontend can point a write at a file of its
 * choosing, and the Analysis is not part of what gets sent.
 *
 * The chart is written first and the project only afterwards, because the project holds
 * the reference to the chart: pointing at a file before it exists would be the one
 * ordering that can leave a project referencing nothing.
 */
export async function saveChart(
  projectPath: string,
  chart: ChartState,
  snap: SnapSettings,
): Promise<SaveOutcome> {
  const document = serializeChart(chart);
  try {
    return await invoke<SaveOutcome>("save_chart", {
      projectPath,
      chart: document,
      // Only the two fields the Project contract defines for snapping. The command
      // takes a typed struct, so this is the whole of the project document the
      // frontend is able to write.
      editor: { snap: { enabled: snap.enabled, division: snap.division } },
    });
  } catch (raw) {
    throw toLoadError(raw);
  }
}
