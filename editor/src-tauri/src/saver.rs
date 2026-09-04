//! Writing the Chart back out.
//!
//! The rule the loader establishes carries over: the frontend never names a file. It
//! hands over a project path the user opened and a chart document, and this module
//! derives the destination the same way the loader does. There is no command here that
//! takes an arbitrary path to write to.
//!
//! Overwriting the chart is the Editor's job - unlike the Analyzer, whose output is a
//! record of a run and is guarded against being clobbered - so an existing chart is
//! replaced without complaint. What must never happen is a half-written chart: every
//! write goes to a temporary file in the destination directory, is flushed and synced,
//! and only then replaces the target in one step. A crash mid-save leaves the previous
//! chart intact.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::loader::{chart_target, sha256_file, LoadError, LoadResult};

/// The slice of `project.editor` the Editor is allowed to write back.
///
/// Deliberately a typed struct rather than a free-form object: the frontend can persist
/// the two snap fields the Project contract defines and nothing else, so no code path
/// lets the webview rewrite arbitrary parts of a project document. Every other key under
/// `editor` - and any key a future contract adds - is left exactly as it was found.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditorState {
    pub snap: SnapState,
}

/// `project.editor.snap`, as the Project contract defines it.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapState {
    pub enabled: bool,
    /// Subdivisions per beat. The contract requires a positive integer.
    pub division: u32,
}

/// What a successful save did, so the UI can say so precisely.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SavedChart {
    /// Where the chart was written.
    pub chart_path: String,
    /// Whether the project file was rewritten - to record or re-hash the chart
    /// reference, to store changed snap settings, or both.
    pub project_updated: bool,
    /// sha256 of the bytes just written.
    pub sha256: String,
}

/// Write `bytes` to `target` without ever leaving a partial file there.
fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;

    let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let temp = dir.join(format!(".{name}.{}.tmp", std::process::id()));

    let write = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.flush()?;
        // Force the contents to the device before the rename, so a power loss cannot
        // leave the directory entry pointing at an empty file.
        file.sync_all()?;
        Ok(())
    })();

    if let Err(error) = write {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    // fs::rename replaces an existing destination on both Windows and Unix, and does so
    // in one operation: the target is either the old chart or the new one, never both.
    if let Err(error) = fs::rename(&temp, target) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

fn to_pretty_json(document: &serde_json::Value) -> String {
    let mut text = serde_json::to_string_pretty(document).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    text
}

/// Save one Chart for the project at `project_path`.
///
/// The project is re-read from disk rather than trusted from the frontend's copy, so the
/// destination is derived from what is actually on disk at save time.
///
/// Order matters, and it is chart first: the project holds the reference to the chart,
/// so the file being pointed at must exist before anything points at it. If the project
/// write then fails, the chart on disk is newer than the project - complete and valid,
/// just not yet referenced or not yet re-hashed - which the next successful save fixes.
/// The reverse order could leave a project referencing a chart that was never written.
///
/// The project file is rewritten only when it has to be: when it does not reference a
/// chart yet, when the reference carries a sha256 that this write invalidates, or when
/// the snap settings changed. Otherwise the whole save is a single atomic file write.
pub fn save_chart(
    project_path: &str,
    chart: serde_json::Value,
    editor: EditorState,
) -> LoadResult<SavedChart> {
    let project_path = Path::new(project_path);
    if !project_path.is_file() {
        return Err(LoadError::new(
            "projectUnreadable",
            format!("project file does not exist: {}", project_path.display()),
        ));
    }

    let bytes = fs::read(project_path).map_err(|e| {
        LoadError::with_detail("projectUnreadable", "cannot read the project file", e.to_string())
    })?;
    let mut project: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
        LoadError::with_detail("projectMalformed", "the project file is not valid JSON", e.to_string())
    })?;

    let target: PathBuf = chart_target(project_path, &project)?;
    let text = to_pretty_json(&chart);

    atomic_write(&target, text.as_bytes()).map_err(|e| {
        LoadError::with_detail(
            "chartWriteFailed",
            format!("could not write the chart to {}", target.display()),
            e.to_string(),
        )
    })?;

    let digest = sha256_file(&target).map_err(|e| {
        LoadError::with_detail("chartWriteFailed", "cannot hash the written chart", e.to_string())
    })?;
    let chart_path = fs::canonicalize(&target)
        .map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
        .unwrap_or_else(|_| target.display().to_string());

    let project_updated = update_project(project_path, &mut project, &target, &digest, editor)?;

    Ok(SavedChart { chart_path, project_updated, sha256: digest })
}

