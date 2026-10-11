//! Recursive search and tree snapshots for agents and the UI.
//! Name matching is fuzzy (nucleo, same scorer as teleport); content
//! matching is a case-insensitive substring scan of small text files.

use crate::{entry_from_path, sort_default, Entry, FsError, Kind, Result};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::time::{Duration, Instant};

/// Folders that are almost never what a person is looking for.
pub const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "__pycache__",
    "$RECYCLE.BIN",
    "System Volume Information",
    ".next",
    "dist",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOpts {
    pub query: String,
    /// Also scan file contents for `query` (substring, case-insensitive).
    pub content: bool,
    pub limit: usize,
    pub max_depth: usize,
    pub include_hidden: bool,
    /// Lowercase extensions without dot; empty = all.
    pub ext: Vec<String>,
    /// Only files, only dirs, or both ("file" | "dir" | "").
    pub kind: String,
    pub timeout_ms: u64,
}

impl Default for SearchOpts {
    fn default() -> Self {
        Self {
            query: String::new(),
            content: false,
            limit: 50,
            max_depth: 12,
            include_hidden: false,
            ext: vec![],
            kind: String::new(),
            timeout_ms: 15_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub entry: Entry,
    pub score: u32,
    /// 1-based line of the first content match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    pub scanned: u64,
    /// True when the walk stopped early (timeout); results may be incomplete.
    pub truncated: bool,
}

const MAX_CONTENT_BYTES: u64 = 4 << 20;

fn skip(name: &str, hidden: bool, opts: &SearchOpts) -> bool {
    SKIP_DIRS.iter().any(|d| d.eq_ignore_ascii_case(name)) || (hidden && !opts.include_hidden)
}

fn quick_hidden(e: &walkdir::DirEntry) -> bool {
    e.file_name().to_string_lossy().starts_with('.')
        || entry_from_path(e.path()).map(|x| x.hidden).unwrap_or(false)
}

fn looks_binary(path: &Path) -> bool {
    let mut buf = [0u8; 8192];
    match std::fs::File::open(path).and_then(|mut f| f.read(&mut buf)) {
        Ok(n) => buf[..n].contains(&0),
        Err(_) => true,
    }
}

fn content_match(path: &Path, needle_lc: &str) -> Option<(u64, String)> {
    let md = std::fs::metadata(path).ok()?;
    if md.len() > MAX_CONTENT_BYTES || looks_binary(path) {
        return None;
    }
    let f = std::fs::File::open(path).ok()?;
    for (i, line) in BufReader::new(f).lines().enumerate() {
        let line = line.ok()?;
        if line.to_lowercase().contains(needle_lc) {
            let s: String = line.trim().chars().take(200).collect();
            return Some((i as u64 + 1, s));
        }
    }
    None
}

/// Walk `root` and return the best matches, highest score first.
pub fn search(root: &Path, opts: &SearchOpts) -> Result<SearchResult> {
    if !root.is_dir() {
        return Err(FsError::NotDir(root.into()));
    }
    let q = opts.query.trim();
    let pat = Pattern::parse(q, CaseMatching::Smart, Normalization::Smart);
    let mut m = Matcher::new(Config::DEFAULT);
    let mut buf = Vec::new();
    let needle = q.to_lowercase();
    let deadline = Instant::now() + Duration::from_millis(opts.timeout_ms.max(100));
    let mut hits: Vec<Hit> = Vec::new();
    let mut scanned = 0u64;
    let mut truncated = false;
    let walker = walkdir::WalkDir::new(root)
        .min_depth(1)
        .max_depth(opts.max_depth.max(1))
        .into_iter()
        .filter_entry(|e| {
            !(e.file_type().is_dir()
                && skip(&e.file_name().to_string_lossy(), quick_hidden(e), opts))
        });
    for e in walker.filter_map(|e| e.ok()) {
        if Instant::now() > deadline {
            truncated = true;
            break;
        }
        scanned += 1;
        let is_dir = e.file_type().is_dir();
        match opts.kind.as_str() {
            "file" if is_dir => continue,
            "dir" if !is_dir => continue,
            _ => {}
        }
        if !opts.include_hidden && !is_dir && quick_hidden(&e) {
            continue;
        }
        let name = e.file_name().to_string_lossy();
        if !opts.ext.is_empty() {
            let ext = e
                .path()
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if is_dir
                || !opts
                    .ext
                    .iter()
                    .any(|x| x.trim_start_matches('.').eq_ignore_ascii_case(&ext))
            {
                continue;
            }
        }
        let name_score = if q.is_empty() {
            Some(1)
        } else {
            pat.score(Utf32Str::new(&name, &mut buf), &mut m)
        };
        let (score, line, snippet) = match name_score {
            Some(s) => (s + 1000, None, None),
            None if opts.content && !is_dir && !needle.is_empty() => {
                match content_match(e.path(), &needle) {
                    Some((l, s)) => (500, Some(l), Some(s)),
                    None => continue,
                }
            }
            None => continue,
        };
        if let Ok(entry) = entry_from_path(e.path()) {
            hits.push(Hit {
                entry,
                score,
                line,
                snippet,
            });
        }
    }
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.entry.path.len().cmp(&b.entry.path.len()))
    });
    hits.truncate(opts.limit.max(1));
    Ok(SearchResult {
        hits,
        scanned,
        truncated,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: Kind,
    pub size: u64,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub children: Vec<TreeNode>,
    /// Children not shown because of the depth or entry limit.
    #[serde(skip_serializing_if = "is_zero", default)]
    pub more: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// Folder tree down to `depth` levels, at most `limit` nodes overall.
pub fn tree(root: &Path, depth: usize, limit: usize, include_hidden: bool) -> Result<TreeNode> {
    let e = entry_from_path(root)?;
    if e.kind != Kind::Dir {
        return Err(FsError::NotDir(root.into()));
    }
    let mut budget = limit.max(1);
    Ok(build(e, depth, &mut budget, include_hidden))
}

fn build(e: Entry, depth: usize, budget: &mut usize, include_hidden: bool) -> TreeNode {
    let mut node = TreeNode {
        name: e.name,
        path: e.path,
        kind: e.kind,
        size: e.size,
        children: vec![],
        more: 0,
    };
    if node.kind != Kind::Dir {
        return node;
    }
    let Ok(mut kids) = crate::list_dir(Path::new(&node.path)) else {
        return node;
    };
    kids.retain(|k| include_hidden || !k.hidden);
    sort_default(&mut kids);
    if depth == 0 {
        node.more = kids.len();
        return node;
    }
    let total = kids.len();
    for k in kids {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let skip_inner =
            k.kind == Kind::Dir && SKIP_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&k.name));
        let d = if skip_inner { 0 } else { depth - 1 };
        node.children.push(build(k, d, budget, include_hidden));
    }
    node.more = total - node.children.len();
    node
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        let p = t.path();
        std::fs::create_dir_all(p.join("src/deep")).unwrap();
        std::fs::create_dir_all(p.join("node_modules/pkg")).unwrap();
        std::fs::write(p.join("src/deep/invoice_2024.pdf"), b"%PDF").unwrap();
        std::fs::write(p.join("src/notes.md"), "shopping\nbuy Milk today\n").unwrap();
        std::fs::write(p.join("node_modules/pkg/invoice.js"), b"x").unwrap();
        std::fs::write(p.join("bin.dat"), [0u8, 1, 2, b'm', b'i', b'l', b'k']).unwrap();
        t
    }

    #[test]
    fn fuzzy_name_skips_noise_dirs() {
        let t = fixture();
        let r = search(
            t.path(),
            &SearchOpts {
                query: "inv24".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.hits.len(), 1);
        assert!(r.hits[0].entry.path.ends_with("invoice_2024.pdf"));
    }

    #[test]
    fn content_match_reports_line_and_ignores_binary() {
        let t = fixture();
        let r = search(
            t.path(),
            &SearchOpts {
                query: "milk".into(),
                content: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].line, Some(2));
        assert_eq!(r.hits[0].snippet.as_deref(), Some("buy Milk today"));
    }

    #[test]
    fn filters_by_ext_and_kind() {
        let t = fixture();
        let r = search(
            t.path(),
            &SearchOpts {
                ext: vec![".md".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.hits.len(), 1);
        let r = search(
            t.path(),
            &SearchOpts {
                kind: "dir".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(r.hits.iter().all(|h| h.entry.kind == Kind::Dir));
        assert_eq!(r.hits.len(), 2); // src, src/deep
    }

    #[test]
    fn tree_respects_depth_and_limit() {
        let t = fixture();
        let n = tree(t.path(), 1, 100, false).unwrap();
        let src = n.children.iter().find(|c| c.name == "src").unwrap();
        assert!(src.children.is_empty());
        assert_eq!(src.more, 2);
        let n = tree(t.path(), 5, 2, false).unwrap();
        assert_eq!(n.children.len(), 2);
        assert!(n.more > 0);
    }
}
