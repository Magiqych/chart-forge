/**
 * Application shell: editor state and interaction orchestration.
 *
 * React holds the viewport, the playhead, layer visibility, the loaded projection and
 * the Chart being authored. It does not hold the Analysis document, decoded audio, or
 * anything per-event.
 *
 * Two kinds of state live here and are kept apart on purpose. The Chart document is the
 * thing that gets written to disk, and it only ever changes through the command
 * functions in core/editorSession. The hovered placement preview, the chosen note type
 * and the snap settings are working state: they steer what the next command will do and
 * are never serialised into the chart.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AnalysisProjection } from "./core/analysis";
import { ChartError, type Direction, type PlaceableType } from "./core/chart";
import {
  isDirty, markChartSaved, markSaved, openSession, place, remove, select, setSnap,
  type EditorSession,
} from "./core/editorSession";
import type { RowId } from "./core/lanes";
import { describeFailure, ProjectLoadError } from "./core/project";
import { buildSnapGrid, DEFAULT_SNAP, type SnapSettings } from "./core/snap";
import { fitToWidth, maxBoundedDuration, type Viewport } from "./core/viewport";
import {
  chooseProjectFile, confirmDiscard, openProject, saveChart, type OpenedProject,
} from "./io/documentSource";
import { loadAudio, type LoadedAudio } from "./audio/player";
import type { NotesRenderStats } from "./render/notesRenderer";
import type { RenderStats } from "./render/timelineRenderer";
import { ChartBar } from "./ui/ChartBar";
import { LayerPanel, type LayerKey } from "./ui/LayerPanel";
import { Timeline } from "./ui/Timeline";
import { Toolbar } from "./ui/Toolbar";

const ALL_LAYERS: readonly LayerKey[] = [
  "grid", "waveform", "drums", "other", "bass", "vocals", "notes",
];

export default function App(): React.JSX.Element {
  const [opened, setOpened] = useState<OpenedProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("No project loaded");
  const [view, setView] = useState<Viewport>({ startSec: 0, pixelsPerSecond: 100, widthPx: 1000 });
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [visible, setVisible] = useState<ReadonlySet<LayerKey>>(new Set(ALL_LAYERS));
  const [stats, setStats] = useState<RenderStats | null>(null);
  const [notesStats, setNotesStats] = useState<NotesRenderStats | null>(null);

  // The document being authored, whether it differs from what is on disk, and what is
  // selected. Every change to it goes through the command functions in core/editorSession.
  const [session, setSession] = useState<EditorSession | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  // Working state: what the next command will do. None of this is written to the chart.
  // Snap lives in the session instead, because the Project persists it.
  const [noteType, setNoteType] = useState<PlaceableType>("tap");
  const [direction, setDirection] = useState<Direction>("right");

  const audioRef = useRef<LoadedAudio | null>(null);
  const projection: AnalysisProjection | null = opened?.projection ?? null;
  const chart = session?.chart ?? null;
  const dirty = session ? isDirty(session) : false;
  const selectedNoteId = session?.selectedNoteId ?? null;
  const snap = session?.snap ?? DEFAULT_SNAP;

  const maxEventDurationSec = useMemo(
    () => (projection ? maxBoundedDuration(projection.events) : 0),
    [projection],
  );

  // The snap grid is subdivided from the detected beats, so it is rebuilt when the
  // division changes and never synthesised from a tempo number.
  const snapGrid = useMemo(
    () => (projection ? buildSnapGrid(projection.beats, snap.division) : []),
    [projection, snap.division],
  );

  const visibleRows = useMemo<ReadonlySet<RowId>>(() => {
    const rows = new Set<RowId>(["ruler"]);
    for (const key of visible) if (key !== "grid") rows.add(key as RowId);
    return rows;
  }, [visible]);

  const loadInto = useCallback(async (path: string) => {
    setStatus("Loading...");
    const result = await openProject(path);
    setOpened(result);
    setSession(openSession(result.chart, result.snap));
    setSaveMessage(
      result.chartExisted
        ? `Chart loaded: ${result.chart.notes.length} note(s)`
        : "No chart yet - Save will create one",
    );
    setPlayheadSec(0);
    setView((v) => ({
      ...v,
      startSec: 0,
      pixelsPerSecond: fitToWidth(result.projection.audio.durationSec, v.widthPx),
    }));

    const counts = result.projection.counts;
    setStatus(
      `${counts.beats} beats (${counts.downbeats} downbeats), ${counts.events} events ` +
        `- drums ${counts.byLane.drums}, other ${counts.byLane.other}, ` +
        `bass ${counts.byLane.bass}, vocals ${counts.byLane.vocals}` +
        (result.summary.analysisHashVerified ? " - hash verified" : ""),
    );

    if (result.audioUrl) {
      audioRef.current?.element.pause();
      audioRef.current = await loadAudio(result.audioUrl);
    } else {
      audioRef.current = null;
    }
  }, []);

  const handleOpen = useCallback(async () => {
    // Unsaved notes are the author's work; opening another project must not discard
    // them without asking.
    if (
      dirty &&
      !(await confirmDiscard(
        "This chart has unsaved changes. Open another project and lose them?",
      ))
    ) {
      return;
    }
    setBusy(true);
    try {
      const path = await chooseProjectFile();
      if (!path) return;
      await loadInto(path);
    } catch (error) {
      const failure =
        error instanceof ProjectLoadError
          ? `${describeFailure(error)} ${error.detail ?? error.message}`
          : String(error);
      setStatus(failure);
      setOpened(null);
      setSession(null);
    } finally {
      setBusy(false);
    }
  }, [dirty, loadInto]);

  // --- editor commands -----------------------------------------------------------
  // The only two ways the chart changes. An undo stack would wrap exactly these.

  const handlePlace = useCallback(
    (timeSec: number, lane: number) => {
      setSession((current) => {
        if (!current) return current;
        try {
          const next = place(current, {
            timeSec,
            lane,
            type: noteType,
            ...(noteType === "flick" ? { direction } : {}),
          });
          setSaveMessage(
            `Placed ${next.selectedNoteId} in lane ${lane + 1} at ${timeSec.toFixed(3)}s`,
          );
          return next;
        } catch (error) {
          setSaveMessage(error instanceof ChartError ? error.message : String(error));
          return current;
        }
      });
    },
    [noteType, direction],
  );

  const handleSelect = useCallback((noteId: string | null) => {
    setSession((current) => (current ? select(current, noteId) : current));
  }, []);

  const handleSnap = useCallback((next: SnapSettings) => {
    setSession((current) => (current ? setSnap(current, next) : current));
  }, []);

  const handleDeleteSelected = useCallback(() => {
    setSession((current) => {
      if (!current || !current.selectedNoteId) return current;
      const id = current.selectedNoteId;
      try {
        const next = remove(current, id);
        setSaveMessage(`Deleted ${id}`);
        return next;
      } catch (error) {
        setSaveMessage(error instanceof ChartError ? error.message : String(error));
        return current;
      }
    });
  }, []);

  const handleSave = useCallback(async () => {
    const projectPath = opened?.summary.projectPath;
    if (!projectPath || !session) return;
    setSaving(true);
    try {
      const outcome = await saveChart(projectPath, session.chart, session.snap);
      setSession((current) => (current ? markSaved(current) : current));
      setSaveMessage(
        `Saved ${session.chart.notes.length} note(s) to ${outcome.chartPath}` +
          (outcome.projectUpdated ? " (project updated)" : ""),
      );
    } catch (error) {
      const failure =
        error instanceof ProjectLoadError
          ? `${describeFailure(error)} ${error.detail ?? error.message}`
          : String(error);

      // The one partial outcome: the chart is written before the project, so this error
      // means the notes are safely on disk and only the project side is outstanding.
      // Anything else failed before writing anything, and both documents stay dirty -
      // the work is still only in memory, and pretending otherwise is how people lose
      // charts.
      if (error instanceof ProjectLoadError && error.kind === "project-update-failed") {
        setSession((current) => (current ? markChartSaved(current) : current));
      }
      setSaveMessage(failure);
    } finally {
      setSaving(false);
    }
  }, [opened, session]);

  // --- transport -----------------------------------------------------------------

  const handlePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.element.paused) {
      audio.element.currentTime = playheadSec;
      void audio.element.play();
      setPlaying(true);
    } else {
      audio.element.pause();
      setPlaying(false);
    }
  }, [playheadSec]);

  // Follow the audio clock rather than a frame counter, so the playhead cannot drift.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        setPlayheadSec(audio.element.currentTime);
        if (audio.element.ended) setPlaying(false);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const handleSeek = useCallback((timeSec: number) => {
    setPlayheadSec(timeSec);
    const audio = audioRef.current;
    if (audio) audio.element.currentTime = timeSec;
  }, []);

  const toggleLayer = useCallback((key: LayerKey) => {
    setVisible((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const durationSec = projection?.audio.durationSec ?? 0;

  return (
    <div className="app">
      <Toolbar
        onOpen={() => void handleOpen()}
        busy={busy}
        canPlay={audioRef.current !== null}
        playing={playing}
        onPlayPause={handlePlayPause}
        playheadSec={playheadSec}
        durationSec={durationSec}
        view={view}
        onZoom={(pixelsPerSecond) => setView((v) => ({ ...v, pixelsPerSecond }))}
        onFit={() =>
          setView((v) => ({ ...v, startSec: 0, pixelsPerSecond: fitToWidth(durationSec, v.widthPx) }))
        }
        status={status}
      />

      <ChartBar
        enabled={chart !== null}
        noteCount={chart?.notes.length ?? 0}
        dirty={dirty}
        saving={saving}
        onSave={() => void handleSave()}
        saveMessage={saveMessage}
        noteType={noteType}
        onNoteType={setNoteType}
        direction={direction}
        onDirection={setDirection}
        snap={snap}
        onSnap={handleSnap}
        snapAvailable={snapGrid.length > 0}
        selectedNoteId={selectedNoteId}
        onDeleteSelected={handleDeleteSelected}
        targetPath={opened?.summary.chartTargetPath ?? ""}
      />

      <div className="body">
        <LayerPanel projection={projection} visible={visible} onToggle={toggleLayer} />
        <main className="stage">
          <Timeline
            projection={projection}
            view={view}
            onViewChange={setView}
            playheadSec={playheadSec}
            onSeek={handleSeek}
            visibleRows={visibleRows}
            showGrid={visible.has("grid")}
            waveform={visible.has("waveform") ? (audioRef.current?.envelope ?? null) : null}
            waveformDurationSec={audioRef.current?.durationSec ?? durationSec}
            maxEventDurationSec={maxEventDurationSec}
            onStats={setStats}
            onNotesStats={setNotesStats}
            chart={visible.has("notes") ? chart : null}
            snapGrid={snapGrid}
            snap={snap}
            selectedNoteId={selectedNoteId}
            onPlace={handlePlace}
            onSelect={handleSelect}
          />
          <footer className="stats">
            {stats
              ? `drew ${stats.drawnEvents} events, ${stats.drawnBeats} beats in ${stats.millis.toFixed(2)} ms` +
                (notesStats
                  ? ` | ${notesStats.drawnNotes} notes in ${notesStats.millis.toFixed(2)} ms`
                  : "")
              : " "}
          </footer>
        </main>
      </div>
    </div>
  );
}
