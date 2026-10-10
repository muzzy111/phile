// Address bar: breadcrumbs at rest, a smart path input when focused.
// Accepts paths, ~, %ENV%, $ENV, @aliases, file:/// URLs and file jumps.
import { createSignal, For, Show } from "solid-js";
import { api, type Entry, joinPath, parentOf, sep } from "../lib/api";
import { navigate, notify, type Tab } from "../lib/state";

export const omniInputs: (HTMLInputElement | undefined)[] = [undefined, undefined];

export function Omnibar(p: { pane: 0 | 1; tab: Tab; onFocusPane: () => void }) {
  const [editing, setEditing] = createSignal(false);
  const [value, setValue] = createSignal("");
  const [sugg, setSugg] = createSignal<Entry[]>([]);
  const [si, setSi] = createSignal(-1);
  let input!: HTMLInputElement;
  let reqId = 0;

  const crumbs = () => {
    const path = p.tab.path;
    const s = sep(path);
    const parts = path.split(/[\\/]/).filter(Boolean);
    const out: [string, string][] = [];
    let acc = path.startsWith("/") ? "/" : "";
    if (acc) out.push(["/", "/"]);
    parts.forEach((part, i) => {
      acc = i === 0 && !acc ? part + s : acc.endsWith(s) ? acc + part : acc + s + part;
      out.push([part, acc]);
    });
    return out;
  };

  const begin = () => {
    p.onFocusPane();
    setValue(p.tab.path);
    setEditing(true);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  };

  const suggest = async (v: string) => {
    const id = ++reqId;
    if (!v || v.startsWith("@") || v.includes("%") || v.includes("$")) return setSugg([]);
    const endsSep = /[\\/]$/.test(v);
    const dir = endsSep ? v : parentOf(v);
    const prefix = endsSep ? "" : v.split(/[\\/]/).pop()!.toLowerCase();
    try {
      const list = await api.listDir(dir);
      if (id !== reqId) return;
      setSugg(list.filter((e) => e.kind !== "file" && e.name.toLowerCase().startsWith(prefix)).slice(0, 12));
      setSi(-1);
    } catch {
      if (id === reqId) setSugg([]);
    }
  };

  const go = async (raw: string) => {
    try {
      const t = await api.resolve(raw, p.tab.path);
      if (t.type === "dir") await navigate(p.pane, t.path);
      else if (t.type === "file") await navigate(p.pane, t.dir, { select: t.path });
      else {
        notify(`Not found: ${t.expanded}`, "error");
        return;
      }
      setEditing(false);
    } catch (e) {
      notify(String(e), "error");
    }
  };

  const key = (e: KeyboardEvent) => {
    const s = sugg();
    if (e.key === "Escape") {
      setEditing(false);
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(si() >= 0 ? s[si()].path : value());
    } else if (e.key === "ArrowDown" && s.length) {
      e.preventDefault();
      setSi((si() + 1) % s.length);
    } else if (e.key === "ArrowUp" && s.length) {
      e.preventDefault();
      setSi((si() - 1 + s.length) % s.length);
    } else if (e.key === "Tab" && s.length) {
      e.preventDefault();
      const pick = s[Math.max(0, si())];
      const v = joinPath(pick.path, "");
      setValue(v);
      suggest(v);
    }
    e.stopPropagation();
  };

  return (
    <div class="omnibar">
      <Show
        when={editing()}
        fallback={
          <div class="crumbs" onClick={begin} title="Click or Ctrl+L to type a path">
            <For each={crumbs()}>
              {([label, path], i) => (
                <>
                  <Show when={i() > 0}>
                    <span class="crumb-sep">›</span>
                  </Show>
                  <button
                    class="crumb"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onFocusPane();
                      navigate(p.pane, path);
                    }}
                  >
                    {label}
                  </button>
                </>
              )}
            </For>
          </div>
        }
      >
        <input
          ref={(el) => {
            input = el;
            omniInputs[p.pane] = el;
          }}
          class="omni-input"
          value={value()}
          spellcheck={false}
          placeholder="Path, ~, %APPDATA%, @alias, or a file"
          onInput={(e) => {
            setValue(e.currentTarget.value);
            suggest(e.currentTarget.value);
          }}
          onKeyDown={key}
          onBlur={() => setTimeout(() => setEditing(false), 150)}
        />
        <Show when={sugg().length}>
          <div class="omni-sugg">
            <For each={sugg()}>
              {(s, i) => (
                <div class="sugg" classList={{ active: si() === i() }} onMouseDown={(e) => { e.preventDefault(); go(s.path); }}>
                  {s.path}
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
      {/* Hidden handle so Ctrl+L can enter edit mode from anywhere. */}
      <button class="omni-edit-handle" data-pane={p.pane} onClick={begin} tabIndex={-1} aria-hidden="true" />
    </div>
  );
}
