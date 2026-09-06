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

import type { AnalysisProjection, LaneId, ProjectedEvent } from "./core/analysis";
import {
  chainOf, ChartError, flickEndAction, isBoundedPlaceable, travelsBetweenLanes,
  type ChartNote, type EditorMode, type FlickDirection, type PlaceableType,
} from "./core/chart";
import {
  addToSelection, canRedoSession, canUndoSession, changeEndAction, changeFlickDirection,
  chartOf, clearSelection, connect, connectableSelection, disconnect, disconnectableRun,
  disconnectFlickRun, isDirty,
  markChartSaved, markSaved, moveSelected, openSession, place, placeAtEvent, redo,
  removeSelected, resize, select, selectEvent, selectMany, setSnap, setSnapMode,
  soleSelectedId, toggleSelected, undo,
  type EditorSession,
} from "./core/editorSession";

/**
 * Stable empties, so "nothing selected" is the same value every render and the memos
 * and effects that watch the selection do not fire on a new empty array each time.
 */
const EMPTY_SELECTION: readonly string[] = [];
const EMPTY_NOTES: readonly ChartNote[] = [];
import type { RowId } from "./core/lanes";
import { describeFailure, ProjectLoadError } from "./core/project";
import {
  buildSnapGrid, DEFAULT_SNAP, type SnapMode, type SnapSettings,
} from "./core/snap";
import {
  centreOnTime, fitToWidth, followStartSec, maxBoundedDuration, revealStartSec,
  startSecAfterZoom, type Viewport,
} from "./core/viewport";
import { isEditableTarget } from "./core/keyboard";
import { keyboardSeekTarget } from "./core/keyboardSeek";
import { describeAnchor, type GuideAnchor } from "./core/guideAnchors";
import {
  createAuditionController, planNavigationAudition, type AuditionMedia,
} from "./core/audition";
import {
  eventStep, navigableEvents, navigationReferenceSec,
} from "./core/eventNavigation";
import {
  chooseProjectFile, confirmDiscard, openProject, saveChart, type OpenedProject,
} from "./io/documentSource";
import { loadAudio, type LoadedAudio } from "./audio/player";
import { createHitSoundEngine, type HitSoundEngine } from "./audio/hitsound";
import {
  advanceScheduler, idleScheduler, resetSchedulerTo, voiceForNote,
  type HitVoice, type SchedulerState,
} from "./core/hitScheduler";
import type { NotesRenderStats } from "./render/notesRenderer";
import type { RenderStats } from "./render/timelineRenderer";
import { ChartBar } from "./ui/ChartBar";
import { LayerPanel, type LayerKey } from "./ui/LayerPanel";
import { Timeline } from "./ui/Timeline";
import { Toolbar } from "./ui/Toolbar";

