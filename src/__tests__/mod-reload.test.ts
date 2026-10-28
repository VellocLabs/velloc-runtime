/**
 * Enable, disable and reload a mod without restarting the session (F-25): `ModRuntime.reconcile` closes removed
 * modules and loads added ones at the end of the chain (`session.start` for them alone); `reload` reloads only the
 * modules whose text changed. The hub's `mods.reload` is `full` only.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { ConnectionHub } from '../browser/runtimeHub/ConnectionHub'
import { registerModsCapability } from '../browser/runtimeHub/modsCapability'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import type { RuntimeContext } from '../browser/runtimeHub/types'
import { WORKER_ACTION_SCOPES } from '../browser/runtimeHub/sessionSurface'
import type { WebUiBridgeContext } from '../browser/worker/webUiBridge'
import { MODS_ACTION_SCOPES, RUNTIME_PROTOCOL_VERSION, type Frame, type HelloFrame, type ResFrame } from '../browser/runtimeProtocol'
import type { FrameTransport } from '../browser/runtimeTransport'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
  vi.restoreAllMocks()
})

type Worker = ModWorkerHandle & { closedCalls: number }

/** A slot over mutable module texts, keyed by plugin name. */
function world(
  initial: Record<string, string>,
  options: { compile?: (ref: ModModuleRef, source: string) => Promise<string> } = {},
) {
  const texts = new Map<string, string>()
  const pathOf = (plugin: string): string => `/plugins/${plugin}/hooks/register.js`
  const refOf = (plugin: string): ModModuleRef => ({ plugin, path: pathOf(plugin), root: `/plugins/${plugin}` })
  const wrap = (plugin: string, body: string): string =>
    `export function register(on) {\n${body}\n}\n// ${plugin}`
  for (const [plugin, body] of Object.entries(initial)) texts.set(pathOf(plugin), wrap(plugin, body))
  const reports: string[] = []
  const workers: Record<string, Worker[]> = {}
  const statusChanges: number[] = []
  const commandChanges: number[] = []
  const runtime = new ModRuntime({
    modules: Object.keys(initial).map(refOf),
    readModule: async path => {
      const text = texts.get(path)
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    openWorker: async (plugin): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      const worker: Worker = {
        port: channel.port1,
        closed,
        closedCalls: 0,
        close: () => {
          worker.closedCalls += 1
          settle({ reason: 'closed' })
        },
      }
      ;(workers[plugin] ??= []).push(worker)
      return worker
    },
    ...(options.compile ? { compile: options.compile } : {}),
    session: { id: () => 'sess-reload', cwd: () => '/work/project' },
    report: line => reports.push(line),
    onStatusChanged: () => statusChanges.push(Date.now()),
    onCommandsChanged: () => commandChanges.push(Date.now()),
  })
  runtimes.push(runtime)
  return {
    runtime,
    reports,
    workers,
    statusChanges,
    commandChanges,
    refOf,
    pathOf,
    /** Rewrite a plugin's module text (what a reload compares). */
    write(plugin: string, body: string) {
      texts.set(pathOf(plugin), wrap(plugin, body))
    },
    /** Set the text at `path` as it is (a plugin's second module, an entry
     *  that imports). */
    writeAt(path: string, text: string) {
      texts.set(path, text)
    },
  }
}

/** A `session.start` hook that counts its runs in `$.state` and registers `/name`. */
const starter = (name: string): string => `
  on('session.start', async ($, e, next) => {
    const ref = { plugin: $.plugin.name, key: 'starts' }
    const { value } = await $.state.get(ref)
    await $.state.set(ref, (value ?? 0) + 1)
    await $.ui.status('${name} up')
    await $.command.register({ name: '${name}', description: 'From ${name}.' })
    return next(e)
  })
  on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + ' [${name}]' }))
`

const starts = (runtime: ModRuntime, plugin: string): unknown => runtime.state.get({ plugin, key: 'starts' }).value
const generations = (runtime: ModRuntime): Array<[string, number | undefined, string]> =>
  runtime.status().map(row => [row.plugin, row.generation, row.state])

