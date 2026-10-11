// Phile workspace: turns Claude Code into an Antigravity-style agent IDE.
//
//   Agent Manager pane  agents and subagents live, artifacts, planning/fast mode, undo
//   Explorer pane       folder tree; click a file to @mention it, click a folder to open it
//   Search pane         fuzzy name + content search through Phile's Rust core
//   Band                one-line mission control above the prompt
//   Tools               mcp__phile__* (search, move, copy, trash, rename, undo...) from phile-agent

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  PhileAgentRow,
  PhileArtifact,
  PhileBackend,
  PhileEntry,
  PhileExplorer,
  PhileHit,
  PhileMode,
  PhileSearch,
} from '../types'
import { baseName, join, mention, parent } from './bridge'
import type { CallErr, CallOk } from './bridge'

type $ = EngineInterface

const P = 'phile'
const AGENTS = 'phile-agents'
const FILES = 'phile-explorer'
const FIND = 'phile-search'
const TOOL_PREFIX = 'mcp__phile__'

const backend = atom({ plugin: 'phile', key: 'backend' } as const, { bin: '', version: '', note: 'starting' } as PhileBackend)
const mode = atom({ plugin: 'phile', key: 'mode' } as const, 'planning' as PhileMode)
const agents = atom({ plugin: 'phile', key: 'agents' } as const, [] as PhileAgentRow[])
const artifacts = atom({ plugin: 'phile', key: 'artifacts' } as const, [] as PhileArtifact[])
const explorer = atom({ plugin: 'phile', key: 'explorer' } as const, { root: '', expanded: [], children: {}, error: '' } as PhileExplorer)
const search = atom({ plugin: 'phile', key: 'search' } as const, {
  query: '',
  content: false,
  busy: false,
  hits: [],
  scanned: 0,
  error: '',
} as PhileSearch)
const bandHidden = atom({ plugin: 'phile', key: 'bandHidden' } as const, false)

const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SECRET_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'cwd'])

// ---- phile-agent bridge: the binary's own `tools` table is the source of truth for
// tool names, descriptions and schemas, so new Rust tools appear without touching the mod.

