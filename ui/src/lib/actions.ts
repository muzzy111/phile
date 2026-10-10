// User-level actions shared by keyboard shortcuts, menus and the palette.
import { api, baseName, type Collision, type Entry, joinPath } from "./api";
import { activeTab, load, navigate, notify, otherPane, runtime, selectedPaths, setRt, setWs, updateTab, view, ws, type SortKey } from "./state";
import { ask, confirmBox } from "../components/Dialog";
import { createSignal } from "solid-js";

export const [quickLook, setQuickLook] = createSignal<string | null>(null);
export const [paletteOpen, setPaletteOpen] = createSignal<null | "teleport" | "command">(null);
export const [jobsOpen, setJobsOpen] = createSignal(false);
export const [collision, setCollision] = createSignal<Collision>("rename");
export const [verify, setVerify] = createSignal(true);

export async function openEntry(pane: 0 | 1, e: Entry) {
  if (e.kind === "dir" || (e.kind === "symlink" && !e.ext)) {
    try {
      await navigate(pane, e.path);
      return;
    } catch {
      /* fall through: maybe a file symlink */
    }
  }
  api.open(e.path).catch((err) => notify(String(err), "error"));
}

export const cursorEntry = (pane: 0 | 1 = ws.focus): Entry | undefined => {
  const t = activeTab(pane);
  return view(t)[runtime(t.id).cursor];
};

export async function transfer(kind: "copy" | "move", sources?: string[], dest?: string) {
  const from = ws.focus;
  const src = sources ?? selectedPaths(activeTab(from));
  if (!src.length) return;
  const to = dest ?? activeTab(otherPane()).path;
  if (!ws.dual && !dest) {
    const d = await ask(`${kind === "copy" ? "Copy" : "Move"} ${src.length} item(s) to`, activeTab(from).path);
    if (!d) return;
    return transfer(kind, src, d);
  }
  await api.jobSubmit({ kind, sources: src, dest: to, collision: collision(), verify: kind === "copy" && verify() });
  notify(`${kind === "copy" ? "Copying" : "Moving"} ${src.length} item(s)`);
}

export async function remove(permanent: boolean) {
  const t = activeTab(ws.focus);
  const src = selectedPaths(t);
  if (!src.length) return;
  if (permanent) {
    const ok = await confirmBox(
      `Permanently delete ${src.length === 1 ? baseName(src[0]) : `${src.length} items`}?`,
      "This skips the Recycle Bin and cannot be undone.",
      true,
      "Delete",
    );
    if (!ok) return;
  }
  await api.jobSubmit({ kind: permanent ? "delete" : "trash", sources: src });
  setRt(t.id, "selected", {});
}

export async function rename() {
  const e = cursorEntry();
  if (!e) return;
  const name = await ask("Rename", e.name);
  if (!name || name === e.name) return;
  try {
    const to = await api.rename(e.path, name);
    await load(ws.focus, true);
    const i = view(activeTab(ws.focus)).findIndex((x) => x.path === to);
    if (i >= 0) setRt(activeTab(ws.focus).id, "cursor", i);
  } catch (err) {
    notify(String(err), "error");
  }
}

export async function newFolder() {
  const t = activeTab(ws.focus);
  const name = await ask("New folder", "New folder");
  if (!name) return;
  try {
    const p = await api.createFolder(t.path, name);
    await load(ws.focus, true);
    const i = view(activeTab(ws.focus)).findIndex((x) => x.path === p);
    if (i >= 0) setRt(t.id, "cursor", i);
  } catch (err) {
    notify(String(err), "error");
  }
}

export function sortBy(pane: 0 | 1, k: SortKey) {
  const t = activeTab(pane);
  updateTab(pane, t.sortKey === k ? { sortDir: t.sortDir === 1 ? -1 : 1 } : { sortKey: k, sortDir: k === "name" || k === "ext" ? 1 : -1 });
}

export const toggleHidden = () => updateTab(ws.focus, { showHidden: !activeTab(ws.focus).showHidden });
export const toggleFlat = () => updateTab(ws.focus, { flat: !activeTab(ws.focus).flat }, true);
export const toggleDual = () => setWs("dual", (d) => !d);
export const toggleSync = () => {
  setWs("syncScroll", (d) => !d);
  notify(`Synchronized scrolling ${ws.syncScroll ? "on" : "off"}`);
};
export const toggleCompare = () => {
  setWs("compare", (d) => !d);
  if (ws.compare && !ws.dual) setWs("dual", true);
};
export const togglePreview = () => setWs("previewPanel", (d) => !d);

export const mirrorPane = () => navigate(otherPane(), activeTab(ws.focus).path);
export const swapPanes = () => {
  const a = activeTab(0).path;
  const b = activeTab(1).path;
  navigate(0, b);
  navigate(1, a);
};

export const selectAll = () => {
  const t = activeTab(ws.focus);
  const sel: Record<string, true> = {};
  view(t).forEach((e) => (sel[e.path] = true));
  setRt(t.id, "selected", sel);
};
export const invertSelection = () => {
  const t = activeTab(ws.focus);
  const cur = runtime(t.id).selected;
  const sel: Record<string, true> = {};
  view(t).forEach((e) => !cur[e.path] && (sel[e.path] = true));
  setRt(t.id, "selected", sel);
};

export async function copyPath() {
  const p = selectedPaths(activeTab(ws.focus));
  await navigator.clipboard.writeText(p.join("\r\n"));
  notify(p.length === 1 ? "Path copied" : `${p.length} paths copied`);
}

export async function addAlias() {
  const t = activeTab(ws.focus);
  const name = await ask("Alias name (use as @name in the address bar)", baseName(t.path).toLowerCase().replace(/\s+/g, "-"));
  if (!name) return;
  await api.setAlias(name.replace(/^@/, ""), t.path);
  notify(`@${name.replace(/^@/, "")} → ${t.path}`);
}

export const childPath = (dir: string, name: string) => joinPath(dir, name);
