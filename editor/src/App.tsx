/**
 * Application shell: editor state and interaction orchestration.
 *
 * React holds the viewport, the playhead, layer visibility and the loaded projection.
 * It does not hold the Analysis document, decoded audio, or anything per-event.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AnalysisProjection } from "./core/analysis";
import type { RowId } from "./core/lanes";
import { describeFailure, ProjectLoadError } from "./core/project";
import { fitToWidth, maxBoundedDuration, type Viewport } from "./core/viewport";
import { chooseProjectFile, openProject, type OpenedProject } from "./io/documentSource";
import { loadAudio, type LoadedAudio } from "./audio/player";
import type { RenderStats } from "./render/timelineRenderer";
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

  const audioRef = useRef<LoadedAudio | null>(null);
  const projection: AnalysisProjection | null = opened?.projection ?? null;

  const maxEventDurationSec = useMemo(
    () => (projection ? maxBoundedDuration(projection.events) : 0),
    [projection],
  );

  const visibleRows = useMemo<ReadonlySet<RowId>>(() => {
    const rows = new Set<RowId>(["ruler"]);
    for (const key of visible) if (key !== "grid") rows.add(key as RowId);
    return rows;
  }, [visible]);

  const handleOpen = useCallback(async () => {
    setBusy(true);
    try {
      const path = await chooseProjectFile();
      if (!path) return;
      setStatus("Loading...");
      const result = await openProject(path);
      setOpened(result);
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
    } catch (error) {
      const failure =
        error instanceof ProjectLoadError
          ? `${describeFailure(error)} ${error.detail ?? error.message}`
          : String(error);
      setStatus(failure);
      setOpened(null);
    } finally {
      setBusy(false);
    }
  }, []);

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
          />
          <footer className="stats">
            {stats
              ? `drew ${stats.drawnEvents} events, ${stats.drawnBeats} beats in ${stats.millis.toFixed(1)} ms`
              : " "}
          </footer>
        </main>
      </div>
    </div>
  );
}
