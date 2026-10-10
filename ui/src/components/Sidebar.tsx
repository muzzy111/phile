import { createResource, createSignal, For, Show } from "solid-js";
import { api, baseName, type Pin } from "../lib/api";
import { activeTab, navigate, notify, switchWorkspace, workspaceName, ws } from "../lib/state";
import { ask, confirmBox } from "./Dialog";
import { commands } from "../lib/commands";
import { setPaletteOpen } from "../lib/actions";

const [wsOpen, setWsOpen] = createSignal(false);
const [helpOpen, setHelpOpen] = createSignal(false);
export const showWorkspaces = () => setWsOpen(true);
export const showHelp = () => setHelpOpen(true);
export const overlaysOpen = () => wsOpen() || helpOpen();

export function Sidebar(p: { home: string; known: [string, string][]; roots: string[] }) {
  const [pins, { mutate }] = createResource(() => api.pins().catch(() => [] as Pin[]));
  const savePins = (v: Pin[]) => {
    mutate(v);
    api.setPins(v);
  };
  const pinCurrent = () => {
    const path = activeTab(ws.focus).path;
    if ((pins() ?? []).some((x) => x.path === path)) return notify("Already pinned");
    savePins([...(pins() ?? []), { path, label: baseName(path) || path }]);
  };
  const go = (path: string) => navigate(ws.focus, path);
  const cur = () => activeTab(ws.focus).path;

  return (
    <nav class="sidebar">
      <div class="sb-ws" onClick={showWorkspaces} title="Switch workspace (Ctrl+Shift+W)">
        <span class="sb-ws-label">Workspace</span>
        <span class="sb-ws-name">{workspaceName()}</span>
      </div>
      <div class="sb-group">
        <div class="sb-title">
          Pinned <button class="sb-add" title="Pin current folder" onClick={pinCurrent}>+</button>
        </div>
        <For each={pins() ?? []}>
          {(pin, i) => (
            <div class="sb-item" classList={{ active: cur() === pin.path }} onClick={() => go(pin.path)} title={pin.path}
              onContextMenu={(e) => { e.preventDefault(); savePins((pins() ?? []).filter((_, j) => j !== i())); notify(`Unpinned ${pin.label}`); }}>
              <span class="dot pin" />{pin.label}
            </div>
          )}
        </For>
        <Show when={!(pins() ?? []).length}><div class="sb-hint">Click + to pin the current folder. Right-click to unpin.</div></Show>
      </div>
      <div class="sb-group">
        <div class="sb-title">Places</div>
        <For each={p.known}>
          {([label, path]) => (
            <div class="sb-item" classList={{ active: cur() === path }} onClick={() => go(path)} title={path}><span class="dot" />{label}</div>
          )}
        </For>
      </div>
      <div class="sb-group">
        <div class="sb-title">Drives</div>
        <For each={p.roots}>
          {(r) => <div class="sb-item" classList={{ active: cur() === r }} onClick={() => go(r)}><span class="dot drive" />{r}</div>}
        </For>
      </div>
      <div class="sb-foot">
        <button onClick={() => setPaletteOpen("teleport")}>Ctrl+P Go to</button>
        <button onClick={showHelp}>F1 Keys</button>
      </div>
      <WorkspaceDialog home={p.home} />
      <HelpDialog />
    </nav>
  );
}

function WorkspaceDialog(p: { home: string }) {
  const [list, { refetch }] = createResource(wsOpen, (o) => (o ? api.workspaceList() : Promise.resolve([])));
  const named = () => (list() ?? []).filter((w) => !w.name.startsWith("__"));
  const create = async () => {
    const n = await ask("New workspace name", "Project A", "Saves your tabs, panes and layout under this name.");
    if (!n) return;
    setWsOpen(false);
    await switchWorkspace(n.trim(), p.home);
  };
  return (
    <Show when={wsOpen()}>
      <div class="modal-back" onMouseDown={() => setWsOpen(false)}>
        <div class="modal wide" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setWsOpen(false); }}>
          <div class="modal-title">Workspaces</div>
          <div class="modal-msg">Each workspace remembers its tabs, split view and folders across restarts.</div>
          <div class="ws-list">
            <div class="ws-row" classList={{ active: workspaceName() === "Default" }} onClick={() => { setWsOpen(false); switchWorkspace("Default", p.home); }}>
              <span>Default</span>
            </div>
            <For each={named().filter((w) => w.name !== "Default")}>
              {(w) => (
                <div class="ws-row" classList={{ active: workspaceName() === w.name }} onClick={() => { setWsOpen(false); switchWorkspace(w.name, p.home); }}>
                  <span>{w.name}</span>
                  <span class="ws-date">{new Date(w.updated * 1000).toLocaleDateString()}</span>
                  <button class="tab-x" onClick={async (e) => {
                    e.stopPropagation();
                    if (await confirmBox(`Delete workspace "${w.name}"?`, "Your files are not affected.", true, "Delete")) {
                      await api.workspaceDelete(w.name);
                      refetch();
                    }
                  }}>×</button>
                </div>
              )}
            </For>
          </div>
          <div class="modal-btns">
            <button onClick={() => setWsOpen(false)}>Close</button>
            <button class="primary" onClick={create}>New workspace</button>
          </div>
        </div>
      </div>
    </Show>
  );
}

function HelpDialog() {
  return (
    <Show when={helpOpen()}>
      <div class="modal-back" onMouseDown={() => setHelpOpen(false)}>
        <div class="modal wide" tabIndex={-1} ref={(el) => queueMicrotask(() => el.focus())} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape" || e.key === "F1") setHelpOpen(false); }}>
          <div class="modal-title">Keyboard shortcuts</div>
          <div class="keys">
            <For each={commands().filter((c) => c.key)}>
              {(c) => <div class="key-row"><span>{c.label}</span><kbd>{c.key}</kbd></div>}
            </For>
            <div class="key-row"><span>Pick tab 1-9</span><kbd>Ctrl+1…9</kbd></div>
            <div class="key-row"><span>Mark item and move down</span><kbd>Insert</kbd></div>
            <div class="key-row"><span>Jump by typing a name</span><kbd>a…z</kbd></div>
            <div class="key-row"><span>Drag to other pane: copy (hold Shift to move)</span><kbd>Drag</kbd></div>
          </div>
          <div class="modal-btns"><button class="primary" onClick={() => setHelpOpen(false)}>Got it</button></div>
        </div>
      </div>
    </Show>
  );
}
