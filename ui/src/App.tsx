import { createResource, onCleanup, onMount, Show } from "solid-js";
import { api, onDirChanged } from "./lib/api";
import { jobsOpen, paletteOpen, quickLook, setJobsOpen, setQuickLook, cursorEntry } from "./lib/actions";
import { installKeys } from "./lib/commands";
import { load, restore, toast, ws } from "./lib/state";
import { MenuHost } from "./components/ContextMenu";
import { DialogHost } from "./components/Dialog";
import { JobsBridge, JobsPanel, activeJobs } from "./components/Jobs";
import { Palette } from "./components/Palette";
import { Pane } from "./components/Pane";
import { PreviewView } from "./components/Preview";
import { overlaysOpen, Sidebar } from "./components/Sidebar";

export default function App() {
  const [places] = createResource(() => api.places());

  onMount(async () => {
    const p = await api.places();
    await restore(p.home);
    installKeys(() => !!paletteOpen() || overlaysOpen() || !!document.querySelector(".modal-back"));
    const un = await onDirChanged((pane) => load(pane === "p0" ? 0 : 1, true));
    onCleanup(un);
  });

  return (
    <div class="app" classList={{ single: !ws.dual }}>
      <Show when={places()}>
        {(p) => <Sidebar home={p().home} known={p().known} roots={p().roots.map((r) => r.path)} />}
      </Show>
      <main class="main">
        <div class="panes">
          <Pane pane={0} />
          <Show when={ws.dual}>
            <Pane pane={1} />
          </Show>
          <Show when={ws.previewPanel}>
            <aside class="side-preview">
              <PreviewView path={cursorEntry()?.kind === "file" ? cursorEntry()!.path : cursorEntry()?.path ?? null} />
            </aside>
          </Show>
        </div>
        <JobsPanel />
        <footer class="statusbar">
          <span class="sb-left">
            <Show when={ws.syncScroll}><span class="flag">SYNC</span></Show>
            <Show when={ws.compare}><span class="flag">COMPARE</span></Show>
          </span>
          <span class="spacer" />
          <button class="sb-btn" classList={{ busy: activeJobs().length > 0 }} onClick={() => setJobsOpen(!jobsOpen())}>
            {activeJobs().length ? `${activeJobs().length} transfer(s) running` : "Transfers"}
          </button>
          <span class="sb-hint">Ctrl+P go to · Ctrl+Shift+P commands · F1 keys</span>
        </footer>
      </main>
      <Show when={quickLook()}>
        <div class="quicklook-back" onMouseDown={() => setQuickLook(null)}>
          <div class="quicklook" onMouseDown={(e) => e.stopPropagation()}>
            <PreviewView path={quickLook()} large />
          </div>
        </div>
      </Show>
      <Palette />
      <DialogHost />
      <MenuHost />
      <JobsBridge />
      <Show when={toast()}>
        {(t) => <div class={`toast ${t().kind}`}>{t().msg}</div>}
      </Show>
    </div>
  );
}
