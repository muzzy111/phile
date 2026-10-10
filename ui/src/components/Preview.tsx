// Quick-look renderers. Used by the side panel and the Space overlay.
// Add a format: extend `renderKind` and add a branch in <Rendered>.
import { convertFileSrc } from "@tauri-apps/api/core";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { createEffect, createResource, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { api, fmtDate, fmtSize, type Preview as P } from "../lib/api";

type Mode = "view" | "text" | "hex" | "info";
const IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);
const VID = new Set(["mp4", "webm", "mov", "m4v", "mkv", "ogv"]);
const AUD = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"]);
const CODE_LANG: Record<string, string> = {
  rs: "rust", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", py: "python",
  go: "go", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", java: "java", kt: "kotlin", swift: "swift", rb: "ruby",
  php: "php", lua: "lua", sh: "bash", bash: "bash", ps1: "powershell", json: "json", toml: "ini", ini: "ini", yaml: "yaml", yml: "yaml",
  xml: "xml", html: "xml", css: "css", scss: "scss", sql: "sql", diff: "diff", patch: "diff", dockerfile: "dockerfile", makefile: "makefile",
};

const renderKind = (p: P): string => {
  const e = p.entry.ext;
  if (p.entry.kind === "dir") return "dir";
  if (IMG.has(e)) return "image";
  if (VID.has(e)) return "video";
  if (AUD.has(e)) return "audio";
  if (e === "pdf") return "pdf";
  if (e === "md" || e === "markdown") return "markdown";
  if (e === "csv" || e === "tsv") return "table";
  if (p.isText && CODE_LANG[e]) return "code";
  if (p.isText) return "text";
  return "binary";
};

