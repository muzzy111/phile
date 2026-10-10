// Single source of truth for commands: drives keyboard shortcuts AND the palette.
// To add a feature, add one entry here.
import { createSignal } from "solid-js";
import * as A from "./actions";
import { activeTab, closeTab, goHistory, goUp, load, openTab, otherPane, runtime, setRt, setWs, switchTab, view, ws } from "./state";
import { omniInputs } from "../components/Omnibar";
import { filterInputs } from "../components/Pane";
import { showWorkspaces, showHelp } from "../components/Sidebar";

export interface Command {
  id: string;
  label: string;
  key?: string; // display + matching, e.g. "Ctrl+Shift+N"
  run: () => void;
  when?: () => boolean;
}

const focusOmni = () => {
  const h = document.querySelector<HTMLButtonElement>(`.omni-edit-handle[data-pane="${ws.focus}"]`);
  h?.click();
  queueMicrotask(() => omniInputs[ws.focus]?.focus());
};

const [list] = createSignal<Command[]>([
  { id: "teleport", label: "Go to folder (fuzzy)", key: "Ctrl+P", run: () => A.setPaletteOpen("teleport") },
  { id: "palette", label: "Command palette", key: "Ctrl+Shift+P", run: () => A.setPaletteOpen("command") },
  { id: "omnibar", label: "Edit address", key: "Ctrl+L", run: focusOmni },
  { id: "filter", label: "Filter this folder", key: "Ctrl+F", run: () => filterInputs[ws.focus]?.focus() },
  { id: "open", label: "Open", key: "Enter", run: () => { const e = A.cursorEntry(); if (e) A.openEntry(ws.focus, e); } },
  { id: "open-tab", label: "Open folder in new tab", key: "Ctrl+Enter", run: () => { const e = A.cursorEntry(); if (e?.kind === "dir") openTab(ws.focus, e.path); } },
  { id: "up", label: "Go up", key: "Backspace", run: () => goUp(ws.focus) },
  { id: "up2", label: "Go up", key: "Alt+ArrowUp", run: () => goUp(ws.focus) },
  { id: "back", label: "Back", key: "Alt+ArrowLeft", run: () => goHistory(ws.focus, -1) },
  { id: "fwd", label: "Forward", key: "Alt+ArrowRight", run: () => goHistory(ws.focus, 1) },
  { id: "quicklook", label: "Quick look", key: "Space", run: () => { const e = A.cursorEntry(); A.setQuickLook(A.quickLook() ? null : e?.path ?? null); } },
  { id: "switch-pane", label: "Switch pane", key: "Tab", run: () => ws.dual && setWs("focus", otherPane()) },
  { id: "copy", label: "Copy to other pane", key: "F5", run: () => A.transfer("copy") },
  { id: "move", label: "Move to other pane", key: "F6", run: () => A.transfer("move") },
  { id: "rename", label: "Rename", key: "F2", run: A.rename },
  { id: "trash", label: "Move to Recycle Bin", key: "Delete", run: () => A.remove(false) },
  { id: "delete", label: "Delete permanently", key: "Shift+Delete", run: () => A.remove(true) },
  { id: "new-folder", label: "New folder", key: "Ctrl+Shift+N", run: A.newFolder },
  { id: "refresh", label: "Refresh", key: "Ctrl+R", run: () => load(ws.focus, true) },
  { id: "select-all", label: "Select all", key: "Ctrl+A", run: A.selectAll },
  { id: "invert", label: "Invert selection", key: "Ctrl+I", run: A.invertSelection },
  { id: "copy-path", label: "Copy path", key: "Ctrl+Shift+C", run: A.copyPath },
  { id: "new-tab", label: "New tab", key: "Ctrl+T", run: () => openTab(ws.focus, activeTab(ws.focus).path) },
  { id: "close-tab", label: "Close tab", key: "Ctrl+W", run: () => closeTab(ws.focus) },
  { id: "next-tab", label: "Next tab", key: "Ctrl+Tab", run: () => { const p = ws.panes[ws.focus]; switchTab(ws.focus, (p.active + 1) % p.tabs.length); } },
  { id: "prev-tab", label: "Previous tab", key: "Ctrl+Shift+Tab", run: () => { const p = ws.panes[ws.focus]; switchTab(ws.focus, (p.active - 1 + p.tabs.length) % p.tabs.length); } },
  { id: "hidden", label: "Toggle hidden files", key: "Ctrl+H", run: A.toggleHidden },
  { id: "flat", label: "Toggle flatten subfolders", key: "Ctrl+Shift+F", run: A.toggleFlat },
  { id: "dual", label: "Toggle dual pane", key: "Ctrl+D", run: A.toggleDual },
  { id: "sync", label: "Toggle synchronized scrolling", key: "Ctrl+Shift+S", run: A.toggleSync },
  { id: "compare", label: "Compare panes (highlight differences)", key: "Ctrl+Shift+D", run: A.toggleCompare },
  { id: "preview", label: "Toggle preview panel", key: "Ctrl+Shift+V", run: A.togglePreview },
  { id: "mirror", label: "Open this folder in the other pane", key: "Ctrl+M", run: A.mirrorPane },
  { id: "swap", label: "Swap panes", key: "Ctrl+U", run: A.swapPanes },
  { id: "jobs", label: "Show transfers", key: "Ctrl+J", run: () => A.setJobsOpen(!A.jobsOpen()) },
  { id: "workspaces", label: "Switch workspace…", key: "Ctrl+Shift+W", run: () => showWorkspaces() },
  { id: "alias", label: "Add alias for this folder", run: A.addAlias },
  { id: "help", label: "Keyboard shortcuts", key: "F1", run: () => showHelp() },
]);
export const commands = () => list().filter((c) => !c.when || c.when());