async function exists($: $, p: string) {
  try {
    await $.fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** Every place the installer or a developer could have put the binary, best first. */
async function candidates($: $, configured: string): Promise<string[]> {
  const out: string[] = []
  if (configured) out.push(configured)
  const fromEnv = await $.env.get('PHILE_AGENT')
  if (fromEnv) out.push(fromEnv)
  const local = await $.env.get('LOCALAPPDATA')
  const profile = await $.env.get('USERPROFILE')
  const home = await $.env.get('HOME')
  if (local) {
    out.push(`${local}\\Phile\\bin\\phile-agent.exe`, `${local}\\Phile\\phile-agent.exe`, `${local}\\Programs\\Phile\\phile-agent.exe`)
  }
  if (profile) out.push(`${profile}\\.cargo\\bin\\phile-agent.exe`)
  if (home) out.push(`${home}/.local/bin/phile-agent`, `${home}/.cargo/bin/phile-agent`)
  return out
}

async function locate($: $, configured: string): Promise<PhileBackend> {
  const tried: string[] = []
  for (const path of await candidates($, configured)) {
    tried.push(path)
    if (!(await exists($, path))) continue
    const v = await version($, path)
    if (v) return { bin: path, version: v, note: '' }
  }
  for (const bare of ['phile-agent', 'phile-agent.exe']) {
    const v = await version($, bare)
    if (v) return { bin: bare, version: v, note: '' }
  }
  return {
    bin: '',
    version: '',
    note: `phile-agent not found. Run install-claude-mod.cmd in the Phile folder, or set the plugin's agentPath option. Looked in: ${tried.join(', ')}`,
  }
}

async function version($: $, bin: string) {
  try {
    const r = await $.process.run([bin, 'version'], { timeoutMs: 5000 })
    if (r.exitCode !== 0) return ''
    return String(JSON.parse(r.stdout).version ?? '')
  } catch {
    return ''
  }
}

async function listTools($: $, bin: string): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]> {
  const r = await $.process.run([bin, 'tools'], { timeoutMs: 10000 })
  if (r.exitCode !== 0) throw new Error(r.stderr || 'phile-agent tools failed')
  return JSON.parse(r.stdout).tools
}

/** Run one Phile tool. Arguments travel on stdin, so no shell quoting is involved on any OS. */
async function call($: $, bin: string, tool: string, args: Record<string, unknown>, cwd: string): Promise<CallOk | CallErr> {
  if (!bin) return { ok: false, error: 'Phile backend is not installed (run install-claude-mod.cmd).' }
  try {
    const r = await $.process.run([bin, 'call', tool, '-'], {
      ...(cwd ? { cwd } : {}),
      stdin: JSON.stringify(cwd ? { cwd, ...args } : args),
      timeoutMs: 10 * 60 * 1000,
    })
    const text = r.stdout.trim().split('\n').pop() ?? ''
    if (!text) return { ok: false, error: r.stderr.trim() || `phile-agent exited ${r.exitCode}` }
    return JSON.parse(text)
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

let cwd = ''
let configuredPath = ''

const now = ($: $) => $.clock.now()

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

const glyph: Record<PhileAgentRow['status'], string> = {
  running: '●',
  waiting: '◐',
  idle: '○',
  done: '✓',
  failed: '✗',
}

async function upsertAgent($: $, id: string, patch: Partial<PhileAgentRow>) {
  const t = await now($)
  await update($, agents, list => {
    const i = list.findIndex(a => a.id === id)
    if (i < 0) {
      const row: PhileAgentRow = { id, label: id, type: 'agent', status: 'running', tool: '', calls: 0, startedAt: t, endedAt: 0, ...patch }
      return [...list, row].slice(-40)
    }
    return list.map(a => (a.id === id ? { ...a, ...patch } : a))
  })
}

async function addArtifact($: $, path: string, action: string) {
  const at = await now($)
  await update($, artifacts, list => [{ path, action, at }, ...list.filter(a => a.path !== path)].slice(0, 60))
}

async function loadDir($: $, dir: string): Promise<PhileEntry[]> {
  const entries = await $.fs.list(dir)
  return entries
    .map(e => ({ name: e.name, path: join(dir, e.name), isDir: e.kind === 'dir', size: e.size }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

async function openRoot($: $, root: string) {
  try {
    const kids = await loadDir($, root)
    await update($, explorer, () => ({ root, expanded: [], children: { [root]: kids }, error: '' }))
  } catch (err) {
    await update($, explorer, x => ({ ...x, error: `Cannot open ${root}: ${String(err)}` }))
  }
}

async function toggleDir($: $, dir: string) {
  const x = await read($, explorer)
  if (x.expanded.includes(dir)) {
    await update($, explorer, v => ({ ...v, expanded: v.expanded.filter(d => d !== dir) }))
    return
  }
  try {
    const kids = await loadDir($, dir)
    await update($, explorer, v => ({ ...v, expanded: [...v.expanded, dir], children: { ...v.children, [dir]: kids }, error: '' }))
  } catch (err) {
    await update($, explorer, v => ({ ...v, error: `Cannot open ${dir}: ${String(err)}` }))
  }
}

async function refreshExplorer($: $) {
  const x = await read($, explorer)
  if (!x.root) return
  const children: Record<string, PhileEntry[]> = {}
  for (const d of [x.root, ...x.expanded]) {
    try {
      children[d] = await loadDir($, d)
    } catch {
      /* folder moved away */
    }
  }
  await update($, explorer, v => ({ ...v, children, expanded: v.expanded.filter(d => children[d]) }))
}

/** Go-to box: a path opens directly, anything else teleports by Phile's frecency, then fuzzy search. */
async function goTo($: $, text: string) {
  const q = text.trim()
  if (!q) return
  const x = await read($, explorer)
  const looksLikePath = /^([a-zA-Z]:[\\/]|[\\/]|~|\.)/.test(q)
  if (looksLikePath) {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const abs = q.startsWith('~') ? home + q.slice(1) : q.startsWith('.') ? join(x.root || cwd, q) : q
    return openRoot($, abs)
  }
  const { bin } = await read($, backend)
  const tp = await call($, bin, 'phile_teleport', { query: q, limit: 1 }, cwd)
  const hit = tp.ok ? tp.result.hits?.[0]?.path : undefined
  if (hit) return openRoot($, hit)
  const sr = await call($, bin, 'phile_search', { root: x.root || cwd, query: q, kind: 'dir', limit: 1 }, cwd)
  const dir = sr.ok ? sr.result.hits?.[0]?.entry?.path : undefined
  if (dir) return openRoot($, dir)
  $.ui.toast(`No folder matches "${q}"`)
}

async function runSearch($: $, query: string) {
  const q = query.trim()
  if (!q) return
  const s = await read($, search)
  await update($, search, v => ({ ...v, query: q, busy: true, error: '' }))
  const { bin } = await read($, backend)
  const root = (await read($, explorer)).root || cwd
  const r = await call($, bin, 'phile_search', { root, query: q, content: s.content, limit: 80 }, cwd)
  if (!r.ok) {
    await update($, search, v => ({ ...v, busy: false, hits: [], error: r.error }))
    return
  }
  const hits: PhileHit[] = (r.result.hits ?? []).map((hit: any) => ({
    path: hit.entry.path,
    name: hit.entry.name,
    isDir: hit.entry.kind === 'dir',
    line: hit.line ?? 0,
    snippet: hit.snippet ?? '',
  }))
  await update($, search, v => ({ ...v, busy: false, hits, scanned: r.result.scanned ?? 0, error: r.result.truncated ? 'Stopped early: narrow the folder or query.' : '' }))
}

const insert = ($: $, text: string) => $.prompt.fill({ text: text + ' ', mode: 'insert' })

const openAll = async ($: $) => {
  await $.ui.open({ id: AGENTS, title: 'Agent Manager' })
  await $.ui.open({ id: FILES, title: 'Explorer' })
  await $.ui.open({ id: FIND, title: 'Search' })
}

const PLANNING = `Planning mode (Phile workspace, Antigravity style). For any task beyond a one-line answer:
1. Start with an Implementation Plan: goal, numbered steps, files and folders it touches, risks. Track the steps with your todo list.
2. For file moves, renames or clean-ups, call the phile tools with dryRun:true first and show the plan; wait for a yes before running them for real when more than 10 items or anything outside the working folder is involved.
3. Finish with a short Walkthrough: what changed, how it was checked, how to undo (phile undo for file operations).`

const FAST = `Fast mode (Phile workspace). Act directly with minimal planning; still use phile tools for file operations and keep answers short.`

function workspaceSection(m: PhileMode, b: PhileBackend) {
  const tools = b.bin
    ? `File operations: prefer the ${TOOL_PREFIX}* tools (search, tree, list, move, copy, trash, rename, mkdir, undo, history, places) over shell commands. They are Phile's Rust core: fuzzy and content search, journaled moves, Recycle Bin instead of deletion, one-step undo. Never delete permanently.`
    : `The Phile backend is not installed, so phile tools are unavailable; tell the person to run install-claude-mod.cmd in their Phile folder if they ask for file operations.`
  return `${tools}\n\n${m === 'planning' ? PLANNING : FAST}`
}

export const register: Register = (on, options) => {
  configuredPath = typeof options.agentPath === 'string' ? options.agentPath.trim() : ''

  on('session.start', async ($, e, next) => {
    cwd = e.cwd || (await $.session.cwd())
    const stored = await $.store.get('phile.mode')
    if (stored === 'planning' || stored === 'fast') await update($, mode, () => stored)

    const b = await locate($, configuredPath)
    await update($, backend, () => b)
    if (b.bin) {
      try {
        for (const t of await listTools($, b.bin)) {
          const short = t.name.replace(/^phile_/, '')
          await $.tool.register({
            name: short,
            description: t.description,
            inputSchema: t.inputSchema,
            isDeferred: !['search', 'tree', 'move', 'list'].includes(short),
          })
        }
      } catch (err) {
        await update($, backend, v => ({ ...v, note: `Tools failed to load: ${String(err)}` }))
      }
    } else {
      $.ui.toast('Phile backend not found: run install-claude-mod.cmd (see /phile)')
    }

    for (const c of [
      { name: 'ag', description: 'Open the Phile workspace: Agent Manager, Explorer and Search' },
      { name: 'agents', description: 'Open the Agent Manager pane' },
      { name: 'files', description: 'Open the Explorer pane', argumentHint: '[folder]' },
      { name: 'find', description: 'Search files by name (add --content to search inside)', argumentHint: '<query> [--content]' },
      { name: 'mode', description: 'Switch between planning and fast mode', argumentHint: 'planning|fast' },
      { name: 'undo-files', description: 'Undo the last Phile file operation' },
      { name: 'phile', description: 'Phile workspace status and setup help' },
    ]) {
      await $.command.register(c)
    }

    await openRoot($, cwd)
    await upsertAgent($, 'main', { label: 'Main agent', type: 'main', status: 'idle', startedAt: await now($) })

    // Keep subagent status in step with the engine.
    $.clock.every(2000, async () => {
      const live = await $.agent.list()
      if (live.length === 0) return
      const map: Record<string, PhileAgentRow['status']> = {
        pending: 'waiting',
        running: 'running',
        waiting: 'waiting',
        idle: 'idle',
        completed: 'done',
        failed: 'failed',
        killed: 'failed',
      }
      const rows = await read($, agents)
      for (const a of live) {
        const status = map[a.status] ?? 'running'
        const row = rows.find(r => r.id === a.id)
        if (!row) await upsertAgent($, a.id, { label: a.name || a.description, type: a.type, status })
        else if (row.status !== status) await upsertAgent($, a.id, { status, endedAt: status === 'done' || status === 'failed' ? await now($) : 0 })
      }
    })

    if (e.isInteractive && e.surface) void $.ui.open({ id: AGENTS, title: 'Agent Manager' })
    return next(e)
  })

  // ---- system prompt: the workspace's rules and the current mode ----
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const text = workspaceSection(await read($, mode), await read($, backend))
    return { sections: [...r.sections, { id: 'phile:workspace', text, scope: 'session' as const }] }
  })

  // ---- agents ----
  on('turn.start', async ($, e, next) => {
    await upsertAgent($, 'main', { status: 'running', label: e.text.slice(0, 60) || 'Main agent', tool: '', endedAt: 0 })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = (e as { agentId?: string }).agentId
    await upsertAgent($, id ?? 'main', { status: id ? 'done' : 'idle', tool: '', endedAt: await now($) })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = r.agentId ?? e.tool_use_id
    await upsertAgent($, id, { label: e.name || e.description, type: e.subagentType || 'agent', status: 'running', startedAt: await now($) })
    return r
  }).catch(($, e, next) => next(e))

  // ---- tool calls: serve phile tools, track agent activity and artifacts ----
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    const who = (e as { agentId?: string }).agentId ?? 'main'
    const row = (await read($, agents)).find(a => a.id === who)
    await upsertAgent($, who, { tool: name.replace(TOOL_PREFIX, 'phile '), calls: (row?.calls ?? 0) + 1, status: 'running' })

    if (name.startsWith(TOOL_PREFIX)) {
      const args: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(e)) if (!SECRET_KEYS.has(k)) args[k] = v
      const { bin } = await read($, backend)
      const r = await call($, bin, 'phile_' + name.slice(TOOL_PREFIX.length), args, cwd)
      if (!r.ok) return { deny: r.error }
      const res = r.result
      if (!res.dryRun) {
        for (const step of res.plan ?? []) if (step.to) await addArtifact($, String(step.to), res.op)
        if (res.op === 'rename') await addArtifact($, String(res.to), 'renamed')
        if (res.op === 'trash') for (const p of res.recycled ?? []) await addArtifact($, String(p), 'recycled')
        if (['move', 'copy', 'rename', 'trash', 'mkdir'].includes(res.op)) await refreshExplorer($)
      }
      return { result: JSON.stringify(res) } as never
    }

    const ran = await next(e)
    if (WRITERS.has(name) && ran.deny === undefined && !ran.isError) {
      const path = (e as { file_path?: string; notebook_path?: string }).file_path ?? (e as { notebook_path?: string }).notebook_path
      if (path) await addArtifact($, path, name === 'Write' ? 'written' : 'edited')
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : String(e.tool).startsWith(TOOL_PREFIX) ? { deny: 'Phile tool failed' } : next(e)))

  // ---- commands ----
  on('command.run', { command: 'ag' }, async $ => {
    await openAll($)
    return { text: 'Phile workspace open: Agent Manager, Explorer, Search.' }
  })
  on('command.run', { command: 'agents' }, async $ => {
    await $.ui.open({ id: AGENTS, title: 'Agent Manager' })
    return { text: 'Agent Manager open.' }
  })
  on('command.run', { command: 'files' }, async ($, e) => {
    if (e.args.trim()) await goTo($, e.args)
    await $.ui.open({ id: FILES, title: 'Explorer' })
    return { text: `Explorer: ${(await read($, explorer)).root}` }
  })
  on('command.run', { command: 'find' }, async ($, e) => {
    const content = /(^|\s)--content(\s|$)/.test(e.args)
    const q = e.args.replace(/(^|\s)--content(\s|$)/, ' ').trim()
    await update($, search, v => ({ ...v, content }))
    await $.ui.open({ id: FIND, title: 'Search' })
    if (q) await runSearch($, q)
    const s = await read($, search)
    return { text: q ? `${s.hits.length} matches for "${q}"` : 'Search open.' }
  })
  on('command.run', { command: 'mode' }, async ($, e) => {
    const cur = await read($, mode)
    const want = e.args.trim().toLowerCase()
    const m: PhileMode = want === 'planning' || want === 'fast' ? want : cur === 'planning' ? 'fast' : 'planning'
    await update($, mode, () => m)
    await $.store.set('phile.mode', m)
    return { text: `Mode: ${m}.` }
  })
  on('command.run', { command: 'undo-files' }, async $ => {
    const { bin } = await read($, backend)
    const r = await call($, bin, 'phile_undo', {}, cwd)
    if (!r.ok) return { text: `Undo failed: ${r.error}` }
    await refreshExplorer($)
    const errs = (r.result.errors ?? []) as string[]
    return { text: r.result.note ?? `Undid ${r.result.undone} change(s).${errs.length ? ' ' + errs.join('; ') : ''}` }
  })
  on('command.run', { command: 'phile' }, async $ => {
    const b = await locate($, configuredPath)
    await update($, backend, () => b)
    const m = await read($, mode)
    return {
      text: b.bin
        ? `Phile backend ${b.version} at ${b.bin}. Mode: ${m}. /ag opens the workspace.`
        : `${b.note}\nRestart Claude Code after installing.`,
    }
  })

  // ---- band above the prompt ----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, bandHidden))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, mode)
    const list = await read($, agents)
    const running = list.filter(a => a.status === 'running' || a.status === 'waiting').length
    const arts = (await read($, artifacts)).length
    const b = await read($, backend)
    return (
      <Box flexDirection="row" gap={1}>
        <Text bold color="magenta">◆ Phile</Text>
        <Button key="mode" plain onPress={async () => { const n = m === 'planning' ? 'fast' : 'planning'; await update($, mode, () => n); await $.store.set('phile.mode', n) }}>
          <Text color={m === 'planning' ? 'cyan' : 'yellow'}>{m === 'planning' ? 'Planning' : 'Fast'}</Text>
        </Button>
        <Text dimColor>· {running} running · {arts} artifacts{b.bin ? '' : ' · backend missing'}</Text>
        <Button key="agents" label="Agents" onPress={() => void $.ui.open({ id: AGENTS, title: 'Agent Manager' })} />
        <Button key="files" label="Files" onPress={() => void $.ui.open({ id: FILES, title: 'Explorer' })} />
        <Button key="find" label="Search" onPress={() => void $.ui.open({ id: FIND, title: 'Search' })} />
        <Button key="hide" plain dimColor label="×" onPress={() => update($, bandHidden, () => true)} />
      </Box>
    )
  })

  // ---- Agent Manager ----
  on('ui.render', { component: 'Pane', requestId: AGENTS }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e as never) as any
    const t = await now($)
    const m = await read($, mode)
    const list = await read($, agents)
    const arts = await read($, artifacts)
    const b = await read($, backend)
    const room = Math.max(6, (e.viewport?.rows ?? 30) - 14)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>Mode</Text>
          <Button key="m-plan" label="Planning" variant={m === 'planning' ? 'primary' : 'secondary'} onPress={async () => { await update($, mode, () => 'planning' as PhileMode); await $.store.set('phile.mode', 'planning') }} />
          <Button key="m-fast" label="Fast" variant={m === 'fast' ? 'primary' : 'secondary'} onPress={async () => { await update($, mode, () => 'fast' as PhileMode); await $.store.set('phile.mode', 'fast') }} />
        </Box>
        {Input && (
          <Input key="task" placeholder="Start a new task for the agent…" submitLabel="Run" onSubmit={(v: string) => { if (v.trim()) void $.prompt.submit({ text: v.trim() }) }} />
        )}
        <Box flexDirection="column">
          <Text bold>Agents</Text>
          {list.slice(-Math.ceil(room / 2)).map(a => (
            <Text key={'a-' + a.id} dimColor={a.status === 'done' || a.status === 'idle'}>
              <Text color={a.status === 'running' ? 'green' : a.status === 'failed' ? 'red' : undefined}>{glyph[a.status]}</Text> {a.label.slice(0, 48)}
              <Text dimColor> {a.type} · {a.calls} calls{a.tool ? ` · ${a.tool}` : ''} · {ago((a.endedAt || t) - a.startedAt)}</Text>
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Artifacts</Text>
          {arts.length === 0 && <Text dimColor>Files the agents write, edit or move show up here.</Text>}
          {arts.slice(0, Math.floor(room / 2)).map(a => (
            <Button key={'f-' + a.path} plain onPress={() => void insert($, mention(a.path, cwd))}>
              {baseName(a.path)} <Text dimColor>{a.action} {ago(t - a.at)} ago</Text>
            </Button>
          ))}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="undo" label="Undo last file change" onPress={async () => {
            const r = await call($, b.bin, 'phile_undo', {}, cwd)
            $.ui.toast(r.ok ? (r.result.note ?? `Undid ${r.result.undone} change(s)`) : r.error)
            await refreshExplorer($)
          }} />
          <Button key="clear" label="Clear finished" onPress={() => update($, agents, l => l.filter(a => a.status !== 'done' && a.status !== 'failed'))} />
        </Box>
        {!b.bin && <Text color="yellow">{b.note}</Text>}
      </Box>
    )
  })

  // ---- Explorer ----
  on('ui.render', { component: 'Pane', requestId: FILES }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e as never) as any
    const x = await read($, explorer)
    const width = Math.max(20, (e.props as { bodyColumns?: number }).bodyColumns ?? 40)
    const room = Math.max(5, (e.viewport?.rows ?? 30) - 8)
    const rows: { entry: PhileEntry; depth: number }[] = []
    const walk = (dir: string, depth: number) => {
      for (const entry of x.children[dir] ?? []) {
        if (rows.length >= room) return
        rows.push({ entry, depth })
        if (entry.isDir && x.expanded.includes(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk(x.root, 0)
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-start">{x.root}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="up" label="Up" onPress={() => openRoot($, parent(x.root))} />
          <Button key="home" label="Project" onPress={() => openRoot($, cwd)} />
          <Button key="refresh" label="Refresh" onPress={() => refreshExplorer($)} />
          <Button key="here" label="Use here" onPress={() => void insert($, mention(x.root, cwd))} />
        </Box>
        {Input && <Input key="goto" placeholder="Go to folder (path or fuzzy name)…" onSubmit={(v: string) => goTo($, v)} />}
        {x.error && <Text color="red">{x.error}</Text>}
        {rows.map(({ entry, depth }) => (
          <Button
            key={'e-' + entry.path}
            plain
            onPress={() => (entry.isDir ? toggleDir($, entry.path) : insert($, mention(entry.path, cwd)))}
          >
            {'  '.repeat(depth)}
            {entry.isDir ? (x.expanded.includes(entry.path) ? '▾ ' : '▸ ') : '  '}
            {entry.name.slice(0, width - depth * 2 - 4)}
            {entry.isDir ? '/' : ''}
          </Button>
        ))}
        {rows.length >= room && <Text dimColor>… more below; collapse folders or use Search</Text>}
      </Box>
    )
  })

  // ---- Search ----
  on('ui.render', { component: 'Pane', requestId: FIND }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e as never) as any
    const s = await read($, search)
    const root = (await read($, explorer)).root || cwd
    const room = Math.max(4, (e.viewport?.rows ?? 30) - 9)
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-start">in {root}</Text>
        {Input && <Input key="q" placeholder="Fuzzy name, e.g. inv24 → invoice_2024.pdf" value={s.query} submitLabel="Find" onSubmit={(v: string) => runSearch($, v)} />}
        <Box flexDirection="row" gap={1}>
          <Button key="content" label={s.content ? 'Names + contents' : 'Names only'} onPress={() => update($, search, v => ({ ...v, content: !v.content }))} />
          {s.hits.length > 0 && (
            <Button key="ask" label="Ask Claude to organize these" onPress={() => void $.prompt.fill({
              text: `Using the phile tools, organize these ${s.hits.length} items (dry run first):\n${s.hits.map(hit => mention(hit.path, cwd)).join('\n')}\n`,
              mode: 'replace',
            })} />
          )}
        </Box>
        {s.busy && <Text color="cyan">Searching…</Text>}
        {s.error && <Text color="yellow">{s.error}</Text>}
        {!s.busy && s.query && s.hits.length === 0 && !s.error && <Text dimColor>No matches ({s.scanned} items scanned).</Text>}
        {s.hits.slice(0, room).map(hit => (
          <Button key={'h-' + hit.path} plain onPress={() => void insert($, mention(hit.path, cwd))}>
            {hit.isDir ? '▸ ' : '  '}{hit.name}
            <Text dimColor> {hit.line ? `:${hit.line} ${hit.snippet.slice(0, 60)}` : parent(hit.path).slice(-50)}</Text>
          </Button>
        ))}
      </Box>
    )
  })
}
