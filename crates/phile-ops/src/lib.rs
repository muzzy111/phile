//! Asynchronous file-operation queue.
//!
//! Jobs run on a fixed worker pool. Each job streams `JobEvent`s to a sink
//! (the UI adapter forwards them as Tauri events). Jobs can be paused,
//! resumed and cancelled; per-file failures retry with backoff; copies can
//! be throttled and verified with blake3; name collisions resolve per policy.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub type JobId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpKind {
    Copy,
    Move,
    /// Send to Recycle Bin (safe default).
    Trash,
    /// Permanent delete.
    Delete,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Collision {
    /// "name (2).ext"
    #[default]
    Rename,
    Overwrite,
    Skip,
    /// Overwrite only when the source is newer.
    Newer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub kind: OpKind,
    pub sources: Vec<PathBuf>,
    #[serde(default)]
    pub dest: Option<PathBuf>,
    #[serde(default)]
    pub collision: Collision,
    #[serde(default)]
    pub verify: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Running,
    Paused,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub id: JobId,
    pub kind: OpKind,
    pub state: JobState,
    pub files_total: u64,
    pub files_done: u64,
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub current: String,
    pub errors: Vec<String>,
    pub label: String,
}

pub type Sink = Arc<dyn Fn(&JobProgress) + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum OpError {
    #[error("{0}: {1}")]
    Io(String, std::io::Error),
    #[error("verification failed for {0}")]
    Verify(String),
    #[error("destination required")]
    NoDest,
    #[error("cannot copy a folder into itself: {0}")]
    IntoSelf(String),
    #[error("cancelled")]
    Cancelled,
    #[error("trash: {0}")]
    Trash(String),
}

struct Control {
    paused: AtomicBool,
    cancelled: AtomicBool,
}

struct Job {
    spec: JobSpec,
    ctl: Arc<Control>,
    progress: Arc<Mutex<JobProgress>>,
}

struct Shared {
    queue: Mutex<VecDeque<JobId>>,
    jobs: Mutex<HashMap<JobId, Arc<Job>>>,
    cv: Condvar,
    next: AtomicU64,
    /// Bytes per second; 0 = unlimited.
    throttle: AtomicU64,
    sink: Sink,
    shutdown: AtomicBool,
}

#[derive(Clone)]
pub struct JobQueue {
    s: Arc<Shared>,
}

const RETRIES: u32 = 3;
const CHUNK: usize = 1 << 20;

impl JobQueue {
    pub fn new(workers: usize, sink: Sink) -> Self {
        let s = Arc::new(Shared {
            queue: Mutex::new(VecDeque::new()),
            jobs: Mutex::new(HashMap::new()),
            cv: Condvar::new(),
            next: AtomicU64::new(1),
            throttle: AtomicU64::new(0),
            sink,
            shutdown: AtomicBool::new(false),
        });
        for _ in 0..workers.max(1) {
            let s = s.clone();
            std::thread::spawn(move || worker(s));
        }
        Self { s }
    }

    pub fn submit(&self, spec: JobSpec) -> JobId {
        let id = self.s.next.fetch_add(1, Ordering::SeqCst);
        let label = label_for(&spec);
        let progress = JobProgress {
            id,
            kind: spec.kind,
            state: JobState::Queued,
            files_total: 0,
            files_done: 0,
            bytes_total: 0,
            bytes_done: 0,
            current: String::new(),
            errors: vec![],
            label,
        };
        (self.s.sink)(&progress);
        let job = Arc::new(Job {
            spec,
            ctl: Arc::new(Control { paused: AtomicBool::new(false), cancelled: AtomicBool::new(false) }),
            progress: Arc::new(Mutex::new(progress)),
        });
        self.s.jobs.lock().unwrap().insert(id, job);
        self.s.queue.lock().unwrap().push_back(id);
        self.s.cv.notify_one();
        id
    }

    fn with<F: FnOnce(&Job)>(&self, id: JobId, f: F) {
        if let Some(j) = self.s.jobs.lock().unwrap().get(&id) {
            f(j);
        }
    }