const norm = (e: KeyboardEvent) => {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const k = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(k);
  return parts.join("+");
};

const byKey = () => new Map(list().filter((c) => c.key).map((c) => [c.key!, c]));

export function installKeys(isBlocked: () => boolean) {
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
    if (typing || isBlocked()) return;
    const k = norm(e);
    // Ctrl+1..9 picks a tab.
    const m = /^Ctrl\+([1-9])$/.exec(k);
    if (m) {
      e.preventDefault();
      return switchTab(ws.focus, +m[1] - 1);
    }
    if (A.quickLook() && k === "Escape") {
      e.preventDefault();
      return A.setQuickLook(null);
    }
    const c = byKey().get(k);
    if (c) {
      e.preventDefault();
      c.run();
      return;
    }
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", "Shift+ArrowDown", "Shift+ArrowUp", "Ctrl+Home", "Ctrl+End"].includes(k)) {
      e.preventDefault();
      moveCursor(k);
    } else if (k === "Insert") {
      e.preventDefault();
      toggleMarkAndAdvance();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key !== " ") {
      typeAhead(e.key);
    }
  });
}


function moveCursor(k: string) {
  const t = activeTab(ws.focus);
  const r = runtime(t.id);
  const n = view(t).length;
  if (!n) return;
  const page = Math.max(1, Math.floor((document.querySelector(".pane.focused .scroller")?.clientHeight ?? 400) / 26) - 1);
  const delta: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, "Shift+ArrowDown": 1, "Shift+ArrowUp": -1 };
  let c = r.cursor;
  if (k === "Home" || k === "Ctrl+Home") c = 0;
  else if (k === "End" || k === "Ctrl+End") c = n - 1;
  else c = Math.max(0, Math.min(n - 1, c + delta[k]));
  if (k.startsWith("Shift+")) {
    const sel = { ...r.selected };
    sel[view(t)[r.cursor].path] = true;
    sel[view(t)[c].path] = true;
    setRt(t.id, "selected", sel);
  }
  setRt(t.id, "cursor", c);
  if (A.quickLook()) A.setQuickLook(view(t)[c].path);
}

function toggleMarkAndAdvance() {
  const t = activeTab(ws.focus);
  const r = runtime(t.id);
  const e = view(t)[r.cursor];
  if (!e) return;
  const sel = { ...r.selected };
  if (sel[e.path]) delete sel[e.path];
  else sel[e.path] = true;
  setRt(t.id, { selected: sel, cursor: Math.min(r.cursor + 1, view(t).length - 1) });
}

// Type the first letters of a name to jump to it, like Explorer.
let buf = "";
let bufTimer: number | undefined;
function typeAhead(ch: string) {
  buf += ch.toLowerCase();
  clearTimeout(bufTimer);
  bufTimer = window.setTimeout(() => (buf = ""), 700);
  const t = activeTab(ws.focus);
  const v = view(t);
  const r = runtime(t.id);
  const start = buf.length === 1 ? r.cursor + 1 : r.cursor;
  for (let i = 0; i < v.length; i++) {
    const j = (start + i) % v.length;
    if (v[j].name.toLowerCase().startsWith(buf)) return setRt(t.id, "cursor", j);
  }
}
