// App state. Persisted shape (Workspace) is kept separate from runtime data
// (listings, selection) so saved workspaces stay small and forward-compatible.
import { createStore, produce, reconcile } from "solid-js/store";
import { createSignal } from "solid-js";
import { api, type Entry, joinPath, parentOf } from "./api";

export type SortKey = "name" | "size" | "modified" | "ext";
export interface Tab {
  id: string;
  path: string;
  history: string[];
  hIndex: number;
  sortKey: SortKey;
  sortDir: 1 | -1;
  showHidden: boolean;
  flat: boolean;
  filter: string;
}
export interface PaneState {
  tabs: Tab[];
  active: number;
}
export interface Workspace {
  version: 1;
  panes: [PaneState, PaneState];
  focus: 0 | 1;
  dual: boolean;
  syncScroll: boolean;
  compare: boolean;
  previewPanel: boolean;
}
export interface Runtime {
  entries: Entry[];
  loading: boolean;
  error: string | null;
  selected: Record<string, true>;
  cursor: number;
}

let seq = 0;
const tid = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export const newTab = (path: string): Tab => ({
  id: tid(),
  path,
  history: [path],
  hIndex: 0,
  sortKey: "name",
  sortDir: 1,
  showHidden: false,
  flat: false,
  filter: "",
});

export const defaultWorkspace = (home: string): Workspace => ({
  version: 1,
  panes: [
    { tabs: [newTab(home)], active: 0 },
    { tabs: [newTab(home)], active: 0 },
  ],
  focus: 0,
  dual: true,
  syncScroll: false,
  compare: false,
  previewPanel: true,
});

export const [ws, setWs] = createStore<Workspace>(defaultWorkspace("/"));
export const [rt, setRt] = createStore<Record<string, Runtime>>({});
export const [workspaceName, setWorkspaceName] = createSignal("Default");
export const [toast, setToast] = createSignal<{ msg: string; kind: "info" | "error" } | null>(null);

let toastTimer: number | undefined;
export const notify = (msg: string, kind: "info" | "error" = "info") => {
  setToast({ msg, kind });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setToast(null), kind === "error" ? 6000 : 2500);
};

export const activeTab = (pane: 0 | 1) => ws.panes[pane].tabs[ws.panes[pane].active];
export const focusedTab = () => activeTab(ws.focus);
export const otherPane = (): 0 | 1 => (ws.focus === 0 ? 1 : 0);
export const runtime = (id: string): Runtime =>
  rt[id] ?? { entries: [], loading: false, error: null, selected: {}, cursor: 0 };

// Visible, sorted, filtered entries for a tab.
export const view = (t: Tab): Entry[] => {
  const r = runtime(t.id);
  const f = t.filter.toLowerCase();
  const v = r.entries.filter((e) => (t.showHidden || !e.hidden) && (!f || e.name.toLowerCase().includes(f)));
  const k = t.sortKey;
  const d = t.sortDir;
  return v.sort((a, b) => {
    const ad = a.kind === "dir" ? 0 : 1;
    const bd = b.kind === "dir" ? 0 : 1;
    if (ad !== bd && !t.flat) return ad - bd;
    let c = 0;
    if (k === "size") c = a.size - b.size;
    else if (k === "modified") c = a.modified - b.modified;
    else if (k === "ext") c = a.ext.localeCompare(b.ext);
    if (c === 0) c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    return c * d;
  });
};

export const selectedPaths = (t: Tab): string[] => {
  const r = runtime(t.id);
  const sel = Object.keys(r.selected);
  if (sel.length) return sel;
  const cur = view(t)[r.cursor];
  return cur ? [cur.path] : [];
};

// ---- loading ----
const loadToken: Record<string, number> = {};

export async function load(pane: 0 | 1, keepSelection = false) {
  const t = activeTab(pane);
  const id = t.id;
  const token = (loadToken[id] = (loadToken[id] ?? 0) + 1);
  if (!rt[id]) setRt(id, { entries: [], loading: true, error: null, selected: {}, cursor: 0 });
  else setRt(id, "loading", true);
  try {
    const entries = t.flat ? await api.flatten(t.path) : await api.listDir(t.path);
    if (loadToken[id] !== token) return;
    setRt(id, "entries", reconcile(entries, { key: "path" }));
    setRt(id, "error", null);
    if (!keepSelection) setRt(id, { selected: {}, cursor: 0 });
    else setRt(id, "cursor", (c) => Math.min(c, Math.max(0, view(t).length - 1)));
    api.watch(`p${pane}`, t.path).catch(() => {});
  } catch (e) {
    if (loadToken[id] !== token) return;
    setRt(id, { entries: [], error: String(e) });
  } finally {
    if (loadToken[id] === token) setRt(id, "loading", false);
  }
}

