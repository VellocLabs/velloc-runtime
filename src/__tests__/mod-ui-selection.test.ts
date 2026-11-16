/**
 * `$.ui.selection()` (F-25): the person's last selection a page holds, raised as
 * the op event `ui.selection` (a hook may scrub or deny it); none without a page,
 * and none once the person's next prompt has run.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import { isUiSelectionResult, uiSelectionCore, type ModPageHost } from '../mods/modPage'

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

function pageHost(held: { text: string; requestId?: string; at: number } | undefined): ModPageHost {
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

  it('takes only a text and a row from a hook', () => {
    expect(isUiSelectionResult(undefined)).toBe(true)
    expect(isUiSelectionResult({ text: 'a', requestId: 'r' })).toBe(true)
    expect(isUiSelectionResult({ text: 'a', at: 1 })).toBe(false)
    expect(isUiSelectionResult({ text: 'a', requestId: '' })).toBe(false)
  })
})