    pub fn pause(&self, id: JobId) {
        self.with(id, |j| j.ctl.paused.store(true, Ordering::SeqCst));
        self.set_state_if(id, JobState::Running, JobState::Paused);
    }
    pub fn resume(&self, id: JobId) {
        self.with(id, |j| j.ctl.paused.store(false, Ordering::SeqCst));
        self.set_state_if(id, JobState::Paused, JobState::Running);
    }
    pub fn cancel(&self, id: JobId) {
        self.with(id, |j| {
            j.ctl.cancelled.store(true, Ordering::SeqCst);
            j.ctl.paused.store(false, Ordering::SeqCst);
        });
    }
    pub fn set_throttle(&self, bytes_per_sec: u64) {
        self.s.throttle.store(bytes_per_sec, Ordering::SeqCst);
    }
    pub fn list(&self) -> Vec<JobProgress> {
        let mut v: Vec<_> = self.s.jobs.lock().unwrap().values().map(|j| j.progress.lock().unwrap().clone()).collect();
        v.sort_by_key(|p| p.id);
        v
    }
    /// Drop finished jobs from the list.
    pub fn clear_finished(&self) {
        self.s.jobs.lock().unwrap().retain(|_, j| {
            !matches!(j.progress.lock().unwrap().state, JobState::Done | JobState::Failed | JobState::Cancelled)
        });
    }
    pub fn get(&self, id: JobId) -> Option<JobProgress> {
        self.s.jobs.lock().unwrap().get(&id).map(|j| j.progress.lock().unwrap().clone())
    }
    /// Block until the job leaves the active states (tests / CLI).
    pub fn wait(&self, id: JobId, timeout: Duration) -> Option<JobProgress> {
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            if let Some(p) = self.get(id) {
                if matches!(p.state, JobState::Done | JobState::Failed | JobState::Cancelled) {
                    return Some(p);
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.get(id)
    }

    fn set_state_if(&self, id: JobId, from: JobState, to: JobState) {
        self.with(id, |j| {
            let mut p = j.progress.lock().unwrap();
            if p.state == from {
                p.state = to;
                (self.s.sink)(&p);
            }
        });
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }
}

fn label_for(spec: &JobSpec) -> String {
    let n = spec.sources.len();
    let what = if n == 1 {
        spec.sources[0].file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        format!("{n} items")
    };
    let verb = match spec.kind {
        OpKind::Copy => "Copy",
        OpKind::Move => "Move",
        OpKind::Trash => "Recycle",
        OpKind::Delete => "Delete",
    };
    match &spec.dest {
        Some(d) => format!("{verb} {what} → {}", d.display()),
        None => format!("{verb} {what}"),
    }
}

fn worker(s: Arc<Shared>) {
    loop {
        let id = {
            let mut q = s.queue.lock().unwrap();
            loop {
                if s.shutdown.load(Ordering::SeqCst) {
                    return;
                }
                if let Some(id) = q.pop_front() {
                    break id;
                }
                q = s.cv.wait_timeout(q, Duration::from_millis(500)).unwrap().0;
            }
        };
        let job = match s.jobs.lock().unwrap().get(&id) {
            Some(j) => j.clone(),
            None => continue,
        };
        run_job(&s, &job);
    }
}

struct Ctx<'a> {
    s: &'a Shared,
    job: &'a Job,
    last_emit: Mutex<Instant>,
}

impl Ctx<'_> {
    fn update<F: FnOnce(&mut JobProgress)>(&self, f: F, force: bool) {
        let mut p = self.job.progress.lock().unwrap();
        f(&mut p);
        let mut last = self.last_emit.lock().unwrap();
        if force || last.elapsed() > Duration::from_millis(100) {
            *last = Instant::now();
            (self.s.sink)(&p);
        }
    }
    /// Blocks while paused; errors if cancelled.
    fn checkpoint(&self) -> Result<(), OpError> {
        while self.job.ctl.paused.load(Ordering::SeqCst) {
            if self.job.ctl.cancelled.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if self.job.ctl.cancelled.load(Ordering::SeqCst) {
            return Err(OpError::Cancelled);
        }
        Ok(())
    }
}

fn run_job(s: &Shared, job: &Job) {
    let ctx = Ctx { s, job, last_emit: Mutex::new(Instant::now()) };
    if job.ctl.cancelled.load(Ordering::SeqCst) {
        ctx.update(|p| p.state = JobState::Cancelled, true);
        return;
    }
    ctx.update(|p| p.state = if job.ctl.paused.load(Ordering::SeqCst) { JobState::Paused } else { JobState::Running }, true);

    // Size pass so the UI can show real percentages.
    let (files, bytes) = measure(&job.spec.sources);
    ctx.update(|p| { p.files_total = files; p.bytes_total = bytes; }, true);

    let result = match job.spec.kind {
        OpKind::Copy | OpKind::Move => run_transfer(&ctx),
        OpKind::Trash => run_trash(&ctx),
        OpKind::Delete => run_delete(&ctx),
    };
    let final_state = match &result {
        Ok(()) if job.progress.lock().unwrap().errors.is_empty() => JobState::Done,
        Ok(()) => JobState::Failed,
        Err(OpError::Cancelled) => JobState::Cancelled,
        Err(_) => JobState::Failed,
    };
    ctx.update(
        |p| {
            if let Err(e) = &result {
                if !matches!(e, OpError::Cancelled) {
                    p.errors.push(e.to_string());
                }
            }
            p.state = final_state;
            p.current.clear();
        },
        true,
    );
}

fn measure(sources: &[PathBuf]) -> (u64, u64) {
    let (mut f, mut b) = (0, 0);
    for src in sources {
        for e in walkdir::WalkDir::new(src).into_iter().filter_map(|e| e.ok()) {
            if e.file_type().is_file() {
                f += 1;
                b += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (f, b)
}

fn io<T>(p: &Path, r: std::io::Result<T>) -> Result<T, OpError> {
    r.map_err(|e| OpError::Io(p.display().to_string(), e))
}

/// "report.pdf" -> "report (2).pdf", first free name.
pub fn unique_name(dest: &Path) -> PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let parent = dest.parent().unwrap_or(Path::new(""));
    let stem = dest.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = dest.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..).map(|n| parent.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap()
}

/// Apply the collision policy. `None` means skip.
fn resolve_target(src: &Path, target: PathBuf, policy: Collision) -> Option<PathBuf> {
    if !target.exists() {
        return Some(target);
    }
    match policy {
        Collision::Rename => Some(unique_name(&target)),
        Collision::Overwrite => Some(target),
        Collision::Skip => None,
        Collision::Newer => {
            let m = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
            (m(src) > m(&target)).then_some(target)
        }
    }
}

fn retry<T>(ctx: &Ctx, mut f: impl FnMut() -> Result<T, OpError>) -> Result<T, OpError> {
    let mut attempt = 0;
    loop {
        match f() {
            Err(OpError::Cancelled) => return Err(OpError::Cancelled),
            Err(e) if attempt + 1 < RETRIES => {
                attempt += 1;
                ctx.checkpoint()?;
                std::thread::sleep(Duration::from_millis(200 * (1 << attempt)));
                let _ = e;
            }
            r => return r,
        }
    }
}

fn run_transfer(ctx: &Ctx) -> Result<(), OpError> {
    let spec = &ctx.job.spec;
    let dest = spec.dest.as_ref().ok_or(OpError::NoDest)?;
    io(dest, std::fs::create_dir_all(dest))?;
    for src in &spec.sources {
        ctx.checkpoint()?;
        let name = src.file_name().unwrap_or(src.as_os_str());
        let canon_src = std::fs::canonicalize(src).unwrap_or(src.clone());
        let canon_dst = std::fs::canonicalize(dest).unwrap_or(dest.clone());
        if src.is_dir() && canon_dst.starts_with(&canon_src) {
            ctx.update(|p| p.errors.push(OpError::IntoSelf(src.display().to_string()).to_string()), true);
            continue;
        }
        let Some(target) = resolve_target(src, dest.join(name), spec.collision) else {
            let (f, b) = measure(std::slice::from_ref(src));
            ctx.update(|p| { p.files_done += f; p.bytes_done += b; }, false);
            continue;
        };
        // Same-volume move: a rename is instant and atomic.
        if spec.kind == OpKind::Move && !target.exists() && std::fs::rename(src, &target).is_ok() {
            let (f, b) = measure(std::slice::from_ref(&target));
            ctx.update(|p| { p.files_done += f; p.bytes_done += b; }, false);
            continue;
        }
        let r = if src.is_dir() { copy_tree(ctx, src, &target) } else { copy_one(ctx, src, &target) };
        match r {
            Ok(()) if spec.kind == OpKind::Move => {
                let rm = if src.is_dir() { std::fs::remove_dir_all(src) } else { std::fs::remove_file(src) };
                if let Err(e) = rm {
                    ctx.update(|p| p.errors.push(format!("{}: {e}", src.display())), true);
                }
            }
            Ok(()) => {}
            Err(OpError::Cancelled) => return Err(OpError::Cancelled),
            Err(e) => ctx.update(|p| p.errors.push(e.to_string()), true),
        }
    }
    Ok(())
}

fn copy_tree(ctx: &Ctx, src: &Path, target: &Path) -> Result<(), OpError> {
    io(target, std::fs::create_dir_all(target))?;
    for e in walkdir::WalkDir::new(src).min_depth(1).into_iter() {
        ctx.checkpoint()?;
        let e = match e {
            Ok(e) => e,
            Err(err) => {
                ctx.update(|p| p.errors.push(err.to_string()), true);
                continue;
            }
        };
        let rel = e.path().strip_prefix(src).unwrap();
        let out = target.join(rel);
        if e.file_type().is_dir() {
            io(&out, std::fs::create_dir_all(&out))?;
        } else if e.file_type().is_file() {
            let out = match resolve_target(e.path(), out, ctx.job.spec.collision) {
                Some(o) => o,
                None => continue,
            };
            if let Err(err) = copy_one(ctx, e.path(), &out) {
                if matches!(err, OpError::Cancelled) {
                    return Err(err);
                }
                ctx.update(|p| p.errors.push(err.to_string()), true);
            }
        }
    }
    Ok(())
}

fn copy_one(ctx: &Ctx, src: &Path, dst: &Path) -> Result<(), OpError> {
    ctx.update(|p| p.current = src.display().to_string(), false);
    let mut copied_total = 0u64;
    retry(ctx, || {
        // Roll back progress from a failed attempt.
        if copied_total > 0 {
            let c = copied_total;
            ctx.update(|p| p.bytes_done = p.bytes_done.saturating_sub(c), false);
            copied_total = 0;
        }
        let tmp = dst.with_file_name(format!(".{}.phile-part", dst.file_name().unwrap().to_string_lossy()));
        let mut r = io(src, File::open(src))?;
        let mut w = io(&tmp, File::create(&tmp))?;
        let mut buf = vec![0u8; CHUNK];
        let mut window_start = Instant::now();
        let mut window_bytes = 0u64;
        loop {
            if let Err(e) = ctx.checkpoint() {
                drop(w);
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
            let n = io(src, r.read(&mut buf))?;
            if n == 0 {
                break;
            }
            io(&tmp, w.write_all(&buf[..n]))?;
            copied_total += n as u64;
            ctx.update(|p| p.bytes_done += n as u64, false);
            let limit = ctx.s.throttle.load(Ordering::Relaxed);
            if limit > 0 {
                window_bytes += n as u64;
                let expected = Duration::from_secs_f64(window_bytes as f64 / limit as f64);
                let el = window_start.elapsed();
                if expected > el {
                    std::thread::sleep(expected - el);
                }
                if el > Duration::from_secs(1) {
                    window_start = Instant::now();
                    window_bytes = 0;
                }
            }
        }
        io(&tmp, w.flush())?;
        drop(w);
        if let Ok(md) = std::fs::metadata(src) {
            if let Ok(m) = md.modified() {
                let _ = File::options().write(true).open(&tmp).and_then(|f| f.set_modified(m));
            }
        }
        if ctx.job.spec.verify {
            let a = phile_meta::blake3_file(src).map_err(|e| OpError::Io(src.display().to_string(), to_io(e)))?;
            let b = phile_meta::blake3_file(&tmp).map_err(|e| OpError::Io(tmp.display().to_string(), to_io(e)))?;
            if a != b {
                let _ = std::fs::remove_file(&tmp);
                return Err(OpError::Verify(src.display().to_string()));
            }
        }
        if dst.exists() {
            io(dst, std::fs::remove_file(dst))?;
        }
        io(dst, std::fs::rename(&tmp, dst))?;
        Ok(())
    })?;
    ctx.update(|p| p.files_done += 1, false);
    Ok(())
}

fn to_io(e: phile_meta::MetaError) -> std::io::Error {
    match e {
        phile_meta::MetaError::Io(e) => e,
    }
}

fn run_trash(ctx: &Ctx) -> Result<(), OpError> {
    for src in &ctx.job.spec.sources {
        ctx.checkpoint()?;
        ctx.update(|p| p.current = src.display().to_string(), false);
        let (f, b) = measure(std::slice::from_ref(src));
        match trash::delete(src) {
            Ok(()) => ctx.update(|p| { p.files_done += f; p.bytes_done += b; }, false),
            Err(e) => ctx.update(|p| p.errors.push(OpError::Trash(format!("{}: {e}", src.display())).to_string()), true),
        }
    }
    Ok(())
}

fn run_delete(ctx: &Ctx) -> Result<(), OpError> {
    for src in &ctx.job.spec.sources {
        ctx.checkpoint()?;
        ctx.update(|p| p.current = src.display().to_string(), false);
        let (f, b) = measure(std::slice::from_ref(src));
        let r = if src.is_dir() { std::fs::remove_dir_all(src) } else { std::fs::remove_file(src) };
        match r {
            Ok(()) => ctx.update(|p| { p.files_done += f; p.bytes_done += b; }, false),
            Err(e) => ctx.update(|p| p.errors.push(format!("{}: {e}", src.display())), true),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q() -> JobQueue {
        JobQueue::new(2, Arc::new(|_| {}))
    }

    #[test]
    fn copies_tree_with_verify_and_renames_collision() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), b"hello").unwrap();
        std::fs::write(src.join("sub/b.bin"), vec![7u8; 3_000_000]).unwrap();
        let dst = t.path().join("dst");
        let q = q();
        let spec = JobSpec { kind: OpKind::Copy, sources: vec![src.clone()], dest: Some(dst.clone()), collision: Collision::Rename, verify: true };
        let p = q.wait(q.submit(spec.clone()), Duration::from_secs(10)).unwrap();
        assert_eq!(p.state, JobState::Done, "{:?}", p.errors);
        assert_eq!(p.files_done, 2);
        assert_eq!(std::fs::read(dst.join("src/sub/b.bin")).unwrap().len(), 3_000_000);
        // Second copy collides -> "src (2)".
        let p = q.wait(q.submit(spec), Duration::from_secs(10)).unwrap();
        assert_eq!(p.state, JobState::Done);
        assert!(dst.join("src (2)/a.txt").exists());
    }

    #[test]
    fn moves_and_deletes() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("m.txt");
        std::fs::write(&f, b"x").unwrap();
        let dst = t.path().join("out");
        let q = q();
        let p = q.wait(q.submit(JobSpec { kind: OpKind::Move, sources: vec![f.clone()], dest: Some(dst.clone()), collision: Collision::Rename, verify: false }), Duration::from_secs(5)).unwrap();
        assert_eq!(p.state, JobState::Done);
        assert!(!f.exists() && dst.join("m.txt").exists());
        let p = q.wait(q.submit(JobSpec { kind: OpKind::Delete, sources: vec![dst.clone()], dest: None, collision: Collision::Rename, verify: false }), Duration::from_secs(5)).unwrap();
        assert_eq!(p.state, JobState::Done);
        assert!(!dst.exists());
    }

    #[test]
    fn refuses_copy_into_self() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().join("d");
        std::fs::create_dir(&d).unwrap();
        let q = q();
        let p = q.wait(q.submit(JobSpec { kind: OpKind::Copy, sources: vec![d.clone()], dest: Some(d.join("inner")), collision: Collision::Rename, verify: false }), Duration::from_secs(5)).unwrap();
        assert_eq!(p.state, JobState::Failed);
    }

    #[test]
    fn cancel_while_paused() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("big");
        std::fs::write(&f, vec![0u8; 8_000_000]).unwrap();
        let q = q();
        q.set_throttle(1_000_000);
        let id = q.submit(JobSpec { kind: OpKind::Copy, sources: vec![f], dest: Some(t.path().join("o")), collision: Collision::Rename, verify: false });
        std::thread::sleep(Duration::from_millis(300));
        q.pause(id);
        q.cancel(id);
        let p = q.wait(id, Duration::from_secs(5)).unwrap();
        assert_eq!(p.state, JobState::Cancelled);
        assert!(!t.path().join("o/big").exists());
    }

    #[test]
    fn unique_names() {
        let t = tempfile::tempdir().unwrap();
        let a = t.path().join("r.pdf");
        std::fs::write(&a, b"").unwrap();
        assert_eq!(unique_name(&a).file_name().unwrap(), "r (2).pdf");
    }
}
