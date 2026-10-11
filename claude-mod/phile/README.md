# Phile workspace for Claude Code

Turns Claude Code into an Antigravity-style agent workspace, with Phile as the file engine.

## Install (Windows, one step)

Double-click **`install-claude-mod.cmd`** in the Phile folder. Then start Claude Code anywhere and type `/ag`.

It builds `phile-agent` (or reuses the one from a Phile release), puts it in `%LOCALAPPDATA%\Phile\bin`, and installs this mod. Run it again to update; `install-claude-mod.cmd -Uninstall` removes it.

## What you get

| Antigravity | Here |
|---|---|
| Agent Manager | **Agent Manager** pane: every agent and subagent live (status, current tool, calls, time), a "new task" box, artifacts list, one-click undo of file changes |
| Planning / Fast modes | Band above the prompt and `/mode`. Planning: plan first, dry-run file moves, walkthrough at the end. Fast: just do it |
| Artifacts | Files the agents write, edit, move or recycle, newest first; click to @mention |
| Editor file tree | **Explorer** pane: expand folders, click a file to @mention it, "Go to" box takes a path or a fuzzy folder name (Phile's teleport) |
| Search | **Search** pane and `/find`: fuzzy names (`inv24` finds `invoice_2024.pdf`), `--content` searches inside files; "Ask Claude to organize these" |
| File tools for the agent | `mcp__phile__search, tree, list, info, move, copy, trash, rename, mkdir, undo, history, places, teleport` |

Commands: `/ag` (all panes), `/agents`, `/files [folder]`, `/find <query> [--content]`, `/mode planning|fast`, `/undo-files`, `/phile` (status and setup help).

## Safety

Nothing is deleted permanently: removal goes to the Recycle Bin. Moves and copies never overwrite unless asked (`collision: overwrite`). Home, Desktop, Documents, Downloads, drive roots and system folders cannot be moved or recycled. Every change is journaled in `%APPDATA%\app.phile.explorer\agent-journal.jsonl`; `/undo-files` reverses the last batch. Claude Code still asks before each file-changing tool unless you allow it.

## Same tools in other agent apps

`phile-agent mcp` is a standard MCP server. The installer writes `%LOCALAPPDATA%\Phile\mcp.json`; paste it into Antigravity, Cursor or Claude Desktop.

## How it holds up to change

- Tool names, descriptions and schemas come from `phile-agent tools` at startup, so new Rust tools show up with no mod change.
- The model-facing rules live in one prompt section, not in the model: switching models keeps them.
- The panes degrade by surface (no text boxes on mobile) and the tests run them on terminal, desktop, VS Code and mobile.
- If the mod API changes, the MCP server keeps working on its own.

## Develop

```
cargo test -p phile-agent -p phile-fs
claude plugin validate claude-mod/phile
claude plugin test claude-mod/phile
claude --plugin-dir claude-mod/phile     # live reload while editing
```
