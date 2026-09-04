// Chart Forge Editor - Tauri shell.
//
// The Rust side is deliberately tiny: an OS file dialog, one document loader command,
// and the asset scope needed to play the one audio file a Project points at. Everything
// else - projection, layout, rendering, interaction - lives in TypeScript.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod loader;

use tauri::Manager;

/// Load a Project and the Analysis it references.
///
/// This is the frontend's only filesystem entry point. It takes an absolute project path
/// that the user chose through the OS dialog, and returns just the documents that project
/// references.
#[tauri::command]
fn load_project(path: String) -> Result<loader::LoadedProject, loader::LoadError> {
    loader::load_project(&path)
}

/// Grant the webview permission to stream one specific audio file.
///
/// Called only with a path the loader itself resolved from the Analysis, so the scope
/// stays as narrow as the document requires and the frontend cannot widen it to a
/// directory of its own choosing. Streaming through the asset protocol also avoids
/// shipping a 40 MB file through IPC as base64.
///
/// Returns the canonical path rather than a URL: the asset URL differs per platform
/// (`http://asset.localhost/...` on Windows, `asset://localhost/...` elsewhere), and the
/// frontend's `convertFileSrc` already knows which to build. Constructing it by hand here
/// produced an unplayable URL on Windows.
#[tauri::command]
fn allow_audio(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let file = std::path::PathBuf::from(&path);
    if !file.is_file() {
        return Err(format!("audio file does not exist: {path}"));
    }
    app.asset_protocol_scope()
        .allow_file(&file)
        .map_err(|e| format!("could not grant access to {path}: {e}"))?;
    Ok(path)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![load_project, allow_audio])
        .run(tauri::generate_context!())
        .expect("error while running the Chart Forge Editor");
}