/// Bring the project file up to date with what was just written, if it needs it.
///
/// Runs after the chart is safely on disk, and makes at most one write: the chart
/// reference and the snap settings are decided first and then written together, so the
/// project is never rewritten twice for one save.
///
/// If this step fails the notes are not lost - they are in the chart file, complete and
/// valid - but the project may not point at them yet, so the error says exactly that and
/// the Editor keeps reporting the project side as unsaved.
fn update_project(
    project_path: &Path,
    project: &mut serde_json::Value,
    target: &Path,
    digest: &str,
    editor: EditorState,
) -> LoadResult<bool> {
    let reference_change = chart_reference_update(project, target, digest);
    let snap_change = snap_update(project, editor);

    if reference_change.is_none() && !snap_change {
        return Ok(false);
    }

    if let Some(reference) = reference_change {
        if let Some(object) = project.as_object_mut() {
            object.insert("chart".into(), reference);
        }
    }
    if snap_change {
        apply_snap(project, editor);
    }

    let text = to_pretty_json(project);
    atomic_write(project_path, text.as_bytes()).map_err(|e| {
        LoadError::with_detail(
            "projectUpdateFailed",
            format!(
                "the chart was saved to {} but the project could not be updated",
                target.display()
            ),
            e.to_string(),
        )
    })?;
    Ok(true)
}

/// The chart reference the project should carry, or `None` when it already has it right.
fn chart_reference_update(
    project: &serde_json::Value,
    target: &Path,
    digest: &str,
) -> Option<serde_json::Value> {
    match project.get("chart").cloned() {
        None | Some(serde_json::Value::Null) => {
            // A newly created chart is referenced by name only. No sha256 is recorded:
            // the Editor rewrites this file on every save, so a hash here would be stale
            // the moment it is written unless the project were rewritten every time too.
            let name = target
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "chart.json".to_string());
            Some(serde_json::json!({ "kind": "file", "path": name }))
        }
        Some(reference) => {
            // An existing reference keeps its path. Its hash, if it has one, now describes
            // the previous contents, so it has to be brought up to date or the next load
            // would fail its own integrity check.
            if reference.get("sha256").is_some() {
                let mut updated = reference.clone();
                if let Some(object) = updated.as_object_mut() {
                    object.insert("sha256".into(), serde_json::Value::String(digest.to_string()));
                }
                Some(updated)
            } else {
                None
            }
        }
    }
}

/// Whether `project.editor.snap` differs from what the author is now working with.
///
/// Compared rather than written unconditionally, so that saving a project whose snap
/// settings did not change does not rewrite the file for nothing.
fn snap_update(project: &serde_json::Value, editor: EditorState) -> bool {
    let existing = project.get("editor").and_then(|e| e.get("snap"));
    let Some(existing) = existing else { return true };
    let enabled = existing.get("enabled").and_then(|v| v.as_bool());
    let division = existing.get("division").and_then(|v| v.as_u64());
    enabled != Some(editor.snap.enabled) || division != Some(u64::from(editor.snap.division))
}

