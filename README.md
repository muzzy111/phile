# Phile

A fast, modern file explorer for Windows. Two panes, tabs, workspaces, instant previews, and a transfer queue you can pause.

## Install

1. Open the **Releases** page of this repository.
2. Download `Phile_x.y.z_x64-setup.exe`.
3. Double-click it. No admin rights needed. Done.

> Until the app is code-signed, Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**.

## What you get today

| Feature | How |
|---|---|
| Two panes side by side | `Tab` switches pane, `Ctrl+D` toggles single/dual |
| Copy / move to the other pane | `F5` / `F6`, or drag (hold `Shift` to move) |
| Tabs | `Ctrl+T`, `Ctrl+W`, `Ctrl+1…9`, middle-click closes |
| Workspaces that survive restarts | Click **Workspace** in the sidebar, or `Ctrl+Shift+W` |
| Smart address bar | `Ctrl+L`, then type a path, `~`, `%APPDATA%`, `$HOME`, `@alias`, or a file name |
| Jump to any folder you've visited | `Ctrl+P`, type a few letters |
| All commands | `Ctrl+Shift+P` |
| Quick look | `Space`: Markdown, code, PDF, images, video, audio waveform, CSV |
| Hex view and checksums | Preview panel → **Hex** / **Info** (SHA-256, MD5, BLAKE3) |
| Flatten subfolders | `Ctrl+Shift+F` lists every file below the folder |
| Compare two folders | `Ctrl+Shift+D` colours files that differ |
| Synced scrolling | `Ctrl+Shift+S` |
| Transfer queue | `Ctrl+J`: pause, resume, cancel, speed limit, verify copies, collision rules |
| Safe delete | `Del` goes to Recycle Bin; `Shift+Del` asks first |
| All shortcuts | `F1` |

Coming next: git badges, metadata/EXIF sidebar, batch renamer, terminal drawer, instant search, tags, disk heatmap. See [docs/PLAN.md](docs/PLAN.md).

## Claude Code workspace (optional)

Turn Claude Code into an Antigravity-style agent IDE that uses Phile to find, move, copy and organize files: double-click **`install-claude-mod.cmd`**, then type `/ag` in Claude Code. Details: [claude-mod/phile/README.md](claude-mod/phile/README.md).

## For developers

See [CLAUDE.md](CLAUDE.md) for layout, rules and commands.
