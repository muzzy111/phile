//! Phile's core exposed as agent tools.
//!
//! One table (`tools()`) describes every tool; one function (`call()`) runs
//! them. The CLI, the MCP server and the Claude Code mod all go through these
//! two, so a new tool is one schema entry plus one match arm.
//!
//! Safety: nothing here deletes permanently. Removal goes to the Recycle Bin,
//! moves and copies never overwrite unless asked, every change is journaled
//! and `phile_undo` reverses the last batch.

use phile_fs::search::{self, SearchOpts};
use phile_ops::{Collision, JobQueue, JobSpec, JobState, OpKind};
use phile_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Where Phile keeps its data; shared with the desktop app (Tauri `app_data_dir`).
pub fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("PHILE_DATA_DIR") {
        return PathBuf::from(d);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("app.phile.explorer")
}

pub struct Ctx {
    pub cwd: PathBuf,
    pub data: PathBuf,
}

impl Default for Ctx {
    fn default() -> Self {
        Self {
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            data: data_dir(),
        }
    }
}

impl Ctx {
    fn path(&self, p: &str) -> PathBuf {
        let p = p.trim();
        let expanded = if p == "~" || p.starts_with("~/") || p.starts_with("~\\") {
            dirs::home_dir()
                .map(|h| h.join(p[1..].trim_start_matches(['/', '\\'])))
                .unwrap_or_else(|| p.into())
        } else {
            PathBuf::from(p)
        };
        let joined = if expanded.is_absolute() {
            expanded
        } else {
            self.cwd.join(expanded)
        };
        phile_fs::omnibar::normalize(&joined)
    }
    fn store(&self) -> Option<Store> {
        Store::open(&self.data.join("phile.db")).ok()
    }
    fn journal(&self) -> PathBuf {
        self.data.join("agent-journal.jsonl")
    }
}

type R = Result<Value, String>;

