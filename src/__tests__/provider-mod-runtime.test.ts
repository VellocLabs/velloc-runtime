/**
 * Provider mods, the global runtime: one worker per provider module, loaded by the first call, closed when idle,
 * respawned after a crash under the backoff and limit, failing closed with no host window; events go to the owning
 * module; provider-kind admission both ways.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { refuseProviderModuleUses, refuseProviderRegistrations, refuseRegistrations } from '../mods/modAdmission'
import { MOD_RESPAWN_LIMIT, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  ProviderHookUnansweredError,
  ProviderModRuntime,
  ProviderModUnavailableError,
  type ProviderModRuntimeOptions,
  type ProviderModuleRef,
  type ProviderModWindow,
} from '../mods/provider/ProviderModRuntime'
import { PROVIDER_EVENTS, refuseProviderModuleCall } from '../mods/provider/providerEvents'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(5)
  }
}

let uniqueLoad = 0
const openPorts: MessagePort[] = []
const runtimes: ProviderModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
})

type Worker = ModWorkerHandle & { crash(message?: string): void; id: number }

function world(
  modules: Record<string, { source: string; providers: string[] }>,
  options: Partial<ProviderModRuntimeOptions> & {
    /** How long a closed worker takes to be reported gone. */
    closeDelayMs?: number
  } = {},
) {
  const reports: string[] = []
  const log: string[] = []
  const workers: Worker[] = []
  let opened = 0
  const refs: ProviderModuleRef[] = Object.entries(modules).map(([path, entry]) => ({
    plugin: path.split('/')[0]!,
    path,
    providers: entry.providers,
  }))
  const runtime = new ProviderModRuntime({
    readModule: async path => `${modules[path]!.source}\n// load ${++uniqueLoad}`,
    openWorker: async ref => {
      const id = ++opened
      log.push(`open#${id}:${ref.plugin}`)
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed'; message?: string }) => void
      const closed = new Promise<{
        reason: 'closed' | 'crashed'
        message?: string
      }>(resolve => {
        settle = resolve
      })
      void closed.then(c => log.push(`closed#${id}:${c.reason}`))
      const worker: Worker = {
        id,
        port: channel.port1,
        closed,
        close() {
          if (options.closeDelayMs) setTimeout(() => settle({ reason: 'closed' }), options.closeDelayMs)
          else settle({ reason: 'closed' })
        },
        crash(message) {
          settle({ reason: 'crashed', ...(message ? { message } : {}) })
        },
      }
      workers.push(worker)
      return worker
    },
    window: options.window ?? {
      available: () => true,
      attached: async () => {},
    },
    report: line => reports.push(line),
    respawnBackoffMs: [10],
    ...options,
  })
  runtimes.push(runtime)
  const byPlugin = new Map<string, ProviderModuleRef[]>()
  for (const ref of refs) byPlugin.set(ref.plugin, [...(byPlugin.get(ref.plugin) ?? []), ref])
  for (const [plugin, list] of byPlugin) runtime.register(plugin, list)
  const status = (plugin = refs[0]!.plugin) => runtime.status().find(s => s.plugin === plugin)!
  return { runtime, reports, log, workers, status, opened: () => opened }
}

/** Counts its loads' calls in a module variable, and echoes the provider. */
const ECHO = `
  let calls = 0
  export function register(on) {
    on('provider.request', ($, e) => { calls += 1; return { headers: { 'x-provider': e.provider, 'x-calls': String(calls) } } })
  }
`

