/**
 * `$.ui.selection()` (F-25): the person's last selection a page holds, raised as
 * the op event `ui.selection` (a hook may scrub or deny it); none without a page,
 * and none once the person's next prompt has run. Across pages, the newest by
 * `at` wins once the grace ends; a page with none never beats one with a
 * selection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import { MOD_PAGE_GRACE_MS, ModPageBridge, isUiSelectionResult, uiSelectionCore, type ModPageHost, type ModPageRequest } from '../mods/modPage'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniq = 0
function world(
  modules: Record<string, { source: string; tier?: ModModuleRef['tier'] }>,
  host: (runtime: () => ModRuntime) => Partial<ModNounHost> = () => ({}),
) {
  const reports: string[] = []
  const refs: ModModuleRef[] = Object.entries(modules).map(([plugin, { tier }]) => ({
    plugin,
    path: `/plugins/${plugin}/hooks/register.js`,
    ...(tier ? { tier } : {}),
  }))
  let self: ModRuntime | undefined
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `${modules[path.split('/')[2]!]!.source}\n// load ${++uniq}`,
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
    session: { id: () => 's', cwd: () => '/work/project', ...host(() => self!) },
    report: line => reports.push(line),
  })
  self = runtime
  runtimes.push(runtime)
  return { runtime, reports }
}


const READER = `
  export function register(on) {
    on('command.run', { command: 'quote' }, async ($, e) => {
      const got = await $.ui.selection().catch(err => 'rejected: ' + err.message);
      await $.ui.log(JSON.stringify({ got: got === undefined ? null : got }));
      return { text: 'ok' };
    });
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'quote', description: 'quote' });
      return next(e);
    });
  }
`

function pageHost(held: { text: string; requestId?: string; at: number; inPromptBox?: true } | undefined): ModPageHost {
  return {
    copy: async () => ({ isCopied: false, reason: 'no-surface' }),
    ask: async request => (request.op === 'selection' ? { requestId: 'p', op: 'selection', ...(held ? { selection: held } : {}) } : null),
    site: () => undefined,
    answersPerson: () => false,
  }
}

async function quote(runtime: ModRuntime, reports: string[]): Promise<unknown> {
  reports.length = 0
  await runtime.commandRun({ command: 'quote', args: '' }, undefined)
  const line = reports.find(r => r.startsWith('reader: {'))
  if (!line) throw new Error(`no answer: ${reports.join(' | ')}`)
  return (JSON.parse(line.slice('reader: '.length)) as { got: unknown }).got
}

describe('$.ui.selection', () => {
  it('hands the text and its row; a hook may scrub or deny it', async () => {
    const { runtime, reports } = world(
      {
        scrub: {
          source: `
            export function register(on) {
              on('ui.selection', async ($, e, next) => {
                const { value } = await next(e);
                if (value && value.text.includes('secret')) return { deny: 'private' };
                return { value: value ? { ...value, text: value.text.toUpperCase() } : value };
              });
            }
          `,
        },
        reader: { source: READER },
      },
      () => ({ page: pageHost({ text: 'npm test', requestId: 'toolu_1', at: Date.now() + 60_000 }) }),
    )
    await runtime.ready
    expect(await quote(runtime, reports)).toEqual({ text: 'NPM TEST', requestId: 'toolu_1' })
  })

  it('is none with no page, and none for a selection made before the last command ran', async () => {
    const before = Date.now() - 1
    const { runtime, reports } = world({ reader: { source: READER } }, () => ({ page: pageHost({ text: 'old', at: before }) }))
    await runtime.ready
    // The first run reads it: the cutoff moves only once a command has run.
    expect(await quote(runtime, reports)).toEqual({ text: 'old' })
    expect(await quote(runtime, reports)).toBeNull()
    const noPage = await uiSelectionCore({ copy: async () => ({ isCopied: true }), site: () => undefined, answersPerson: () => false })
    expect(noPage).toBeUndefined()
  })

  it('drops a selection made before a later prompt ran, and keeps one made after it', async () => {
    const held: { text: string; at: number } = { text: 'old', at: Date.now() - 10_000 }
    const page: ModPageHost = {
      ...pageHost(undefined),
      ask: async request => (request.op === 'selection' ? { requestId: 'p', op: 'selection', selection: { ...held } } : null),
    }
    const { runtime, reports } = world({ reader: { source: READER } }, () => ({ page }))
    await runtime.ready
    await runtime.promptSubmit('go on')
    expect(await quote(runtime, reports)).toBeNull()
    held.at = Date.now() + 60_000
    held.text = 'new'
    expect(await quote(runtime, reports)).toEqual({ text: 'new' })
  })

  it('hands a selection in the prompt box only to a plugin that may read the box', async () => {
    const box = { text: 'sk-secret', at: Date.now() + 60_000, inPromptBox: true as const }
    expect(await uiSelectionCore(pageHost(box))).toBeUndefined()
    expect(await uiSelectionCore(pageHost(box), undefined, () => false)).toBeUndefined()
    expect(await uiSelectionCore(pageHost(box), undefined, () => true)).toEqual({ text: 'sk-secret' })
    const { runtime, reports } = world({ reader: { source: READER } }, () => ({ page: pageHost(box) }))
    await runtime.ready
    expect(await quote(runtime, reports)).toBeNull()
  })

  it('takes only a text and a row from a hook', () => {
    expect(isUiSelectionResult(undefined)).toBe(true)
    expect(isUiSelectionResult({ text: 'a', requestId: 'r' })).toBe(true)
    expect(isUiSelectionResult({ text: 'a', at: 1 })).toBe(false)
    expect(isUiSelectionResult({ text: 'a', requestId: '' })).toBe(false)
  })
})

describe('a selection asked of several pages', () => {
  afterEach(() => vi.useRealTimers())

  function bridge() {
    const asked: ModPageRequest[] = []
    return { asked, pages: new ModPageBridge(request => void asked.push(request)) }
  }

  it('waits out the grace after the first answer and returns the newest by at, whatever the order', async () => {
    vi.useFakeTimers()
    const { asked, pages } = bridge()
    let settled: unknown = 'pending'
    void pages.ask({ op: 'selection' }).then(answer => (settled = answer))
    const requestId = asked[0]!.requestId
    expect(pages.answer({ requestId, op: 'selection', selection: { text: 'newer', at: 200 } })).toBe(true)
    await vi.advanceTimersByTimeAsync(MOD_PAGE_GRACE_MS - 1)
    expect(settled).toBe('pending')
    pages.answer({ requestId, op: 'selection', selection: { text: 'older', at: 100 } })
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toEqual({ requestId, op: 'selection', selection: { text: 'newer', at: 200 } })
  })

  it('a later answer with a newer at wins over an earlier one', async () => {
    vi.useFakeTimers()
    const { asked, pages } = bridge()
    const answer = pages.ask({ op: 'selection' })
    const requestId = asked[0]!.requestId
    pages.answer({ requestId, op: 'selection', selection: { text: 'older', at: 100 } })
    pages.answer({ requestId, op: 'selection', selection: { text: 'newer', at: 300 } })
    await vi.advanceTimersByTimeAsync(MOD_PAGE_GRACE_MS)
    expect((await answer)?.op === 'selection' && (await answer)).toMatchObject({ selection: { text: 'newer' } })
  })

  it('a page with none never beats a page with a selection, before or after it', async () => {
    vi.useFakeTimers()
    const { asked, pages } = bridge()
    const first = pages.ask({ op: 'selection' })
    const second = pages.ask({ op: 'selection' })
    const [a, b] = [asked[0]!.requestId, asked[1]!.requestId]
    pages.answer({ requestId: a, op: 'selection' })
    pages.answer({ requestId: a, op: 'selection', selection: { text: 'real', at: 1 } })
    pages.answer({ requestId: b, op: 'selection', selection: { text: 'real', at: 1 } })
    pages.answer({ requestId: b, op: 'selection' })
    await vi.advanceTimersByTimeAsync(MOD_PAGE_GRACE_MS)
    expect(await first).toMatchObject({ selection: { text: 'real' } })
    expect(await second).toMatchObject({ selection: { text: 'real' } })
  })

  it('none from every page settles as none when the grace ends', async () => {
    vi.useFakeTimers()
    const { asked, pages } = bridge()
    const answer = pages.ask({ op: 'selection' })
    pages.answer({ requestId: asked[0]!.requestId, op: 'selection' })
    await vi.advanceTimersByTimeAsync(MOD_PAGE_GRACE_MS)
    expect(await answer).toEqual({ requestId: asked[0]!.requestId, op: 'selection' })
  })

  it('a copy still settles on the first page that took it, without the grace', async () => {
    vi.useFakeTimers()
    const { asked, pages } = bridge()
    const answer = pages.ask({ op: 'copy', text: 't', hostCopied: false })
    pages.answer({ requestId: asked[0]!.requestId, op: 'copy', isCopied: true })
    expect(await answer).toMatchObject({ isCopied: true })
  })
})