fn s<'a>(a: &'a Value, k: &str) -> Result<&'a str, String> {
    a.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string argument `{k}`"))
}
fn opt_s<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str).filter(|v| !v.is_empty())
}
fn list(a: &Value, k: &str) -> Result<Vec<String>, String> {
    match a.get(k) {
        Some(Value::String(v)) => Ok(vec![v.clone()]),
        Some(Value::Array(v)) => Ok(v
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect()),
        _ => Err(format!("missing list argument `{k}`")),
    }
}
fn num(a: &Value, k: &str, d: u64) -> u64 {
    a.get(k).and_then(Value::as_u64).unwrap_or(d)
}
fn flag(a: &Value, k: &str) -> bool {
    a.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// Paths an agent may never move, copy over or recycle as a whole.
fn protected(p: &Path) -> bool {
    let norm = |x: &Path| {
        x.to_string_lossy()
            .trim_end_matches(['/', '\\'])
            .to_lowercase()
    };
    let me = norm(p);
    if p.parent().is_none() || me.is_empty() || me.len() <= 3 {
        return true; // filesystem / drive roots
    }
    let mut guarded: Vec<PathBuf> = [
        dirs::home_dir(),
        dirs::desktop_dir(),
        dirs::document_dir(),
        dirs::download_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();
    for v in [
        "SystemRoot",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "APPDATA",
        "LOCALAPPDATA",
    ] {
        if let Some(x) = std::env::var_os(v) {
            guarded.push(x.into());
        }
    }
    guarded.iter().any(|g| norm(g) == me)
}

fn guard(paths: &[PathBuf]) -> Result<(), String> {
    for p in paths {
        if protected(p) {
            return Err(format!("refused: {} is a protected folder", p.display()));
        }
        if !p.exists() {
            return Err(format!("not found: {}", p.display()));
        }
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct JournalEntry {
    batch: u64,
    op: String,
    from: String,
    to: String,
}

fn journal(ctx: &Ctx, entries: &[JournalEntry]) {
    if entries.is_empty() {
        return;
    }
    let _ = std::fs::create_dir_all(&ctx.data);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(ctx.journal())
    {
        for e in entries {
            let _ = writeln!(f, "{}", serde_json::to_string(e).unwrap_or_default());
        }
    }
}

fn read_journal(ctx: &Ctx) -> Vec<JournalEntry> {
    std::fs::read_to_string(ctx.journal())
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn batch_id() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn collision(a: &Value) -> Collision {
    match opt_s(a, "collision").unwrap_or("rename") {
        "overwrite" => Collision::Overwrite,
        "skip" => Collision::Skip,
        "newer" => Collision::Newer,
        _ => Collision::Rename,
    }
}

/// Where `src` lands inside `dest` under `c`; `None` when it would be skipped.
fn predict(src: &Path, dest: &Path, c: Collision) -> Option<PathBuf> {
    let t = dest.join(src.file_name()?);
    if !t.exists() {
        return Some(t);
    }
    match c {
        Collision::Rename => Some(phile_ops::unique_name(&t)),
        Collision::Skip => None,
        Collision::Overwrite | Collision::Newer => Some(t),
    }
}

fn run_job(spec: JobSpec) -> Result<phile_ops::JobProgress, String> {
    let q = JobQueue::new(1, Arc::new(|_| {}));
    let id = q.submit(spec);
    let p = q
        .wait(id, Duration::from_secs(24 * 3600))
        .ok_or("job vanished")?;
    if p.state == JobState::Failed {
        return Err(p.errors.join("; "));
    }
    Ok(p)
}

fn transfer(ctx: &Ctx, a: &Value, kind: OpKind) -> R {
    let sources: Vec<PathBuf> = list(a, "sources")?.iter().map(|p| ctx.path(p)).collect();
    let dest = ctx.path(s(a, "dest")?);
    if sources.is_empty() {
        return Err("no sources".into());
    }
    if kind == OpKind::Move {
        guard(&sources)?;
    } else {
        for p in &sources {
            if !p.exists() {
                return Err(format!("not found: {}", p.display()));
            }
        }
    }
    let c = collision(a);
    let plan: Vec<(PathBuf, Option<PathBuf>)> = sources
        .iter()
        .map(|s| (s.clone(), predict(s, &dest, c)))
        .collect();
    let plan_json: Vec<Value> = plan
        .iter()
        .map(|(f, t)| json!({ "from": f, "to": t, "skipped": t.is_none() }))
        .collect();
    if flag(a, "dryRun") {
        return Ok(
            json!({ "dryRun": true, "op": kind_name(kind), "dest": dest, "plan": plan_json }),
        );
    }
    let batch = batch_id();
    let mut done = Vec::new();
    let mut errors = Vec::new();
    let mut bytes = 0;
    for (src, target) in &plan {
        let Some(target) = target else { continue };
        let spec = JobSpec {
            kind,
            sources: vec![src.clone()],
            dest: Some(dest.clone()),
            collision: c,
            verify: flag(a, "verify"),
        };
        match run_job(spec) {
            Ok(p) => {
                bytes += p.bytes_done;
                errors.extend(p.errors);
                if target.exists() {
                    done.push(JournalEntry {
                        batch,
                        op: kind_name(kind).into(),
                        from: src.display().to_string(),
                        to: target.display().to_string(),
                    });
                }
            }
            Err(e) => errors.push(e),
        }
    }
    journal(ctx, &done);
    if let Some(st) = ctx.store() {
        let _ = st.record_visit(&dest.to_string_lossy());
    }
    Ok(
        json!({ "op": kind_name(kind), "dest": dest, "done": done.len(), "bytes": bytes, "plan": plan_json, "errors": errors, "batch": batch }),
    )
}

fn kind_name(k: OpKind) -> &'static str {
    match k {
        OpKind::Copy => "copy",
        OpKind::Move => "move",
        OpKind::Trash => "trash",
        OpKind::Delete => "delete",
    }
}

fn trash(ctx: &Ctx, a: &Value) -> R {
    let paths: Vec<PathBuf> = list(a, "paths")?.iter().map(|p| ctx.path(p)).collect();
    guard(&paths)?;
    if flag(a, "dryRun") {
        return Ok(json!({ "dryRun": true, "op": "trash", "paths": paths }));
    }
    let p = run_job(JobSpec {
        kind: OpKind::Trash,
        sources: paths.clone(),
        dest: None,
        collision: Collision::default(),
        verify: false,
    })?;
    let batch = batch_id();
    journal(
        ctx,
        &paths
            .iter()
            .map(|x| JournalEntry {
                batch,
                op: "trash".into(),
                from: x.display().to_string(),
                to: "Recycle Bin".into(),
            })
            .collect::<Vec<_>>(),
    );
    Ok(
        json!({ "op": "trash", "recycled": paths, "errors": p.errors, "batch": batch, "note": "Items are in the Recycle Bin and can be restored from there." }),
    )
}

fn rename(ctx: &Ctx, a: &Value) -> R {
    let from = ctx.path(s(a, "path")?);
    let name = s(a, "name")?;
    if name.contains(['/', '\\']) || name == "." || name == ".." || name.is_empty() {
        return Err("`name` must be a plain file name; use phile_move to change folders".into());
    }
    guard(std::slice::from_ref(&from))?;
    let to = from.with_file_name(name);
    if to.exists() && !to.as_os_str().eq_ignore_ascii_case(from.as_os_str()) {
        return Err(format!("already exists: {}", to.display()));
    }
    if flag(a, "dryRun") {
        return Ok(json!({ "dryRun": true, "op": "rename", "from": from, "to": to }));
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    let batch = batch_id();
    journal(
        ctx,
        &[JournalEntry {
            batch,
            op: "rename".into(),
            from: from.display().to_string(),
            to: to.display().to_string(),
        }],
    );
    Ok(json!({ "op": "rename", "from": from, "to": to, "batch": batch }))
}

fn mkdir(ctx: &Ctx, a: &Value) -> R {
    let p = ctx.path(s(a, "path")?);
    let existed = p.is_dir();
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    if !existed {
        journal(
            ctx,
            &[JournalEntry {
                batch: batch_id(),
                op: "mkdir".into(),
                from: String::new(),
                to: p.display().to_string(),
            }],
        );
    }
    Ok(json!({ "op": "mkdir", "path": p, "created": !existed }))
}

/// Reverse the most recent batch of moves, renames and created (still empty) folders.
fn undo(ctx: &Ctx, a: &Value) -> R {
    let all = read_journal(ctx);
    let undone: Vec<u64> = all
        .iter()
        .filter(|e| e.op == "undo")
        .filter_map(|e| e.from.parse().ok())
        .collect();
    let Some(target) = all
        .iter()
        .rev()
        .filter(|e| e.op != "undo" && !undone.contains(&e.batch))
        .map(|e| e.batch)
        .next()
    else {
        return Ok(json!({ "undone": 0, "note": "Nothing to undo." }));
    };
    let batch: Vec<&JournalEntry> = all
        .iter()
        .filter(|e| e.batch == target && e.op != "undo")
        .collect();
    let mut steps = Vec::new();
    let mut errors = Vec::new();
    for e in batch.iter().rev() {
        let (from, to) = (PathBuf::from(&e.from), PathBuf::from(&e.to));
        let r = match e.op.as_str() {
            "move" | "rename" if to.exists() && !from.exists() => {
                let _ = from.parent().map(std::fs::create_dir_all);
                if flag(a, "dryRun") {
                    Ok(())
                } else {
                    std::fs::rename(&to, &from)
                        .or_else(|_| {
                            let parent = from.parent().map(Path::to_path_buf).unwrap_or_default();
                            run_job(JobSpec {
                                kind: OpKind::Move,
                                sources: vec![to.clone()],
                                dest: Some(parent),
                                collision: Collision::Skip,
                                verify: false,
                            })
                            .map(|_| ())
                            .map_err(std::io::Error::other)
                        })
                        .map_err(|x| x.to_string())
                }
            }
            "copy" if to.exists() => {
                if flag(a, "dryRun") {
                    Ok(())
                } else {
                    run_job(JobSpec {
                        kind: OpKind::Trash,
                        sources: vec![to.clone()],
                        dest: None,
                        collision: Collision::default(),
                        verify: false,
                    })
                    .map(|_| ())
                }
            }
            "mkdir" if to.is_dir() => {
                if flag(a, "dryRun") {
                    Ok(())
                } else {
                    std::fs::remove_dir(&to)
                        .map_err(|x| format!("{}: {x} (folder not empty?)", to.display()))
                }
            }
            "trash" => Err(format!("{}: restore it from the Recycle Bin", e.from)),
            _ => Err(format!("{}: already changed since, left as is", e.to)),
        };
        match r {
            Ok(()) => steps.push(json!({ "op": e.op, "restored": e.from, "was": e.to })),
            Err(x) => errors.push(x),
        }
    }
    if !flag(a, "dryRun") {
        journal(
            ctx,
            &[JournalEntry {
                batch: batch_id(),
                op: "undo".into(),
                from: target.to_string(),
                to: String::new(),
            }],
        );
    }
    Ok(
        json!({ "batch": target, "undone": steps.len(), "steps": steps, "errors": errors, "dryRun": flag(a, "dryRun") }),
    )
}

fn history(ctx: &Ctx, a: &Value) -> R {
    let all = read_journal(ctx);
    let n = num(a, "limit", 30) as usize;
    let tail: Vec<&JournalEntry> = all.iter().rev().take(n).collect();
    Ok(json!({ "entries": tail }))
}

fn info(ctx: &Ctx, a: &Value) -> R {
    let p = ctx.path(s(a, "path")?);
    let e = phile_fs::entry_from_path(&p).map_err(|e| e.to_string())?;
    let mut v = json!({ "entry": e });
    if p.is_file() {
        if let Ok(sn) = phile_meta::sniff(&p) {
            v["sniff"] = json!(sn);
            if sn.is_text && flag(a, "preview") {
                if let Ok((t, cut)) = phile_meta::read_text(&p, num(a, "maxBytes", 4096) as usize) {
                    v["text"] = json!(t);
                    v["textTruncated"] = json!(cut);
                }
            }
        }
        if flag(a, "hash") {
            v["hashes"] = json!(phile_meta::hash_file(&p).map_err(|e| e.to_string())?);
        }
    } else if p.is_dir() {
        let (mut files, mut dirs, mut bytes) = (0u64, 0u64, 0u64);
        for e in phile_fs::flatten(&p, 200_000).unwrap_or_default() {
            files += 1;
            bytes += e.size;
        }
        if let Ok(k) = phile_fs::list_dir(&p) {
            dirs = k.iter().filter(|x| x.kind == phile_fs::Kind::Dir).count() as u64;
        }
        v["summary"] = json!({ "files": files, "subfolders": dirs, "bytes": bytes });
    }
    Ok(v)
}

/// Run one tool by name. `args` is the tool's JSON input.
pub fn call(ctx: &Ctx, tool: &str, args: &Value) -> R {
    let a = args;
    match tool.trim_start_matches("mcp__phile__") {
        "phile_list" => {
            let p = ctx.path(opt_s(a, "path").unwrap_or("."));
            let mut v = phile_fs::list_dir(&p).map_err(|e| e.to_string())?;
            if !flag(a, "includeHidden") {
                v.retain(|e| !e.hidden);
            }
            if let Some(st) = ctx.store() {
                let _ = st.record_visit(&p.to_string_lossy());
            }
            let total = v.len();
            v.truncate(num(a, "limit", 500) as usize);
            Ok(json!({ "path": p, "total": total, "entries": v }))
        }
        "phile_tree" => {
            let p = ctx.path(opt_s(a, "path").unwrap_or("."));
            let t = search::tree(
                &p,
                num(a, "depth", 2) as usize,
                num(a, "limit", 400) as usize,
                flag(a, "includeHidden"),
            )
            .map_err(|e| e.to_string())?;
            Ok(json!(t))
        }
        "phile_search" => {
            let root = ctx.path(opt_s(a, "root").unwrap_or("."));
            let opts = SearchOpts {
                query: s(a, "query")?.to_string(),
                content: flag(a, "content"),
                limit: num(a, "limit", 50) as usize,
                max_depth: num(a, "maxDepth", 12) as usize,
                include_hidden: flag(a, "includeHidden"),
                ext: list(a, "ext").unwrap_or_default(),
                kind: opt_s(a, "kind").unwrap_or("").to_string(),
                timeout_ms: num(a, "timeoutMs", 15_000),
            };
            Ok(json!(
                search::search(&root, &opts).map_err(|e| e.to_string())?
            ))
        }
        "phile_teleport" => {
            let st = ctx.store().ok_or("Phile's database is not available")?;
            Ok(
                json!({ "hits": st.teleport(opt_s(a, "query").unwrap_or(""), num(a, "limit", 10) as usize).map_err(|e| e.to_string())? }),
            )
        }
        "phile_info" => info(ctx, a),
        "phile_move" => transfer(ctx, a, OpKind::Move),
        "phile_copy" => transfer(ctx, a, OpKind::Copy),
        "phile_trash" => trash(ctx, a),
        "phile_rename" => rename(ctx, a),
        "phile_mkdir" => mkdir(ctx, a),
        "phile_undo" => undo(ctx, a),
        "phile_history" => history(ctx, a),
        "phile_places" => Ok(json!({
            "cwd": ctx.cwd,
            "known": phile_fs::known_folders().into_iter().map(|(l, p)| json!({ "label": l, "path": p })).collect::<Vec<_>>(),
            "roots": phile_fs::roots(),
            "pins": ctx.store().and_then(|s| s.pins().ok()).unwrap_or_default(),
        })),
        other => Err(format!("unknown tool `{other}`")),
    }
}

fn obj(props: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

/// Every tool: name, description, JSON schema. Single source of truth for CLI, MCP and the mod.
pub fn tools() -> Vec<Value> {
    let path = json!({ "type": "string", "description": "Absolute, relative to the working folder, or ~/..." });
    let dry = json!({ "type": "boolean", "description": "Only report what would happen" });
    let coll = json!({ "type": "string", "enum": ["rename", "skip", "overwrite", "newer"], "description": "When the name exists at the destination. Default rename (adds \" (2)\")." });
    let hidden = json!({ "type": "boolean" });
    vec![
        json!({ "name": "phile_list", "description": "List one folder (folders first). Records the visit for teleport.",
            "inputSchema": obj(json!({ "path": path, "includeHidden": hidden, "limit": { "type": "integer" } }), &[]) }),
        json!({ "name": "phile_tree", "description": "Folder tree to a depth, skipping noise like .git and node_modules. Cheap way to see a project's shape.",
            "inputSchema": obj(json!({ "path": path, "depth": { "type": "integer", "description": "Default 2" }, "limit": { "type": "integer", "description": "Max nodes, default 400" }, "includeHidden": hidden }), &[]) }),
        json!({ "name": "phile_search", "description": "Find files and folders under a root by fuzzy name (\"inv24\" finds invoice_2024.pdf). content=true also searches inside text files.",
            "inputSchema": obj(json!({ "root": path, "query": { "type": "string" }, "content": { "type": "boolean" }, "ext": { "type": "array", "items": { "type": "string" } },
                "kind": { "type": "string", "enum": ["", "file", "dir"] }, "limit": { "type": "integer" }, "maxDepth": { "type": "integer" }, "includeHidden": hidden, "timeoutMs": { "type": "integer" } }), &["query"]) }),
        json!({ "name": "phile_teleport", "description": "Jump to a frequently used folder by fuzzy name, ranked by how often and how recently it was opened in Phile.",
            "inputSchema": obj(json!({ "query": { "type": "string" }, "limit": { "type": "integer" } }), &[]) }),
        json!({ "name": "phile_info", "description": "Details for a file or folder: size, type, dates; folder totals; optional text preview and hashes.",
            "inputSchema": obj(json!({ "path": path, "preview": { "type": "boolean" }, "maxBytes": { "type": "integer" }, "hash": { "type": "boolean" } }), &["path"]) }),
        json!({ "name": "phile_move", "description": "Move files or folders into a destination folder (created if missing). Journaled; phile_undo reverses it. Use dryRun first for big batches.",
            "inputSchema": obj(json!({ "sources": { "type": "array", "items": { "type": "string" } }, "dest": path, "collision": coll, "dryRun": dry }), &["sources", "dest"]) }),
        json!({ "name": "phile_copy", "description": "Copy files or folders into a destination folder, optionally verifying each file with blake3.",
            "inputSchema": obj(json!({ "sources": { "type": "array", "items": { "type": "string" } }, "dest": path, "collision": coll, "verify": { "type": "boolean" }, "dryRun": dry }), &["sources", "dest"]) }),
        json!({ "name": "phile_trash", "description": "Send files or folders to the Recycle Bin (never a permanent delete).",
            "inputSchema": obj(json!({ "paths": { "type": "array", "items": { "type": "string" } }, "dryRun": dry }), &["paths"]) }),
        json!({ "name": "phile_rename", "description": "Rename one file or folder in place.",
            "inputSchema": obj(json!({ "path": path, "name": { "type": "string", "description": "New name only, no folders" }, "dryRun": dry }), &["path", "name"]) }),
        json!({ "name": "phile_mkdir", "description": "Create a folder (and any missing parents).",
            "inputSchema": obj(json!({ "path": path }), &["path"]) }),
        json!({ "name": "phile_undo", "description": "Undo the most recent batch of Phile moves, copies, renames and new folders.",
            "inputSchema": obj(json!({ "dryRun": dry }), &[]) }),
        json!({ "name": "phile_history", "description": "Recent file changes made through Phile tools, newest first.",
            "inputSchema": obj(json!({ "limit": { "type": "integer" } }), &[]) }),
        json!({ "name": "phile_places", "description": "Drives, well-known folders (Desktop, Documents, Downloads...), Phile pins and the working folder.",
            "inputSchema": obj(json!({}), &[]) }),
    ]
}

/// True for tools that change files (the mod asks before these unless dry-run).
pub fn is_mutating(tool: &str) -> bool {
    matches!(
        tool.trim_start_matches("mcp__phile__"),
        "phile_move" | "phile_copy" | "phile_trash" | "phile_rename" | "phile_mkdir" | "phile_undo"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(t: &Path) -> Ctx {
        Ctx {
            cwd: t.join("work"),
            data: t.join("data"),
        }
    }

    #[test]
    fn move_then_undo_restores() {
        let t = tempfile::tempdir().unwrap();
        let c = ctx(t.path());
        std::fs::create_dir_all(c.cwd.join("inbox")).unwrap();
        std::fs::write(c.cwd.join("inbox/a.txt"), b"a").unwrap();
        std::fs::write(c.cwd.join("inbox/b.txt"), b"b").unwrap();

        let dry = call(
            &c,
            "phile_move",
            &json!({ "sources": ["inbox/a.txt"], "dest": "sorted", "dryRun": true }),
        )
        .unwrap();
        assert_eq!(dry["dryRun"], true);
        assert!(!c.cwd.join("sorted").exists());

        let r = call(
            &c,
            "phile_move",
            &json!({ "sources": ["inbox/a.txt", "inbox/b.txt"], "dest": "sorted" }),
        )
        .unwrap();
        assert_eq!(r["done"], 2, "{r}");
        assert!(c.cwd.join("sorted/a.txt").exists());
        assert!(!c.cwd.join("inbox/a.txt").exists());

        let u = call(&c, "phile_undo", &json!({})).unwrap();
        assert_eq!(u["undone"], 2, "{u}");
        assert!(c.cwd.join("inbox/a.txt").exists());
        assert!(!c.cwd.join("sorted/b.txt").exists());

        let again = call(&c, "phile_undo", &json!({})).unwrap();
        assert_eq!(again["undone"], 0);
    }

    #[test]
    fn copy_collision_renames_and_records() {
        let t = tempfile::tempdir().unwrap();
        let c = ctx(t.path());
        std::fs::create_dir_all(c.cwd.join("dst")).unwrap();
        std::fs::write(c.cwd.join("x.md"), b"new").unwrap();
        std::fs::write(c.cwd.join("dst/x.md"), b"old").unwrap();
        let r = call(
            &c,
            "phile_copy",
            &json!({ "sources": "x.md", "dest": "dst", "verify": true }),
        )
        .unwrap();
        assert_eq!(r["done"], 1, "{r}");
        assert!(c.cwd.join("dst/x (2).md").exists());
        assert_eq!(std::fs::read(c.cwd.join("dst/x.md")).unwrap(), b"old");
        let h = call(&c, "phile_history", &json!({})).unwrap();
        assert_eq!(h["entries"][0]["op"], "copy");
    }

    #[test]
    fn rename_rejects_paths_and_protected() {
        let t = tempfile::tempdir().unwrap();
        let c = ctx(t.path());
        std::fs::create_dir_all(&c.cwd).unwrap();
        std::fs::write(c.cwd.join("a.txt"), b"a").unwrap();
        assert!(call(
            &c,
            "phile_rename",
            &json!({ "path": "a.txt", "name": "../b.txt" })
        )
        .is_err());
        call(
            &c,
            "phile_rename",
            &json!({ "path": "a.txt", "name": "b.txt" }),
        )
        .unwrap();
        assert!(c.cwd.join("b.txt").exists());
        assert!(call(&c, "phile_trash", &json!({ "paths": ["/"] }))
            .unwrap_err()
            .contains("protected"));
        if let Some(h) = dirs::home_dir() {
            assert!(call(&c, "phile_move", &json!({ "sources": [h], "dest": "x" })).is_err());
        }
    }

    #[test]
    fn search_tree_list_and_schema() {
        let t = tempfile::tempdir().unwrap();
        let c = ctx(t.path());
        std::fs::create_dir_all(c.cwd.join("docs")).unwrap();
        std::fs::write(c.cwd.join("docs/report_q3.txt"), b"revenue up").unwrap();
        let r = call(&c, "phile_search", &json!({ "query": "rq3" })).unwrap();
        assert_eq!(r["hits"].as_array().unwrap().len(), 1);
        let r = call(
            &c,
            "phile_search",
            &json!({ "query": "revenue", "content": true }),
        )
        .unwrap();
        assert_eq!(r["hits"][0]["line"], 1);
        assert_eq!(
            call(&c, "phile_tree", &json!({})).unwrap()["children"][0]["name"],
            "docs"
        );
        assert_eq!(
            call(&c, "phile_list", &json!({ "path": "docs" })).unwrap()["total"],
            1
        );
        assert!(call(&c, "nope", &json!({})).is_err());
        for t in tools() {
            let n = t["name"].as_str().unwrap();
            assert!(n.starts_with("phile_") && t["inputSchema"]["type"] == "object");
        }
    }
}