describe('ProviderModRuntime — residency', () => {
  it('nothing loads at registration; the first call spawns, the second reuses the worker', async () => {
    const { runtime, status, opened } = world({
      'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] },
    })
    expect(opened()).toBe(0)
    expect(status().state).toBe('cold')
    expect(runtime.hasHook('mod.acme.zen', 'provider.request')).toBeUndefined()
    const first = await runtime.call('mod.acme.zen', 'provider.request', {
      body: {},
    })
    expect(first).toEqual({
      raised: true,
      value: { headers: { 'x-provider': 'mod.acme.zen', 'x-calls': '1' } },
    })
    const second = await runtime.call('mod.acme.zen', 'provider.request', {})
    expect(second).toEqual({
      raised: true,
      value: { headers: { 'x-provider': 'mod.acme.zen', 'x-calls': '2' } },
    })
    expect(opened()).toBe(1)
    expect(status()).toMatchObject({
      state: 'ready',
      generation: 1,
      exits: 0,
      crashes: 0,
    })
    expect(runtime.hasHook('mod.acme.zen', 'provider.request')).toBe(true)
  })

  it('an idle module exits, is counted as an exit and never as a crash, and comes back fresh', async () => {
    const { runtime, status, opened } = world(
      {
        'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] },
      },
      { idleMs: 40, idleCheckMs: 10 },
    )
    // More idle cycles than the respawn limit allows crashes.
    for (let cycle = 1; cycle <= MOD_RESPAWN_LIMIT + 2; cycle += 1) {
      const answer = await runtime.call('mod.acme.zen', 'provider.request', {})
      // Module variables start over at each load.
      expect(answer).toEqual({
        raised: true,
        value: { headers: { 'x-provider': 'mod.acme.zen', 'x-calls': '1' } },
      })
      await until(() => status().exits === cycle && status().state === 'cold')
      expect(status().crashes).toBe(0)
    }
    expect(opened()).toBe(MOD_RESPAWN_LIMIT + 2)
    expect(status().state).toBe('cold')
  })

  it('a pending call keeps the worker past the idle period', async () => {
    const SLOW = `
      export function register(on) {
        on('provider.models', async ($, e) => { await $.clock.sleep(150); return [] })
      }
    `
    const { runtime, status } = world(
      {
        'acme/providers/zen.js': { source: SLOW, providers: ['mod.acme.zen'] },
      },
      { idleMs: 30, idleCheckMs: 5 },
    )
    const answer = await runtime.call('mod.acme.zen', 'provider.models', {})
    expect(answer).toEqual({ raised: true, value: [] })
    // The call outlived idleMs several times over without an exit.
    expect(status().exits).toBe(0)
    await until(() => status().exits === 1)
  })

  it('a call arriving during an exit waits for the old worker to go, then spawns a new one', async () => {
    const { runtime, status, log } = world(
      {
        'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] },
      },
      { idleMs: 20, idleCheckMs: 5, closeDelayMs: 80 },
    )
    await runtime.call('mod.acme.zen', 'provider.request', {})
    await until(() => status().state === 'exiting')
    const answer = await runtime.call('mod.acme.zen', 'provider.request', {})
    expect(answer).toMatchObject({ raised: true })
    expect(log.indexOf('closed#1:closed')).toBeGreaterThan(-1)
    expect(log.indexOf('closed#1:closed')).toBeLessThan(log.indexOf('open#2:acme'))
    expect(status()).toMatchObject({ exits: 1, crashes: 0, generation: 2 })
  })
})

describe('ProviderModRuntime — crashes', () => {
  it('a crashed worker is started again by the next call after the backoff, and given up on past the limit', async () => {
    const { runtime, status, workers } = world(
      {
        'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] },
      },
      { respawnBackoffMs: [40] },
    )
    for (let crash = 1; crash <= MOD_RESPAWN_LIMIT; crash += 1) {
      await runtime.call('mod.acme.zen', 'provider.request', {})
      // The backoff runs from the crash, not from the next call: part of it
      // is spent while this test polls for the state, so measure from before
      // the crash (a timer may also fire a millisecond early).
      const crashedAt = Date.now()
      workers.at(-1)!.crash('Uncaught RangeError')
      await until(() => status().state === 'crashed')
      expect(status().crashes).toBe(crash)
      await runtime.call('mod.acme.zen', 'provider.request', {})
      expect(Date.now() - crashedAt).toBeGreaterThanOrEqual(35)
      expect(status().state).toBe('ready')
    }
    workers.at(-1)!.crash()
    await until(() => status().state === 'dead')
    await expect(runtime.call('mod.acme.zen', 'provider.request', {})).rejects.toBeInstanceOf(
      ProviderModUnavailableError,
    )
    expect(workers).toHaveLength(MOD_RESPAWN_LIMIT + 1)
  })

  it('three hooks in a row out of time is a stuck worker: closed and counted as a crash', async () => {
    const STUCK = `
      export function register(on) {
        on('provider.request', () => new Promise(() => {}))
      }
    `
    const { runtime, status, workers } = world(
      {
        'acme/providers/zen.js': { source: STUCK, providers: ['mod.acme.zen'] },
      },
      { budgetMs: 20, catchMs: 10 },
    )
    for (let i = 0; i < 3; i += 1) {
      // Fail closed: a hook out of time is no answer.
      await expect(runtime.call('mod.acme.zen', 'provider.request', {})).rejects.toBeInstanceOf(
        ProviderHookUnansweredError,
      )
    }
    await until(() => status().state === 'crashed')
    expect(status().crashes).toBe(1)
    expect(workers).toHaveLength(1)
  })
})