export async function navigate(pane: 0 | 1, path: string, opts: { select?: string; push?: boolean } = {}) {
  const p = ws.panes[pane];
  const prev = activeTab(pane).path;
  setWs(
    "panes",
    pane,
    "tabs",
    p.active,
    produce((t) => {
      if (opts.push !== false && t.path !== path) {
        t.history = t.history.slice(0, t.hIndex + 1);
        t.history.push(path);
        if (t.history.length > 100) t.history.shift();
        t.hIndex = t.history.length - 1;
      }
      t.path = path;
      t.filter = "";
    }),
  );
  await load(pane);
  const t = activeTab(pane);
  let want = opts.select;
  if (!want && prev !== path && prev.toLowerCase().startsWith(path.toLowerCase())) {
    // Going up: land the cursor on the folder we came from.
    const first = prev.slice(path.length).replace(/^[\\/]+/, "").split(/[\\/]/)[0];
    if (first) want = joinPath(path, first);
  }
  if (want) {
    const i = view(t).findIndex((e) => e.path === want);
    if (i >= 0) setRt(t.id, "cursor", i);
  }
  api.recordVisit(path).catch(() => {});
  scheduleSave();
}

export const goUp = (pane: 0 | 1) => {
  const t = activeTab(pane);
  const up = parentOf(t.path);
  if (up !== t.path) navigate(pane, up);
};

export function goHistory(pane: 0 | 1, delta: number) {
  const t = activeTab(pane);
  const i = t.hIndex + delta;
  if (i < 0 || i >= t.history.length) return;
  setWs("panes", pane, "tabs", ws.panes[pane].active, "hIndex", i);
  navigate(pane, t.history[i], { push: false });
}

export function openTab(pane: 0 | 1, path: string) {
  setWs("panes", pane, produce((p) => {
    p.tabs.push(newTab(path));
    p.active = p.tabs.length - 1;
  }));
  load(pane);
  scheduleSave();
}

export function closeTab(pane: 0 | 1, index?: number) {
  const p = ws.panes[pane];
  const i = index ?? p.active;
  if (p.tabs.length === 1) return;
  setWs("panes", pane, produce((p) => {
    p.tabs.splice(i, 1);
    if (p.active >= p.tabs.length) p.active = p.tabs.length - 1;
    else if (p.active > i) p.active--;
  }));
  load(pane, true);
  scheduleSave();
}

export function switchTab(pane: 0 | 1, i: number) {
  if (i < 0 || i >= ws.panes[pane].tabs.length) return;
  setWs("panes", pane, "active", i);
  if (!rt[activeTab(pane).id]) load(pane);
  scheduleSave();
}

export function updateTab(pane: 0 | 1, patch: Partial<Tab>, reload = false) {
  setWs("panes", pane, "tabs", ws.panes[pane].active, patch);
  if (reload) load(pane);
  scheduleSave();
}

// ---- persistence ----
const LAST = "__last__";
let saveTimer: number | undefined;
export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const snap = JSON.parse(JSON.stringify(ws));
    api.workspaceSave(LAST, { name: workspaceName(), ws: snap }).catch(() => {});
    if (workspaceName() !== "Default") api.workspaceSave(workspaceName(), snap).catch(() => {});
  }, 400);
}

const valid = (w: any): w is Workspace => w && w.version === 1 && Array.isArray(w.panes) && w.panes.length === 2;

export async function restore(home: string) {
  const last = await api.workspaceLoad<{ name: string; ws: Workspace }>(LAST).catch(() => null);
  if (last && valid(last.ws)) {
    setWs(reconcile(last.ws));
    setWorkspaceName(last.name || "Default");
  } else {
    setWs(reconcile(defaultWorkspace(home)));
  }
  await Promise.all([load(0), load(1)]);
}

export async function switchWorkspace(name: string, home: string) {
  scheduleSave();
  const w = await api.workspaceLoad<Workspace>(name).catch(() => null);
  setWorkspaceName(name);
  if (valid(w)) setWs(reconcile(w));
  else {
    // New workspace starts from the current layout.
    await api.workspaceSave(name, JSON.parse(JSON.stringify(ws)));
  }
  if (!ws.panes) setWs(reconcile(defaultWorkspace(home)));
  await Promise.all([load(0), load(1)]);
  scheduleSave();
  notify(`Workspace: ${name}`);
}
