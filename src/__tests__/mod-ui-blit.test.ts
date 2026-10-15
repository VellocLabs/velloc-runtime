/**
 * `$.ui.blit` (F-25): no desktop surface mounts a `Raster` or `Image`, so the call answers `{ deny }`. It is
 * admitted, its argument checked, raised as `ui.blit` (a hook may rewrite, answer or refuse, never move the address
 * or change the kind), and a hook on it loads.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { RAISED_EVENTS } from '../mods/modAdmission'
import { blitDenial, uiBlitArgsOf } from '../mods/modBlit'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(5)
  }
}

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

const IMAGE = { png: 'iVBORw0KGgo=' }

describe('the argument', () => {
  it('requestId, key, and exactly one of cells or source; columns / rows 1 to 255', () => {
    expect(uiBlitArgsOf({ requestId: 'p', key: 'k', cells: 'AAAA', columns: 2, rows: 2 })).toEqual({
      requestId: 'p',
      key: 'k',
      cells: 'AAAA',
      columns: 2,
      rows: 2,
    })
    expect(uiBlitArgsOf({ requestId: 'p', key: 'view', source: IMAGE })).toEqual({ requestId: 'p', key: 'view', source: IMAGE })
    expect(() => uiBlitArgsOf({ requestId: 'p', key: 'k' })).toThrow('exactly one of cells')
    expect(() => uiBlitArgsOf({ requestId: 'p', key: 'k', cells: 'A', source: IMAGE })).toThrow('exactly one of cells')
    expect(() => uiBlitArgsOf({ requestId: '', key: 'k', cells: 'A' })).toThrow('requestId')
    expect(() => uiBlitArgsOf({ requestId: 'p', cells: 'A' })).toThrow('key')
    expect(() => uiBlitArgsOf({ requestId: 'p', key: 'k', cells: 3 })).toThrow('cells must be a string')
    expect(() => uiBlitArgsOf({ requestId: 'p', key: 'k', source: 'x.png' })).toThrow('source must be')
    expect(() => uiBlitArgsOf({ requestId: 'p', key: 'k', cells: 'A', rows: 0 })).toThrow('rows must be')
    expect(() => uiBlitArgsOf({ requestId: 'p', key: 'k', cells: 'A', columns: 256 })).toThrow('columns must be')
  })

  it('ui.blit is an event a hook may take', () => {
    expect(RAISED_EVENTS).toContain('ui.blit')
  })
})

// ── through a real runtime ──

let uniq = 0
function world(modules: Record<string, string>) {
  const reports: string[] = []
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniq}`,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    session: { id: () => 's', cwd: () => '/work/project' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  return {
    runtime,
    reports,
    logs: (plugin: string) =>
      reports.filter(r => r.startsWith(`${plugin}: {`)).map(r => JSON.parse(r.slice(plugin.length + 2))),
  }
}

/** Logs what each call resolves to, or the error it rejects with. */
const caller = (calls: string) => `
  on('session.start', async ($, e, next) => {
    ${calls}
    return next(e)
  })
`
const log = (expression: string) => `
    try { await $.ui.log(JSON.stringify({ got: await ${expression} })) }
    catch (error) { await $.ui.log(JSON.stringify({ error: error.name + ': ' + error.message })) }
`

describe('$.ui.blit through the runtime', () => {
  it('admitted: a Raster or an Image blit answers { deny }, the desktop mounting neither', async () => {
    const { runtime, logs } = world({
      viewer: caller(
        log(`$.ui.blit({ requestId: 'browser', key: 'view', source: ${JSON.stringify(IMAGE)} })`) +
          log(`$.ui.blit({ requestId: 'browser', key: 'grid', cells: 'AAAA' })`) +
          log(`$.ui.blit({ requestId: 'browser', key: 'grid' })`),
      ),
    })
    await runtime.ready
    await until(() => logs('viewer').length === 3)
    expect(logs('viewer')).toEqual([
      { got: { deny: blitDenial('viewer', { requestId: 'browser', key: 'view', source: IMAGE }) } },
      { got: { deny: blitDenial('viewer', { requestId: 'browser', key: 'grid', cells: 'AAAA' }) } },
      { error: expect.stringContaining('TypeError: $.ui.blit') },
    ])
    expect(logs('viewer')[0].got.deny).toContain('draws no Image')
    expect(logs('viewer')[1].got.deny).toContain('draws no Raster')
  })

  it('raised as ui.blit: a hook sees the argument and the caller, may answer or refuse', async () => {
    const { runtime, logs } = world({
      watcher: `on('ui.blit', async ($, e, next) => {
        await $.ui.log(JSON.stringify({ saw: e }))
        if (e.key === 'refused') return { deny: 'not now' }
        if (e.key === 'answered') return { value: {} }
        return next(e)
      })`,
      viewer: caller(
        log(`$.ui.blit({ requestId: 'p', key: 'refused', cells: 'A' })`) +
          log(`$.ui.blit({ requestId: 'p', key: 'answered', cells: 'A' })`) +
          log(`$.ui.blit({ requestId: 'p', key: 'passed', cells: 'A' })`),
      ),
    })
    await runtime.ready
    await until(() => logs('viewer').length === 3)
    expect(logs('watcher')).toEqual([
      { saw: { requestId: 'p', key: 'refused', cells: 'A' } },
      { saw: { requestId: 'p', key: 'answered', cells: 'A' } },
      { saw: { requestId: 'p', key: 'passed', cells: 'A' } },
    ])
    expect(logs('viewer')).toEqual([
      { error: 'DeniedError: not now' },
      { got: {} },
      { got: { deny: expect.stringContaining('draws no Raster') } },
    ])
  })

  it('a hook may rewrite the cells, never the address or the kind', async () => {
    const { runtime, logs, reports } = world({
      rewriter: `on('ui.blit', async ($, e, next) => {
        if (e.key === 'move') return next({ ...e, key: 'elsewhere' })
        if (e.key === 'kind') return next({ requestId: e.requestId, key: e.key, source: { png: 'x' } })
        return next({ ...e, cells: 'BBBB' })
      })`,
      viewer: caller(
        log(`$.ui.blit({ requestId: 'p', key: 'fine', cells: 'AAAA' })`) +
          log(`$.ui.blit({ requestId: 'p', key: 'move', cells: 'A' })`) +
          log(`$.ui.blit({ requestId: 'p', key: 'kind', cells: 'A' })`),
      ),
    })
    await runtime.ready
    await until(() => logs('viewer').length === 3)
    const [fine, moved, kind] = logs('viewer')
    expect(fine).toEqual({ got: { deny: expect.stringContaining('draws no Raster') } })
    expect(JSON.stringify(moved)).toContain('requestId and key are pinned')
    expect(JSON.stringify(kind)).toContain('cannot change between cells and source')
    void reports
  })
})
