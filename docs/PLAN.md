# Phile: Architecture & Build Plan

A modern Windows file explorer. Turnkey: one installer, no setup, sensible defaults.

## 1. Stack (decision)

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | Small installer (~10 MB vs ~150 MB Electron), native WebView2 (ships with Win10/11), Rust backend, auto-updater built in. |
| Core | **Rust** workspace | Speed and safety for indexing, file ops, hashing. Crates outlive UI rewrites. |
| UI | **SolidJS + TypeScript + Vite** | Fine-grained reactivity handles 100k-row virtual lists without React re-render cost. |
| Storage | **SQLite** (rusqlite, WAL, FTS5) | Tags, workspaces, filename index, settings. One file, zero admin. |
| Installer | **NSIS (per-user) + MSI** via `tauri-bundler` | Per-user NSIS installs with no admin prompt. MSI for managed machines. |
| CI | **GitHub Actions** `windows-latest` | Builds signed installer on every tag; user never touches a compiler. |

Override considered: WinUI 3/C# gives the most native look but locks UI to Windows and C# tooling; previews (Markdown, PDF, Parquet, waveforms, treemap) are far cheaper on the web stack. Tauri wins.

## 2. Architecture

```
┌──────────────────────── UI (SolidJS, WebView2) ────────────────────────┐
│ Panes/Tabs/Workspaces │ Omnibar │ Palette │ Preview │ Treemap │ Terminal│
└───────────────▲──────────────── typed IPC (tauri-specta) ──────────────┘
                │ commands + event streams
┌───────────────┴──────────────── Rust core (crates/) ───────────────────┐
│ phile-fs      listing, watch (notify/ReadDirectoryChangesW), flatten   │
│ phile-ops     job queue: copy/move/delete, pause/retry/throttle, verify│
│ phile-index   MFT/USN-journal filename index + fallback walker         │
│ phile-search  query parser (ext: size: modified:) + ripgrep (grep crate)│
│ phile-meta    hashes (blake3/sha2/md5), MIME, EXIF, media (symphonia), │
│               ACLs (windows crate), symlink/junction targets           │
│ phile-git     gix: status badges, branch, diffs                        │
│ phile-tags    SQLite tags + NTFS ADS mirror, virtual folders           │
│ phile-rename  regex + token engine, dry-run diff, undo journal         │
│ phile-disk    parallel size scan, treemap data, duplicate finder       │
│ phile-term    ConPTY via portable-pty, streamed to xterm.js            │
│ phile-store   SQLite schema + migrations (workspaces, settings)        │
└─────────────────────────────────────────────────────────────────────────┘
```

Rules that keep it future-proof:
- **Core has no Tauri dependency.** Each crate is a plain library with its own tests; `src-tauri` is a thin adapter. A CLI (`phile-cli`) uses the same crates, so features are testable headless and swappable shells stay possible.
- **Typed IPC generated from Rust** (tauri-specta). Changing a command breaks the TS build, not production.
- **Every long op is a Job** with id, progress events, cancel. UI never blocks.
- **Schema migrations versioned** (refinery). Settings and workspaces survive upgrades.
- **Plugin seam**: preview renderers and omnibar resolvers are registries keyed by MIME/prefix, so new formats are drop-in.
- **No AI model dependency in core.** Optional AI features (semantic search, smart rename) go behind a provider interface so models can change freely.

## 3. Feature map → crate → phase

| # | Feature | Crate(s) | Phase |
|---|---|---|---|
| 1.1 | Dual pane, sync scroll, F5/F6 copy/move between panes | UI, ops | 1 |
| 1.2 | Tabs, named workspaces persisted across reboots | UI, store | 1 |
| 1.3 | Smart omnibar (paths, `%ENV%`, `~`, aliases, file jump) | fs | 1 |
| 1.4 | Ctrl+P fuzzy teleport (frecency-ranked dirs, nucleo matcher) | index, store | 2 |
| 2.1 | Space quick-look: MD+frontmatter, code (Shiki), PDF (pdf.js), CSV/Parquet (DuckDB-wasm), audio/video + waveform | UI, meta | 2 |
| 2.2 | Hex/raw view, MIME, SHA-256/MD5 | meta | 2 |
| 2.3 | Git badges, branch, inline diff | git | 3 |
| 2.4 | Metadata/EXIF sidebar, ACLs, octal perms, link targets | meta | 3 |
| 3.1 | Batch renamer with live preview + undo | rename | 3 |
| 3.2 | Queued transfers: pause, retry, throttle, hash verify, collision rules | ops | 1 (basic) / 3 (full) |
| 3.3 | Tags + virtual folders | tags | 4 |
| 3.4 | Flatten subfolders | fs | 2 |
| 4.1 | Hybrid instant search (filename index + content grep, token filters) | index, search | 4 |
| 4.2 | Disk treemap/sunburst, orphan caches, duplicates | disk | 4 |
| 4.3 | Terminal drawer locked to focused dir (PowerShell/cmd/WSL/Git Bash) | term | 3 |
| 4.x+ | Rest of spec (truncated in message) | TBD | folded in on arrival |

## 4. Phases

**Phase 0: Foundation.** Repo, Cargo workspace, Tauri 2 shell, SolidJS UI, CI producing an unsigned installer artifact, CLAUDE.md, lint/test gates. *Exit: double-click installer, app opens a folder.*

**Phase 1: Usable explorer (MVP).** Virtualized list/detail views, dual pane, tabs, workspaces, omnibar, keyboard-first bindings, basic job queue (copy/move/delete to Recycle Bin), live folder watching, dark/light theme. *Exit: can replace Explorer for daily navigation.*

**Phase 2: Inspect.** Quick-look renderers, hex view, hashes, flatten view, Ctrl+P palette.

**Phase 3: Power tools.** Git overlays, metadata sidebar, batch renamer, full transfer manager, terminal drawer.

**Phase 4: Intelligence.** USN-journal instant index, content search, tags/virtual folders, treemap, duplicate finder.

**Phase 5: Polish & ship.** Code signing, auto-update channel, Explorer "Open with Phile" context menu + default-folder handler (opt-in), first-run tour, crash reporting (opt-in), accessibility pass (UIA via WebView2).

## 5. Turnkey distribution

- User downloads `Phile-Setup.exe` from GitHub Releases. Per-user install, no admin, no dependencies (WebView2 bootstrapper embedded).
- Auto-update via Tauri updater with signed manifests.
- Defaults: dual pane on, dark theme follows Windows, Ctrl+P enabled, index builds in background at low priority.
- Code signing: needs a certificate (Azure Trusted Signing ~$10/mo is cheapest). Until then SmartScreen warns on first run.

## 6. Risks

| Risk | Mitigation |
|---|---|
| USN/MFT read needs admin | Optional elevated helper service; fallback to parallel walker + watcher |
| WebView perf on huge folders | Virtualized rows, Rust-side sort/filter, paged IPC |
| Shell integration (thumbnails, context menus) | `windows` crate COM: IShellItemImageFactory, IContextMenu |
| Data loss in ops | Journaled jobs, delete-to-Recycle by default, rename undo log, hash verify |

## 7. Needed from user

- **GitHub repo** (suggested `muzzy111/phile`) to scaffold, push, and run Windows CI.
- Later: code-signing certificate (Phase 5).
- Remainder of feature spec (section 4 onward).