describe('ModRuntime.reconcile — enable and disable mid-session', () => {
  it('a module newly listed loads at the end of the chain and session.start is raised for it alone', async () => {
    const w = world({ a: starter('a') })
    await w.runtime.ready
    expect(starts(w.runtime, 'a')).toBe(1)

    w.write('b', starter('b'))
    const outcome = await w.runtime.reconcile([w.refOf('a'), w.refOf('b')])
    expect(outcome).toEqual({ added: [w.pathOf('b')], removed: [], reloaded: [] })
    expect(generations(w.runtime)).toEqual([['a', 1, 'loaded'], ['b', 1, 'loaded']])
    // b's start ran once; a's did not run again.
    expect(starts(w.runtime, 'b')).toBe(1)
    expect(starts(w.runtime, 'a')).toBe(1)
    expect(w.runtime.listRegisteredCommands().map(c => c.name)).toEqual(['a', 'b'])
    expect(w.runtime.ui.snapshot().status).toEqual([{ plugin: 'a', text: 'a up' }, { plugin: 'b', text: 'b up' }])
    // The chain runs in seat order: a first, then b.
    const entered = await w.runtime.promptSubmit('hi')
    expect(entered).toMatchObject({ text: 'hi [a] [b]' })
  })

  it('a session that had no loaded module gains one by reconcile, and its session.start runs', async () => {
    const w = world({})
    await w.runtime.ready
    expect(w.runtime.status()).toEqual([])
    w.write('late', starter('late'))
    await w.runtime.reconcile([w.refOf('late')])
    expect(generations(w.runtime)).toEqual([['late', 1, 'loaded']])
    expect(starts(w.runtime, 'late')).toBe(1)
  })

  it('a module no longer listed is removed: its worker closes, its commands and status lines go, the rest keep their seats', async () => {
    const w = world({ a: starter('a'), b: starter('b'), c: starter('c') })
    await w.runtime.ready
    expect(w.runtime.listRegisteredCommands().map(c => c.name)).toEqual(['a', 'b', 'c'])
    const statusBefore = w.statusChanges.length
    const commandsBefore = w.commandChanges.length

    const outcome = await w.runtime.reconcile([w.refOf('a'), w.refOf('c')])
    expect(outcome).toEqual({ added: [], removed: [w.pathOf('b')], reloaded: [] })
    expect(generations(w.runtime)).toEqual([['a', 1, 'loaded'], ['c', 1, 'loaded']])
    expect(w.workers.b![0]!.closedCalls).toBe(1)
    expect(w.workers.a![0]!.closedCalls).toBe(0)
    expect(w.workers.c![0]!.closedCalls).toBe(0)
    expect(w.runtime.listRegisteredCommands().map(c => c.name)).toEqual(['a', 'c'])
    expect(w.runtime.ui.snapshot().status).toEqual([{ plugin: 'a', text: 'a up' }, { plugin: 'c', text: 'c up' }])
    expect(w.statusChanges.length).toBeGreaterThan(statusBefore)
    expect(w.commandChanges.length).toBeGreaterThan(commandsBefore)
    expect(w.reports).toContain(`b: the hooks module was removed (${w.pathOf('b')})`)
    // The chain no longer visits b.
    expect(await w.runtime.promptSubmit('hi')).toMatchObject({ text: 'hi [a] [c]' })
    // Nobody's session.start ran again.
    expect([starts(w.runtime, 'a'), starts(w.runtime, 'c')]).toEqual([1, 1])
  })

  it('removing the last module leaves an empty, live slot that a later enable fills', async () => {
    const w = world({ a: starter('a') })
    await w.runtime.ready
    await w.runtime.reconcile([])
    expect(w.runtime.status()).toEqual([])
    expect(w.workers.a![0]!.closedCalls).toBe(1)
    expect(w.runtime.listRegisteredCommands()).toEqual([])
    expect(await w.runtime.promptSubmit('hi')).toMatchObject({ text: 'hi' })
    await w.runtime.reconcile([w.refOf('a')])
    expect(generations(w.runtime)).toEqual([['a', 1, 'loaded']])
    expect(w.workers.a).toHaveLength(2)
    // A fresh seat, a fresh generation count: the removed seat is forgotten.
    expect(starts(w.runtime, 'a')).toBe(2)
  })

  it('a module listed whose text did not change is left alone by reconcile without reloadChanged', async () => {
    const w = world({ a: starter('a') })
    await w.runtime.ready
    w.write('a', starter('a2'))
    const outcome = await w.runtime.reconcile([w.refOf('a')])
    expect(outcome).toEqual({ added: [], removed: [], reloaded: [] })
    expect(generations(w.runtime)).toEqual([['a', 1, 'loaded']])
    expect(w.workers.a).toHaveLength(1)
  })

  it('two reconciles in flight run one after the other, and the last list wins', async () => {
    const w = world({ a: starter('a') })
    await w.runtime.ready
    w.write('b', starter('b'))
    w.write('c', starter('c'))
    const first = w.runtime.reconcile([w.refOf('a'), w.refOf('b')])
    const second = w.runtime.reconcile([w.refOf('a'), w.refOf('c')])
    expect(await first).toEqual({ added: [w.pathOf('b')], removed: [], reloaded: [] })
    expect(await second).toEqual({ added: [w.pathOf('c')], removed: [w.pathOf('b')], reloaded: [] })
    expect(generations(w.runtime)).toEqual([['a', 1, 'loaded'], ['c', 1, 'loaded']])
    expect(w.workers.b![0]!.closedCalls).toBe(1)
  })

  it('a plugin\'s second module keeps its own seat and commands when its first is removed, and a new one takes a free key', async () => {
    const w = world({ a: starter('a') })
    await w.runtime.ready
    const ref = (file: string): ModModuleRef => ({ plugin: 'p', path: `/plugins/p/hooks/${file}.js`, root: '/plugins/p' })
    for (const file of ['one', 'two', 'three']) {
      w.writeAt(ref(file).path, `export function register(on) {\n${starter(file)}\n}\n// ${file}`)
    }
    await w.runtime.reconcile([w.refOf('a'), ref('one'), ref('two')])
    expect(w.runtime.listRegisteredCommands().map(c => c.name)).toEqual(['a', 'one', 'two'])
    // Removing `one` takes its command alone: `two` registered its own.
    await w.runtime.reconcile([w.refOf('a'), ref('two'), ref('three')])
    expect(w.runtime.listRegisteredCommands().map(c => c.name).sort()).toEqual(['a', 'three', 'two'])
    // `three` did not land on `two`'s key: both their hooks run.
    expect(await w.runtime.promptSubmit('hi')).toMatchObject({ text: 'hi [a] [two] [three]' })
  })

  it('reconcile on a disposed runtime does nothing and never rejects', async () => {
    const w = world({ a: starter('a') })
    await w.runtime.ready
    w.runtime.dispose()
    w.write('b', starter('b'))
    await expect(w.runtime.reconcile([w.refOf('a'), w.refOf('b')])).resolves.toEqual({
      added: [],
      removed: [],
      reloaded: [],
    })
    expect(w.workers.b).toBeUndefined()
  })
})

