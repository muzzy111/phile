import { createMemo, For, Show } from "solid-js";
import { api, baseName, type Entry, fmtSize } from "../lib/api";
import * as A from "../lib/actions";
import {
  activeTab, closeTab, goHistory, goUp, load, openTab, runtime, setWs, switchTab, updateTab, view, ws,
} from "../lib/state";
import { showMenu } from "./ContextMenu";
import { FileList } from "./FileList";
import { Omnibar } from "./Omnibar";

export const filterInputs: (HTMLInputElement | undefined)[] = [undefined, undefined];

export function Pane(p: { pane: 0 | 1 }) {
  const tab = () => activeTab(p.pane);
  const focused = () => ws.focus === p.pane;
  const focus = () => ws.focus !== p.pane && setWs("focus", p.pane);
  const r = () => runtime(tab().id);
  const rows = createMemo(() => view(tab()));

  // Compare mode: index the other pane's entries by name.
  const compareMap = createMemo(() => {
    if (!ws.compare || !ws.dual) return undefined;
    const o = activeTab(p.pane === 0 ? 1 : 0);
    return new Map(view(o).map((e) => [e.name, e] as [string, Entry]));
  });

  const selInfo = () => {
    const sel = Object.keys(r().selected);
    if (!sel.length) return "";
    const set = new Set(sel);
    const size = rows().filter((e) => set.has(e.path)).reduce((a, e) => a + e.size, 0);
    return `${sel.length} selected · ${fmtSize(size)}`;
  };

  const context = (ev: MouseEvent, e: Entry | null) => {
    const other = ws.dual ? baseName(activeTab(p.pane === 0 ? 1 : 0).path) : "…";
    if (!e) {
      return showMenu(ev, [
        { label: "New folder", hint: "Ctrl+Shift+N", run: A.newFolder },
        { label: "Refresh", hint: "F5", run: () => load(p.pane, true) },
        "-",
        { label: tab().showHidden ? "Hide hidden files" : "Show hidden files", hint: "Ctrl+H", run: A.toggleHidden },
        { label: tab().flat ? "Unflatten" : "Flatten subfolders", hint: "Ctrl+Shift+F", run: A.toggleFlat },
        { label: "Add alias for this folder…", run: A.addAlias },
        { label: "Open in system Explorer", run: () => api.open(tab().path) },
      ]);
    }
    showMenu(ev, [
      { label: "Open", hint: "Enter", run: () => A.openEntry(p.pane, e) },
      ...(e.kind === "dir" ? [{ label: "Open in new tab", hint: "Ctrl+Enter", run: () => openTab(p.pane, e.path) }] : []),
      { label: "Quick look", hint: "Space", run: () => A.setQuickLook(e.path) },
      "-",
      { label: `Copy to ${other}`, hint: "F5", run: () => A.transfer("copy") },
      { label: `Move to ${other}`, hint: "F6", run: () => A.transfer("move") },
      { label: "Rename", hint: "F2", run: A.rename },
      { label: "Copy path", hint: "Ctrl+Shift+C", run: A.copyPath },
      { label: "Show in Explorer", run: () => api.reveal(e.path) },
      "-",
      { label: "Move to Recycle Bin", hint: "Del", run: () => A.remove(false) },
      { label: "Delete permanently", hint: "Shift+Del", danger: true, run: () => A.remove(true) },
    ]);
  };

  return (
    <section class="pane" classList={{ focused: focused() }} onMouseDown={focus}>
      <div class="tabs">
        <For each={ws.panes[p.pane].tabs}>
          {(t, i) => (
            <div
              class="tab"
              classList={{ active: ws.panes[p.pane].active === i() }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(p.pane, i());
                } else switchTab(p.pane, i());
              }}
              title={t.path}
            >
              <span class="tab-label">{baseName(t.path) || t.path}</span>
              <Show when={ws.panes[p.pane].tabs.length > 1}>
                <button class="tab-x" onMouseDown={(e) => { e.stopPropagation(); closeTab(p.pane, i()); }}>×</button>
              </Show>
            </div>
          )}
        </For>
        <button class="tab-new" title="New tab (Ctrl+T)" onClick={() => openTab(p.pane, tab().path)}>+</button>
      </div>
      <div class="toolbar">
        <button class="tb" title="Back (Alt+←)" disabled={tab().hIndex <= 0} onClick={() => goHistory(p.pane, -1)}>‹</button>
        <button class="tb" title="Forward (Alt+→)" disabled={tab().hIndex >= tab().history.length - 1} onClick={() => goHistory(p.pane, 1)}>›</button>
        <button class="tb" title="Up (Backspace)" onClick={() => goUp(p.pane)}>↑</button>
        <Omnibar pane={p.pane} tab={tab()} onFocusPane={focus} />
        <input
          ref={(el) => (filterInputs[p.pane] = el)}
          class="filter"
          placeholder="Filter"
          value={tab().filter}
          onInput={(e) => updateTab(p.pane, { filter: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter") {
              if (e.key === "Escape") updateTab(p.pane, { filter: "" });
              e.currentTarget.blur();
            }
            e.stopPropagation();
          }}
        />
      </div>
      <FileList
        pane={p.pane}
        tab={tab()}
        compareWith={compareMap()}
        onOpen={(e) => A.openEntry(p.pane, e)}
        onSort={(k) => A.sortBy(p.pane, k)}
        onFocus={focus}
        onDrop={(paths, move) => A.transfer(move ? "move" : "copy", paths, tab().path)}
        onContext={context}
      />
      <div class="pane-status">
        <span>{rows().length.toLocaleString()} items</span>
        <span>{selInfo()}</span>
        <span class="flags">
          <Show when={tab().flat}><span class="flag" onClick={A.toggleFlat}>FLAT</span></Show>
          <Show when={tab().showHidden}><span class="flag" onClick={A.toggleHidden}>HIDDEN</span></Show>
          <Show when={tab().filter}><span class="flag">FILTER</span></Show>
          <Show when={r().loading}><span class="flag spin">LOADING</span></Show>
        </span>
      </div>
    </section>
  );
}

