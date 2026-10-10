import { createSignal, For, Show } from "solid-js";

export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}
type Item = MenuItem | "-";
const [menu, setMenu] = createSignal<{ x: number; y: number; items: Item[] } | null>(null);

export const showMenu = (e: MouseEvent, items: Item[]) => setMenu({ x: e.clientX, y: e.clientY, items });

export function MenuHost() {
  return (
    <Show when={menu()}>
      {(m) => (
        <div class="menu-back" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div
            class="menu"
            style={{ left: `${Math.min(m().x, innerWidth - 240)}px`, top: `${Math.min(m().y, innerHeight - m().items.length * 28 - 10)}px` }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <For each={m().items}>
              {(it) =>
                it === "-" ? (
                  <div class="menu-sep" />
                ) : (
                  <button
                    class="menu-item"
                    classList={{ danger: !!it.danger }}
                    disabled={it.disabled}
                    onClick={() => {
                      setMenu(null);
                      it.run();
                    }}
                  >
                    <span>{it.label}</span>
                    <span class="hint">{it.hint}</span>
                  </button>
                )
              }
            </For>
          </div>
        </div>
      )}
    </Show>
  );
}