describe('ModRuntime.reload — changed modules only', () => {
  it('loads again, one generation on, the modules whose text changed; the others keep worker and generation', async () => {
    const w = world({ a: starter('a'), b: starter('b') })
    await w.runtime.ready
    w.write('b', starter('b2'))
    const outcome = await w.runtime.reload()
    expect(outcome).toEqual({ added: [], removed: [], reloaded: [w.pathOf('b')] })
    // Seat order is kept; only b's generation moved.
    expect(generations(w.runtime)).toEqual([['a', 1, 'loaded'], ['b', 2, 'loaded']])
    expect(w.workers.a).toHaveLength(1)
    expect(w.workers.b).toHaveLength(2)
    expect(w.workers.b![0]!.closedCalls).toBe(1)
    // session.start ran again for b alone; b's old command is gone, the new one listed.
    expect([starts(w.runtime, 'a'), starts(w.runtime, 'b')]).toEqual([1, 2])
    expect(w.runtime.listRegisteredCommands().map(c => c.name)).toEqual(['a', 'b2'])
    expect(w.runtime.ui.snapshot().status).toEqual([{ plugin: 'a', text: 'a up' }, { plugin: 'b', text: 'b2 up' }])
    // The new text's hooks are in effect, in b's seat.
    expect(await w.runtime.promptSubmit('hi')).toMatchObject({ text: 'hi [a] [b2]' })
    expect(w.reports).toContain('b: the hooks module was reloaded (generation 2)')
  })

  it('a reload queued behind a disable does not bring the disabled module back', async () => {
    const w = world({ a: starter('a'), b: starter('b') })
    await w.runtime.ready
    const disable = w.runtime.reconcile([w.refOf('a')])
    const reload = w.runtime.reload()
    await disable
    expect(await reload).toEqual({ added: [], removed: [], reloaded: [] })
    expect(generations(w.runtime)).toEqual([['a', 1, 'loaded']])
    expect(w.workers.b).toHaveLength(1)
  })

  it('a compiled module whose entry is unchanged reloads when a file it imports changed', async () => {
    const dep = { tag: 'v1' }
    const w = world({}, {
      // A stand-in for the compiler: the import is linked in from `dep`.
      compile: async (_ref, source) =>
        source.replace(/^import .*$/m, `const tag = ${JSON.stringify(dep.tag)}`),
    })
    const path = '/plugins/c/hooks/register.js'
    w.writeAt(path, `import { tag } from './tag'\nexport function register(on) {\n  on('prompt.submit', ($, e, next) => next({ ...e, text: e.text + ' ' + tag }))\n}\n`)
    await w.runtime.ready
    await w.runtime.reconcile([{ plugin: 'c', path, root: '/plugins/c' }])
    expect(await w.runtime.promptSubmit('hi')).toMatchObject({ text: 'hi v1' })
    expect(await w.runtime.reload()).toEqual({ added: [], removed: [], reloaded: [] })
    dep.tag = 'v2'
    expect(await w.runtime.reload()).toEqual({ added: [], removed: [], reloaded: [path] })
    expect(await w.runtime.promptSubmit('hi')).toMatchObject({ text: 'hi v2' })
  })

  it('with nothing changed, reload does nothing: no worker closes, no session.start, no report', async () => {
    const w = world({ a: starter('a'), b: starter('b') })
    await w.runtime.ready
    const reportsBefore = w.reports.length
    expect(await w.runtime.reload()).toEqual({ added: [], removed: [], reloaded: [] })
    expect(generations(w.runtime)).toEqual([['a', 1, 'loaded'], ['b', 1, 'loaded']])
    expect(w.workers.a).toHaveLength(1)
    expect(w.workers.b).toHaveLength(1)
    expect([starts(w.runtime, 'a'), starts(w.runtime, 'b')]).toEqual([1, 1])
    expect(w.reports).toHaveLength(reportsBefore)
  })

  it('$.state survives a reload — the module\'s own variables start over, the host\'s values stay', async () => {
    const w = world({
      a: `
        let local = 0
        on('session.start', async ($, e, next) => {
          local += 1
          const ref = { plugin: 'a', key: 'runs' }
          const { value } = await $.state.get(ref)
          await $.state.set(ref, (value ?? 0) + 1)
          return next(e)
        })
        on('prompt.submit', async ($, e, next) => next({ ...e, text: e.text + ' local=' + local }))
      `,
    })
    await w.runtime.ready
    expect(starts(w.runtime, 'a')).toBeUndefined()
    expect(w.runtime.state.get({ plugin: 'a', key: 'runs' }).value).toBe(1)
    w.write('a', `
        let local = 0
        on('session.start', async ($, e, next) => {
          local += 1
          const ref = { plugin: 'a', key: 'runs' }
          const { value } = await $.state.get(ref)
          await $.state.set(ref, (value ?? 0) + 1)
          return next(e)
        })
        on('prompt.submit', async ($, e, next) => next({ ...e, text: e.text + ' v2 local=' + local }))
      `)
    await w.runtime.reload()
    expect(w.runtime.state.get({ plugin: 'a', key: 'runs' }).value).toBe(2)
    expect(await w.runtime.promptSubmit('x')).toMatchObject({ text: 'x v2 local=1' })
  })

  it('a changed module that now fails to load leaves its seat failed at the new generation; the others go on', async () => {
    const w = world({ a: starter('a'), b: starter('b') })
    await w.runtime.ready
    w.write('b', `throw new Error('boom at register')`)
    const outcome = await w.runtime.reload()
    expect(outcome.reloaded).toEqual([w.pathOf('b')])
    const rows = w.runtime.status()
    expect(rows.map(row => row.plugin)).toEqual(['a', 'b'])
    expect(rows[1]).toMatchObject({ plugin: 'b', generation: 2 })
    expect(rows[1]!.state).not.toBe('loaded')
    expect(w.runtime.listRegisteredCommands().map(c => c.name)).toEqual(['a'])
    expect(await w.runtime.promptSubmit('hi')).toMatchObject({ text: 'hi [a]' })
  })

  it('a module whose text cannot be read any more is left as it is', async () => {
    const w = world({ a: starter('a') })
    await w.runtime.ready
    const unreadable = world({})
    unreadable.runtime.dispose()
    // Replace the read with a failing one for a's path.
    const readModule = (w.runtime as unknown as { options: { readModule: (path: string) => Promise<string> } }).options
    const original = readModule.readModule
    readModule.readModule = async () => {
      throw new Error('EACCES')
    }
    try {
      expect(await w.runtime.reload()).toEqual({ added: [], removed: [], reloaded: [] })
      expect(generations(w.runtime)).toEqual([['a', 1, 'loaded']])
    } finally {
      readModule.readModule = original
    }
  })
})