/// Write the snap settings into `project.editor`, leaving every other key alone.
///
/// The contract calls `editor` "purely a convenience for restoring a session" and allows
/// keys this Editor does not know about, so viewport, layers and anything else found
/// there survive untouched.
fn apply_snap(project: &mut serde_json::Value, editor: EditorState) {
    let Some(root) = project.as_object_mut() else { return };
    let slot = root.entry("editor").or_insert_with(|| serde_json::json!({}));
    if !slot.is_object() {
        *slot = serde_json::json!({});
    }
    if let Some(object) = slot.as_object_mut() {
        object.insert(
            "snap".into(),
            serde_json::json!({
                "enabled": editor.snap.enabled,
                "division": editor.snap.division,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-saver-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn chart(notes: &str) -> serde_json::Value {
        serde_json::from_str(&format!(
            r#"{{"version":"0.1.0","audio":{{"path":"song.wav"}},"timing":{{"offsetSec":0}},
                "playfield":{{"laneCount":5}},"notes":[{notes}]}}"#
        ))
        .unwrap()
    }

    const NOTE: &str = r#"{"id":"n-0001","type":"tap","timeSec":1.0,"lane":2}"#;

    /// The snap settings the author is working with. Beat-level snapping, on.
    fn snap_on() -> EditorState {
        EditorState { snap: SnapState { enabled: true, division: 1 } }
    }

    fn snap(enabled: bool, division: u32) -> EditorState {
        EditorState { snap: SnapState { enabled, division } }
    }

    #[test]
    fn writes_a_new_chart_beside_the_project_and_records_it() {
        let root = temp_dir("new-chart");
        let project = root.join("song.project.json");
        write(&project, r#"{"version":"0.1.0","audio":{"path":"song.wav"}}"#);

        let saved = save_chart(project.to_str().unwrap(), chart(NOTE), snap_on()).unwrap();

        assert!(saved.chart_path.replace('\\', "/").ends_with("song.chart.json"));
        assert!(saved.project_updated, "a project with no chart must gain a reference");

        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("song.chart.json")).unwrap()).unwrap();
        assert_eq!(written["notes"][0]["id"], "n-0001");

        let updated: serde_json::Value =
            serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
        assert_eq!(updated["chart"]["kind"], "file");
        assert_eq!(updated["chart"]["path"], "song.chart.json");
        assert!(
            updated["chart"].get("sha256").is_none(),
            "a chart this Editor owns should not carry a hash it invalidates on every save"
        );
        // Fields the Editor does not own must survive untouched.
        assert_eq!(updated["audio"]["path"], "song.wav");
    }

    #[test]
    fn overwrites_only_the_chart_the_project_references() {
        let root = temp_dir("targeted");
        let project = root.join("song.project.json");
        // Snap settings already match, so the only reason left to touch the project
        // would be the reference itself - and a reference without a hash needs none.
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"},
            "chart":{"kind":"file","path":"charts/mine.json"},
            "editor":{"snap":{"enabled":true,"division":1}}}"#);
        write(&root.join("charts/mine.json"), "{}");
        write(&root.join("charts/other.json"), "{\"untouched\":true}");
        write(&root.join("song.chart.json"), "{\"also-untouched\":true}");

        let saved = save_chart(project.to_str().unwrap(), chart(NOTE), snap_on()).unwrap();
        assert!(saved.chart_path.replace('\\', "/").ends_with("charts/mine.json"));
        assert!(!saved.project_updated, "a reference without a hash needs no project rewrite");

        assert_eq!(fs::read_to_string(root.join("charts/other.json")).unwrap(), "{\"untouched\":true}");
        assert_eq!(
            fs::read_to_string(root.join("song.chart.json")).unwrap(),
            "{\"also-untouched\":true}"
        );
    }

    #[test]
    fn refreshes_a_recorded_hash_so_the_next_load_still_verifies() {
        let root = temp_dir("rehash");
        let project = root.join("song.project.json");
        write(&project, &format!(
            r#"{{"version":"0.1.0","audio":{{"path":"a.wav"}},
                "chart":{{"kind":"file","path":"song.chart.json","sha256":"{}"}}}}"#,
            "0".repeat(64)
        ));
        write(&root.join("song.chart.json"), "{}");

        let saved = save_chart(project.to_str().unwrap(), chart(NOTE), snap_on()).unwrap();
        assert!(saved.project_updated);

        let updated: serde_json::Value =
            serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
        assert_eq!(updated["chart"]["sha256"], saved.sha256);
        assert_eq!(
            saved.sha256,
            sha256_file(&root.join("song.chart.json")).unwrap(),
            "the recorded hash must describe the bytes actually on disk"
        );
    }

    #[test]
    fn refuses_to_save_over_an_inline_chart() {
        let root = temp_dir("inline");
        let project = root.join("song.project.json");
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"},
            "chart":{"kind":"inline","data":{"version":"0.1.0"}}}"#);

        let error = save_chart(project.to_str().unwrap(), chart(NOTE), snap_on()).unwrap_err();
        assert_eq!(error.kind, "chartInlineUnsupported");
    }

    #[test]
    fn a_failed_write_leaves_the_previous_chart_intact() {
        let root = temp_dir("failed-write");
        let project = root.join("song.project.json");
        // The reference points at a directory, so creating the file cannot succeed.
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"},
            "chart":{"kind":"file","path":"blocked"}}"#);
        fs::create_dir_all(root.join("blocked")).unwrap();
        write(&root.join("blocked/keep.json"), "still here");

        let error = save_chart(project.to_str().unwrap(), chart(NOTE), snap_on()).unwrap_err();
        assert_eq!(error.kind, "chartWriteFailed");
        assert_eq!(fs::read_to_string(root.join("blocked/keep.json")).unwrap(), "still here");
    }

    #[test]
    fn leaves_no_temporary_file_behind_after_a_successful_save() {
        let root = temp_dir("no-temp");
        let project = root.join("song.project.json");
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"}}"#);

        save_chart(project.to_str().unwrap(), chart(NOTE), snap_on()).unwrap();

        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files left behind: {leftovers:?}");
    }

    #[test]
    fn a_second_save_replaces_the_first() {
        let root = temp_dir("resave");
        let project = root.join("song.project.json");
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"}}"#);

        save_chart(project.to_str().unwrap(), chart(NOTE), snap_on()).unwrap();
        save_chart(project.to_str().unwrap(), chart(""), snap_on()).unwrap();

        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("song.chart.json")).unwrap()).unwrap();
        assert_eq!(written["notes"].as_array().unwrap().len(), 0);
    }


    #[test]
    fn stores_the_snap_settings_in_the_project() {
        let root = temp_dir("snap-store");
        let project = root.join("song.project.json");
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"}}"#);

        save_chart(project.to_str().unwrap(), chart(NOTE), snap(false, 4)).unwrap();

        let updated: serde_json::Value =
            serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
        assert_eq!(updated["editor"]["snap"]["enabled"], false);
        assert_eq!(updated["editor"]["snap"]["division"], 4);
    }

    #[test]
    fn leaves_the_rest_of_the_editor_state_alone() {
        // The contract allows keys this Editor knows nothing about under `editor`, and
        // says any Editor must work when they are present. They must also survive a save.
        let root = temp_dir("snap-preserve");
        let project = root.join("song.project.json");
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"},
            "editor":{"viewportStartSec":12.5,"pixelsPerSecond":97.0,
                      "layers":[{"id":"waveform","visible":false}],
                      "somethingFuture":{"kept":true},
                      "snap":{"enabled":true,"division":1}}}"#);

        save_chart(project.to_str().unwrap(), chart(NOTE), snap(true, 8)).unwrap();

        let updated: serde_json::Value =
            serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
        assert_eq!(updated["editor"]["snap"]["division"], 8);
        assert_eq!(updated["editor"]["viewportStartSec"], 12.5);
        assert_eq!(updated["editor"]["pixelsPerSecond"], 97.0);
        assert_eq!(updated["editor"]["layers"][0]["id"], "waveform");
        assert_eq!(updated["editor"]["somethingFuture"]["kept"], true);
    }

    #[test]
    fn creates_the_editor_section_when_the_project_has_none() {
        let root = temp_dir("snap-create");
        let project = root.join("song.project.json");
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"},
            "chart":{"kind":"file","path":"song.chart.json"}}"#);
        write(&root.join("song.chart.json"), "{}");

        let saved = save_chart(project.to_str().unwrap(), chart(NOTE), snap(false, 2)).unwrap();
        assert!(saved.project_updated, "the snap settings had to be recorded");

        let updated: serde_json::Value =
            serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
        assert_eq!(updated["editor"]["snap"]["enabled"], false);
        assert_eq!(updated["editor"]["snap"]["division"], 2);
    }

    #[test]
    fn does_not_rewrite_the_project_when_nothing_about_it_changed() {
        let root = temp_dir("snap-unchanged");
        let project = root.join("song.project.json");
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"},
            "chart":{"kind":"file","path":"song.chart.json"},
            "editor":{"snap":{"enabled":true,"division":4}}}"#);
        write(&root.join("song.chart.json"), "{}");
        let before = fs::read_to_string(&project).unwrap();

        let saved = save_chart(project.to_str().unwrap(), chart(NOTE), snap(true, 4)).unwrap();

        assert!(!saved.project_updated);
        assert_eq!(
            fs::read_to_string(&project).unwrap(),
            before,
            "an unchanged project should be left byte for byte as it was"
        );
    }

    #[test]
    fn records_the_reference_and_the_snap_settings_in_one_write() {
        // Both reasons to touch the project are decided first and written together, so a
        // single save never rewrites the project twice.
        let root = temp_dir("snap-and-ref");
        let project = root.join("song.project.json");
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"}}"#);

        let saved = save_chart(project.to_str().unwrap(), chart(NOTE), snap(false, 6)).unwrap();
        assert!(saved.project_updated);

        let updated: serde_json::Value =
            serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
        assert_eq!(updated["chart"]["path"], "song.chart.json");
        assert_eq!(updated["editor"]["snap"]["division"], 6);
    }

    #[test]
    fn a_failed_project_write_still_leaves_a_complete_chart() {
        // The chart is written first on purpose: a project may reference a chart that is
        // not there yet, but a chart that exists and is not yet referenced is merely
        // waiting for the next save. Neither state is corruption - the notes are on disk,
        // complete and parseable - which is why no rollback machinery is needed here.
        let root = temp_dir("project-write-fails");
        let project = root.join("song.project.json");
        write(&project, r#"{"version":"0.1.0","audio":{"path":"a.wav"}}"#);

        // Read-only: the project can still be read, but the rename over it cannot land.
        let mut permissions = fs::metadata(&project).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&project, permissions).unwrap();

        let error = save_chart(project.to_str().unwrap(), chart(NOTE), snap(false, 4)).unwrap_err();
        assert_eq!(error.kind, "projectUpdateFailed");

        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("song.chart.json")).unwrap()).unwrap();
        assert_eq!(written["notes"][0]["id"], "n-0001", "the chart is intact and complete");

        let untouched: serde_json::Value =
            serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
        assert!(untouched.get("chart").is_none(), "the project was not half-written");

        let mut permissions = fs::metadata(&project).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&project, permissions).unwrap();
    }

    #[test]
    fn reports_a_missing_project_rather_than_writing_anywhere() {
        let root = temp_dir("no-project");
        let error = save_chart(root.join("absent.json").to_str().unwrap(), chart(NOTE), snap_on()).unwrap_err();
        assert_eq!(error.kind, "projectUnreadable");
        assert!(!root.join("absent.chart.json").exists());
    }
}
