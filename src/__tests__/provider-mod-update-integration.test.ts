/**
 * Provider mods, the update flow end to end in one realm: a check parks a wider version; consent activates it
 * without losing an in-flight call; later calls hit the new module; rollback returns; a version the runtime would
 * refuse is refused at update time. The https fetch is injected (`servedFetch`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetCustomProviderRecords } from '../config/customProviderRegistry'
import { resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { registerProviderUpdatesCapability } from '../browser/runtimeHub/providerUpdatesCapability'
import type { ConnectionInfo } from '../browser/runtimeHub/types'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import { ProviderModHost } from '../mods/provider/providerModHost'
import { createProviderModAdmit } from '../mods/provider/providerModUpdateWiring'
import { providerModuleLoaders } from '../mods/provider/providerModuleLoaders'
import { installFromHttps } from '../pluginHost/httpsSource'
import { forgetRegistryFile } from '../pluginHost/installedRegistry'
import { assemblePluginAt } from '../pluginHost/loadPlugins'
import { forgetCatalogs } from '../pluginHost/marketplaces'
import { createProviderModUpdateService } from '../pluginHost/providerModUpdates'
import { PROVIDER_UPDATES_TOPIC, type ProviderUpdatesState } from '../pluginHost/providerUpdatesProtocol'
import { wipeSettingsMemos } from '../settings/settingsStore'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { makeMemFs } from './_helpers/memFs'
import { pluginArchive, providerJson, servedFetch, type Served } from './_helpers/pluginArchive'

const HOME = '/home/u'
const URL_A = 'https://plugins.acme.test/acme.tar.gz'
const ID = 'acme@direct'
const DIR = `${HOME}/.velloc/plugins/cache/direct/acme`
const PROVIDER_ID = 'mod.acme.main'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(5)
  }
}

const ports: MessagePort[] = []
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  for (const port of ports.splice(0)) port.close()
  resetModProviderDefinitions()
  resetCustomProviderRecords()
})
beforeEach(() => {
  forgetRegistryFile()
  forgetCatalogs()
  wipeSettingsMemos()
})

/** A provider module that answers `provider.models` with `tag` after `waitMs`. */
const moduleText = (tag: string, waitMs: number, extra = ''): string => `
  export function register(on) {
    ${extra}
    on('provider.models', async ($) => { await $.clock.sleep(${waitMs}); return ['${tag}'] })
  }
`