// ── the hub: `mods.reload` is full-only ────────────────────────────────────────

type End = FrameTransport & { peer: End | null; emit(frame: Frame): void }

function loopback(): { client: End; server: End } {
  const makeEnd = (): End => {
    const frameListeners = new Set<(frame: Frame) => void>()
    const closedListeners = new Set<(reason: string, retryable: boolean) => void>()
    let isClosed = false
    const end = {
      kind: 'message-port',
      limits: { chunkBytes: 4, windowChunks: Number.POSITIVE_INFINITY },
      peer: null as End | null,
      emit: (frame: Frame) => frameListeners.forEach(listener => listener(frame)),
      bufferedBytes: () => 0,
      send(frame: Frame) {
        if (isClosed) return
        const peer = end.peer
        queueMicrotask(() => peer?.emit(frame))
      },
      sendBlobChunk() {},
      onFrame(listener: (frame: Frame) => void) {
        frameListeners.add(listener)
        return () => {
          frameListeners.delete(listener)
        }
      },
      onBlobChunk() {
        return () => {}
      },
      onClosed(listener: (reason: string, retryable: boolean) => void) {
        closedListeners.add(listener)
        return () => {
          closedListeners.delete(listener)
        }
      },
      close() {
        if (isClosed) return
        isClosed = true
        closedListeners.forEach(listener => listener('closed', false))
      },
    }
    return end as unknown as End
  }
  const client = makeEnd()
  const server = makeEnd()
  client.peer = server
  server.peer = client
  return { client, server }
}

