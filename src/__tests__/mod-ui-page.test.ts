/**
 * `$.ui.copy`, `$.ui.focus` and `$.ui.scroll` (F-25), the runtime's half: copy tries the host's clipboard, then
 * each page's (`isCopied` when any took it); focus a caller's site; scroll a site's window (clamped) or a
 * transcript row while answering the person. The page round trip (`ModPageBridge`): the first success settles,
 * nobody answering times out. The page's half is `mod-ui-page.render`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModRuntimeOptions, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModUiEvent } from '../mods/modUi'
import { RAISED_EVENTS } from '../mods/modAdmission'
import {
  ModPageBridge,
  copyEverywhere,
  uiCopyArgsOf,
  uiFocusArgsOf,
  uiScrollArgsOf,
  type ModPageAnswer,
  type ModPageRequest,
} from '../mods/modPage'
import { isModsPageAnswerPayload, isModsPageRequest } from '../browser/runtimeProtocol'

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

describe('the arguments', () => {
  it('copy: text a string, surface one of the four, desktop when left out', () => {
    expect(uiCopyArgsOf({ text: 'x' })).toEqual({ text: 'x', surface: 'desktop' })
    expect(uiCopyArgsOf({ text: '', surface: 'terminal' })).toEqual({ text: '', surface: 'terminal' })
    expect(() => uiCopyArgsOf({ text: 3 })).toThrow('text must be a string')
    expect(() => uiCopyArgsOf({ text: 'x', surface: 'phone' })).toThrow()
  })

  it('focus: requestId and key', () => {
    expect(uiFocusArgsOf({ requestId: 'band', key: 'go' })).toEqual({ requestId: 'band', key: 'go' })
    expect(() => uiFocusArgsOf({ requestId: 'band' })).toThrow()
  })

  it('scroll: to, in where start / end need it, block nearest by default', () => {
    expect(uiScrollArgsOf({ to: { key: 'k' } })).toEqual({ to: { key: 'k' }, block: 'nearest' })
    expect(uiScrollArgsOf({ to: 'end', in: 'log', block: 'end' })).toEqual({ to: 'end', in: 'log', block: 'end' })
    expect(() => uiScrollArgsOf({ to: 'start' })).toThrow('needs in')
    expect(() => uiScrollArgsOf({ to: 'middle', in: 'log' })).toThrow('to must be')
    expect(() => uiScrollArgsOf({ to: { key: 'k' }, block: 'top' })).toThrow('block must be one of')
  })

  it('the three are events a hook may take, and the wire guards hold the shapes', () => {
    for (const event of ['ui.copy', 'ui.focus', 'ui.scroll']) expect(RAISED_EVENTS).toContain(event)
    expect(isModsPageRequest({ requestId: 'p1', op: 'copy', text: 'x', hostCopied: false })).toBe(true)
    expect(isModsPageRequest({ requestId: 'p1', op: 'focus', plugin: 'a', component: 'Pane', site: 'x', key: 'k', holdsKeys: true })).toBe(true)
    expect(isModsPageRequest({ requestId: 'p1', op: 'scrollApply', component: 'Band', site: 'x', offset: 1, stickToEnd: false })).toBe(false)
    expect(isModsPageRequest({ requestId: 'p1', op: 'scrollRow', row: 'r', block: 'top' })).toBe(false)
    expect(isModsPageAnswerPayload({ sessionId: 's', requestId: 'p1', op: 'copy', isCopied: true })).toBe(true)
    expect(isModsPageAnswerPayload({ sessionId: 's', requestId: 'p1', op: 'focus', deny: 'x'.repeat(501) })).toBe(false)
    expect(
      isModsPageAnswerPayload({
        sessionId: 's',
        requestId: 'p1',
        op: 'scrollMeasure',
        measured: { component: 'Pane', site: 'log', current: 0, offset: 3, bodyRows: 4, contentRows: 9 },
      }),
    ).toBe(true)
    expect(isModsPageAnswerPayload({ sessionId: 's', requestId: 'p1', op: 'scrollMeasure', measured: { component: 'Pane' } })).toBe(false)
  })
})

describe('the round trip to the pages', () => {
  it('the first success settles it; a failure waits the grace for another page', async () => {
    const pushed: ModPageRequest[] = []
    const bridge = new ModPageBridge(request => pushed.push(request), 1_000, 50)
    const asked = bridge.ask({ op: 'copy', text: 'x', hostCopied: false })
    expect(pushed).toEqual([{ op: 'copy', text: 'x', hostCopied: false, requestId: 'p1' }])
    expect(bridge.answer({ requestId: 'p1', op: 'copy', isCopied: false })).toBe(true)
    expect(bridge.answer({ requestId: 'p1', op: 'copy', isCopied: true })).toBe(true)
    await expect(asked).resolves.toEqual({ requestId: 'p1', op: 'copy', isCopied: true })
    expect(bridge.answer({ requestId: 'p1', op: 'copy', isCopied: true })).toBe(false)

    const failed = bridge.ask({ op: 'focus', plugin: 'a', component: 'Pane', site: 's', key: 'k', holdsKeys: true })
    expect(bridge.answer({ requestId: 'p2', op: 'scrollRow' })).toBe(false)
    bridge.answer({ requestId: 'p2', op: 'focus', deny: 'not shown' })
    await expect(failed).resolves.toEqual({ requestId: 'p2', op: 'focus', deny: 'not shown' })
  })

  it('no page answering is the timeout; abandoning rejects; dispose settles what waits', async () => {
    const bridge = new ModPageBridge(() => {}, 30, 10)
    await expect(bridge.ask({ op: 'scrollRow', row: 'r', block: 'start' })).resolves.toBeNull()
    const abort = new AbortController()
    const abandoned = bridge.ask({ op: 'scrollRow', row: 'r', block: 'start' }, abort.signal)
    abort.abort()
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    const waiting = new ModPageBridge(() => {}, 10_000).ask({ op: 'scrollRow', row: 'r', block: 'start' })
    const other = new ModPageBridge(() => {}, 10_000)
    const pending = other.ask({ op: 'scrollRow', row: 'r', block: 'start' })
    other.dispose()
    await expect(pending).resolves.toBeNull()
    void waiting
  })
})

describe('every clipboard path', () => {
  const pagesAnswering = (isCopied: boolean | null, seen: ModPageRequest[] = []) =>
    async (request: Parameters<NonNullable<Parameters<typeof copyEverywhere>[1]['pages']>>[0]): Promise<ModPageAnswer | null> => {
      seen.push({ ...request, requestId: 'p' } as ModPageRequest)
      return isCopied === null ? null : { requestId: 'p', op: 'copy', isCopied }
    }

  it("the host's clipboard first: taken, the pages still copy for their devices, told the host has it", async () => {
    const seen: ModPageRequest[] = []
    const result = await copyEverywhere('hi', { host: { write: async () => true }, pages: pagesAnswering(false, seen) })
    expect(result).toEqual({ isCopied: true })
    expect(seen).toEqual([{ op: 'copy', text: 'hi', hostCopied: true, requestId: 'p' }])
  })

  it('the host failing — false, a throw, an older host — leaves it to the pages', async () => {
    const seen: ModPageRequest[] = []
    expect(await copyEverywhere('hi', { host: { write: async () => false }, pages: pagesAnswering(true, seen) })).toEqual({ isCopied: true })
    expect(seen[0]).toMatchObject({ hostCopied: false })
    const notImplemented = { write: () => Promise.reject(new Error('NOT_IMPLEMENTED: ui.writeClipboard')) }
    expect(await copyEverywhere('hi', { host: notImplemented, pages: pagesAnswering(true) })).toEqual({ isCopied: true })
  })

  it('no path took it: no-clipboard; no path at all: no-surface', async () => {
    expect(await copyEverywhere('hi', { host: { write: async () => false }, pages: pagesAnswering(false) })).toEqual({
      isCopied: false,
      reason: 'no-clipboard',
    })
    expect(await copyEverywhere('hi', { pages: pagesAnswering(null) })).toEqual({ isCopied: false, reason: 'no-clipboard' })
    expect(await copyEverywhere('hi', { host: { write: async () => true } })).toEqual({ isCopied: true })
    expect(await copyEverywhere('hi', {})).toEqual({ isCopied: false, reason: 'no-surface' })
  })
})

// ── through a real runtime ──

let uniq = 0
type PageAnswerer = (request: ModPageRequest) => ModPageAnswer | null
function world(
  modules: Record<string, string>,
  page: PageAnswerer | null,
  options: Partial<ModRuntimeOptions> = {},
) {
  const reports: string[] = []
  const asked: ModPageRequest[] = []
  const events: ModUiEvent[] = []
  let runtime!: ModRuntime
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  runtime = new ModRuntime({
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
    ...(page ? { drawsComposer: true } : {}),
    pageTimeoutMs: 300,
    onUiChanged: (event: ModUiEvent) => {
      events.push(event)
      if (event.kind !== 'page' || !page) return
      asked.push(event.page)
      const answer = page(event.page)
      // The page answers on a later tick.
      if (answer) setTimeout(() => runtime.pageAnswer(answer), 0)
    },
    ...options,
  })
  runtimes.push(runtime)
  return {
    runtime,
    asked,
    reports,
    logs: (plugin: string) =>
      reports.filter(r => r.startsWith(`${plugin}: {`)).map(r => JSON.parse(r.slice(plugin.length + 2))),
  }
}

/** Logs what each call resolves to. */
const caller = (calls: string) => `
  on('session.start', async ($, e, next) => {
    ${calls}
    return next(e)
  })
`
const log = (expression: string) => `
    try { await $.ui.log(JSON.stringify({ got: await ${expression} })) }
    catch (error) { await $.ui.log(JSON.stringify({ error: error.message })) }
`

