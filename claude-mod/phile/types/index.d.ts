export type PhileMode = 'planning' | 'fast'

export type PhileAgentStatus = 'running' | 'waiting' | 'idle' | 'done' | 'failed'

export type PhileAgentRow = {
  id: string
  label: string
  type: string
  status: PhileAgentStatus
  tool: string
  calls: number
  startedAt: number
  endedAt: number
}

export type PhileArtifact = { path: string; action: string; at: number }

export type PhileEntry = { name: string; path: string; isDir: boolean; size: number }

export type PhileExplorer = {
  root: string
  expanded: string[]
  children: Record<string, PhileEntry[]>
  error: string
}

export type PhileHit = { path: string; name: string; isDir: boolean; line: number; snippet: string }

export type PhileSearch = {
  query: string
  content: boolean
  busy: boolean
  hits: PhileHit[]
  scanned: number
  error: string
}

export type PhileBackend = { bin: string; version: string; note: string }

declare module 'claude-code' {
  interface PluginState {
    phile: {
      backend: PhileBackend
      mode: PhileMode
      agents: PhileAgentRow[]
      artifacts: PhileArtifact[]
      explorer: PhileExplorer
      search: PhileSearch
      bandHidden: boolean
    }
  }
}