function hubRig() {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const webUiBridge: WebUiBridgeContext = { homeDir: '/home/t', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null }
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/home/t',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => [],
    webUiBridge,
  }
  let nextId = 1
  const hub = new ConnectionHub({
    registry,
    broker,
    context,
    runtimeVersion: 'test-1',
    bootstrap: () => ({ homeDir: context.homeDir, platform: 'test', pathSep: '/' }),
    createId: () => `id-${nextId++}`,
  })
  context.connections = () => hub.list()
  const reloadAll = vi.fn()
  registerModsCapability(registry, broker, { reloadAll })
  const ends = loopback()
  hub.attach(ends.server)
  const pending = new Map<string, (res: ResFrame) => void>()
  ends.client.onFrame((frame: Frame) => {
    if (frame.kind === 'res') pending.get(frame.id)?.(frame)
  })
  let requestId = 1
  const client = {
    hello(overrides: Partial<HelloFrame> = {}): Promise<Frame> {
      return new Promise(resolve => {
        const unsubscribe = ends.client.onFrame((frame: Frame) => {
          if (frame.kind === 'welcome' || frame.kind === 'bye') {
            unsubscribe()
            resolve(frame)
          }
        })
        ends.client.send({
          kind: 'hello',
          v: RUNTIME_PROTOCOL_VERSION,
          client: { clientId: 'client-A', kind: 'desktop-shell' },
          auth: { mode: 'local' },
          ...overrides,
        })
      })
    },
    request(route: string, payload?: unknown): Promise<ResFrame> {
      const id = `r${requestId++}`
      const promise = new Promise<ResFrame>(resolve => pending.set(id, resolve))
      ends.client.send({ kind: 'req', id, route: route as never, payload })
      return promise
    },
  }
  return { registry, client, reloadAll }
}