const copied = (request: ModPageRequest): ModPageAnswer | null =>
  request.op === 'copy' ? { requestId: request.requestId, op: 'copy', isCopied: true } : null

describe('$.ui.copy through the runtime', () => {
  it("the host's clipboard takes it; the page is asked too, told so", async () => {
    const written: string[] = []
    const { runtime, asked, logs } = world({ copier: caller(log(`$.ui.copy({ text: 'npm test' })`)) }, () => null, {
      clipboard: { write: async text => (written.push(text), true) },
    })
    await runtime.ready
    await until(() => logs('copier').length === 1)
    expect(logs('copier')).toEqual([{ got: { isCopied: true } }])
    expect(written).toEqual(['npm test'])
    expect(asked).toMatchObject([{ op: 'copy', text: 'npm test', hostCopied: true }])
  })

  it('the host failing, the page decides', async () => {
    const { runtime, asked, logs } = world({ copier: caller(log(`$.ui.copy({ text: 'x' })`)) }, copied, {
      clipboard: { write: async () => false },
    })
    await runtime.ready
    await until(() => logs('copier').length === 1)
    expect(logs('copier')).toEqual([{ got: { isCopied: true } }])
    expect(asked).toMatchObject([{ op: 'copy', hostCopied: false }])
  })

  it('another surface is no-surface; nothing took it is no-clipboard', async () => {
    const { runtime, logs } = world(
      {
        copier: caller(log(`$.ui.copy({ text: 'x', surface: 'terminal' })`) + log(`$.ui.copy({ text: 'y' })`)),
      },
      request => (request.op === 'copy' ? { requestId: request.requestId, op: 'copy', isCopied: false } : null),
    )
    await runtime.ready
    await until(() => logs('copier').length === 2)
    expect(logs('copier')).toEqual([
      { got: { isCopied: false, reason: 'no-surface' } },
      { got: { isCopied: false, reason: 'no-clipboard' } },
    ])
  })

  it("raised as ui.copy: a hook rewrites the text, or refuses (reason 'refused')", async () => {
    const written: string[] = []
    const { runtime, logs } = world(
      {
        guard: `on('ui.copy', async ($, e, next) => e.text.includes('secret') ? { deny: 'no secrets' } : next({ ...e, text: e.text.trim() }))`,
        copier: caller(log(`$.ui.copy({ text: '  padded  ' })`) + log(`$.ui.copy({ text: 'a secret' })`)),
      },
      null,
      { clipboard: { write: async text => (written.push(text), true) } },
    )
    await runtime.ready
    await until(() => logs('copier').length === 2)
    expect(logs('copier')).toEqual([{ got: { isCopied: true } }, { got: { isCopied: false, reason: 'refused' } }])
    expect(written).toEqual(['padded'])
  })
})

