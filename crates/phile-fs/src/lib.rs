//! Filesystem primitives: listing, flattening and omnibar resolution.
//! No UI or Tauri dependencies; everything here is testable headless.

pub mod omnibar;
pub mod search;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("not a directory: {0}")]
    NotDir(PathBuf),
}

pub type Result<T> = std::result::Result<T, FsError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: Kind,
    pub size: u64,
    /// Milliseconds since Unix epoch; 0 when unknown.
    pub modified: i64,
    pub hidden: bool,
    pub ext: String,
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> i64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn is_hidden(_name: &str, md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    md.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn is_hidden(name: &str, _md: &std::fs::Metadata) -> bool {
    name.starts_with('.')
}

pub fn entry_from_path(path: &Path) -> Result<Entry> {
    let lmd = std::fs::symlink_metadata(path).map_err(|e| FsError::Io {
        path: path.into(),
        source: e,
    })?;
    let is_link = lmd.file_type().is_symlink();
    let md = if is_link {
        std::fs::metadata(path).unwrap_or(lmd.clone())
    } else {
        lmd.clone()
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let kind = if is_link {
        Kind::Symlink
    } else if md.is_dir() {
        Kind::Dir
    } else if md.is_file() {
        Kind::File
    } else {
        Kind::Other
    };
    let ext = if md.is_dir() {
        String::new()
    } else {
        path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };
    Ok(Entry {
        hidden: is_hidden(&name, &lmd),
        name,
        path: path.to_string_lossy().into_owned(),
        kind: if is_link && md.is_dir() {
            Kind::Symlink
        } else {
            kind
        },
        size: if md.is_file() { md.len() } else { 0 },
        modified: ms(md.modified()),
        ext,
    })
}

/// List a directory's immediate children. Unreadable children are skipped, not fatal.
pub fn list_dir(dir: &Path) -> Result<Vec<Entry>> {
    if !dir.is_dir() {
        return Err(FsError::NotDir(dir.into()));
    }
    let rd = std::fs::read_dir(dir).map_err(|e| FsError::Io {
        path: dir.into(),
        source: e,
    })?;
    let mut out: Vec<Entry> = rd
        .filter_map(|r| r.ok())
        .filter_map(|d| entry_from_path(&d.path()).ok())
        .collect();
    sort_default(&mut out);
    Ok(out)
}

/// Folders first, then case-insensitive natural-ish name order.
pub fn sort_default(v: &mut [Entry]) {
    v.sort_by(|a, b| {
        let ad = a.kind == Kind::Dir;
        let bd = b.kind == Kind::Dir;
        bd.cmp(&ad)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// "Flatten subfolders": every file below `dir`, up to `limit` entries.
pub fn flatten(dir: &Path, limit: usize) -> Result<Vec<Entry>> {
    if !dir.is_dir() {
        return Err(FsError::NotDir(dir.into()));
    }
    Ok(walkdir::WalkDir::new(dir)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .take(limit)
        .filter_map(|e| entry_from_path(e.path()).ok())
        .collect())
}

/// Breadcrumb segments for a path: (label, absolute path).
pub fn breadcrumbs(path: &Path) -> Vec<(String, String)> {
    let mut acc = PathBuf::new();
    let mut out = Vec::new();
    for c in path.components() {
        acc.push(c);
        let label = c
            .as_os_str()
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_string();
        if label.is_empty() && !out.is_empty() {
            continue;
        }
        out.push((
            if label.is_empty() { "/".into() } else { label },
            acc.to_string_lossy().into_owned(),
        ));
    }
    out
}

fn root_entry(p: String) -> Entry {
    Entry {
        name: p.clone(),
        path: p,
        kind: Kind::Dir,
        size: 0,
        modified: 0,
        hidden: false,
        ext: String::new(),
    }
}

/// Drives (Windows) or `/` (elsewhere) for the sidebar.
#[cfg(windows)]
pub fn roots() -> Vec<Entry> {
    (b'A'..=b'Z')
        .map(|l| format!("{}:\\", l as char))
        .filter(|p| Path::new(p).exists())
        .map(root_entry)
        .collect()
}

#[cfg(not(windows))]
pub fn roots() -> Vec<Entry> {
    vec![root_entry("/".into())]
}

/// Well-known folders for the sidebar.
pub fn known_folders() -> Vec<(String, String)> {
    let mut v = Vec::new();
    let mut push = |label: &str, p: Option<PathBuf>| {
        if let Some(p) = p {
            v.push((label.to_string(), p.to_string_lossy().into_owned()));
        }
    };
    push("Home", dirs::home_dir());
    push("Desktop", dirs::desktop_dir());
    push("Documents", dirs::document_dir());
    push("Downloads", dirs::download_dir());
    push("Pictures", dirs::picture_dir());
    push("Music", dirs::audio_dir());
    push("Videos", dirs::video_dir());
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_dirs_first() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("a.txt"), b"hi").unwrap();
        std::fs::create_dir(t.path().join("zdir")).unwrap();
        let v = list_dir(t.path()).unwrap();
        assert_eq!(v[0].name, "zdir");
        assert_eq!(v[1].ext, "txt");
        assert_eq!(v[1].size, 2);
    }

    #[test]
    fn flattens_nested() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("a/b/c")).unwrap();
        std::fs::write(t.path().join("a/b/c/deep.md"), b"x").unwrap();
        std::fs::write(t.path().join("top.md"), b"x").unwrap();
        let v = flatten(t.path(), 100).unwrap();
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn crumbs() {
        let c = breadcrumbs(Path::new("/usr/local/bin"));
        assert_eq!(c.last().unwrap().0, "bin");
        assert_eq!(c.len(), 4);
    }
}
