//! Local persistence in one SQLite file (WAL). Versioned migrations keep
//! user data intact across upgrades: append to `MIGRATIONS`, never edit.

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, StoreError>;

const MIGRATIONS: &[&str] = &[
    // 1: initial schema
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE workspaces (name TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL);
     CREATE TABLE aliases (name TEXT PRIMARY KEY, path TEXT NOT NULL);
     CREATE TABLE visits (path TEXT PRIMARY KEY, count INTEGER NOT NULL, last INTEGER NOT NULL);
     CREATE TABLE pins (path TEXT PRIMARY KEY, label TEXT NOT NULL, ord INTEGER NOT NULL);",
];

pub struct Store {
    db: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub name: String,
    pub updated: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirHit {
    pub path: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub path: String,
    pub label: String,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(p) = path.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        Self::init(Connection::open(path)?)
    }

    pub fn memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(c: Connection) -> Result<Self> {
        c.pragma_update(None, "journal_mode", "WAL")?;
        c.pragma_update(None, "synchronous", "NORMAL")?;
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, m) in MIGRATIONS.iter().enumerate().skip(v as usize) {
            c.execute_batch(&format!("BEGIN; {m}; PRAGMA user_version = {}; COMMIT;", i + 1))?;
        }
        Ok(Self { db: Mutex::new(c) })
    }

    // ---- settings (JSON values) ----
    pub fn get_setting<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Result<Option<T>> {
        let s: Option<String> = self.db.lock().unwrap().query_row("SELECT value FROM settings WHERE key=?", [key], |r| r.get(0)).optional()?;
        Ok(match s {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        })
    }
    pub fn set_setting<T: Serialize>(&self, key: &str, v: &T) -> Result<()> {
        let s = serde_json::to_string(v)?;
        self.db.lock().unwrap().execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, s])?;
        Ok(())
    }

    // ---- workspaces (opaque JSON from the UI) ----
    pub fn save_workspace(&self, name: &str, state: &serde_json::Value) -> Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT INTO workspaces(name,state,updated) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state, updated=excluded.updated",
            params![name, state.to_string(), now()],
        )?;
        Ok(())
    }
    pub fn load_workspace(&self, name: &str) -> Result<Option<serde_json::Value>> {
        let s: Option<String> = self.db.lock().unwrap().query_row("SELECT state FROM workspaces WHERE name=?", [name], |r| r.get(0)).optional()?;
        Ok(match s {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        })
    }
    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare("SELECT name, updated FROM workspaces ORDER BY updated DESC")?;
        let v = st.query_map([], |r| Ok(WorkspaceInfo { name: r.get(0)?, updated: r.get(1)? }))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    }
    pub fn delete_workspace(&self, name: &str) -> Result<()> {
        self.db.lock().unwrap().execute("DELETE FROM workspaces WHERE name=?", [name])?;
        Ok(())
    }

    // ---- aliases (@name) ----
    pub fn aliases(&self) -> Result<std::collections::HashMap<String, String>> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare("SELECT name, path FROM aliases")?;
        let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(v)
    }
    pub fn set_alias(&self, name: &str, path: &str) -> Result<()> {
        self.db.lock().unwrap().execute("INSERT OR REPLACE INTO aliases(name,path) VALUES(?,?)", params![name, path])?;
        Ok(())
    }
    pub fn remove_alias(&self, name: &str) -> Result<()> {
        self.db.lock().unwrap().execute("DELETE FROM aliases WHERE name=?", [name])?;
        Ok(())
    }

    // ---- pins ----
    pub fn pins(&self) -> Result<Vec<Pin>> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare("SELECT path, label FROM pins ORDER BY ord")?;
        let v = st.query_map([], |r| Ok(Pin { path: r.get(0)?, label: r.get(1)? }))?.collect::<rusqlite::Result<_>>()?;
        Ok(v)
    }
    pub fn set_pins(&self, pins: &[Pin]) -> Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM pins", [])?;
        for (i, p) in pins.iter().enumerate() {
            tx.execute("INSERT INTO pins(path,label,ord) VALUES(?,?,?)", params![p.path, p.label, i as i64])?;
        }
        tx.commit()?;
        Ok(())
    }

    // ---- frecency + fuzzy teleport ----
    pub fn record_visit(&self, path: &str) -> Result<()> {
        self.db.lock().unwrap().execute(
            "INSERT INTO visits(path,count,last) VALUES(?,1,?) ON CONFLICT(path) DO UPDATE SET count=count+1, last=excluded.last",
            params![path, now()],
        )?;
        Ok(())
    }
    pub fn forget_visit(&self, path: &str) -> Result<()> {
        self.db.lock().unwrap().execute("DELETE FROM visits WHERE path=?", [path])?;
        Ok(())
    }

    /// Fuzzy-match `query` against visited directories, ranked by match quality x frecency.
    /// Empty query returns the most frecent directories.
    pub fn teleport(&self, query: &str, limit: usize) -> Result<Vec<DirHit>> {
        let rows: Vec<(String, i64, i64)> = {
            let db = self.db.lock().unwrap();
            let mut st = db.prepare("SELECT path, count, last FROM visits")?;
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
            v
        };
        let t = now();
        let frec = |count: i64, last: i64| {
            let age_h = ((t - last).max(0) as f64) / 3600.0;
            let w = if age_h < 1.0 { 4.0 } else if age_h < 24.0 { 2.0 } else if age_h < 168.0 { 1.0 } else { 0.5 };
            (count as f64) * w
        };
        let mut hits: Vec<DirHit> = if query.trim().is_empty() {
            rows.iter().map(|(p, c, l)| DirHit { path: p.clone(), score: frec(*c, *l) }).collect()
        } else {
            let mut m = Matcher::new(Config::DEFAULT.match_paths());
            let pat = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
            let mut buf = Vec::new();
            rows.iter()
                .filter_map(|(p, c, l)| {
                    let s = pat.score(Utf32Str::new(p, &mut buf), &mut m)?;
                    Some(DirHit { path: p.clone(), score: s as f64 * (1.0 + frec(*c, *l).ln_1p()) })
                })
                .collect()
        };
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(limit);
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips() {
        let s = Store::memory().unwrap();
        s.set_setting("theme", &"dark").unwrap();
        assert_eq!(s.get_setting::<String>("theme").unwrap().as_deref(), Some("dark"));
        s.save_workspace("Project A", &serde_json::json!({"tabs": 2})).unwrap();
        assert_eq!(s.load_workspace("Project A").unwrap().unwrap()["tabs"], 2);
        assert_eq!(s.list_workspaces().unwrap().len(), 1);
        s.set_alias("proj", "C:/work").unwrap();
        assert_eq!(s.aliases().unwrap()["proj"], "C:/work");
    }

    #[test]
    fn teleport_ranks() {
        let s = Store::memory().unwrap();
        for _ in 0..5 {
            s.record_visit("/home/u/projects/phile").unwrap();
        }
        s.record_visit("/home/u/photos").unwrap();
        s.record_visit("/var/log").unwrap();
        let h = s.teleport("phl", 10).unwrap();
        assert_eq!(h[0].path, "/home/u/projects/phile");
        assert_eq!(s.teleport("", 10).unwrap()[0].path, "/home/u/projects/phile");
    }

    #[test]
    fn migrations_persist() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.db");
        Store::open(&p).unwrap().set_setting("k", &1).unwrap();
        assert_eq!(Store::open(&p).unwrap().get_setting::<i32>("k").unwrap(), Some(1));
    }
}
