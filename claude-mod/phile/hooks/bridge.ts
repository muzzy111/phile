// Path helpers shared by the panes. Pure functions: no engine access here.

export type CallOk = { ok: true; result: any }
export type CallErr = { ok: false; error: string }

export const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')

export const sep = (p: string) => (p.includes('\\') || isWindowsPath(p) ? '\\' : '/')

export const join = (dir: string, name: string) => {
  const s = sep(dir)
  return dir.endsWith(s) ? dir + name : dir + s + name
}

export const parent = (p: string) => {
  const s = sep(p)
  const trimmed = p.length > 1 && p.endsWith(s) && !/^[a-zA-Z]:\\$/.test(p) ? p.slice(0, -1) : p
  const i = trimmed.lastIndexOf(s)
  if (i < 0) return trimmed
  if (i === 0) return s
  const up = trimmed.slice(0, i)
  return /^[a-zA-Z]:$/.test(up) ? up + '\\' : up
}

export const baseName = (p: string) => {
  const s = sep(p)
  const parts = p.split(s).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** `@relative/path` when under cwd, else the absolute path, quoted if it has spaces. */
export const mention = (path: string, cwd: string) => {
  const s = sep(cwd)
  const root = cwd.endsWith(s) ? cwd : cwd + s
  const rel = path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length) : path
  return /\s/.test(rel) ? `@"${rel}"` : `@${rel}`
}

