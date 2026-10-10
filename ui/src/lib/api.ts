// Typed wrappers over Rust commands. Every backend call goes through here,
// so a renamed command breaks one file, not the whole UI.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Kind = "file" | "dir" | "symlink" | "other";
export interface Entry {
  name: string;
  path: string;
  kind: Kind;
  size: number;
  modified: number;
  hidden: boolean;
  ext: string;
}
export type Target =
  | { type: "dir"; path: string }
  | { type: "file"; dir: string; path: string }
  | { type: "notFound"; input: string; expanded: string; fallback: string | null };

export interface Places {
  roots: Entry[];
  known: [string, string][];
  home: string;
}
export interface Preview {
  entry: Entry;
  mime: string;
  isText: boolean;
  encoding: string;
  text: string | null;
  truncated: boolean;
}
export interface Hashes {
  sha256: string;
  md5: string;
  blake3: string;
}
export type OpKind = "copy" | "move" | "trash" | "delete";
export type Collision = "rename" | "overwrite" | "skip" | "newer";
export interface JobSpec {
  kind: OpKind;
  sources: string[];
  dest?: string;
  collision?: Collision;
  verify?: boolean;
}
export type JobState = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
export interface JobProgress {
  id: number;
  kind: OpKind;
  state: JobState;
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  current: string;
  errors: string[];
  label: string;
}
export interface DirHit {
  path: string;
  score: number;
}
export interface Pin {
  path: string;
  label: string;
}
export interface WorkspaceInfo {
  name: string;
  updated: number;
}

export const api = {
  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  flatten: (path: string, limit?: number) => invoke<Entry[]>("flatten", { path, limit }),
  resolve: (input: string, cwd: string) => invoke<Target>("resolve", { input, cwd }),
  places: () => invoke<Places>("places"),
  breadcrumbs: (path: string) => invoke<[string, string][]>("breadcrumbs", { path }),
  createFolder: (parent: string, name: string) => invoke<string>("create_folder", { parent, name }),
  rename: (path: string, newName: string) => invoke<string>("rename_entry", { path, newName }),
  open: (path: string) => invoke<void>("open_default", { path }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  watch: (pane: string, path: string) => invoke<void>("watch_dir", { pane, path }),
  preview: (path: string) => invoke<Preview>("preview", { path }),
  hex: (path: string, offset = 0, len = 4096) => invoke<string>("hex", { path, offset, len }),
  hashes: (path: string) => invoke<Hashes>("hashes", { path }),
  jobSubmit: (spec: JobSpec) => invoke<number>("job_submit", { spec }),
  jobPause: (id: number) => invoke<void>("job_pause", { id }),
  jobResume: (id: number) => invoke<void>("job_resume", { id }),
  jobCancel: (id: number) => invoke<void>("job_cancel", { id }),
  jobList: () => invoke<JobProgress[]>("job_list"),
  jobClear: () => invoke<void>("job_clear"),
  setThrottle: (bytesPerSec: number) => invoke<void>("set_throttle", { bytesPerSec }),
  workspaceSave: (name: string, state: unknown) => invoke<void>("workspace_save", { name, state }),
  workspaceLoad: <T>(name: string) => invoke<T | null>("workspace_load", { name }),
  workspaceList: () => invoke<WorkspaceInfo[]>("workspace_list"),
  workspaceDelete: (name: string) => invoke<void>("workspace_delete", { name }),
  recordVisit: (path: string) => invoke<void>("record_visit", { path }),
  teleport: (query: string) => invoke<DirHit[]>("teleport", { query }),
  aliases: () => invoke<Record<string, string>>("aliases"),
  setAlias: (name: string, path: string | null) => invoke<void>("set_alias", { name, path }),
  pins: () => invoke<Pin[]>("pins"),
  setPins: (pins: Pin[]) => invoke<void>("set_pins", { pins }),
  settingGet: <T>(key: string) => invoke<T | null>("setting_get", { key }),
  settingSet: (key: string, value: unknown) => invoke<void>("setting_set", { key, value }),
};

export const onJobProgress = (f: (p: JobProgress) => void): Promise<UnlistenFn> =>
  listen<JobProgress>("job-progress", (e) => f(e.payload));
export const onDirChanged = (f: (pane: string) => void): Promise<UnlistenFn> =>
  listen<string>("dir-changed", (e) => f(e.payload));

export const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};
export const fmtDate = (ms: number) =>
  ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "";
export const sep = (p: string) => (p.includes("\\") ? "\\" : "/");
export const joinPath = (dir: string, name: string) => {
  const s = sep(dir);
  return dir.endsWith(s) ? dir + name : dir + s + name;
};
export const parentOf = (p: string) => {
  const s = sep(p);
  const t = p.endsWith(s) && p.length > 3 ? p.slice(0, -1) : p;
  const i = t.lastIndexOf(s);
  if (i < 0) return p;
  if (i === 0) return s;
  const parent = t.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
};
export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