describe('ProviderModRuntime — unreadable module', () => {
  it('a read failure leaves the module cold and retryable: the next call reads again and is served', async () => {
    let reads = 0
    const { runtime, status, reports } = world(
      { 'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] } },
      {
        readModule: async () => {
          reads += 1
          if (reads === 1) throw new Error('EBUSY: resource busy or locked')
          return ECHO
        },
      },
    )
    await expect(runtime.call('mod.acme.zen', 'provider.request', {})).rejects.toBeInstanceOf(
      ProviderModUnavailableError,
    )
    expect(status()).toMatchObject({ state: 'cold', crashes: 0 })
    expect(status().reason).toMatch(/could not be read.*EBUSY/)
    expect(reports.join(' ')).toMatch(/next call reads it again/)
    await expect(runtime.call('mod.acme.zen', 'provider.request', {})).resolves.toMatchObject({ raised: true })
    expect(reads).toBe(2)
    expect(status().state).toBe('ready')
  })

  it('an admission refusal stays final: the module is not read again', async () => {
    let reads = 0
    const SESSION = `export function register(on) { on('session.start', ($, e, next) => next(e)) }`
    const { runtime, status } = world(
      { 'acme/providers/zen.js': { source: SESSION, providers: ['mod.acme.zen'] } },
      {
        readModule: async () => {
          reads += 1
          return SESSION
        },
      },
    )
    await expect(runtime.call('mod.acme.zen', 'provider.request', {})).rejects.toThrow(/cannot load/)
    await expect(runtime.call('mod.acme.zen', 'provider.request', {})).rejects.toThrow(/is off/)
    expect(reads).toBe(1)
    expect(status().state).toBe('refused')
  })
})

describe('ProviderModRuntime — no window', () => {
  function controllableWindow(): ProviderModWindow & {
    attach(): void
    open: boolean
  } {
    const waiters = new Set<() => void>()
    const win = {
      open: false,
      available: () => win.open,
      attached: (signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          const wake = (): void => resolve()
          waiters.add(wake)
          signal.addEventListener('abort', () => {
            waiters.delete(wake)
            reject(new Error('aborted'))
          })
        }),
      attach() {
        win.open = true
        for (const wake of waiters) wake()
      },
    }
    return win
  }

  it('waits up to the bound for a window, then fails closed — not a crash', async () => {
    const win = controllableWindow()
    const { runtime, status, opened } = world(
      {
        'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] },
      },
      { window: win, windowWaitMs: 30 },
    )
    await expect(runtime.call('mod.acme.zen', 'provider.request', {})).rejects.toThrow(
      /no Velloc window is open .* fails closed/,
    )
    expect(opened()).toBe(0)
    expect(status()).toMatchObject({ state: 'cold', crashes: 0 })
  })

  it('a window that attaches during the wait starts the module', async () => {
    const win = controllableWindow()
    const { runtime, opened } = world(
      {
        'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] },
      },
      { window: win, windowWaitMs: 2_000 },
    )
    const calling = runtime.call('mod.acme.zen', 'provider.request', {})
    await sleep(20)
    expect(opened()).toBe(0)
    win.attach()
    await expect(calling).resolves.toMatchObject({ raised: true })
    expect(opened()).toBe(1)
  })
})