const PANE = (id: string, extra = '') => `await $.ui.open({ id: '${id}', title: 'T'${extra} })`

describe('$.ui.focus through the runtime', () => {
  it("the page focuses the element in the caller's pane; a pane opened with focus holds the keys", async () => {
    const { runtime, asked, logs } = world(
      { form: caller(`${PANE('ask', ', focus: true')}\n${PANE('quiet')}` + log(`$.ui.focus({ requestId: 'ask', key: 'q' })`) + log(`$.ui.focus({ requestId: 'quiet', key: 'q' })`)) },
      request => (request.op === 'focus' ? { requestId: request.requestId, op: 'focus' } : null),
    )
    await runtime.ready
    await until(() => logs('form').length === 2)
    expect(logs('form')).toEqual([{ got: {} }, { got: {} }])
    expect(asked).toMatchObject([
      { op: 'focus', plugin: 'form', component: 'Pane', site: 'ask', key: 'q', holdsKeys: true },
      { op: 'focus', plugin: 'form', component: 'Pane', site: 'quiet', key: 'q', holdsKeys: false },
    ])
  })

  it("another plugin's pane, or no page, is a deny; the page's deny is the call's", async () => {
    const { runtime, logs } = world(
      {
        owner: caller(PANE('theirs')),
        form: caller(
          `await new Promise(r => setTimeout(r, 50))` +
            log(`$.ui.focus({ requestId: 'theirs', key: 'q' })`) +
            log(`$.ui.focus({ requestId: 'band', key: 'q' })`),
        ),
      },
      request => (request.op === 'focus' ? { requestId: request.requestId, op: 'focus', deny: 'the site does not hold the keys' } : null),
    )
    await runtime.ready
    await until(() => logs('form').length === 2)
    expect(logs('form')[0].got.deny).toContain("not one of form's sites")
    expect(logs('form')[1]).toEqual({ got: { deny: 'the site does not hold the keys' } })

    const headless = world({ form: caller(PANE('p') + log(`$.ui.focus({ requestId: 'p', key: 'q' })`)) }, null)
    await headless.runtime.ready
    await until(() => headless.logs('form').length === 1)
    expect(headless.logs('form')[0].got.deny).toBe('no page draws this session')
  })

  it('raised as ui.focus: element is the one key a hook may rewrite; a hook may deny', async () => {
    const { runtime, asked, logs } = world(
      {
        steer: `on('ui.focus', async ($, e, next) => e.element === 'no' ? { deny: 'steered away' } : next({ ...e, element: 'other' }))`,
        form: caller(PANE('ask', ', focus: true') + log(`$.ui.focus({ requestId: 'ask', key: 'q' })`) + log(`$.ui.focus({ requestId: 'ask', key: 'no' })`)),
      },
      request => (request.op === 'focus' ? { requestId: request.requestId, op: 'focus' } : null),
    )
    await runtime.ready
    await until(() => logs('form').length === 2)
    expect(logs('form')).toEqual([{ got: {} }, { got: { deny: 'steered away' } }])
    expect(asked).toMatchObject([{ op: 'focus', key: 'other' }])
  })
})

