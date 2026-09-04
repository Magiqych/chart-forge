//! The document loader: the frontend's only route to the filesystem.
//!
//! The Editor deliberately does not get a general filesystem plugin. Instead it asks for
//! a Project by absolute path (chosen by the user through the OS dialog) and this module
//! resolves, reads and returns exactly the documents that Project references - nothing
//! else. A compromised or buggy frontend therefore cannot read arbitrary files.
//!
//! Reference resolution follows the Project contract: a `documentRef` path is relative
//! to the project file unless it is absolute. A leading `..` is entirely legitimate - a
//! project commonly sits beside the runs directory it points into - so paths are
//! canonicalised, not rejected for their shape.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// Everything the Editor needs from one Open Project action.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProject {
    /// Canonical path of the project file.
    pub project_path: String,
    /// The Project document, verbatim.
    pub project: serde_json::Value,
    /// Canonical path of the resolved Analysis document, if the project references one.
    pub analysis_path: Option<String>,
    /// The Analysis document, verbatim. The frontend projects it; we do not interpret it.
    pub analysis: Option<serde_json::Value>,
    /// Whether the project recorded a sha256 for the analysis and it matched.
    pub analysis_hash_verified: bool,
    /// Canonical path of the audio the analysis refers to, when it exists on disk.
    pub audio_path: Option<String>,
}

/// Errors the UI is expected to tell apart. The `kind` matches the TypeScript union in
/// src/core/project.ts, so the frontend can branch without parsing prose.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoadError {
    pub kind: String,
    pub message: String,
    pub detail: Option<String>,
}

impl LoadError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: message.into(), detail: None }
    }

    fn with_detail(kind: &str, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: message.into(), detail: Some(detail.into()) }
    }
}

type LoadResult<T> = Result<T, LoadError>;

fn canonical(path: &Path) -> Option<String> {
    fs::canonicalize(path)
        .ok()
        .map(|p| p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
}

/// Resolve a documentRef against the project file's directory.
///
/// `..` is permitted and normalised by the OS during canonicalisation; it is not a
/// security boundary here, because the only paths that ever reach this function come
/// from a Project the user explicitly opened.
fn resolve_ref(project_path: &Path, reference: &str) -> PathBuf {
    let candidate = Path::new(reference);
    if candidate.is_absolute() {
        return candidate.to_path_buf();
    }
    project_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(candidate)
}

fn read_json(path: &Path, unreadable: &str, malformed: &str) -> LoadResult<serde_json::Value> {
    let bytes = fs::read(path)
        .map_err(|e| LoadError::with_detail(unreadable, format!("cannot read {}", path.display()), e.to_string()))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| LoadError::with_detail(malformed, format!("{} is not valid JSON", path.display()), e.to_string()))
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let bytes = fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn version_of(document: &serde_json::Value) -> &str {
    document.get("version").and_then(|v| v.as_str()).unwrap_or("")
}

/// Load a Project and the Analysis it references.
pub fn load_project(project_path: &str) -> LoadResult<LoadedProject> {
    let project_path = Path::new(project_path);
    if !project_path.is_file() {
        return Err(LoadError::new(
            "projectUnreadable",
            format!("project file does not exist: {}", project_path.display()),
        ));
    }

    let project = read_json(project_path, "projectUnreadable", "projectMalformed")?;
    if !project.is_object() {
        return Err(LoadError::new("projectMalformed", "project document is not an object"));
    }

    let project_version = version_of(&project);
    if !(project_version.starts_with("0.1.") || project_version.starts_with("0.2.")) {
        return Err(LoadError::new(
            "projectUnsupportedVersion",
            format!("unsupported Project version {project_version:?}"),
        ));
    }

    let canonical_project = canonical(project_path).unwrap_or_else(|| project_path.display().to_string());

    // The analysis reference is optional: a project may exist before anything is analysed.
    let analysis_ref = project.get("analysis");
    let Some(analysis_ref) = analysis_ref else {
        return Ok(LoadedProject {
            project_path: canonical_project,
            project,
            analysis_path: None,
            analysis: None,
            analysis_hash_verified: false,
            audio_path: None,
        });
    };

    let kind = analysis_ref.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let (analysis, analysis_path, hash_verified) = match kind {
        "inline" => {
            let data = analysis_ref
                .get("data")
                .cloned()
                .ok_or_else(|| LoadError::new("analysisMissingReference", "inline analysis has no data"))?;
            (data, None, false)
        }
        "file" => {
            let reference = analysis_ref
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| LoadError::new("analysisMissingReference", "analysis reference has no path"))?;
            let resolved = resolve_ref(project_path, reference);
            if !resolved.is_file() {
                return Err(LoadError::with_detail(
                    "analysisUnreadable",
                    format!("analysis not found: {}", resolved.display()),
                    format!("referenced as {reference:?}"),
                ));
            }
            let document = read_json(&resolved, "analysisUnreadable", "analysisMalformed")?;

            let mut verified = false;
            if let Some(expected) = analysis_ref.get("sha256").and_then(|v| v.as_str()) {
                let actual = sha256_file(&resolved).map_err(|e| {
                    LoadError::with_detail("analysisUnreadable", "cannot hash analysis", e.to_string())
                })?;
                if actual != expected {
                    return Err(LoadError::with_detail(
                        "analysisHashMismatch",
                        "the analysis has changed since the project recorded its hash",
                        format!("expected {expected}, found {actual}"),
                    ));
                }
                verified = true;
            }
            let path = canonical(&resolved).unwrap_or_else(|| resolved.display().to_string());
            (document, Some(path), verified)
        }
        other => {
            return Err(LoadError::new(
                "analysisMissingReference",
                format!("unsupported analysis reference kind {other:?}"),
            ))
        }
    };

    let analysis_version = version_of(&analysis);
    if !analysis_version.starts_with("0.2.") {
        return Err(LoadError::new(
            "analysisUnsupportedVersion",
            format!("this Editor reads Analysis 0.2.x, found {analysis_version:?}"),
        ));
    }

    // The audio path inside an Analysis is written by the Analyzer as an absolute path,
    // but the contract allows relative, so both are handled the same way.
    let audio_path = analysis
        .get("audio")
        .and_then(|a| a.get("path"))
        .and_then(|p| p.as_str())
        .map(|reference| {
            let base = analysis_path.as_deref().map(Path::new).unwrap_or(project_path);
            resolve_ref(base, reference)
        })
        .and_then(|p| if p.is_file() { canonical(&p) } else { None });

    Ok(LoadedProject {
        project_path: canonical_project,
        project,
        analysis_path,
        analysis: Some(analysis),
        analysis_hash_verified: hash_verified,
        audio_path,
    })
}

