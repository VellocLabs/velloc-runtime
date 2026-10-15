/**
 * `$.ui.status`, `$.ui.toast`, `$.ui.notice` (F-25): a mod's
 * own lines, held per slot and published as events; a lost seat takes its
 * lines with it.
 *
 * Real module text, loaded by `ModWorkerHost` on a MessageChannel.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RAISED_EVENTS } from '../mods/modAdmission'
import { implementedNouns } from '../mods/modNouns'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  MOD_TOAST_DEFAULT_TIMEOUT_MS,
  MOD_TOAST_MAX_TIMEOUT_MS,
  MOD_UI_TEXT_MAX_CHARS,
  ModUiState,
  sanitizeModUiText,
  type ModUiEvent,
} from '../mods/modUi'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(5)
  }
}

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

type Worker = ModWorkerHandle & { crash(): void }

function world(modules: Record<string, string>) {
  const reports: string[] = []
  const events: ModUiEvent[] = []
  const workers: Record<string, Worker[]> = {}
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniqueLoad}`,
    openWorker: async (plugin): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      const worker: Worker = { port: channel.port1, closed, close: () => settle({ reason: 'closed' }), crash: () => settle({ reason: 'crashed' }) }
      ;(workers[plugin] ??= []).push(worker)
      return worker
    },
    session: { id: () => 'sess-ui', cwd: () => '/work/project' },
    report: line => reports.push(line),
    respawnBackoffMs: [10],
    onUiChanged: event => events.push(event),
  })
  runtimes.push(runtime)
  return { runtime, reports, events, workers }
}

const logging = (expr: string): string => `
  on('prompt.submit', async ($, e, next) => {
    try {
      await $.ui.log(JSON.stringify(await (${expr})))
    } catch (error) {
      await $.ui.log('ERR ' + error.name + ': ' + error.message)
    }
    return next(e)
  })
`

describe('the nouns are listed', () => {
  it('ui.status, ui.toast and ui.notice are implemented and raised', () => {
    for (const noun of ['ui.status', 'ui.toast', 'ui.notice']) {
      expect(implementedNouns(), noun).toContain(noun)
      expect(RAISED_EVENTS, noun).toContain(noun)
    }
  })
})

describe('ModUiState', () => {
  it('status is one line per plugin, replaced by the next call, cleared by undefined; a same text is no event', () => {
    const events: ModUiEvent[] = []
    const ui = new ModUiState(e => events.push(e))
    ui.setStatus('a', 'thinking')
    ui.setStatus('a', 'thinking')
    ui.setStatus('b', 'idle')
    ui.setStatus('a', 'done')
    expect(ui.snapshot()).toEqual({ status: [{ plugin: 'a', text: 'done' }, { plugin: 'b', text: 'idle' }], notices: [] })
    ui.setStatus('a', undefined)
    ui.setStatus('a', undefined)
    expect(ui.snapshot().status).toEqual([{ plugin: 'b', text: 'idle' }])
    expect(events).toHaveLength(4)
    expect(events.every(e => e.kind === 'state')).toBe(true)
  })

  it('a toast is a moment with a bounded stay; a notice is one line per call, its last writer\'s', () => {
    const events: ModUiEvent[] = []
    const ui = new ModUiState(e => events.push(e))
    ui.toast('a', 'hello')
    ui.toast('a', 'long', 10 * 60_000)
    ui.toast('a', 'bad', -5)
    expect(events.map(e => (e.kind === 'toast' ? e.toast : null))).toEqual([
      { plugin: 'a', text: 'hello', timeoutMs: MOD_TOAST_DEFAULT_TIMEOUT_MS },
      { plugin: 'a', text: 'long', timeoutMs: MOD_TOAST_MAX_TIMEOUT_MS },
      { plugin: 'a', text: 'bad', timeoutMs: MOD_TOAST_DEFAULT_TIMEOUT_MS },
    ])
    ui.setNotice('a', 'tc-1', 'checked by a')
    ui.setNotice('b', 'tc-1', 'checked by b')
    ui.setNotice('a', 'tc-1', undefined) // not a's line any more
    expect(ui.snapshot().notices).toEqual([{ toolUseId: 'tc-1', plugin: 'b', text: 'checked by b' }])
    ui.clearNotice('tc-1')
    expect(ui.snapshot().notices).toEqual([])
    ui.setStatus('a', 'x')
    ui.setNotice('a', 'tc-2', 'y')
    ui.setNotice('b', 'tc-3', 'z')
    ui.clearPlugin('a')
    expect(ui.snapshot()).toEqual({ status: [], notices: [{ toolUseId: 'tc-3', plugin: 'b', text: 'z' }] })
  })

  it('text is bounded and an unpaired surrogate half is drawn as U+FFFD', () => {
    expect(sanitizeModUiText('x'.repeat(MOD_UI_TEXT_MAX_CHARS + 5))).toHaveLength(MOD_UI_TEXT_MAX_CHARS)
    expect(sanitizeModUiText('a\ud83d')).toBe('a�')
    expect(sanitizeModUiText('\ude00b')).toBe('�b')
    expect(sanitizeModUiText('ok 😀')).toBe('ok 😀')
  })
})

describe('the nouns', () => {
  it('a mod pins its status, toasts, and writes a notice; the slot publishes each', async () => {
    const { runtime, events } = world({
      p: `on('session.start', async ($, e, next) => {
        $.ui.status('thinking...')
        $.ui.toast('turn took 3 s', { timeoutMs: 1000 })
        $.ui.notice('tc-9', 'checked by p')
        await $.ui.log('done')
        return next(e)
      })`,
    })
    await runtime.ready
    await until(() => events.filter(e => e.kind === 'toast').length >= 1 && events.length >= 4)
    // The load's own state event (the hooked sites) comes first; the
    // lines follow. Every state carries the panes and the hooked sites too.
    const lines = events.filter(e => e.kind !== 'state' || e.state.status.length > 0 || e.state.notices.length > 0)
    expect(lines).toEqual([
      { kind: 'state', state: { status: [{ plugin: 'p', text: 'thinking...' }], notices: [], panes: [], hooked: [] } },
      { kind: 'toast', toast: { plugin: 'p', text: 'turn took 3 s', timeoutMs: 1000 } },
      { kind: 'state', state: { status: [{ plugin: 'p', text: 'thinking...' }], notices: [{ toolUseId: 'tc-9', plugin: 'p', text: 'checked by p' }], panes: [], hooked: [] } },
    ])
    expect(runtime.ui.snapshot().status).toEqual([{ plugin: 'p', text: 'thinking...' }])
  })

  it('a wrong argument is a TypeError; undefined clears', async () => {
    const { runtime, reports } = world({
      p: logging(`(async () => {
        await $.ui.status('a')
        await $.ui.status(undefined)
        return [
          await $.ui.status(5).catch(e => e.name),
          await $.ui.toast(7).catch(e => e.name),
          await $.ui.toast('x', { timeoutMs: 'soon' }).catch(e => e.name),
          await $.ui.notice('', 'x').catch(e => e.name),
          await $.ui.notice('tc', 5).catch(e => e.name),
        ]
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: ["TypeError","TypeError","TypeError","TypeError","TypeError"]'])
    expect(runtime.ui.snapshot().status).toEqual([])
  })

  it('is an event: another mod may rewrite a toast, and the line stays the caller\'s', async () => {
    const { runtime, events } = world({
      brander: `on('ui.toast', ($, e, next) => next({ ...e, text: '[acme] ' + e.text }))`,
      p: `on('session.start', async ($, e, next) => { $.ui.toast('hi'); await $.ui.log('x'); return next(e) })`,
    })
    await runtime.ready
    await until(() => events.some(e => e.kind === 'toast'))
    expect(events.find(e => e.kind === 'toast')).toEqual({ kind: 'toast', toast: { plugin: 'p', text: '[acme] hi', timeoutMs: MOD_TOAST_DEFAULT_TIMEOUT_MS } })
  })

  it('a lost worker takes its lines with it; the restart may pin them again', async () => {
    const { runtime, workers, events } = world({
      p: `on('session.start', async ($, e, next) => { $.ui.status('up'); await $.ui.log('x'); return next(e) })`,
    })
    await runtime.ready
    await until(() => runtime.ui.snapshot().status.length === 1)
    workers.p![0]!.crash()
    await until(() => events.some(e => e.kind === 'state' && e.state.status.length === 0))
    await until(() => runtime.status()[0]?.generation === 2 && runtime.ui.snapshot().status.length === 1)
    runtime.dispose()
    expect(runtime.ui.snapshot()).toEqual({ status: [], notices: [] })
  })
})
