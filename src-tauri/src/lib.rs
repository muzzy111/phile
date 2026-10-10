//! Thin Tauri adapter: every command delegates to a core crate.
//! Keep logic out of here so it stays testable and shell-agnostic.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use phile_fs::omnibar::Target;
use phile_fs::Entry;
use phile_ops::{JobId, JobProgress, JobQueue, JobSpec};
use phile_store::{DirHit, Pin, Store, WorkspaceInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

struct AppState {
    store: Arc<Store>,
    jobs: JobQueue,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

// ---------- filesystem ----------

#[tauri::command]
async fn list_dir(path: String) -> CmdResult<Vec<Entry>> {
    tauri::async_runtime::spawn_blocking(move || phile_fs::list_dir(&PathBuf::from(path)).map_err(e)).await.map_err(e)?
}

#[tauri::command]
async fn flatten(path: String, limit: Option<usize>) -> CmdResult<Vec<Entry>> {
    tauri::async_runtime::spawn_blocking(move || phile_fs::flatten(&PathBuf::from(path), limit.unwrap_or(200_000)).map_err(e)).await.map_err(e)?
}

#[tauri::command]
fn resolve(input: String, cwd: String, st: State<AppState>) -> CmdResult<Target> {
    let aliases = st.store.aliases().map_err(e)?;
    Ok(phile_fs::omnibar::resolve(&input, &PathBuf::from(cwd), &aliases))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Places {
    roots: Vec<Entry>,
    known: Vec<(String, String)>,
    home: String,
}

#[tauri::command]
fn places() -> Places {
    Places {
        roots: phile_fs::roots(),
        known: phile_fs::known_folders(),
        home: dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into()),
    }
}

#[tauri::command]
fn breadcrumbs(path: String) -> Vec<(String, String)> {
    phile_fs::breadcrumbs(&PathBuf::from(path))
}

#[tauri::command]
fn create_folder(parent: String, name: String) -> CmdResult<String> {
    let p = phile_ops::unique_name(&PathBuf::from(parent).join(name));
    std::fs::create_dir(&p).map_err(e)?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
fn rename_entry(path: String, new_name: String) -> CmdResult<String> {
    if new_name.contains(['/', '\\']) || new_name.trim().is_empty() {
        return Err("Name can't be empty or contain slashes".into());
    }
    let p = PathBuf::from(&path);
    let to = p.with_file_name(new_name.trim());
    if to.exists() && to != p {
        return Err(format!("{} already exists", to.display()));
    }
    std::fs::rename(&p, &to).map_err(e)?;
    Ok(to.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_default(app: AppHandle, path: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(path, None::<&str>).map_err(e)
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(path).map_err(e)
}

/// Watch a directory for one pane; emits `dir-changed` with the pane id.
#[tauri::command]
fn watch_dir(app: AppHandle, st: State<AppState>, pane: String, path: String) -> CmdResult<()> {
    let mut ws = st.watchers.lock().unwrap();
    ws.remove(&pane);
    let pane_id = pane.clone();
    let last = Arc::new(Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(1)));
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            // Coalesce bursts (e.g. extracting an archive) to ~4 refreshes/sec.
            let mut l = last.lock().unwrap();
            if l.elapsed() > std::time::Duration::from_millis(250) {
                *l = std::time::Instant::now();
                let _ = app.emit("dir-changed", &pane_id);
            }
        }
    })
    .map_err(e)?;
    w.watch(&PathBuf::from(path), RecursiveMode::NonRecursive).map_err(e)?;
    ws.insert(pane, w);
    Ok(())
}

// ---------- inspection ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    entry: Entry,
    mime: String,
    is_text: bool,
    encoding: String,
    text: Option<String>,
    truncated: bool,
}

#[tauri::command]
async fn preview(path: String) -> CmdResult<Preview> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let entry = phile_fs::entry_from_path(&p).map_err(e)?;
        if p.is_dir() {
            return Ok(Preview { entry, mime: "inode/directory".into(), is_text: false, encoding: String::new(), text: None, truncated: false });
        }
        let s = phile_meta::sniff(&p).map_err(e)?;
        let (text, truncated) = if s.is_text { phile_meta::read_text(&p, 512 * 1024).map(|(t, tr)| (Some(t), tr)).map_err(e)? } else { (None, false) };
        Ok(Preview { entry, mime: s.mime, is_text: s.is_text, encoding: s.encoding, text, truncated })
    })
    .await
    .map_err(e)?
}

#[tauri::command]
async fn hex(path: String, offset: u64, len: usize) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || phile_meta::hex_dump(&PathBuf::from(path), offset, len.min(1 << 20)).map_err(e)).await.map_err(e)?
}

