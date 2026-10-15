/**
 * Provider mods: a version swap registers the new module beside the old and drains the old (new calls go to the new
 * module; calls on the old run to their answer; it closes at its last call or the drain bound). A version that would
 * not be admitted never replaces the old one.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  ProviderModRuntime,
  ProviderModUnavailableError,
  longestProviderEventMs,
  type ProviderModRuntimeOptions,
  type ProviderModuleRef,
} from '../mods/provider/ProviderModRuntime'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(5)
  }
}

const ports: MessagePort[] = []
const runtimes: ProviderModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of ports.splice(0)) port.close()
})

const ID = 'mod.acme.zen'
const ref = (path: string): ProviderModuleRef => ({ plugin: 'acme', path, providers: [ID] })

/** Answers `provider.models` after `waitMs`, saying which version answered. */
const version = (name: string, waitMs: number): string => `
  export function register(on) {
    on('provider.models', async ($) => { await $.clock.sleep(${waitMs}); return ['${name}'] })
  }
`

function rig(files: Record<string, string>, options: Partial<ProviderModRuntimeOptions> = {}) {
  const log: string[] = []
  const reports: string[] = []
  let opened = 0
  const runtime = new ProviderModRuntime({
    readModule: async path => {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    compile: async (_ref, source) => {
      if (source.includes('BROKEN')) throw new Error('syntax error')
      return source
    },
    openWorker: async r => {
      const id = ++opened
      log.push(`open#${id}:${r.path}`)
      const channel = new MessageChannel()
      ports.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed'; message?: string }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed'; message?: string }>(resolve => {
        settle = resolve
      })
      void closed.then(c => log.push(`closed#${id}:${c.reason}`))
      const worker: ModWorkerHandle & { crash(): void } = {
        port: channel.port1,
        closed,
        close: () => settle({ reason: 'closed' }),
        crash: () => settle({ reason: 'crashed', message: 'test crash' }),
      }
      workers.push(worker)
      return worker
    },
    window: { available: () => true, attached: async () => {} },
    report: line => reports.push(line),
    ...options,
  })
  const workers: Array<ModWorkerHandle & { crash(): void }> = []
  runtimes.push(runtime)
  return { runtime, log, reports, workers }
}

describe('ProviderModRuntime - register beside and drain', () => {
  it('a call in flight finishes on the OLD module; a call after the swap is the NEW module’s; the old closes once drained', async () => {
    const { runtime, log } = rig({ 'acme/v1/zen.js': version('old', 200), 'acme/v2/zen.js': version('new', 5) })
    runtime.register('acme', [ref('acme/v1/zen.js')])
    const inFlight = runtime.call(ID, 'provider.models', {})
    await until(() => runtime.status()[0]?.state === 'ready')

    runtime.register('acme', [ref('acme/v2/zen.js')])
    // Routing switched at once: the new module is registered, cold, alone in status.
    expect(runtime.status().map(s => [s.path, s.state])).toEqual([['acme/v2/zen.js', 'cold']])
    expect(runtime.draining().map(s => s.path)).toEqual(['acme/v1/zen.js'])
    expect(runtime.owns(ID)).toBe(true)

    const fresh = await runtime.call(ID, 'provider.models', {})
    expect(fresh).toEqual({ raised: true, value: ['new'] })
    // The old worker is still up: its call has not settled.
    expect(log).not.toContain('closed#1:closed')

    expect(await inFlight).toEqual({ raised: true, value: ['old'] })
    await until(() => log.includes('closed#1:closed'))
    expect(runtime.draining()).toEqual([])
    expect(log.filter(line => line.startsWith('open#'))).toEqual(['open#1:acme/v1/zen.js', 'open#2:acme/v2/zen.js'])
    expect(runtime.status()[0]).toMatchObject({ path: 'acme/v2/zen.js', state: 'ready', crashes: 0 })
  })

  it('an old module with no call under way closes at once, and the new one loads only at its first call', async () => {
    const { runtime, log } = rig({ 'acme/v1/zen.js': version('old', 1), 'acme/v2/zen.js': version('new', 1) })
    runtime.register('acme', [ref('acme/v1/zen.js')])
    await runtime.call(ID, 'provider.models', {})
    runtime.register('acme', [ref('acme/v2/zen.js')])
    expect(runtime.draining()).toEqual([])
    await until(() => log.includes('closed#1:closed'))
    expect(log.filter(line => line.startsWith('open#'))).toEqual(['open#1:acme/v1/zen.js'])
    expect(await runtime.call(ID, 'provider.models', {})).toEqual({ raised: true, value: ['new'] })
  })

  it('a replaced module is closed at the drain bound, whatever it still holds', async () => {
    const { runtime, log, reports } = rig(
      { 'acme/v1/zen.js': version('old', 5_000), 'acme/v2/zen.js': version('new', 1) },
      { drainMs: 40, budgetMs: 10_000 },
    )
    runtime.register('acme', [ref('acme/v1/zen.js')])
    const stuck = runtime.call(ID, 'provider.models', {}, { core: () => ['core'] }).catch(error => error)
    await until(() => runtime.status()[0]?.state === 'ready')
    runtime.register('acme', [ref('acme/v2/zen.js')])
    expect(runtime.draining()).toHaveLength(1)
    await until(() => log.includes('closed#1:closed'))
    expect(runtime.draining()).toEqual([])
    expect(reports.join('\n')).toMatch(/still had calls after 40ms/)
    await stuck
  })

  it('the default bound is the longest event budget plus slack', () => {
    expect(longestProviderEventMs()).toBeGreaterThanOrEqual(30_000)
  })

  it('a replaced module that crashes is finished, never respawned, and not counted against the new one', async () => {
    const { runtime, log, workers } = rig({ 'acme/v1/zen.js': version('old', 300), 'acme/v2/zen.js': version('new', 1) })
    runtime.register('acme', [ref('acme/v1/zen.js')])
    const pending = runtime.call(ID, 'provider.models', {}, { core: () => ['core'] }).catch(error => error)
    await until(() => runtime.status()[0]?.state === 'ready')
    runtime.register('acme', [ref('acme/v2/zen.js')])
    workers[0]!.crash()
    await until(() => runtime.draining().length === 0)
    expect(log.filter(line => line.startsWith('open#'))).toHaveLength(1)
    expect(runtime.status()[0]).toMatchObject({ path: 'acme/v2/zen.js', crashes: 0, generation: 0 })
    await pending
  })

  it('unregister and dispose close a draining module too', async () => {
    const { runtime, log } = rig({ 'acme/v1/zen.js': version('old', 400), 'acme/v2/zen.js': version('new', 1) })
    runtime.register('acme', [ref('acme/v1/zen.js')])
    const pending = runtime.call(ID, 'provider.models', {}).catch(error => error)
    await until(() => runtime.status()[0]?.state === 'ready')
    runtime.register('acme', [ref('acme/v2/zen.js')])
    runtime.unregister('acme')
    await until(() => log.includes('closed#1:closed'))
    expect(runtime.draining()).toEqual([])
    expect(await pending).toBeInstanceOf(Error)
    expect(runtime.owns(ID)).toBe(false)
  })
})

