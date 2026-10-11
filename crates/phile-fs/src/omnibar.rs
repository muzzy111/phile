//! Smart omnibar: turns whatever the user typed into a navigation target.
//! Accepts Windows and POSIX paths, `~`, `%VAR%`, `$VAR`, `${VAR}`,
//! user aliases (`@proj` -> path), `file:///` URLs, and direct file jumps.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Target {
    /// Navigate to this directory.
    Dir { path: String },
    /// Navigate to the parent and select the file.
    File { dir: String, path: String },
    /// Nothing exists there; `fallback` is the nearest existing ancestor.
    NotFound {
        input: String,
        expanded: String,
        fallback: Option<String>,
    },
}

/// Resolve `input` relative to `cwd`, using `aliases` and the process environment.
pub fn resolve(input: &str, cwd: &Path, aliases: &HashMap<String, String>) -> Target {
    resolve_with(
        input,
        cwd,
        aliases,
        &|k| std::env::var(k).ok(),
        dirs::home_dir(),
    )
}

pub fn resolve_with(
    input: &str,
    cwd: &Path,
    aliases: &HashMap<String, String>,
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<PathBuf>,
) -> Target {
    let expanded = expand(input.trim(), aliases, env, home.as_deref());
    let p = PathBuf::from(&expanded);
    let p = if p.is_absolute() || has_drive(&expanded) {
        p
    } else {
        cwd.join(p)
    };
    let p = normalize(&p);
    let s = p.to_string_lossy().into_owned();
    if p.is_dir() {
        Target::Dir { path: s }
    } else if p.exists() {
        let dir = p
            .parent()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default();
        Target::File { dir, path: s }
    } else {
        let fallback = p
            .ancestors()
            .skip(1)
            .find(|a| a.is_dir())
            .map(|a| a.to_string_lossy().into_owned());
        Target::NotFound {
            input: input.into(),
            expanded: s,
            fallback,
        }
    }
}

fn has_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// Expand aliases, `~`, env vars, quotes and URL prefixes. Pure string transform.
pub fn expand(
    input: &str,
    aliases: &HashMap<String, String>,
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<&Path>,
) -> String {
    let mut s = input.trim_matches('"').trim_matches('\'').to_string();
    if let Some(rest) = s.strip_prefix("file:///") {
        s = percent_decode(rest);
        if !has_drive(&s) {
            s = format!("/{s}");
        }
    }
    // Alias: "@name" or "@name/rest"
    if let Some(rest) = s.strip_prefix('@') {
        let (name, tail) = rest
            .split_once(['/', '\\'])
            .map(|(a, b)| (a, Some(b)))
            .unwrap_or((rest, None));
        if let Some(target) = aliases.get(name) {
            s = match tail {
                Some(t) => format!("{}/{}", target.trim_end_matches(['/', '\\']), t),
                None => target.clone(),
            };
        }
    }
    if s == "~" || s.starts_with("~/") || s.starts_with("~\\") {
        if let Some(h) = home {
            s = format!("{}{}", h.to_string_lossy(), &s[1..]);
        }
    }
    s = expand_env(&s, env);
    // Windows accepts forward slashes; POSIX-style "/c/Users" (Git Bash) -> "C:/Users".
    if cfg!(windows) {
        let b = s.as_bytes();
        if b.len() >= 2
            && b[0] == b'/'
            && b[1].is_ascii_alphabetic()
            && (b.len() == 2 || b[2] == b'/')
        {
            s = format!("{}:{}", (b[1] as char).to_ascii_uppercase(), &s[2..]);
        }
        if s.starts_with("/mnt/")
            && s.len() >= 6
            && s.as_bytes()[5].is_ascii_alphabetic()
            && (s.len() == 6 || s.as_bytes()[6] == b'/')
        {
            s = format!(
                "{}:{}",
                (s.as_bytes()[5] as char).to_ascii_uppercase(),
                &s[6..]
            );
        }
    }
    s
}

fn expand_env(s: &str, env: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let c: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '%' => {
                if let Some(j) = c[i + 1..].iter().position(|&x| x == '%') {
                    let name: String = c[i + 1..i + 1 + j].iter().collect();
                    if !name.is_empty() {
                        if let Some(v) = env(&name).or_else(|| env(&name.to_uppercase())) {
                            out.push_str(&v);
                            i += j + 2;
                            continue;
                        }
                    }
                }
                out.push('%');
                i += 1;
            }
            '$' => {
                let (name, len) = if c.get(i + 1) == Some(&'{') {
                    match c[i + 2..].iter().position(|&x| x == '}') {
                        Some(j) => (c[i + 2..i + 2 + j].iter().collect::<String>(), j + 3),
                        None => (String::new(), 0),
                    }
                } else {
                    let n: String = c[i + 1..]
                        .iter()
                        .take_while(|x| x.is_ascii_alphanumeric() || **x == '_')
                        .collect();
                    let l = n.chars().count() + 1;
                    (n, l)
                };
                match (!name.is_empty()).then(|| env(&name)).flatten() {
                    Some(v) => {
                        out.push_str(&v);
                        i += len;
                    }
                    None => {
                        out.push('$');
                        i += 1;
                    }
                }
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Lexically resolve `.` and `..` without touching the disk.
pub fn normalize(p: &Path) -> PathBuf {
    use std::path::Component::*;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            CurDir => {}
            ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(k: &str) -> Option<String> {
        match k {
            "APPDATA" => Some("/appdata".into()),
            "HOME" => Some("/home/u".into()),
            _ => None,
        }
    }

    #[test]
    fn expands_everything() {
        let mut al = HashMap::new();
        al.insert("proj".to_string(), "/work/proj".to_string());
        let h = Some(Path::new("/home/u"));
        assert_eq!(expand("%APPDATA%/x", &al, &env, h), "/appdata/x");
        assert_eq!(expand("%appdata%", &al, &env, h), "/appdata");
        assert_eq!(expand("$HOME/a", &al, &env, h), "/home/u/a");
        assert_eq!(expand("${HOME}b", &al, &env, h), "/home/ub");
        assert_eq!(expand("~/docs", &al, &env, h), "/home/u/docs");
        assert_eq!(expand("@proj/src", &al, &env, h), "/work/proj/src");
        assert_eq!(expand("100%", &al, &env, h), "100%");
        assert_eq!(expand("$NOPE", &al, &env, h), "$NOPE");
        assert_eq!(expand("file:///tmp/a%20b", &al, &env, h), "/tmp/a b");
    }

    #[test]
    fn resolves_file_and_dir() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("f.txt"), b"").unwrap();
        let al = HashMap::new();
        match resolve("f.txt", t.path(), &al) {
            Target::File { path, .. } => assert!(path.ends_with("f.txt")),
            o => panic!("{o:?}"),
        }
        assert!(matches!(resolve(".", t.path(), &al), Target::Dir { .. }));
        match resolve("nope/deeper", t.path(), &al) {
            Target::NotFound { fallback, .. } => assert!(fallback.is_some()),
            o => panic!("{o:?}"),
        }
    }

    #[test]
    fn normalizes() {
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
    }
}
