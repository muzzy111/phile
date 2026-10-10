# Phile

Windows file explorer. Tauri 2 shell, Rust core crates, SolidJS UI. Plan and phases: `docs/PLAN.md`.

## Layout
- `crates/phile-fs`: listing, flatten, omnibar path resolution (`omnibar.rs`).
- `crates/phile-ops`: job queue (copy/move/trash/delete, pause, retry, throttle, blake3 verify, collisions).
- `crates/phile-meta`: hashes, MIME sniff, hex dump, bounded text reads.
- `crates/phile-store`: SQLite (settings, workspaces, aliases, pins, frecency + fuzzy teleport).
- `src-tauri`: thin adapter. Commands only delegate to crates. No logic here.
- `ui/src/lib/api.ts`: the only place that calls `invoke`. Types mirror Rust structs (camelCase).
- `ui/src/lib/commands.ts`: single registry for shortcuts AND the command palette. New feature = new entry.
- `ui/src/components/Preview.tsx`: quick-look renderers; add formats in `renderKind` + `<Rendered>`.

## Rules
- Core crates never depend on Tauri. Every core feature gets unit tests in its crate.
- Long work runs as a `phile-ops` job or `spawn_blocking`; never block the UI thread.
- Store schema: append to `MIGRATIONS` in `phile-store`; never edit an existing migration.
- Workspace JSON has `version`; bump and migrate in `ui/src/lib/state.ts` when the shape changes.
- Destructive defaults are safe: delete goes to Recycle Bin; permanent delete always confirms.
- Previews never execute file content (markdown HTML is escaped; CSP blocks inline scripts).
- Windows-only code sits behind `#[cfg(windows)]` with a non-Windows fallback so tests run on any OS.

## Commands
- Dev: `pnpm --dir ui install && pnpm dlx @tauri-apps/cli@2 dev` (from `src-tauri/`)
- Test: `cargo test --workspace --exclude phile` and `pnpm --dir ui build` (typechecks)
- Lint: `cargo clippy --workspace -- -D warnings`
- Installer: CI builds it on every push (`.github/workflows/ci.yml`); tag `vX.Y.Z` to publish a release.