#[tauri::command]
async fn hashes(path: String) -> CmdResult<phile_meta::Hashes> {
    tauri::async_runtime::spawn_blocking(move || phile_meta::hash_file(&PathBuf::from(path)).map_err(e)).await.map_err(e)?
}

// ---------- jobs ----------

#[tauri::command]
fn job_submit(st: State<AppState>, spec: JobSpec) -> JobId {
    st.jobs.submit(spec)
}
#[tauri::command]
fn job_pause(st: State<AppState>, id: JobId) {
    st.jobs.pause(id)
}
#[tauri::command]
fn job_resume(st: State<AppState>, id: JobId) {
    st.jobs.resume(id)
}
#[tauri::command]
fn job_cancel(st: State<AppState>, id: JobId) {
    st.jobs.cancel(id)
}
#[tauri::command]
fn job_list(st: State<AppState>) -> Vec<JobProgress> {
    st.jobs.list()
}
#[tauri::command]
fn job_clear(st: State<AppState>) {
    st.jobs.clear_finished()
}
#[tauri::command]
fn set_throttle(st: State<AppState>, bytes_per_sec: u64) -> CmdResult<()> {
    st.jobs.set_throttle(bytes_per_sec);
    st.store.set_setting("throttle", &bytes_per_sec).map_err(e)
}

// ---------- store ----------

#[tauri::command]
fn workspace_save(st: State<AppState>, name: String, state: serde_json::Value) -> CmdResult<()> {
    st.store.save_workspace(&name, &state).map_err(e)
}
#[tauri::command]
fn workspace_load(st: State<AppState>, name: String) -> CmdResult<Option<serde_json::Value>> {
    st.store.load_workspace(&name).map_err(e)
}
#[tauri::command]
fn workspace_list(st: State<AppState>) -> CmdResult<Vec<WorkspaceInfo>> {
    st.store.list_workspaces().map_err(e)
}
#[tauri::command]
fn workspace_delete(st: State<AppState>, name: String) -> CmdResult<()> {
    st.store.delete_workspace(&name).map_err(e)
}
#[tauri::command]
fn record_visit(st: State<AppState>, path: String) -> CmdResult<()> {
    st.store.record_visit(&path).map_err(e)
}
#[tauri::command]
fn teleport(st: State<AppState>, query: String) -> CmdResult<Vec<DirHit>> {
    st.store.teleport(&query, 50).map_err(e)
}
#[tauri::command]
fn aliases(st: State<AppState>) -> CmdResult<HashMap<String, String>> {
    st.store.aliases().map_err(e)
}
#[tauri::command]
fn set_alias(st: State<AppState>, name: String, path: Option<String>) -> CmdResult<()> {
    match path {
        Some(p) => st.store.set_alias(&name, &p),
        None => st.store.remove_alias(&name),
    }
    .map_err(e)
}
#[tauri::command]
fn pins(st: State<AppState>) -> CmdResult<Vec<Pin>> {
    st.store.pins().map_err(e)
}
#[tauri::command]
fn set_pins(st: State<AppState>, pins: Vec<Pin>) -> CmdResult<()> {
    st.store.set_pins(&pins).map_err(e)
}
#[tauri::command]
fn setting_get(st: State<AppState>, key: String) -> CmdResult<Option<serde_json::Value>> {
    st.store.get_setting(&key).map_err(e)
}
#[tauri::command]
fn setting_set(st: State<AppState>, key: String, value: serde_json::Value) -> CmdResult<()> {
    st.store.set_setting(&key, &value).map_err(e)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
            let store = Arc::new(Store::open(&dir.join("phile.db"))?);
            let handle = app.handle().clone();
            let jobs = JobQueue::new(
                2,
                Arc::new(move |p: &JobProgress| {
                    let _ = handle.emit("job-progress", p);
                }),
            );
            if let Ok(Some(t)) = store.get_setting::<u64>("throttle") {
                jobs.set_throttle(t);
            }
            app.manage(AppState { store, jobs, watchers: Mutex::new(HashMap::new()) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir, flatten, resolve, places, breadcrumbs, create_folder, rename_entry, open_default, reveal, watch_dir,
            preview, hex, hashes,
            job_submit, job_pause, job_resume, job_cancel, job_list, job_clear, set_throttle,
            workspace_save, workspace_load, workspace_list, workspace_delete,
            record_visit, teleport, aliases, set_alias, pins, set_pins, setting_get, setting_set
        ])
        .run(tauri::generate_context!())
        .expect("error while running Phile");
}