describe('ProviderModRuntime — routing and answers', () => {
  it('an event reaches the module that owns the provider alone, with e.provider', async () => {
    const OTHER = `export function register(on) { on('provider.request', () => ({ headers: { other: '1' } })) }`
    const { runtime, log } = world({
      'acme/providers/both.js': {
        source: ECHO,
        providers: ['mod.acme.zen', 'mod.acme.go'],
      },
      'other/providers/x.js': { source: OTHER, providers: ['mod.other.x'] },
    })
    const go = await runtime.call('mod.acme.go', 'provider.request', {})
    expect(go).toMatchObject({
      raised: true,
      value: { headers: { 'x-provider': 'mod.acme.go' } },
    })
    const zen = await runtime.call('mod.acme.zen', 'provider.request', {})
    expect(zen).toMatchObject({
      raised: true,
      value: { headers: { 'x-provider': 'mod.acme.zen', 'x-calls': '2' } },
    })
    // One worker for the module that owns both; the other plugin never woke.
    expect(log.filter(line => line.startsWith('open#'))).toEqual(['open#1:acme'])
    await expect(runtime.call('mod.nobody.y', 'provider.request', {})).rejects.toBeInstanceOf(
      ProviderModUnavailableError,
    )
  })

  it('an event the module does not hook is not raised — and once its hooks are known, nothing wakes', async () => {
    const { runtime, status, opened } = world(
      {
        'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] },
      },
      { idleMs: 20, idleCheckMs: 5 },
    )
    // Unknown before the first load: loaded to find out.
    expect(await runtime.call('mod.acme.zen', 'provider.models', {})).toEqual({
      raised: false,
    })
    expect(opened()).toBe(1)
    expect(runtime.hasHook('mod.acme.zen', 'provider.models')).toBe(false)
    await until(() => status().state === 'cold')
    expect(await runtime.call('mod.acme.zen', 'provider.models', {})).toEqual({
      raised: false,
    })
    expect(opened()).toBe(1)
  })

  it('a hook that throws fails a fail-closed event, and is replaced by the caller core elsewhere', async () => {
    const THROWS = `
      export function register(on) {
        on('provider.request', () => { throw new Error('boom') })
        on('provider.verify', () => { throw new Error('boom') })
        on('provider.logout', () => undefined)
      }
    `
    const { runtime } = world({
      'acme/providers/zen.js': { source: THROWS, providers: ['mod.acme.zen'] },
    })
    await expect(runtime.call('mod.acme.zen', 'provider.request', {})).rejects.toBeInstanceOf(
      ProviderHookUnansweredError,
    )
    await expect(
      runtime.call('mod.acme.zen', 'provider.verify', {}, { core: () => ({ ok: true, by: 'core' }) }),
    ).resolves.toEqual({ raised: true, value: { ok: true, by: 'core' } })
    // A void event's hook returning nothing has answered.
    await expect(runtime.call('mod.acme.zen', 'provider.logout', {})).resolves.toEqual({
      raised: true,
      value: undefined,
    })
  })

  it('serves $.store (per plugin) and $.log; refuses session nouns, $.fs but read, and clock.every at the call', async () => {
    const NOUNS = `
      export function register(on) {
        on('provider.usage', async ($) => {
          await $.store.set('n', 7)
          $.log.info('hello')
          const refused = []
          for (const attempt of [() => $.session.id(), () => $.fs.write('x', 'y'), () => $.clock.every(5, () => {})]) {
            try { await attempt() } catch (error) { refused.push(error.name) }
          }
          return { n: await $.store.get('n'), refused }
        })
      }
    `
    const { runtime, reports } = world({
      'acme/providers/zen.js': { source: NOUNS, providers: ['mod.acme.zen'] },
    })
    const answer = await runtime.call('mod.acme.zen', 'provider.usage', {})
    expect(answer).toMatchObject({ raised: true, value: { n: 7 } })
    const refused = (answer as { value: { refused: string[] } }).value.refused
    expect(refused.slice(0, 2)).toEqual(['NotAllowedError', 'NotAllowedError'])
    expect(reports).toContain('acme [info]: hello')
  })

  it('a provider id belongs to one plugin', () => {
    const { runtime } = world({
      'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] },
    })
    expect(() =>
      runtime.register('other', [
        {
          plugin: 'other',
          path: 'other/providers/x.js',
          providers: ['mod.acme.zen'],
        },
      ]),
    ).toThrow(/already provided by acme/)
  })

  it('unregistering closes the worker and fails later calls', async () => {
    const { runtime, log } = world({
      'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] },
    })
    await runtime.call('mod.acme.zen', 'provider.request', {})
    runtime.unregister('acme')
    await until(() => log.includes('closed#1:closed'))
    expect(runtime.owns('mod.acme.zen')).toBe(false)
    await expect(runtime.call('mod.acme.zen', 'provider.request', {})).rejects.toBeInstanceOf(
      ProviderModUnavailableError,
    )
  })
})

