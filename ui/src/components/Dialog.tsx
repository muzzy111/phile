// Promise-based in-app dialogs (prompt/confirm) that match the theme.
import { createSignal, Show } from "solid-js";

interface Req {
  title: string;
  message?: string;
  value?: string;
  input: boolean;
  danger?: boolean;
  ok?: string;
  resolve: (v: string | null) => void;
}
const [req, setReq] = createSignal<Req | null>(null);

export const ask = (title: string, value = "", message?: string) =>
  new Promise<string | null>((resolve) => setReq({ title, value, message, input: true, resolve }));

export const confirmBox = (title: string, message?: string, danger = false, ok = "OK") =>
  new Promise<boolean>((resolve) => setReq({ title, message, input: false, danger, ok, resolve: (v) => resolve(v !== null) }));

export function DialogHost() {
  let input: HTMLInputElement | undefined;
  const done = (v: string | null) => {
    req()?.resolve(v);
    setReq(null);
  };
  return (
    <Show when={req()}>
      {(r) => (
        <div class="modal-back" onMouseDown={() => done(null)}>
          <div
            class="modal"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") done(null);
              if (e.key === "Enter") done(r().input ? input!.value : "ok");
            }}
          >
            <div class="modal-title">{r().title}</div>
            <Show when={r().message}>
              <div class="modal-msg">{r().message}</div>
            </Show>
            <Show
              when={r().input}
              fallback={<button ref={(b) => queueMicrotask(() => b.focus())} style={{ position: "absolute", opacity: 0 }} />}
            >
              <input
                ref={(el) => {
                  input = el;
                  queueMicrotask(() => {
                    el.focus();
                    // Select the name without its extension, like Explorer.
                    const v = el.value;
                    const dot = v.lastIndexOf(".");
                    el.setSelectionRange(0, dot > 0 ? dot : v.length);
                  });
                }}
                value={r().value}
                spellcheck={false}
              />
            </Show>
            <div class="modal-btns">
              <button onClick={() => done(null)}>Cancel</button>
              <button class={r().danger ? "danger" : "primary"} onClick={() => done(r().input ? input!.value : "ok")}>
                {r().ok ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
