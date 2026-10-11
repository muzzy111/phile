import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as const

test('band toggles planning and fast on every surface that takes input', async ($, on) => {
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'phile', surface, ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /Planning|Fast/ } as never)).toBeDefined()
    const before = (await ui.find({ type: 'Text', text: /Planning|Fast/ } as never)) as { text: string }
    await ui.press({ key: 'mode' } as never)
    const after = (await ui.find({ type: 'Text', text: /Planning|Fast/ } as never)) as { text: string }
    expect(after.text).not.toBe(before.text)
    await ui.press({ key: 'mode' } as never)
    await ui.unmount()
  }
})

test('band can be hidden', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const ui = await $.ui.mount({ plugin: 'phile', surface: 'terminal', ...BAND } as never)
  await ui.press({ key: 'hide' } as never)
  expect(await ui.find({ type: 'Text', text: /◆ Phile/ } as never)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine band/ } as never)).toBeDefined()
  await ui.unmount()
})

test('phile tools refuse with setup help when the backend is missing', async ($, on) => {
  mock.clock(on)
  const r = (await $.tool.call({ tool: 'mcp__phile__search', query: 'x' } as never)) as { deny?: string }
  expect(r.deny ?? '').toContain('install-claude-mod')
})

test('phile tools run through phile-agent with arguments on stdin', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  const seen: string[][] = []
  on('process.run', ((_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    seen.push(e.argv)
    if (e.argv[1] === 'version') return { value: { exitCode: 0, stdout: '{"version":"0.1.0"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[1] === 'tools') return { value: { exitCode: 0, stdout: '{"tools":[]}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const args = JSON.parse(e.init?.stdin ?? '{}')
    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { hits: [], echo: args.query } }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }) as never)
  on('fs.stat', (() => ({ deny: 'missing' })) as never)
  on('fs.list', (() => ({ value: [] })) as never)
  await $.command.run({ command: 'phile', args: '' } as never)
  const r = (await $.tool.call({ tool: 'mcp__phile__search', query: 'inv24' } as never)) as { result?: string; deny?: string }
  expect(r.deny).toBeUndefined()
  expect(JSON.parse(r.result ?? '{}').echo).toBe('inv24')
  expect(seen.some(a => a[1] === 'call' && a[2] === 'phile_search' && a[3] === '-')).toBe(true)
})

test('search pane finds files and renders on terminal and desktop', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', ((_$: unknown, e: { argv: string[] }) => {
    if (e.argv[1] === 'version') return ok('{"version":"0.1.0"}')
    const hit = { entry: { name: 'invoice_2024.pdf', path: '/home/u/docs/invoice_2024.pdf', kind: 'file' }, score: 9 }
    return ok(JSON.stringify({ ok: true, result: { hits: [hit], scanned: 3, truncated: false } }))
  }) as never)
  on('fs.stat', (() => ({ deny: 'missing' })) as never)
  await $.command.run({ command: 'phile', args: '' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'phile', surface, component: 'Pane', requestId: 'phile-search', props: { title: 'Search', isFocused: true, bodyColumns: 60 } } as never)
    await (ui as any).input({ key: 'q', text: 'inv24' })
    expect(await ui.find({ text: /invoice_2024\.pdf/ } as never)).toBeDefined()
    await ui.unmount()
  }
})

test('agent manager and explorer panes draw on every surface', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  on('fs.list', (() => ({ value: [{ name: 'src', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }, { name: 'a.md', kind: 'file', size: 3, mtimeMs: 0, isLink: false }] })) as never)
  on('process.run', (() => ({ value: { exitCode: 0, stdout: '{"ok":true,"version":"0.1.0","result":{"hits":[{"path":"/home/u/proj"}]}}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })) as never)
  on('ui.open', (() => ({ value: { isPlaced: true } })) as never)
  on('fs.stat', (() => ({ deny: 'missing' })) as never)
  await $.command.run({ command: 'phile', args: '' } as never)
  await $.command.run({ command: 'files', args: 'proj' } as never)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const props = { title: 'x', isFocused: true, bodyColumns: 60 }
    const files = await $.ui.mount({ plugin: 'phile', surface, component: 'Pane', requestId: 'phile-explorer', props } as never)
    expect(await files.find({ text: /a\.md/ } as never)).toBeDefined()
    await files.unmount()
    const agents = await $.ui.mount({ plugin: 'phile', surface, component: 'Pane', requestId: 'phile-agents', props } as never)
    expect(await agents.find({ text: /Agents/ } as never)).toBeDefined()
    await agents.unmount()
  }
})