export function PreviewView(props: { path: string | null; large?: boolean }) {
  const [mode, setMode] = createSignal<Mode>("view");
  const [data] = createResource(() => props.path, (p) => api.preview(p).catch((e) => ({ error: String(e) }) as any));
  createEffect(on(() => props.path, () => setMode("view")));

  return (
    <div class="preview" classList={{ large: !!props.large }}>
      <Show when={props.path} fallback={<div class="empty">Select a file to preview</div>}>
        <Show when={data() && !(data() as any).error} fallback={<div class="empty">{(data() as any)?.error ?? "Loading…"}</div>}>
          {(_) => {
            const p = () => data() as P;
            return (
              <>
                <div class="pv-head">
                  <div class="pv-title" title={p().entry.path}>{p().entry.name}</div>
                  <div class="pv-modes">
                    <For each={(["view", "text", "hex", "info"] as Mode[]).filter((m) => p().entry.kind !== "dir" || m === "info" || m === "view")}>
                      {(m) => (
                        <button classList={{ active: mode() === m }} onClick={() => setMode(m)}>
                          {m === "view" ? "Preview" : m === "text" ? "Raw" : m === "hex" ? "Hex" : "Info"}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <div class="pv-body">
                  <Switch>
                    <Match when={mode() === "view"}><Rendered p={p()} /></Match>
                    <Match when={mode() === "text"}><pre class="raw">{p().text ?? "Binary file: use Hex view."}</pre></Match>
                    <Match when={mode() === "hex"}><Hex path={p().entry.path} size={p().entry.size} /></Match>
                    <Match when={mode() === "info"}><Info p={p()} /></Match>
                  </Switch>
                </div>
              </>
            );
          }}
        </Show>
      </Show>
    </div>
  );
}

function Rendered(props: { p: P }) {
  const p = () => props.p;
  const src = () => convertFileSrc(p().entry.path);
  return (
    <Switch fallback={<Hex path={p().entry.path} size={p().entry.size} />}>
      <Match when={renderKind(p()) === "dir"}><Info p={p()} /></Match>
      <Match when={renderKind(p()) === "image"}><div class="pv-img"><img src={src()} alt="" /></div></Match>
      <Match when={renderKind(p()) === "video"}><video class="pv-media" src={src()} controls /></Match>
      <Match when={renderKind(p()) === "audio"}><Audio src={src()} /></Match>
      <Match when={renderKind(p()) === "pdf"}><iframe class="pv-pdf" src={src()} title="PDF" /></Match>
      <Match when={renderKind(p()) === "markdown"}><Markdown text={p().text ?? ""} /></Match>
      <Match when={renderKind(p()) === "table"}><Table text={p().text ?? ""} tsv={p().entry.ext === "tsv"} truncated={p().truncated} /></Match>
      <Match when={renderKind(p()) === "code"}><Code text={p().text ?? ""} lang={CODE_LANG[p().entry.ext]} /></Match>
      <Match when={renderKind(p()) === "text"}><pre class="raw">{p().text}</pre></Match>
    </Switch>
  );
}

function Code(p: { text: string; lang: string }) {
  const html = () => {
    try {
      return hljs.highlight(p.text, { language: p.lang, ignoreIllegals: true }).value;
    } catch {
      return hljs.highlightAuto(p.text).value;
    }
  };
  return <pre class="code hljs"><code innerHTML={html()} /></pre>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function Markdown(p: { text: string }) {
  const parts = () => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(p.text);
    const fm = m ? m[1].split(/\r?\n/).map((l) => l.split(/:\s*(.*)/s)).filter((kv) => kv[0]?.trim()) : [];
    const body = m ? p.text.slice(m[0].length) : p.text;
    // Raw HTML in markdown is escaped: previews must never run file content.
    const renderer = new marked.Renderer();
    renderer.html = ({ text }) => esc(text);
    return { fm, html: marked.parse(body, { gfm: true, async: false, renderer }) as string };
  };
  return (
    <div class="md">
      <Show when={parts().fm.length}>
        <table class="frontmatter">
          <tbody>
            <For each={parts().fm}>{([k, v]) => <tr><th>{k}</th><td>{v}</td></tr>}</For>
          </tbody>
        </table>
      </Show>
      <div innerHTML={parts().html} />
    </div>
  );
}

function parseDelimited(text: string, delim: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function Table(p: { text: string; tsv: boolean; truncated: boolean }) {
  const rows = () => parseDelimited(p.text, p.tsv ? "\t" : p.text.split("\n")[0].includes(";") && !p.text.split("\n")[0].includes(",") ? ";" : ",", 2001);
  return (
    <div class="table-wrap">
      <table class="grid">
        <thead><tr><th class="rn">#</th><For each={rows()[0] ?? []}>{(h) => <th>{h}</th>}</For></tr></thead>
        <tbody>
          <For each={rows().slice(1)}>
            {(r, i) => <tr><td class="rn">{i() + 1}</td><For each={r}>{(c) => <td>{c}</td>}</For></tr>}
          </For>
        </tbody>
      </table>
      <Show when={p.truncated || rows().length > 2000}><div class="note">Showing the first rows only.</div></Show>
    </div>
  );
}

function Audio(p: { src: string }) {
  let canvas!: HTMLCanvasElement;
  let audio!: HTMLAudioElement;
  const [info, setInfo] = createSignal("");
  createEffect(on(() => p.src, async (src) => {
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try {
      const buf = await (await fetch(src)).arrayBuffer();
      if (buf.byteLength > 80 * 1024 * 1024) return setInfo("Waveform skipped for very large file");
      const ac = new OfflineAudioContext(1, 1, 44100);
      const audioBuf = await ac.decodeAudioData(buf);
      setInfo(`${audioBuf.sampleRate.toLocaleString()} Hz · ${audioBuf.numberOfChannels} ch · ${audioBuf.duration.toFixed(1)} s`);
      const d = audioBuf.getChannelData(0);
      const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
      const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
      const step = Math.max(1, Math.floor(d.length / w));
      ctx.fillStyle = getComputedStyle(canvas).color;
      for (let x = 0; x < w; x++) {
        let min = 1, max = -1;
        for (let j = 0; j < step; j++) {
          const v = d[x * step + j] ?? 0;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        ctx.fillRect(x, ((1 + min) * h) / 2, 1, Math.max(1, ((max - min) * h) / 2));
      }
    } catch {
      setInfo("Waveform unavailable for this format");
    }
  }));
  const seek = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    if (audio.duration) audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
  };
  return (
    <div class="pv-audio">
      <canvas ref={canvas} class="wave" onClick={seek} />
      <div class="note">{info()}</div>
      <audio ref={audio} src={p.src} controls />
    </div>
  );
}

function Hex(p: { path: string; size: number }) {
  const PAGE = 16 * 256;
  const [text, setText] = createSignal("");
  const [offset, setOffset] = createSignal(0);
  let alive = true;
  onCleanup(() => (alive = false));
  createEffect(on(() => p.path, async (path) => {
    setOffset(0);
    const t = await api.hex(path, 0, PAGE).catch((e) => String(e));
    if (alive) setText(t);
  }));
  const more = async () => {
    const o = offset() + PAGE;
    const t = await api.hex(p.path, o, PAGE);
    setOffset(o);
    setText((x) => x + t);
  };
  return (
    <div class="hex-wrap">
      <pre class="hex">{text()}</pre>
      <Show when={offset() + PAGE < p.size}><button class="more" onClick={more}>Load more ({fmtSize(p.size - offset() - PAGE)} left)</button></Show>
    </div>
  );
}

function Info(p: { p: P }) {
  const [h, setH] = createSignal<{ sha256: string; md5: string; blake3: string } | "busy" | null>(null);
  createEffect(on(() => p.p.entry.path, () => setH(null)));
  const e = () => p.p.entry;
  return (
    <table class="info">
      <tbody>
        <tr><th>Path</th><td class="sel">{e().path}</td></tr>
        <tr><th>Type</th><td>{p.p.mime}</td></tr>
        <Show when={e().kind !== "dir"}>
          <tr><th>Size</th><td>{fmtSize(e().size)} ({e().size.toLocaleString()} bytes)</td></tr>
          <tr><th>Encoding</th><td>{p.p.encoding}</td></tr>
        </Show>
        <tr><th>Modified</th><td>{fmtDate(e().modified)}</td></tr>
        <tr><th>Hidden</th><td>{e().hidden ? "Yes" : "No"}</td></tr>
        <Show when={e().kind !== "dir"}>
          <tr>
            <th>Checksums</th>
            <td>
              <Show when={h() && h() !== "busy"} fallback={<button disabled={h() === "busy"} onClick={async () => { setH("busy"); setH(await api.hashes(e().path)); }}>{h() === "busy" ? "Hashing…" : "Compute SHA-256 / MD5 / BLAKE3"}</button>}>
                {(() => {
                  const v = h() as { sha256: string; md5: string; blake3: string };
                  return (
                    <div class="hashes">
                      <div><b>SHA-256</b> <code class="sel">{v.sha256}</code></div>
                      <div><b>MD5</b> <code class="sel">{v.md5}</code></div>
                      <div><b>BLAKE3</b> <code class="sel">{v.blake3}</code></div>
                    </div>
                  );
                })()}
              </Show>
            </td>
          </tr>
        </Show>
      </tbody>
    </table>
  );
}
