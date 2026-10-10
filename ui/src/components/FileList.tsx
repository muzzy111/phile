// Virtualized file list: renders only visible rows, so 100k-entry folders stay smooth.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type Entry, fmtDate, fmtSize } from "../lib/api";
import { type SortKey, type Tab, runtime, setRt, view, ws } from "../lib/state";
import { Icon } from "./Icon";

export const ROW = 26;

export const scrollers: (HTMLDivElement | undefined)[] = [undefined, undefined];

interface Props {
  pane: 0 | 1;
  tab: Tab;
  compareWith?: Map<string, Entry>;
  onOpen: (e: Entry) => void;
  onSort: (k: SortKey) => void;
  onFocus: () => void;
  onDrop: (paths: string[], move: boolean) => void;
  onContext: (e: MouseEvent, entry: Entry | null) => void;
}

export function FileList(p: Props) {
  let el!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  const [dragOver, setDragOver] = createSignal(false);
  const rows = createMemo(() => view(p.tab));
  const r = () => runtime(p.tab.id);
  const start = () => Math.max(0, Math.floor(top() / ROW) - 10);
  const end = () => Math.min(rows().length, Math.ceil((top() + height()) / ROW) + 10);
  const slice = createMemo(() => rows().slice(start(), end()).map((e, i) => ({ e, i: i + start() })));
  let anchor = 0;

  onMount(() => {
    scrollers[p.pane] = el;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  // Keep the cursor row visible.
  createEffect(() => {
    const c = r().cursor;
    if (!el) return;
    const y = c * ROW;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW > el.scrollTop + el.clientHeight - ROW) el.scrollTop = y + 2 * ROW - el.clientHeight;
  });

  const onScroll = () => {
    setTop(el.scrollTop);
    if (ws.syncScroll) {
      const other = scrollers[p.pane === 0 ? 1 : 0];
      if (other && Math.abs(other.scrollTop - el.scrollTop) > 1) other.scrollTop = el.scrollTop;
    }
  };

  const click = (ev: MouseEvent, i: number, e: Entry) => {
    p.onFocus();
    const id = p.tab.id;
    if (ev.shiftKey) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      const sel: Record<string, true> = ev.ctrlKey ? { ...r().selected } : {};
      rows().slice(a, b + 1).forEach((x) => (sel[x.path] = true));
      setRt(id, { selected: sel, cursor: i });
    } else if (ev.ctrlKey || ev.metaKey) {
      const sel = { ...r().selected };
      if (sel[e.path]) delete sel[e.path];
      else sel[e.path] = true;
      setRt(id, { selected: sel, cursor: i });
      anchor = i;
    } else {
      setRt(id, { selected: {}, cursor: i });
      anchor = i;
    }
  };

  const diffClass = (e: Entry) => {
    if (!p.compareWith) return "";
    const o = p.compareWith.get(e.name);
    if (!o) return "diff-only";
    if (e.kind !== "dir" && (o.size !== e.size || Math.abs(o.modified - e.modified) > 2000)) return o.modified < e.modified ? "diff-newer" : "diff-older";
    return "diff-same";
  };

  const header = (k: SortKey, label: string, cls: string) => (
    <div class={`col ${cls} sortable`} onClick={() => p.onSort(k)}>
      {label}
      <Show when={p.tab.sortKey === k}>
        <span class="sort-ind">{p.tab.sortDir === 1 ? "▲" : "▼"}</span>
      </Show>
    </div>
  );

  return (
    <div class="filelist" classList={{ "drag-over": dragOver() }}>
      <div class="row header">
        {header("name", "Name", "c-name")}
        {header("ext", "Type", "c-ext")}
        {header("size", "Size", "c-size")}
        {header("modified", "Modified", "c-mod")}
      </div>
      <div
        class="scroller"
        ref={el}
        tabIndex={-1}
        onScroll={onScroll}
        onMouseDown={() => p.onFocus()}
        onContextMenu={(ev) => {
          ev.preventDefault();
          p.onContext(ev, null);
        }}
        onDragOver={(ev) => {
          if (ev.dataTransfer?.types.includes("application/x-phile-paths")) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = ev.shiftKey ? "move" : "copy";
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(ev) => {
          setDragOver(false);
          const raw = ev.dataTransfer?.getData("application/x-phile-paths");
          if (!raw) return;
          ev.preventDefault();
          const d = JSON.parse(raw) as { pane: number; paths: string[] };
          if (d.pane === p.pane && !ev.shiftKey) return;
          p.onDrop(d.paths, ev.shiftKey);
        }}
      >
        <Show when={r().error}>
          <div class="empty error">{r().error}</div>
        </Show>
        <Show when={!r().error && !r().loading && rows().length === 0}>
          <div class="empty">{p.tab.filter ? "No matches" : "This folder is empty"}</div>
        </Show>
        <div style={{ height: `${rows().length * ROW}px`, position: "relative" }}>
          <For each={slice()}>
            {({ e, i }) => (
              <div
                class={`row ${diffClass(e)}`}
                classList={{ cursor: r().cursor === i, selected: !!r().selected[e.path], hidden: e.hidden }}
                style={{ transform: `translateY(${i * ROW}px)` }}
                draggable={true}
                onDragStart={(ev) => {
                  const paths = r().selected[e.path] ? Object.keys(r().selected) : [e.path];
                  ev.dataTransfer!.setData("application/x-phile-paths", JSON.stringify({ pane: p.pane, paths }));
                  ev.dataTransfer!.effectAllowed = "copyMove";
                }}
                onMouseDown={(ev) => ev.button === 0 && click(ev, i, e)}
                onDblClick={() => p.onOpen(e)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (!r().selected[e.path]) setRt(p.tab.id, { selected: {}, cursor: i });
                  p.onFocus();
                  p.onContext(ev, e);
                }}
                title={e.path}
              >
                <div class="col c-name">
                  <Icon entry={e} />
                  <span class="name">{p.tab.flat ? e.path.slice(p.tab.path.length).replace(/^[\\/]/, "") : e.name}</span>
                </div>
                <div class="col c-ext">{e.kind === "dir" ? "Folder" : e.ext.toUpperCase()}</div>
                <div class="col c-size">{e.kind === "dir" ? "" : fmtSize(e.size)}</div>
                <div class="col c-mod">{fmtDate(e.modified)}</div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