#[cfg(test)]
mod tests {
    //! These cover the two pieces that exist only in Rust - reference resolution and
    //! hash verification - so they are not merely re-tested versions of the TypeScript.

    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-editor-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = fs::File::create(path).unwrap();
        file.write_all(contents.as_bytes()).unwrap();
    }

    const ANALYSIS: &str = r#"{"version":"0.2.0","audio":{"path":"song.wav","durationSec":1},"events":[]}"#;

    #[test]
    fn resolves_a_plain_relative_reference() {
        let project = Path::new("D:/work/song.project.json");
        assert_eq!(resolve_ref(project, "analysis.json"), PathBuf::from("D:/work/analysis.json"));
    }

    #[test]
    fn resolves_a_parent_relative_reference() {
        // `..` is legitimate: a project commonly sits beside the runs directory it
        // points into, so it must resolve rather than be rejected.
        let project = Path::new("D:/work/projects/song.project.json");
        let resolved = resolve_ref(project, "../runs/pinned-A/analysis.json");
        assert_eq!(resolved, PathBuf::from("D:/work/projects/../runs/pinned-A/analysis.json"));
    }

    #[test]
    fn passes_an_absolute_reference_through() {
        let project = Path::new("D:/work/song.project.json");
        assert_eq!(resolve_ref(project, "D:/other/a.json"), PathBuf::from("D:/other/a.json"));
    }

    #[test]
    fn loads_a_project_through_a_parent_relative_reference() {
        let root = temp_dir("parent-ref");
        write(&root.join("runs/a/analysis.json"), ANALYSIS);
        write(
            &root.join("projects/song.project.json"),
            r#"{"version":"0.1.0","audio":{"path":"x.wav"},
                "analysis":{"kind":"file","path":"../runs/a/analysis.json"}}"#,
        );

        let loaded = load_project(root.join("projects/song.project.json").to_str().unwrap())
            .expect("a legitimate ../ reference must resolve");
        assert!(loaded.analysis.is_some());
        assert!(loaded.analysis_path.unwrap().replace('\\', "/").ends_with("runs/a/analysis.json"));
        assert!(!loaded.analysis_hash_verified, "no hash was recorded, so nothing was verified");
    }

    #[test]
    fn verifies_a_matching_sha256() {
        let root = temp_dir("hash-ok");
        let analysis = root.join("analysis.json");
        write(&analysis, ANALYSIS);
        let digest = sha256_file(&analysis).unwrap();
        write(
            &root.join("p.json"),
            &format!(
                r#"{{"version":"0.1.0","audio":{{"path":"x.wav"}},
                    "analysis":{{"kind":"file","path":"analysis.json","sha256":"{digest}"}}}}"#
            ),
        );

        let loaded = load_project(root.join("p.json").to_str().unwrap()).unwrap();
        assert!(loaded.analysis_hash_verified);
    }

    #[test]
    fn rejects_a_mismatched_sha256() {
        let root = temp_dir("hash-bad");
        write(&root.join("analysis.json"), ANALYSIS);
        write(
            &root.join("p.json"),
            &format!(
                r#"{{"version":"0.1.0","audio":{{"path":"x.wav"}},
                    "analysis":{{"kind":"file","path":"analysis.json","sha256":"{}"}}}}"#,
                "0".repeat(64)
            ),
        );

        let error = load_project(root.join("p.json").to_str().unwrap()).unwrap_err();
        assert_eq!(error.kind, "analysisHashMismatch");
        assert!(error.detail.unwrap().contains("expected"));
    }

    #[test]
    fn sha256_matches_a_known_vector() {
        let root = temp_dir("hash-vector");
        let file = root.join("empty");
        write(&file, "");
        assert_eq!(
            sha256_file(&file).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn reports_a_malformed_project() {
        let root = temp_dir("malformed");
        write(&root.join("p.json"), "{ this is not json");
        let error = load_project(root.join("p.json").to_str().unwrap()).unwrap_err();
        assert_eq!(error.kind, "projectMalformed");
    }

    #[test]
    fn reports_a_missing_project() {
        let root = temp_dir("missing-project");
        let error = load_project(root.join("nope.json").to_str().unwrap()).unwrap_err();
        assert_eq!(error.kind, "projectUnreadable");
    }

    #[test]
    fn reports_a_missing_analysis_file() {
        let root = temp_dir("missing-analysis");
        write(
            &root.join("p.json"),
            r#"{"version":"0.1.0","audio":{"path":"x.wav"},
                "analysis":{"kind":"file","path":"absent.json"}}"#,
        );
        let error = load_project(root.join("p.json").to_str().unwrap()).unwrap_err();
        assert_eq!(error.kind, "analysisUnreadable");
    }

    #[test]
    fn reports_an_unsupported_analysis_version() {
        let root = temp_dir("bad-analysis-version");
        write(&root.join("analysis.json"), r#"{"version":"0.1.0","events":[]}"#);
        write(
            &root.join("p.json"),
            r#"{"version":"0.1.0","audio":{"path":"x.wav"},
                "analysis":{"kind":"file","path":"analysis.json"}}"#,
        );
        let error = load_project(root.join("p.json").to_str().unwrap()).unwrap_err();
        assert_eq!(error.kind, "analysisUnsupportedVersion");
    }

    #[test]
    fn reports_an_unsupported_project_version() {
        let root = temp_dir("bad-project-version");
        write(&root.join("p.json"), r#"{"version":"9.0.0"}"#);
        let error = load_project(root.join("p.json").to_str().unwrap()).unwrap_err();
        assert_eq!(error.kind, "projectUnsupportedVersion");
    }

    #[test]
    fn a_project_without_an_analysis_still_loads() {
        let root = temp_dir("no-analysis");
        write(&root.join("p.json"), r#"{"version":"0.1.0","audio":{"path":"x.wav"}}"#);
        let loaded = load_project(root.join("p.json").to_str().unwrap()).unwrap();
        assert!(loaded.analysis.is_none());
    }

    #[test]
    fn resolves_audio_relative_to_the_analysis() {
        let root = temp_dir("audio-ref");
        write(&root.join("audio/song.wav"), "not really audio, but it exists");
        write(
            &root.join("runs/analysis.json"),
            r#"{"version":"0.2.0","audio":{"path":"../audio/song.wav","durationSec":1},"events":[]}"#,
        );
        write(
            &root.join("p.json"),
            r#"{"version":"0.1.0","audio":{"path":"x.wav"},
                "analysis":{"kind":"file","path":"runs/analysis.json"}}"#,
        );

        let loaded = load_project(root.join("p.json").to_str().unwrap()).unwrap();
        let audio = loaded.audio_path.expect("audio should resolve through the analysis");
        assert!(audio.replace('\\', "/").ends_with("audio/song.wav"));
    }
}