/** The click a placement makes, chosen from the kind rather than restated at each call. */
function auditionVoice(type: PlaceableType): HitVoice {
  switch (type) {
    case "flick": return "flick";
    case "hold": return "holdStart";
    default: return "tap";
  }
}

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
  // Playback and audition settings. Session state throughout: none of it touches a
  // document, so none of it is undoable, dirties anything, or is persisted.
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [hitSoundOn, setHitSoundOn] = useState(true);
  /**
   * Whether an arrow-key seek plays a moment of the song.
   *
   * Session state, like the rest of the playback settings: it changes no document, is not
   * undoable, and has nowhere in the Project contract to live.
   */
  const [auditionOn, setAuditionOn] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [followPlayhead, setFollowPlayhead] = useState(false);
  /**
   * The top-level split: are we making notes, or choosing them?
   *
   * Select is the default. An opening click should never create something the author did
   * not ask for, and Edit is one deliberate press away.
   */
  const [mode, setMode] = useState<EditorMode>("select");
  /** Which kind Edit Mode places. Meaningless in Select Mode, which places nothing. */
  const [noteType, setNoteType] = useState<PlaceableType>("tap");
  const [direction, setDirection] = useState<FlickDirection>("right");
  /**
   * How the next Long or Slide will finish.
   *
   * `null` is an ordinary release. Chosen before drawing the note as well as changeable
   * afterwards, because an author often knows a hold ends in a flick before they draw it.
   */
  const [endFlick, setEndFlick] = useState<FlickDirection | null>(null);
  // The lane `Place Note at Event` uses. A click on the timeline takes its lane from the
  // band that was clicked; a placement from an event has no such position, so the author
  // states the lane here. Nothing derives it from the event's stem.
  const [eventLane, setEventLane] = useState(0);

  const audioRef = useRef<LoadedAudio | null>(null);
  const hitSoundRef = useRef<HitSoundEngine | null>(null);
  const schedulerRef = useRef<SchedulerState>(idleScheduler());
  // The chart the scheduler reads. A ref so the playback loop does not have to be torn
  // down and rebuilt every time a note is placed.
  const notesRef = useRef<readonly ChartNote[]>([]);
  const projection: AnalysisProjection | null = opened?.projection ?? null;
  const chart = session ? chartOf(session) : null;
  const dirty = session ? isDirty(session) : false;
  const selectedNoteIds = session?.selectedNoteIds ?? EMPTY_SELECTION;
  const snap = session?.snap ?? DEFAULT_SNAP;
  const snapMode: SnapMode = session?.snapMode ?? "beat";
  const selectedEventId = session?.selectedEventId ?? null;

  /**
   * The click engine, built on first use.
   *
   * Browsers will not start an AudioContext without a gesture, so it is created the
   * first time a note actually needs to sound - which is always inside a click or a key
   * press - rather than on mount.
   */
  const hitSound = useCallback((): HitSoundEngine | null => {
    if (!hitSoundRef.current) {
      try {
        hitSoundRef.current = createHitSoundEngine(new AudioContext());
      } catch {
        // No Web Audio: the Editor works, it simply does not click.
        return null;
      }
    }
    return hitSoundRef.current;
  }, []);

  useEffect(() => () => hitSoundRef.current?.close(), []);

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

  /**
   * The analysis lanes currently switched on.
   *
   * Keyboard navigation walks the events in these and no others: an event in a hidden
   * layer is not on screen, so jumping to it would move the playhead somewhere for no
   * visible reason. `notes` is deliberately not among them - Chart Notes are what the
   * author is writing, not observations to read through.
   */
  const visibleLanes = useMemo<ReadonlySet<LaneId>>(() => {
    const lanes = new Set<LaneId>();
    for (const key of ["drums", "other", "bass", "vocals"] as const) {
      if (visible.has(key)) lanes.add(key);
    }
    return lanes;
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
      if (mode !== "edit") return;
      const kind = noteType;
      const endAction = flickEndAction(endFlick);
      setSession((current) => {
        if (!current) return current;
        try {
          // A note the author placed by aiming at an event records that event, which is
          // exactly what the contract's `sourceEventId` is for: "a human-authored
          // back-reference ... never a claim that the note was generated from the event".
          // The author still chose the lane, the kind, and to place anything at all.
          const aimedAt = lastAnchorRef.current;
          const next = place(current, {
            timeSec,
            lane,
            type: kind,
            ...(kind === "flick" ? { direction } : {}),
            ...(endAction !== null && isBoundedPlaceable(kind) ? { endAction } : {}),
            ...(aimedAt !== null ? { sourceEventId: aimedAt.eventId } : {}),
          });
          setSaveMessage(
            `Placed ${soleSelectedId(next)} in lane ${lane + 1} at ${timeSec.toFixed(3)}s`,
          );
          // Audition the note that was just created. Only a placement that succeeded
          // gets a sound - a rejected one falls to the catch below and stays silent.
          if (hitSoundOn) hitSound()?.play(auditionVoice(kind));
          return next;
        } catch (error) {
          setSaveMessage(error instanceof ChartError ? error.message : String(error));
          return current;
        }
      });
    },
    [mode, noteType, direction, endFlick, hitSoundOn, hitSound],
  );

  /**
   * Commit a note dragged out in the lanes.
   *
   * Goes through the same `place` command as a click, so it lands in the undo history,
   * auditions, and is serialised by the same code. The persisted types are the Chart
   * contract's own words, `hold` and `slide`. Which one it is decides whether an end
   * lane is recorded: a Long is a duration in one lane, a Slide travels.
   */
  const handlePlaceDragged = useCallback(
    (startSec: number, endSec: number, lane: number, endLane: number | undefined) => {
      if (mode !== "edit" || !isBoundedPlaceable(noteType)) return;
      const kind = noteType;
      const endAction = flickEndAction(endFlick);
      setSession((current) => {
        if (!current) return current;
        try {
          const next = place(current, {
            timeSec: startSec,
            lane,
            type: kind,
            endTimeSec: endSec,
            ...(travelsBetweenLanes(kind) && endLane !== undefined ? { endLane } : {}),
            ...(endAction !== null ? { endAction } : {}),
          });
          setSaveMessage(
            `Placed ${soleSelectedId(next)} in lane ${lane + 1} at ${startSec.toFixed(3)}s ` +
              `for ${(endSec - startSec).toFixed(3)}s` +
              (endLane !== undefined && endLane !== lane ? ` to lane ${endLane + 1}` : ""),
          );
          if (hitSoundOn) hitSound()?.play("holdStart");
          return next;
        } catch (error) {
          setSaveMessage(error instanceof ChartError ? error.message : String(error));
          return current;
        }
      });
    },
    [mode, noteType, endFlick, hitSoundOn, hitSound],
  );

  /**
   * Change mode.
   *
   * Leaving Select drops the selection: the things it names are only actionable in
   * Select, and carrying a stale one into Edit would leave Delete armed against notes
   * the author can no longer see highlighted as a group.
   */
  const handleMode = useCallback((next: EditorMode) => {
    setMode(next);
    if (next === "edit") {
      setSession((current) => (current ? clearSelection(current) : current));
    }
  }, []);

  const handleSelect = useCallback((noteId: string | null) => {
    setSession((current) => (current ? select(current, noteId) : current));
  }, []);

  /**
   * Commit what a rubber band caught.
   *
   * One selection change for the whole gesture: the band itself lives in the Timeline
   * and never reaches here until the pointer comes up.
   */
  const handleSelectMany = useCallback((noteIds: readonly string[], add: boolean) => {
    setSession((current) =>
      current ? (add ? addToSelection(current, noteIds) : selectMany(current, noteIds)) : current,
    );
  }, []);

  const handleToggleSelected = useCallback((noteId: string) => {
    setSession((current) => (current ? toggleSelected(current, noteId) : current));
  }, []);

  /** Select every flick of the run one of them belongs to. */
  const handleSelectRun = useCallback((noteId: string, add: boolean) => {
    setSession((current) => {
      if (!current) return current;
      const ids = chainOf(chartOf(current), noteId).map((note) => note.id);
      if (ids.length === 0) return current;
      return add ? addToSelection(current, ids) : selectMany(current, ids);
    });
  }, []);

  /**
   * Commit a drag that moved the selection.
   *
   * One command for the whole gesture: the timeline previewed it without touching the
   * chart, so this is the first and only thing the history sees.
   */
  const handleMoveSelected = useCallback((deltaSec: number, deltaLane: number) => {
    setSession((current) => {
      if (!current) return current;
      try {
        const next = moveSelected(current, deltaSec, deltaLane);
        if (next !== current) {
          const count = current.selectedNoteIds.length;
          setSaveMessage(
            `Moved ${count} note${count === 1 ? "" : "s"} by ${deltaSec.toFixed(3)}s` +
              (deltaLane === 0 ? "" : ` and ${Math.abs(deltaLane)} lane${Math.abs(deltaLane) === 1 ? "" : "s"}`),
          );
        }
        return next;
      } catch (error) {
        setSaveMessage(error instanceof ChartError ? error.message : String(error));
        return current;
      }
    });
  }, []);

  /** Commit a drag on a held note's grip. Changes the end and nothing else. */
  const handleResize = useCallback((noteId: string, endTimeSec: number) => {
    setSession((current) => {
      if (!current) return current;
      try {
        const next = resize(current, noteId, endTimeSec);
        if (next !== current) {
          const note = chartOf(next).notes.find((candidate) => candidate.id === noteId);
          if (note?.endTimeSec !== undefined) {
            setSaveMessage(
              `${noteId} now lasts ${(note.endTimeSec - note.timeSec).toFixed(3)}s`,
            );
          }
        }
        return next;
      } catch (error) {
        setSaveMessage(error instanceof ChartError ? error.message : String(error));
        return current;
      }
    });
  }, []);

  /**
   * Join what is selected: two slide points into one slide, or two flicks into a run.
   *
   * Which one is decided by what is selected rather than by two buttons, so the message
   * has to say which happened - the two results look and behave quite differently.
   */
  const handleConnect = useCallback(() => {
    setSession((current) => {
      if (!current) return current;
      try {
        const { kind } = connectableSelection(current);
        const next = connect(current);
        if (next !== current) {
          const size = kind === "run"
            ? chainOf(chartOf(next), next.selectedNoteIds[0] as string).length
            : 0;
          setSaveMessage(
            kind === "run"
              ? `Connected a run of ${size} flicks`
              : "Connected two slide points",
          );
        }
        return next;
      } catch (error) {
        setSaveMessage(error instanceof ChartError ? error.message : String(error));
        return current;
      }
    });
  }, []);

  /**
   * Change how the selected note finishes.
   *
   * One history step, and the same command whether the author picks it from the toolbar
   * while placing or from the inspector afterwards.
   */
  const handleEndAction = useCallback((action: FlickDirection | null) => {
    setSession((current) => {
      if (!current) return current;
      const id = soleSelectedId(current);
      if (id === null) return current;
      try {
        const next = changeEndAction(current, id, flickEndAction(action));
        if (next !== current) {
          setSaveMessage(
            action === null ? `${id} ends on release` : `${id} ends in a ${action} flick`,
          );
        }
        return next;
      } catch (error) {
        setSaveMessage(error instanceof ChartError ? error.message : String(error));
        return current;
      }
    });
  }, []);

  /**
   * Turn the selected standalone Flick round.
   *
   * A different command from the end action, writing a different field, because a Flick's
   * own direction and the way a Long finishes are different statements that happen to
   * offer the same two choices.
   */
  const handleFlickDirection = useCallback((direction: FlickDirection) => {
    setSession((current) => {
      if (!current) return current;
      const id = soleSelectedId(current);
      if (id === null) return current;
      try {
        const next = changeFlickDirection(current, id, direction);
        if (next !== current) setSaveMessage(`${id} now flicks ${direction}`);
        return next;
      } catch (error) {
        setSaveMessage(error instanceof ChartError ? error.message : String(error));
        return current;
      }
    });
  }, []);

  /** Take the selected slide back to the two points it was made of. */
  /**
   * Take apart whatever the selection is joined into.
   *
   * A run of flicks or a slide, decided by what is selected rather than by two buttons:
   * the author's question is the same either way, and only the answer differs.
   */
  const handleDisconnect = useCallback(() => {
    setSession((current) => {
      if (!current) return current;
      try {
        const runId = disconnectableRun(current);
        if (runId !== null) {
          const size = chainOf(chartOf(current), runId).length;
          const next = disconnectFlickRun(current, runId);
          if (next !== current) setSaveMessage(`Disconnected a run of ${size} flicks`);
          return next;
        }
        const id = soleSelectedId(current);
        if (id === null) return current;
        const next = disconnect(current, id);
        setSaveMessage("Disconnected a slide into its points");
        return next;
      } catch (error) {
        setSaveMessage(error instanceof ChartError ? error.message : String(error));
        return current;
      }
    });
  }, []);

  /**
   * Remember what the last placement snapped to.
   *
   * Two jobs. It tells the author *why* a note moved - a snap nobody can explain feels
   * like a bug - and it lets a newly placed note record the Analysis Event it was aimed
   * at as its `sourceEventId`, which is exactly the provenance that field is for.
   */
  const lastAnchorRef = useRef<GuideAnchor | null>(null);
  const handleSnapped = useCallback((anchor: GuideAnchor | null) => {
    lastAnchorRef.current = anchor;
    if (anchor) setSaveMessage(`Snap: ${describeAnchor(anchor)}`);
  }, []);

  const handleClearSelection = useCallback(() => {
    setSession((current) => (current ? clearSelection(current) : current));
  }, []);

  const handleSnap = useCallback((next: SnapSettings) => {
    setSession((current) => (current ? setSnap(current, next) : current));
  }, []);

  const handleUndo = useCallback(() => {
    setSession((current) => (current ? undo(current) : current));
  }, []);

  const handleRedo = useCallback(() => {
    setSession((current) => (current ? redo(current) : current));
  }, []);

  const handleSnapMode = useCallback((mode: SnapMode) => {
    setSession((current) => (current ? setSnapMode(current, mode) : current));
  }, []);

  // Consulting the overlay, not editing it: this dirties nothing and creates nothing.
  const handleSelectEvent = useCallback((event: ProjectedEvent | null) => {
    setSession((current) => (current ? selectEvent(current, event?.id ?? null) : current));
  }, []);

  /**
   * The second, explicit step: place a note at the selected event's measured start.
   *
   * Selecting an event never creates anything, so this is where authoring happens. The
   * lane and the note type come from the author's own choices in the toolbar, and the
   * time is the event's `startSec` verbatim - deliberately not snapped, because the
   * point of picking an event was to use where the sound actually is.
   */
  const handlePlaceAtEvent = useCallback(() => {
    if (mode !== "edit") return;
    const kind = noteType;
    setSession((current) => {
      if (!current || !current.selectedEventId) return current;
      const event = projection?.events.find((e) => e.id === current.selectedEventId);
      if (!event) return current;
      try {
        const next = placeAtEvent(
          current,
          event,
          eventLane,
          kind,
          kind === "flick" ? direction : undefined,
        );
        setSaveMessage(
          `Placed ${soleSelectedId(next)} in lane ${eventLane + 1} at ` +
            `${event.startSec.toFixed(3)}s from ${event.id} (exact, not snapped)`,
        );
        if (hitSoundOn) hitSound()?.play(auditionVoice(kind));
        return next;
      } catch (error) {
        setSaveMessage(error instanceof ChartError ? error.message : String(error));
        return current;
      }
    });
  }, [projection, eventLane, mode, noteType, direction, hitSoundOn, hitSound]);

  /**
   * Delete everything selected, as one step.
   *
   * The keyboard, the toolbar and the inspector all call exactly this, so there is one
   * delete in the Editor and undo reverses the author's decision rather than the twenty
   * notes it happened to touch.
   */
  const handleDeleteSelected = useCallback(() => {
    setSession((current) => {
      if (!current || current.selectedNoteIds.length === 0) return current;
      const count = current.selectedNoteIds.length;
      try {
        const next = removeSelected(current);
        setSaveMessage(`Deleted ${count} note${count === 1 ? "" : "s"}`);
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
      const outcome = await saveChart(projectPath, chartOf(session), session.snap);
      setSession((current) => (current ? markSaved(current) : current));
      setSaveMessage(
        `Saved ${chartOf(session).notes.length} note(s) to ${outcome.chartPath}` +
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

  /**
   * Push the volume onto the element that is actually playing.
   *
   * An effect rather than a call inside the slider handler, so a track loaded after the
   * volume was set still starts at that volume, and so a change lands mid-playback
   * without waiting for anything.
   */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.element.volume = Math.min(1, Math.max(0, volume));
    audio.element.muted = muted;
    audio.element.playbackRate = playbackRate;
  }, [volume, muted, playbackRate, opened]);

  const handleToggleMute = useCallback(() => {
    setMuted((current) => !current);
  }, []);

  /** Keep the notes the playback loop reads current without restarting it. */
  useEffect(() => {
    notesRef.current = chart?.notes ?? [];
  }, [chart]);

  const handlePlayPause = useCallback(() => {
    // Whatever the author does with the transport wins: a pending audition stop must not
    // arrive a moment later and pause the playback they just started.
    auditionRef.current.cancel();
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.element.paused) {
      audio.element.currentTime = playheadSec;
      // Resume announces nothing before the position it resumed from: those notes have
      // already been heard. A note just after it sounds normally.
      schedulerRef.current = resetSchedulerTo(playheadSec);
      void audio.element.play();
      setPlaying(true);
    } else {
      audio.element.pause();
      schedulerRef.current = idleScheduler();
      setPlaying(false);
    }
  }, [playheadSec]);

  /**
   * The playback loop.
   *
   * The audio element's own `currentTime` is the clock for everything here - the
   * playhead, the note clicks and the follow scroll. A frame counter or a wall clock
   * would drift from the music, and at 0.75x speed it would drift four times faster.
   */
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        const now = audio.element.currentTime;
        setPlayheadSec(now);

        if (hitSoundOn) {
          const step = advanceScheduler(schedulerRef.current, now, notesRef.current);
          schedulerRef.current = step.state;
          if (step.fired.length > 0) {
            const engine = hitSound();
            // A chord fires every one of its notes: hearing only one lane would
            // misreport the chart.
            for (const note of step.fired) engine?.play(voiceForNote(note));
          }
        } else {
          // Keep the cursor level with playback so switching the clicks back on does
          // not replay everything heard while they were off.
          schedulerRef.current = resetSchedulerTo(now);
        }

        if (audio.element.ended) setPlaying(false);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, hitSoundOn, hitSound]);

  /**
   * Move the playhead to a time, and take the audio element with it.
   *
   * The element's `currentTime` is the clock the playhead, the note clicks and Follow all
   * read, so a seek writes there and everything else follows. There is no second notion
   * of "where we are".
   */
  const seekPlayheadTo = useCallback((timeSec: number) => {
    setPlayheadSec(timeSec);
    const audio = audioRef.current;
    if (audio) audio.element.currentTime = timeSec;
    // A jump is not playback: the notes passed over were not played and must not sound.
    schedulerRef.current = resetSchedulerTo(timeSec);
  }, []);

  const handleSeek = useCallback(
    (timeSec: number) => seekPlayheadTo(timeSec),
    [seekPlayheadTo],
  );

  /**
   * The one audition in flight, if any.
   *
   * Held in a ref rather than state: it is machinery, not something the interface
   * renders, and rebuilding it on every render would lose the pending stop.
   */
  const auditionRef = useRef(
    createAuditionController({
      set: (callback, ms) => window.setTimeout(callback, ms),
      clear: (handle) => window.clearTimeout(handle),
    }),
  );

  /**
   * Let the author hear where a keyboard seek landed.
   *
   * Deliberately called *after* the seek and separately from it: working out where to go
   * is a calculation and making a sound is a side effect, and the two are easier to reason
   * about apart. Nothing here touches the chart, the history or the dirty state.
   */
  const auditionAt = useCallback((targetSec: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const media: AuditionMedia = {
      play: () => audio.element.play(),
      pause: () => audio.element.pause(),
      setCurrentTime: (timeSec) => {
        audio.element.currentTime = timeSec;
      },
    };
    auditionRef.current.run(
      media,
      planNavigationAudition({
        targetSec,
        wasPlaying: playingRef.current,
        enabled: auditionOnRef.current,
      }),
    );
  }, []);

  /**
   * One arrow-key step, sized to the current zoom.
   *
   * The step is a distance on screen rather than a number of seconds, so a press moves
   * the playhead about the same visible amount however far in the author has zoomed -
   * fine work when zoomed in, useful travel when zoomed out.
   */
  const stepPlayhead = useCallback(
    (direction: -1 | 1, coarse: boolean) => {
      const target = keyboardSeekTarget(
        viewRef.current,
        playheadSecRef.current,
        direction,
        durationSecRef.current,
        coarse,
      );
      seekPlayheadTo(target);
      revealPlayheadAt(target);
      auditionAt(target);
      setSaveMessage(`${target.toFixed(3)}s`);
    },
    [seekPlayheadTo, auditionAt],
  );

  /**
   * Walk to the next or previous Analysis Event in the layers that are switched on.
   *
   * Selecting the event as well as seeking to it is what makes a run of presses useful:
   * the inspector shows each one in turn, so the author can read what the Analyzer found
   * without clicking every onset.
   */
  const stepEvent = useCallback(
    (direction: -1 | 1) => {
      const events = navigableEvents(projectionRef.current?.events ?? [], visibleLanesRef.current);
      if (events.length === 0) {
        setSaveMessage("No analysis events in the visible layers");
        return;
      }
      const selected = selectedEventRef.current;
      const from = navigationReferenceSec(selected, playheadSecRef.current);
      const target = eventStep(events, from, direction);
      if (!target) {
        setSaveMessage(direction === 1 ? "Last event" : "First event");
        return;
      }
      seekPlayheadTo(target.startSec);
      revealPlayheadAt(target.startSec);
      auditionAt(target.startSec);
      setSession((current) => (current ? selectEvent(current, target.id) : current));
      setSaveMessage(
        `${direction === 1 ? "Next" : "Previous"} event: ` +
          `${target.lane ?? target.type} @ ${target.startSec.toFixed(3)}s`,
      );
    },
    [seekPlayheadTo, auditionAt],
  );

  const toggleLayer = useCallback((key: LayerKey) => {
    setVisible((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const durationSec = projection?.audio.durationSec ?? 0;

  // Read by callbacks that must not be rebuilt whenever the duration changes.
  const durationSecRef = useRef(0);
  useEffect(() => {
    durationSecRef.current = durationSec;
  }, [durationSec]);

  /**
   * Bring the playhead back on screen if a seek took it off, and otherwise leave the view
   * alone. The same rule a zoom uses, so a keyboard jump and a zoom behave alike.
   */
  const revealPlayheadAt = useCallback((timeSec: number) => {
    setView((v) => {
      const startSec = revealStartSec(v, timeSec, durationSecRef.current);
      return startSec === null ? v : { ...v, startSec };
    });
  }, []);

  /** Put the playhead in the middle of the view, wherever the view had wandered to. */
  const locatePlayhead = useCallback(() => {
    setView((v) => ({ ...v, startSec: centreOnTime(v, playheadSec, durationSecRef.current) }));
  }, [playheadSec]);

  /**
   * Keep the playhead on screen while playing, if the author asked for it.
   *
   * The view is nudged only when the playhead crosses two thirds of the width, and then
   * by a whole leading margin, so the timeline steps rather than creeping under the eye
   * every frame. There is still one viewport: the scrollbar follows because it is drawn
   * from the same `startSec`, not because anything tells it to.
   */
  useEffect(() => {
    if (!followPlayhead || !playing) return;
    setView((v) => {
      const wanted = followStartSec(v, playheadSec, durationSecRef.current);
      return wanted === null ? v : { ...v, startSec: wanted };
    });
  }, [followPlayhead, playing, playheadSec]);

  const selectionCountRef = useRef(0);
  useEffect(() => {
    selectionCountRef.current = selectedNoteIds.length;
  }, [selectedNoteIds]);

  const followPlayheadRef = useRef(false);
  useEffect(() => {
    followPlayheadRef.current = followPlayhead;
  }, [followPlayhead]);

  // Read by the zoom, which must not be rebuilt every frame of playback just to know
  // where the playhead is.
  const playheadSecRef = useRef(0);
  useEffect(() => {
    playheadSecRef.current = playheadSec;
  }, [playheadSec]);

  // Read by the audition, which must never auto-pause playback the author started.
  const playingRef = useRef(false);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const auditionOnRef = useRef(true);
  useEffect(() => {
    auditionOnRef.current = auditionOn;
  }, [auditionOn]);

  // Read by the keyboard handlers, which must not be rebuilt on every frame of playback
  // or every time a layer is toggled.
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const selectedEventRef = useRef<ProjectedEvent | null>(null);

  const projectionRef = useRef<AnalysisProjection | null>(null);
  useEffect(() => {
    projectionRef.current = projection;
  }, [projection]);

  const visibleLanesRef = useRef<ReadonlySet<LaneId>>(new Set());
  useEffect(() => {
    visibleLanesRef.current = visibleLanes;
  }, [visibleLanes]);

  /**
   * Turning Follow off the moment the author scrolls by hand.
   *
   * Fighting the author for the viewport is the worst version of this feature, so a
   * manual move wins outright and says so by clearing the toggle, rather than snapping
   * back a moment later.
   */
  /**
   * The zoom slider, which changes the scale without an anchor to hold on to.
   *
   * Goes through the same rule as the wheel: the playhead is left alone while it is
   * still on screen, and brought back when the new scale has pushed it off.
   */
  const handleZoom = useCallback((pixelsPerSecond: number) => {
    setView((v) => {
      const zoomed = { ...v, pixelsPerSecond };
      const startSec = startSecAfterZoom(
        zoomed, playheadSecRef.current, durationSecRef.current, followPlayheadRef.current,
      );
      return startSec === null ? zoomed : { ...zoomed, startSec };
    });
  }, []);

  /**
   * Take the canvas width the Timeline measured into the one viewport.
   *
   * Before this the viewport carried a placeholder width, so every span the App worked
   * out - Fit, Locate Playhead, the zoom slider and, worst of all, Follow - was computed
   * against a screen that did not exist. Follow in particular concluded that the whole
   * recording already fitted and refused to scroll at all.
   *
   * Deliberately not routed through `handleViewChange`: a resize is not the author
   * taking the wheel, and must not switch Follow off.
   */
  const handleMeasuredWidth = useCallback((widthPx: number) => {
    setView((v) => (v.widthPx === widthPx ? v : { ...v, widthPx }));
  }, []);

  const handleViewChange = useCallback((next: Viewport) => {
    setView((current) => {
      // Only a pan counts as taking the wheel. A zoom changes the lens, not where the
      // author wants to be looking, and the Timeline has already moved `startSec` to
      // honour Follow through it - treating that as a manual move would switch Follow
      // off every time the author zoomed in on the thing they were following.
      const panned =
        next.pixelsPerSecond === current.pixelsPerSecond && next.startSec !== current.startSec;
      if (followPlayheadRef.current && panned) setFollowPlayhead(false);
      return next;
    });
  }, []);

  /**
   * The Editor's one keyboard listener.
   *
   * Deliberately a single handler rather than a shortcut framework: there are six
   * bindings, and a registry for six is more machinery than the problem. Every one of
   * them defers to a field the browser is already editing, so typing into the open
   * dialog or operating a slider keeps its native behaviour.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as (HTMLElement & { type?: string }) | null;
      if (isEditableTarget(target?.tagName, target?.isContentEditable, target?.type)) return;

      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          handleUndo();
        } else if (key === "y" || (key === "z" && event.shiftKey)) {
          event.preventDefault();
          handleRedo();
        }
        return;
      }
      if (event.altKey) return;

      switch (event.key) {
        case "Delete":
        case "Backspace":
          // Only claim the key when there is something to delete, so Backspace keeps
          // its ordinary meaning everywhere else.
          if (selectionCountRef.current > 0) {
            event.preventDefault();
            handleDeleteSelected();
          }
          break;
        case "Escape":
          // Drop the selection rather than acting on it. Claimed only when there is a
          // selection to drop, so Escape keeps its ordinary meaning otherwise.
          if (selectionCountRef.current > 0) {
            event.preventDefault();
            handleClearSelection();
          }
          break;
        case " ":
          event.preventDefault();
          handlePlayPause();
          break;
        // Navigation, not editing: the same in both modes, because moving around a
        // recording is not something the choice of chart tool should change.
        case "ArrowLeft":
          event.preventDefault();
          stepPlayhead(-1, event.shiftKey);
          break;
        case "ArrowRight":
          event.preventDefault();
          stepPlayhead(1, event.shiftKey);
          break;
        case "ArrowUp":
          event.preventDefault();
          stepEvent(-1);
          break;
        case "ArrowDown":
          event.preventDefault();
          stepEvent(1);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    handleUndo, handleRedo, handlePlayPause, stepPlayhead, stepEvent,
    handleDeleteSelected, handleClearSelection,
  ]);

  const connectable = useMemo(
    () => (session ? connectableSelection(session) : { ok: false, why: "", kind: null }),
    [session],
  );

  /** How many flicks the selected run has, or 0 when the selection is not one. */
  const selectedRunSize = useMemo(() => {
    if (!session) return 0;
    const runId = disconnectableRun(session);
    return runId === null ? 0 : chainOf(chartOf(session), runId).length;
  }, [session]);

  const selectedNotes = useMemo<readonly ChartNote[]>(() => {
    if (!chart || selectedNoteIds.length === 0) return EMPTY_NOTES;
    const byId = new Map(chart.notes.map((note) => [note.id, note]));
    return selectedNoteIds.flatMap((id) => {
      const note = byId.get(id);
      return note ? [note] : [];
    });
  }, [chart, selectedNoteIds]);

  const selectedEvent = useMemo<ProjectedEvent | null>(
    () =>
      selectedEventId && projection
        ? (projection.events.find((event) => event.id === selectedEventId) ?? null)
        : null,
    [selectedEventId, projection],
  );
  selectedEventRef.current = selectedEvent;

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
        onZoom={handleZoom}
        onFit={() =>
          setView((v) => ({ ...v, startSec: 0, pixelsPerSecond: fitToWidth(durationSec, v.widthPx) }))
        }
        status={status}
        volume={volume}
        onVolume={setVolume}
        muted={muted}
        onToggleMute={handleToggleMute}
        hitSoundOn={hitSoundOn}
        onToggleHitSound={() => setHitSoundOn((on) => !on)}
        playbackRate={playbackRate}
        onPlaybackRate={setPlaybackRate}
        onLocatePlayhead={locatePlayhead}
        followPlayhead={followPlayhead}
        onToggleFollow={() => setFollowPlayhead((on) => !on)}
        auditionOn={auditionOn}
        onToggleAudition={() => setAuditionOn((on) => !on)}
      />

      <ChartBar
        enabled={chart !== null}
        noteCount={chart?.notes.length ?? 0}
        dirty={dirty}
        saving={saving}
        onSave={() => void handleSave()}
        saveMessage={saveMessage}
        canUndo={session !== null && canUndoSession(session)}
        canRedo={session !== null && canRedoSession(session)}
        onUndo={handleUndo}
        onRedo={handleRedo}
        mode={mode}
        onMode={handleMode}
        noteType={noteType}
        onNoteType={setNoteType}
        direction={direction}
        onDirection={setDirection}
        endFlick={endFlick}
        onEndFlick={setEndFlick}
        snap={snap}
        onSnap={handleSnap}
        snapMode={snapMode}
        onSnapMode={handleSnapMode}
        snapAvailable={projection !== null}
        selectedEventLabel={selectedEvent ? `${selectedEvent.id} (${selectedEvent.type})` : null}
        eventLane={eventLane}
        onEventLane={setEventLane}
        laneCount={chart?.laneCount ?? 0}
        onPlaceAtEvent={handlePlaceAtEvent}
        selectionCount={selectedNoteIds.length}
        onDeleteSelected={handleDeleteSelected}
        canConnect={connectable.ok}
        connectHint={connectable.why}
        onConnect={handleConnect}
        targetPath={opened?.summary.chartTargetPath ?? ""}
      />

      <div className="body">
        <LayerPanel
          projection={projection}
          visible={visible}
          onToggle={toggleLayer}
          selectedEvent={selectedEvent}
          selectedNotes={selectedNotes}
          onDeleteNote={handleDeleteSelected}
          canConnect={connectable.ok}
          connectHint={connectable.why}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          runSize={selectedRunSize}
          onEndAction={handleEndAction}
          onFlickDirection={handleFlickDirection}
        />
        <main className="stage">
          <Timeline
            projection={projection}
            view={view}
            onViewChange={handleViewChange}
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
            snapMode={snapMode}
            selectedNoteIds={selectedNoteIds}
            mode={mode}
            noteType={noteType}
            onPlace={handlePlace}
            onPlaceDragged={handlePlaceDragged}
            onSelect={handleSelect}
            onSelectMany={handleSelectMany}
            onToggleSelected={handleToggleSelected}
            onSelectRun={handleSelectRun}
            onMoveSelected={handleMoveSelected}
            onResize={handleResize}
            visibleLanes={visibleLanes}
            onSnapped={handleSnapped}
            playbackTimeSec={playheadSec}
            followPlayhead={followPlayhead}
            onMeasuredWidth={handleMeasuredWidth}
            selectedEventId={selectedEventId}
            onSelectEvent={handleSelectEvent}
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
