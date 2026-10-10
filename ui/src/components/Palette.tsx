// Ctrl+P: fuzzy teleport to any visited folder. Ctrl+Shift+P: command palette.
// Type ">" in teleport mode to switch to commands.
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { api, type DirHit } from "../lib/api";
import { paletteOpen, setPaletteOpen } from "../lib/actions";
import { navigate, ws } from "../lib/state";
import { commands } from "../lib/commands";

const fuzzy = (q: string, s: string) => {
  // Subsequence match with a bonus for contiguous runs; good enough for ~100 commands.
  q = q.toLowerCase();
  s = s.toLowerCase();
  let si = 0, score = 0, run = 0;
  for (const c of q) {
    const i = s.indexOf(c, si);
    if (i < 0) return -1;
    run = i === si ? run + 1 : 0;
    score += 1 + run * 2 - (i - si) * 0.1;
    si = i + 1;
  }
  return score;
};

export function Palette() {
  const [q, setQ] = createSignal("");
  const [hits, setHits] = createSignal<DirHit[]>([]);
  const [idx, setIdx] = createSignal(0);
  let input!: HTMLInputElement;

  const isCmd = () => paletteOpen() === "command" || q().startsWith(">");
  const cmdQuery = () => (q().startsWith(">") ? q().slice(1).trim() : q());
  const cmdHits = () => {
    const query = cmdQuery();
    const list = commands().map((c) => ({ c, s: query ? fuzzy(query, c.label) : 0 })).filter((x) => x.s >= 0);
    if (query) list.sort((a, b) => b.s - a.s);
    return list.map((x) => x.c);
  };

  createEffect(on(paletteOpen, (o) => {
    if (o) {
      setQ("");
      setIdx(0);
      queueMicrotask(() => input?.focus());
      if (o === "teleport") api.teleport("").then(setHits);
    }
  }));

  let req = 0;
  createEffect(on(q, (v) => {
    setIdx(0);
    if (isCmd()) return;
    const id = ++req;
    api.teleport(v).then((h) => id === req && setHits(h));
  }));

  const count = () => (isCmd() ? cmdHits().length : hits().length);
  const close = () => setPaletteOpen(null);
  const run = (i: number) => {
    if (isCmd()) {
      const c = cmdHits()[i];
      close();
      c?.run();
    } else {
      const h = hits()[i];
      close();
      if (h) navigate(ws.focus, h.path);
      else if (q()) navigate(ws.focus, q());
    }
  };

  return (
    <Show when={paletteOpen()}>
      <div class="modal-back" onMouseDown={close}>
        <div class="palette" onMouseDown={(e) => e.stopPropagation()}>
          <input
            ref={input}
            value={q()}
            spellcheck={false}
            placeholder={isCmd() ? "Run a command…" : "Jump to folder… (type > for commands)"}
            onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((idx() + 1) % Math.max(1, count())); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((idx() - 1 + count()) % Math.max(1, count())); }
              else if (e.key === "Enter") { e.preventDefault(); run(idx()); }
            }}
          />
          <div class="pal-list">
            <Show when={isCmd()} fallback={
              <>
                <For each={hits()}>
                  {(h, i) => {
                    const parts = h.path.split(/[\\/]/).filter(Boolean);
                    return (
                      <div class="pal-item" classList={{ active: idx() === i() }} onMouseEnter={() => setIdx(i())} onMouseDown={() => run(i())}>
                        <span class="pal-main">{parts.pop() ?? h.path}</span>
                        <span class="pal-sub">{h.path}</span>
                      </div>
                    );
                  }}
                </For>
                <Show when={!hits().length}>
                  <div class="pal-empty">{q() ? "No visited folder matches. Enter tries it as a path." : "Folders you visit show up here."}</div>
                </Show>
              </>
            }>
              <For each={cmdHits()}>
                {(c, i) => (
                  <div class="pal-item" classList={{ active: idx() === i() }} onMouseEnter={() => setIdx(i())} onMouseDown={() => run(i())}>
                    <span class="pal-main">{c.label}</span>
                    <span class="pal-key">{c.key ?? ""}</span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