describe('ProviderModRuntime.replace - a refused version leaves the old one serving', () => {
  it('a module that does not compile is refused and the old module keeps answering', async () => {
    const { runtime, log } = rig({
      'acme/v1/zen.ts': version('old', 1),
      'acme/v2/zen.ts': `${version('new', 1)}\nBROKEN`,
    })
    runtime.register('acme', [ref('acme/v1/zen.ts')])
    await expect(runtime.replace('acme', [ref('acme/v2/zen.ts')])).rejects.toThrow(/not admitted.*did not compile/)
    expect(runtime.status().map(s => s.path)).toEqual(['acme/v1/zen.ts'])
    expect(await runtime.call(ID, 'provider.models', {})).toEqual({ raised: true, value: ['old'] })
    expect(log.filter(line => line.startsWith('open#'))).toEqual(['open#1:acme/v1/zen.ts'])
  })

  it('a module whose scan shows a session hook or a $.session call is refused', async () => {
    const files = { 'acme/v1/zen.ts': version('old', 1), 'acme/v2/zen.ts': version('new', 1) }
    let uses: { events: string[]; calls: string[] } = { events: ['session.start'], calls: [] }
    const { runtime } = rig(files, { scan: async () => uses })
    runtime.register('acme', [ref('acme/v1/zen.ts')])
    await expect(runtime.replace('acme', [ref('acme/v2/zen.ts')])).rejects.toThrow(/not admitted/)
    uses = { events: ['provider.models'], calls: ['session.cwd'] }
    await expect(runtime.replace('acme', [ref('acme/v2/zen.ts')])).rejects.toThrow(/not admitted/)
    expect(runtime.status().map(s => s.path)).toEqual(['acme/v1/zen.ts'])
    uses = { events: ['provider.models'], calls: ['clock.sleep'] }
    await runtime.replace('acme', [ref('acme/v2/zen.ts')])
    expect(runtime.status().map(s => s.path)).toEqual(['acme/v2/zen.ts'])
    expect(await runtime.call(ID, 'provider.models', {})).toEqual({ raised: true, value: ['new'] })
  })

  it('an unreadable new version is refused too, and a provider id of another plugin still throws', async () => {
    const { runtime } = rig({ 'acme/v1/zen.js': version('old', 1) })
    runtime.register('acme', [ref('acme/v1/zen.js')])
    await expect(runtime.replace('acme', [ref('acme/gone.js')])).rejects.toThrow(/could not be read/)
    expect(runtime.status().map(s => s.path)).toEqual(['acme/v1/zen.js'])
    await expect(
      runtime.replace('other', [{ plugin: 'other', path: 'acme/v1/zen.js', providers: [ID] }]),
    ).rejects.toThrow(/already provided by acme/)
  })

  it('after dispose, replace refuses', async () => {
    const { runtime } = rig({ 'acme/v1/zen.js': version('old', 1) })
    runtime.dispose()
    await expect(runtime.replace('acme', [ref('acme/v1/zen.js')])).rejects.toThrow(/disposed/)
    await expect(runtime.call(ID, 'provider.models', {})).rejects.toBeInstanceOf(ProviderModUnavailableError)
  })
})