describe('mods.reload over the hub', () => {
  it('is a full-scope action, like the worker\'s reloadMods', () => {
    expect(MODS_ACTION_SCOPES.reload).toBe('full')
    expect(WORKER_ACTION_SCOPES.reloadMods).toBe('full')
  })

  it('is refused below full and advertised to full alone', async () => {
    const rig = hubRig()
    for (const mode of ['observe', 'control', 'manager'] as const) {
      const acts = rig.registry.advertise({ mode, sessions: 'all' }).find(c => c.cap === 'mods')?.acts ?? []
      expect(acts, mode).toContain('list')
      expect(acts, mode).not.toContain('reload')
    }
    expect(rig.registry.advertise({ mode: 'full', sessions: 'all' }).find(c => c.cap === 'mods')?.acts).toContain('reload')
    await rig.client.hello({ scopeCeiling: 'manager' })
    const refused = await rig.client.request('mods.reload', {})
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.error.code).toBe('forbidden_scope')
    expect(rig.reloadAll).not.toHaveBeenCalled()
  })

  it('a full connection reloads every session\'s changed mods', async () => {
    const rig = hubRig()
    await rig.client.hello()
    const ok = await rig.client.request('mods.reload', {})
    expect(ok.ok).toBe(true)
    expect(rig.reloadAll).toHaveBeenCalledTimes(1)
    const bad = await rig.client.request('mods.reload', { sessionId: 's1' })
    expect(bad.ok === false && bad.error.code).toBe('bad_payload')
  })
})

// ── the wiring, pinned at the text ──────────────────────────────────────────────

describe('the session follows its plugin set (source pin)', () => {
  const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

  it('createAgentRuntime reconciles the mods inside onReloadPlugins, after the active plugin paths moved', () => {
    const source = read('browser/runtime/createAgentRuntime.ts')
    const reload = source.indexOf('const onReloadPlugins = async')
    const moved = source.indexOf('activePluginPaths = reloadContributions.plugins.map', reload)
    const reconciled = source.indexOf('await reconcileMods(reloadContributions.plugins)', moved)
    expect(reload).toBeGreaterThan(-1)
    expect(moved).toBeGreaterThan(reload)
    expect(reconciled).toBeGreaterThan(moved)
    // A slot that gains or loses its runtime tells the engine, through the
    // public setter, never by reaching into its config.
    expect(source).toContain('engineForMods?.setMods(mods)')
    expect(source).toContain('engineForMods?.setMods(undefined)')
    expect(source).not.toMatch(/engineForMods\.config\b/)
  })

  it('onReloadPlugins hands the new plugin servers to the pool only from the session that keys it, under the scope the pool was built with', () => {
    const source = read('browser/runtime/createAgentRuntime.ts')
    const reload = source.indexOf('const onReloadPlugins = async')
    const stored = source.indexOf('const changedMcpSecrets = await storeMcpSecrets(reloadContributions)', reload)
    const gate = source.indexOf('if (mcpLease && mcpLease.topLevelSessionId === resolvedSessionId) {', stored)
    const followed = source.indexOf('await mcpPool.followPluginReload(', gate)
    const handed = source.indexOf('changedMcpSecrets,', followed)
    expect(stored).toBeGreaterThan(reload)
    expect(gate).toBeGreaterThan(stored)
    expect(followed).toBeGreaterThan(gate)
    expect(handed).toBeGreaterThan(followed)
    const gated = source.slice(gate, followed)
    expect(gated).toContain('pluginNativeMcpServers = pluginNativeMcpServersInScope(')
    expect(gated).toContain('reloadContributions.nativeMcpServers')
    expect(source.slice(followed, handed)).toContain('pluginMcpServersInScope(mcpScope, reloadContributions.mcpServers')
  })

  it('a runtime built by a reload loads the list it was given, not the list the session booted with; reloads are serialized', () => {
    const source = read('browser/runtime/createAgentRuntime.ts')
    const build = source.indexOf('const buildModRuntime = async')
    const constructed = source.indexOf('new ModRuntime({', build)
    expect(build).toBeGreaterThan(-1)
    expect(source.slice(constructed, constructed + 80)).toMatch(/new ModRuntime\(\{\s*modules,/)
    expect(source).toMatch(/reconcilingMods\.then\(\(\) => reconcileModsNow\(plugins\)\)/)
  })

  it('the worker answers worker.reloadMods with the engine\'s reloadMods, and the session manager fans it out', () => {
    expect(read('browser/worker/AgentRuntimeWorker.ts')).toMatch(/worker\.reloadMods/)
    expect(read('browser/worker/AgentRuntimeWorker.ts')).toMatch(/engine\.reloadMods\(\)/)
    expect(read('browser/worker/SharedWorkerSessionManager.ts')).toMatch(/reloadModsOnAllSessions/)
    expect(read('browser/runtimeHub/RuntimeHub.ts')).toMatch(/reloadModsOnAllSessions/)
  })
})