const measured = (offset: number, current = 0) => ({ component: 'Pane' as const, site: 'log', current, offset, bodyRows: 4, contentRows: 10 })

describe('$.ui.scroll through the runtime', () => {
  it('a site: measured, raised as ui.scroll, applied clamped; end sticks', async () => {
    const { runtime, asked, logs } = world(
      {
        nudge: `on('ui.scroll', async ($, e, next) => {
          await $.ui.log(JSON.stringify({ seen: { by: e.by, offset: e.offset, bodyRows: e.bodyRows, contentRows: e.contentRows, origin: e.origin } }))
          return next(e.offset === 6 ? e : { ...e, offset: e.offset + 99 })
        })`,
        logger: caller(PANE('log') + log(`$.ui.scroll({ to: 'end', in: 'log' })`) + log(`$.ui.scroll({ to: { key: 'row3' }, block: 'start' })`)),
      },
      request => {
        if (request.op === 'scrollMeasure') {
          return { requestId: request.requestId, op: 'scrollMeasure', measured: request.to === 'end' ? measured(6, 1) : measured(3, 6) }
        }
        if (request.op === 'scrollApply') return { requestId: request.requestId, op: 'scrollApply' }
        return null
      },
    )
    await runtime.ready
    await until(() => logs('logger').length === 2)
    expect(logs('logger')).toEqual([{ got: {} }, { got: {} }])
    expect(logs('nudge')).toEqual([
      { seen: { by: 5, offset: 6, bodyRows: 4, contentRows: 10, origin: { kind: 'plugin', name: 'logger' } } },
      { seen: { by: -3, offset: 3, bodyRows: 4, contentRows: 10, origin: { kind: 'plugin', name: 'logger' } } },
    ])
    expect(asked.filter(r => r.op === 'scrollApply')).toMatchObject([
      { component: 'Pane', site: 'log', offset: 6, stickToEnd: true },
      // 3 + 99, clamped to the last offset (10 - 4).
      { component: 'Pane', site: 'log', offset: 6, stickToEnd: false },
    ])
  })

  it("a site not the caller's is refused before the page is asked", async () => {
    const { runtime, asked, logs } = world(
      { owner: caller(PANE('log')), other: caller(`await new Promise(r => setTimeout(r, 50))` + log(`$.ui.scroll({ to: 'start', in: 'log' })`)) },
      () => null,
    )
    await runtime.ready
    await until(() => logs('other').length === 1)
    expect(logs('other')[0].got.deny).toContain("not one of other's sites")
    expect(asked).toEqual([])
  })

  it("a transcript row moves only while the call answers the person's press", async () => {
    const rows: ModPageRequest[] = []
    const { runtime, logs } = world(
      {
        jump: `
          on('session.start', async ($, e, next) => {
            await $.ui.open({ id: 'nav', title: 'Nav' })
            try { await $.ui.log(JSON.stringify({ unasked: await $.ui.scroll({ to: { requestId: 'tool-1' } }) })) } catch (error) { await $.ui.log(JSON.stringify({ error: error.message })) }
            return next(e)
          })
          on('ui.render', { component: 'Pane', requestId: 'nav' }, ($, e) => {
            const { Button } = $.ui.resolve(e)
            return Button({ key: 'go', label: 'Go', onPress: async () => {
              await $.ui.log(JSON.stringify({ pressed: await $.ui.scroll({ to: { requestId: 'tool-1' }, block: 'center' }) }))
            } })
          })`,
      },
      request => {
        if (request.op !== 'scrollRow') return null
        rows.push(request)
        return { requestId: request.requestId, op: 'scrollRow' }
      },
    )
    await runtime.ready
    await until(() => logs('jump').length === 1)
    expect(logs('jump')).toEqual([{ unasked: { deny: 'not person-initiated' } }])
    const drawn = await runtime.render({
      component: 'Pane',
      requestId: 'nav',
      props: { title: 'Nav', isFocused: false, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    if (drawn.kind !== 'tree') throw new Error('expected a tree')
    const handle = (drawn.tree as { press: { handle: number } }).press.handle
    await runtime.uiInput({ kind: 'press', plugin: 'jump', element: 'go', component: 'Pane', requestId: 'nav', handle })
    await until(() => logs('jump').length === 2)
    expect(logs('jump')[1]).toEqual({ pressed: {} })
    expect(rows).toMatchObject([{ op: 'scrollRow', row: 'tool-1', block: 'center' }])
  })
})