async function build() {
  const fs = makeMemFs()
  const fsWithStat = {
    ...fs,
    async stat(path: string) {
      const norm = path.replace(/\\/g, '/').replace(/\/+$/, '')
      if (fs.dump().some(key => key === norm || key.startsWith(`${norm}/`))) return {} as never
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
  } as unknown as RuntimeFs & { dump(): string[] }
  const served = new Map<string, Served>()
  const fetchImpl = servedFetch(served)
  const reports: string[] = []
  const log: string[] = []
  let opened = 0

  const publish = async (version: string, over: Record<string, unknown>, text: string) => {
    served.set(URL_A, {
      body: await pluginArchive({
        version,
        providers: { main: providerJson({ updates: { url: URL_A }, ...over }) },
        files: [{ name: 'providers/main.js', content: text }],
      }),
    })
  }
  await publish('1.0.0', {}, moduleText('v1', 400))
  await installFromHttps({ homeDir: HOME }, fsWithStat, { url: URL_A }, { fetchImpl })

  const loaders = providerModuleLoaders({ homeDir: HOME, fs: fsWithStat, report: line => reports.push(line) })
  const runtime = new ProviderModRuntime({
    readModule: loaders.readModule,
    ...(loaders.compile ? { compile: loaders.compile } : {}),
    ...(loaders.scan ? { scan: loaders.scan } : {}),
    openWorker: async ref => {
      const id = ++opened
      log.push(`open#${id}:${ref.path.split('/').slice(-3, -2)[0]}`)
      const channel = new MessageChannel()
      ports.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      void closed.then(c => log.push(`closed#${id}:${c.reason}`))
      const worker: ModWorkerHandle = { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      return worker
    },
    window: { available: () => true, attached: async () => {} },
    report: line => reports.push(line),
  })
  disposers.push(() => runtime.dispose())

  const host = new ProviderModHost()
  host.configure({
    createRuntime: async () => runtime,
    readText: async () => {
      throw new Error('no icon')
    },
    report: line => reports.push(line),
    adopt: async () => {},
    publish: async () => {},
    hasStoredConfigs: () => false,
  })
  disposers.push(() => host.dispose())
  const { plugin } = await assemblePluginAt(`${DIR}/1.0.0`, `marketplace:${ID}`, true, 'acme', fsWithStat)
  plugin.installIdentifier = ID
  await host.sync({ enabled: [plugin], disabled: [] })

  const service = createProviderModUpdateService({
    ctx: { homeDir: HOME },
    fs: fsWithStat,
    fetchImpl,
    host,
    admit: createProviderModAdmit({ homeDir: HOME, fs: fsWithStat, report: line => reports.push(line) }),
    report: line => reports.push(line),
  })

  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  registerProviderUpdatesCapability(registry, broker, {
    acquire: async () => service,
    onChanged: listener => service.subscribe(listener),
    report: line => reports.push(line),
  })
  const conn = { connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port' } as ConnectionInfo
  const deltas: ProviderUpdatesState[] = []
  await broker.subscribe(
    { conn, send: evt => deltas.push((evt as unknown as { payload: ProviderUpdatesState }).payload), bufferedBytes: () => 0 },
    PROVIDER_UPDATES_TOPIC,
  )
  const ask = async (act: string, payload: Record<string, string> = {}): Promise<any> => {
    const entry = registry.resolve('providerUpdates', act)!
    expect(entry.spec.guard?.(payload, conn, {} as never) ?? true).toBe(true)
    return entry.handle({ id: '1', route: { cap: 'providerUpdates', act }, payload, conn } as never, {} as never)
  }
  return { fs: fsWithStat, publish, runtime, host, service, ask, deltas, reports, log, served }
}

describe('provider mod updates, through the protocol', () => {
  it('a wider version is parked with its delta; consent swaps it without losing a call in flight; rollback returns', async () => {
    const w = await build()
    await w.ask('baseline', { pluginId: ID })
    expect(await w.runtime.call(PROVIDER_ID, 'provider.models', {})).toEqual({ raised: true, value: ['v1'] })
    // A call on v1 that is still running when the swap happens.
    const inFlight = w.runtime.call(PROVIDER_ID, 'provider.models', {})
    await sleep(60)

    await w.publish('2.0.0', { domains: ['api.acme.test', 'cdn.acme.test'] }, moduleText('v2', 1))
    const checked = await w.ask('check', { pluginId: ID })
    expect(checked.plugins[0]).toMatchObject({ state: 'needs-consent', activeVersion: '1.0.0', pending: { version: '2.0.0' } })
    expect(checked.plugins[0].pending.delta.added.perProvider.main.domains).toEqual(['cdn.acme.test'])
    // The topic carried the same: the parked version and its widened grant.
    await until(() => w.deltas.some(d => d.plugins[0]?.state === 'needs-consent'))
    expect(w.runtime.status().map(s => s.path)).toEqual([`${DIR}/1.0.0/providers/main.js`])

    const consented = await w.ask('consent', { pluginId: ID, version: '2.0.0' })
    expect(consented.status).toMatchObject({ state: 'up-to-date', activeVersion: '2.0.0', rollbackVersion: '1.0.0' })
    expect(w.runtime.status().map(s => s.path)).toEqual([`${DIR}/2.0.0/providers/main.js`])
    expect(w.runtime.draining()).toHaveLength(1)

    // New calls: v2. The call that was on v1: v1's answer.
    expect(await w.runtime.call(PROVIDER_ID, 'provider.models', {})).toEqual({ raised: true, value: ['v2'] })
    expect(await inFlight).toEqual({ raised: true, value: ['v1'] })
    await until(() => w.runtime.draining().length === 0)
    expect(w.log.filter(line => line.startsWith('closed#')).length).toBeGreaterThanOrEqual(1)
    await until(() => w.deltas.at(-1)?.plugins[0]?.activeVersion === '2.0.0')

    const back = await w.ask('rollback', { pluginId: ID })
    expect(back.status).toMatchObject({ activeVersion: '1.0.0' })
    expect(await w.runtime.call(PROVIDER_ID, 'provider.models', {})).toEqual({ raised: true, value: ['v1'] })
    await until(() => w.deltas.at(-1)?.plugins[0]?.activeVersion === '1.0.0')
  })

  it('declining a parked version drops it, and the old one keeps serving', async () => {
    const w = await build()
    await w.ask('baseline', { pluginId: ID })
    await w.publish('2.0.0', { domains: ['api.acme.test', 'cdn.acme.test'] }, moduleText('v2', 1))
    await w.ask('check', {})
    const declined = await w.ask('decline', { pluginId: ID, version: '2.0.0' })
    expect(declined.status.state).not.toBe('needs-consent')
    expect(declined.status.pending).toBeUndefined()
    expect(await w.runtime.call(PROVIDER_ID, 'provider.models', {})).toEqual({ raised: true, value: ['v1'] })
    await expect(w.ask('consent', { pluginId: ID, version: '2.0.0' })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('a version the runtime would refuse (it hooks a session event) is refused at update time, the old one serving', async () => {
    const w = await build()
    await w.ask('baseline', { pluginId: ID })
    await w.publish('2.0.0', {}, moduleText('v2', 1, "on('session.start', () => {})"))
    const checked = await w.ask('check', { pluginId: ID })
    expect(checked.plugins[0]).toMatchObject({
      activeVersion: '1.0.0',
      failure: { kind: 'admission', version: '2.0.0' },
    })
    expect(checked.plugins[0].failure.reason).toMatch(/session\.start/)
    expect(await w.runtime.call(PROVIDER_ID, 'provider.models', {})).toEqual({ raised: true, value: ['v1'] })
    expect(w.fs.dump().some(path => path.startsWith(`${DIR}/2.0.0/`))).toBe(false)
  })

  it('a version that calls $.session is refused too', async () => {
    const w = await build()
    await w.ask('baseline', { pluginId: ID })
    await w.publish(
      '2.0.0',
      {},
      "export function register(on) { on('provider.models', async ($) => { await $.session.cwd(); return [] }) }",
    )
    const checked = await w.ask('check', {})
    expect(checked.plugins[0].failure).toMatchObject({ kind: 'admission' })
    expect(checked.plugins[0].activeVersion).toBe('1.0.0')
  })

  it('an unreachable source is a recorded fetch failure the page can show, not an error', async () => {
    const w = await build()
    await w.ask('baseline', { pluginId: ID })
    w.served.delete(URL_A)
    const checked = await w.ask('check', { pluginId: ID })
    expect(checked.plugins[0]).toMatchObject({ state: 'failed', failure: { kind: 'fetch' } })
    expect(await w.runtime.call(PROVIDER_ID, 'provider.models', {})).toEqual({ raised: true, value: ['v1'] })
  })
})