describe('provider-kind admission', () => {
  it('a provider module hooking a session event is refused at load', async () => {
    const SESSION = `export function register(on) { on('session.start', ($, e, next) => next(e)) }`
    const { runtime, status } = world({
      'acme/providers/zen.js': { source: SESSION, providers: ['mod.acme.zen'] },
    })
    await expect(runtime.call('mod.acme.zen', 'provider.request', {})).rejects.toThrow(/cannot load/)
    expect(status()).toMatchObject({ state: 'refused' })
    expect(status().reason).toMatch(/hooks the provider events alone.*session\.start/)
  })

  it('a provider module whose scan shows a session noun or clock.every is refused before it runs', async () => {
    const { runtime, status, opened } = world(
      {
        'acme/providers/zen.js': { source: ECHO, providers: ['mod.acme.zen'] },
      },
      {
        scan: async () => ({
          events: ['provider.request'],
          calls: ['clock.every', 'session.id', 'store.get'],
        }),
      },
    )
    await expect(runtime.call('mod.acme.zen', 'provider.request', {})).rejects.toBeInstanceOf(
      ProviderModUnavailableError,
    )
    expect(opened()).toBe(0)
    expect(status().reason).toMatch(/\$\.clock\.every/)
    expect(status().reason).toMatch(/\$\.session is a session noun/)
  })

  it('refuseProviderRegistrations: provider events and provider.* only, plain functions only', () => {
    const hook = (pattern: string, streams = false) => ({
      hookId: '1',
      pattern,
      hasCatch: false,
      streams,
    })
    expect(refuseProviderRegistrations(Object.keys(PROVIDER_EVENTS).map(name => hook(name)))).toBeNull()
    expect(refuseProviderRegistrations([hook('provider.*')])).toBeNull()
    expect(refuseProviderRegistrations([hook('*')])).toMatch(/provider events alone/)
    expect(refuseProviderRegistrations([hook('tool.call')])).toMatch(/provider events alone/)
    expect(refuseProviderRegistrations([hook('provider.stream')])).toMatch(/does not raise: provider\.stream/)
    expect(refuseProviderRegistrations([hook('provider.request', true)])).toMatch(/async generator/)
  })

  it('a session module hooking a provider event is refused', () => {
    const hook = (pattern: string) => ({
      hookId: '1',
      pattern,
      hasCatch: false,
    })
    expect(refuseRegistrations([hook('provider.request')])).toMatch(/only a provider module can hook/)
    expect(refuseRegistrations([hook('provider.*')])).toMatch(/only a provider module can hook/)
    expect(refuseRegistrations([hook('session.start')])).toBeNull()
  })

  it('the provider nouns: provider, store, http.fetch, log, clock but every, fs.read', () => {
    expect(refuseProviderModuleCall('provider', 'fetch')).toBeNull()
    expect(refuseProviderModuleCall('store', 'set')).toBeNull()
    expect(refuseProviderModuleCall('http', 'fetch')).toBeNull()
    expect(refuseProviderModuleCall('log', 'warn')).toBeNull()
    expect(refuseProviderModuleCall('clock', 'after')).toBeNull()
    expect(refuseProviderModuleCall('clock', 'every')).toMatch(/not available to a provider module/)
    expect(refuseProviderModuleCall('fs', 'read')).toBeNull()
    expect(refuseProviderModuleCall('fs', 'write')).toMatch(/\$\.fs offers read/)
    for (const noun of ['session', 'tool', 'prompt', 'ui', 'model', 'process', 'state', 'env']) {
      expect(refuseProviderModuleCall(noun, 'x')).toMatch(/session noun/)
    }
    expect(
      refuseProviderModuleUses({
        events: [],
        calls: ['store.get', 'http.fetch'],
      }),
    ).toBeNull()
    expect(refuseProviderModuleUses({ events: [], calls: ['ui.log'] })).toMatch(/\$\.ui is a session noun/)
  })
})
