/**
 * Provider mods (PM-9a) — the update service. Fake fs, fetch, clock and host;
 * real extraction, manifest checking, grant comparison and registry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetRegistryFile, loadInstalledPlugins } from '../pluginHost/installedRegistry'
import { installFromHttps, sha256Of } from '../pluginHost/httpsSource'
import { setupPlugin } from '../pluginHost/installSteps'
import { addMarketplace, forgetCatalogs } from '../pluginHost/marketplaces'
import type { PluginInstallPathContext } from '../pluginHost/pluginDirs'
import {
  createProviderModUpdateService,
  startProviderModUpdateSchedule,
  DEFAULT_UPDATE_INTERVAL_MS,
  type ProviderModUpdateService,
  type ProviderModSwapper,
} from '../pluginHost/providerModUpdates'
import { wipeSettingsMemos } from '../settings/settingsStore'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { archive, pluginArchive, providerJson, servedFetch, type Served } from './_helpers/pluginArchive'
import { makeMemFs } from './_helpers/memFs'

const ctx: PluginInstallPathContext = { homeDir: '/home/u' }
const URL_A = 'https://plugins.acme.test/acme.tar.gz'
const ID = 'acme@direct'
const DIR = '/home/u/.velloc/plugins/cache/direct/acme'
const STATE = '/home/u/.velloc/plugins/provider_mod_updates.json'
const T0 = Date.parse('2026-10-09T00:00:00.000Z')

/** The memory fs plus the `stat` the plugin loader asks for. */
function fsWithStat(): ReturnType<typeof makeMemFs> {
  const base = makeMemFs()
  return {
    ...base,
    async stat(path: string) {
      const norm = path.replace(/\\/g, '/').replace(/\/+$/, '')
      if (base.dump().some(key => key === norm || key.startsWith(`${norm}/`))) return {} as never
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
  } as ReturnType<typeof makeMemFs>
}

type World = {
  fs: ReturnType<typeof makeMemFs>
  served: Map<string, Served>
  fetchImpl: ReturnType<typeof servedFetch>
  clock: { t: number }
  host: ProviderModSwapper & { swapPlugin: ReturnType<typeof vi.fn> }
  report: string[]
  service: ProviderModUpdateService
  /** Serve version `version` of the plugin at `url`. */
  publish(version: string, over?: Record<string, unknown>, url?: string): Promise<void>
  active(): Promise<{ installPath: string; version?: string; origin?: unknown }>
  make(over?: { admit?: (p: unknown) => Promise<void> }): ProviderModUpdateService
  paths(): string[]
}

async function world(opts: { updatesUrl?: string; install?: boolean } = {}): Promise<World> {
  const fs = fsWithStat()
  const served = new Map<string, Served>()
  const fetchImpl = servedFetch(served)
  const clock = { t: T0 }
  const host = { isConfigured: () => true, swapPlugin: vi.fn(async () => ({})) }
  const report: string[] = []
  const updatesUrl = opts.updatesUrl ?? URL_A
  const make = (over: { admit?: (p: unknown) => Promise<void> } = {}): ProviderModUpdateService =>
    createProviderModUpdateService({
      ctx,
      fs: fs as unknown as RuntimeFs,
      fetchImpl,
      now: () => clock.t,
      host,
      report: line => report.push(line),
      ...(over.admit ? { admit: over.admit as never } : {}),
    })
  const w: World = {
    fs,
    served,
    fetchImpl,
    clock,
    host,
    report,
    service: make(),
    make,
    async publish(version, over = {}, url = URL_A) {
      served.set(url, {
        body: await pluginArchive({
          version,
          providers: { main: providerJson({ updates: { url: updatesUrl }, ...over }) },
        }),
      })
    },
    async active() {
      const { registry } = await loadInstalledPlugins(ctx, fs)
      return registry.plugins[ID]![0]!
    },
    paths: () => fs.dump(),
  }
  if (opts.install !== false) {
    await w.publish('1.0.0')
    await installFromHttps(ctx, fs, { url: URL_A }, { fetchImpl, nowIso: new Date(T0).toISOString() })
    fetchImpl.calls.length = 0
    // The person approved the grant of what they installed (the consent dialog).
    await w.service.recordInitialConsent(ID)
  }
  return w
}

beforeEach(() => {
  forgetRegistryFile()
  forgetCatalogs()
  wipeSettingsMemos()
})

async function statusOf(service: ProviderModUpdateService, id = ID) {
  return (await service.status()).find(s => s.pluginId === id)!
}

describe('a check that finds nothing new', () => {
  it('is up to date, remembers when it looked, and downloads once per archive digest', async () => {
    const w = await world()
    expect(await statusOf(w.service)).toMatchObject({ state: 'unchecked', activeVersion: '1.0.0', source: { url: URL_A } })
    const [status] = await w.service.checkNow()
    expect(status).toMatchObject({ pluginId: ID, state: 'up-to-date', activeVersion: '1.0.0', lastCheckedAt: new Date(T0).toISOString() })
    expect(w.host.swapPlugin).not.toHaveBeenCalled()
    await w.service.checkNow()
    expect(w.paths().filter(p => p.includes('/cache/direct/acme/')).every(p => p.includes('/1.0.0/'))).toBe(true)
  })

  it('a plugin with no providers or no updates entry is listed as no-source or not at all', async () => {
    const w = await world({ install: false })
    await w.publish('1.0.0', { updates: undefined })
    await installFromHttps(ctx, w.fs, { url: URL_A }, { fetchImpl: w.fetchImpl })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'no-source' })
  })
})

describe('an update that does not widen the grant', () => {
  it('is applied silently: the registry points at the new directory, the host swaps, the old directory stays as the rollback', async () => {
    const w = await world()
    await w.publish('1.1.0', { requestNeeds: [] })
    const [status] = await w.service.checkNow()
    expect(status).toMatchObject({ state: 'up-to-date', activeVersion: '1.1.0', rollbackVersion: '1.0.0', applied: { version: '1.1.0', silent: true } })
    const active = await w.active()
    expect(active.installPath).toBe(`${DIR}/1.1.0`)
    expect(active.version).toBe('1.1.0')
    expect(w.host.swapPlugin).toHaveBeenCalledTimes(1)
    const swapped = w.host.swapPlugin.mock.calls[0]![0] as { name: string; path: string; manifest: { version: string }; installIdentifier: string }
    expect(swapped).toMatchObject({ name: 'acme', path: `${DIR}/1.1.0`, installIdentifier: ID })
    expect(swapped.manifest.version).toBe('1.1.0')
    expect(w.paths()).toEqual(expect.arrayContaining([`${DIR}/1.0.0/providers/main.js`, `${DIR}/1.1.0/providers/main.js`]))
  })

  it('a narrowing update, or one that only rewords, is silent too', async () => {
    const w = await world()
    await w.publish('1.1.0', { displayName: { en: 'Acme Renamed' }, settings: { region: { type: 'string', title: { en: 'Region' } } } })
    expect((await w.service.checkNow())[0]).toMatchObject({ activeVersion: '1.1.0', applied: { silent: true } })
  })

  it('keeps one rollback target: the one before it is removed', async () => {
    const w = await world()
    await w.publish('1.1.0')
    await w.service.checkNow()
    await w.publish('1.2.0')
    const [status] = await w.service.checkNow()
    expect(status).toMatchObject({ activeVersion: '1.2.0', rollbackVersion: '1.1.0' })
    expect(w.paths().some(p => p.startsWith(`${DIR}/1.0.0/`))).toBe(false)
    expect(w.paths().some(p => p.startsWith(`${DIR}/1.1.0/`))).toBe(true)
  })
})

describe('an update that widens the grant', () => {
  const WIDER = { domains: ['api.acme.test', 'cdn.acme.test'] }

  it('is fetched and admitted but NOT activated until consent is recorded', async () => {
    const w = await world()
    await w.publish('1.1.0', WIDER)
    const [status] = await w.service.checkNow()
    expect(status).toMatchObject({ state: 'needs-consent', activeVersion: '1.0.0' })
    expect(status!.pending!.version).toBe('1.1.0')
    expect(status!.pending!.delta.added.perProvider.main!.domains).toEqual(['cdn.acme.test'])
    expect((await w.active()).version).toBe('1.0.0')
    expect(w.host.swapPlugin).not.toHaveBeenCalled()
    expect(w.paths()).toContain(`${DIR}/1.1.0/providers/main.js`)
  })

  it('stays parked on later checks, and survives a restart of the service', async () => {
    const w = await world()
    await w.publish('1.1.0', WIDER)
    await w.service.checkNow()
    const again = w.make()
    expect((await again.checkNow())[0]).toMatchObject({ state: 'needs-consent', pending: { version: '1.1.0' } })
    expect(w.host.swapPlugin).not.toHaveBeenCalled()
    expect(JSON.parse(String(await w.fs.readFile(STATE, { encoding: 'utf-8' }))).plugins[ID].pending.version).toBe('1.1.0')
  })

  it('recordConsent activates it; the consent now covers the wider grant', async () => {
    const w = await world()
    await w.publish('1.1.0', WIDER)
    await w.service.checkNow()
    const status = await w.service.recordConsent(ID, '1.1.0')
    expect(status).toMatchObject({ state: 'up-to-date', activeVersion: '1.1.0', rollbackVersion: '1.0.0', applied: { version: '1.1.0', silent: false } })
    expect(status.pending).toBeUndefined()
    expect((await w.active()).installPath).toBe(`${DIR}/1.1.0`)
    expect(w.host.swapPlugin).toHaveBeenCalledTimes(1)
    // The next version with the same wide grant is silent.
    await w.publish('1.2.0', WIDER)
    expect((await w.service.checkNow())[0]).toMatchObject({ activeVersion: '1.2.0', applied: { silent: true } })
  })

  it('recordConsent for a version that is not parked rejects and changes nothing', async () => {
    const w = await world()
    await w.publish('1.1.0', WIDER)
    await w.service.checkNow()
    await expect(w.service.recordConsent(ID, '9.9.9')).rejects.toThrow(/no parked update/)
    await expect(w.service.recordConsent('nobody@direct', '1.1.0')).rejects.toThrow(/not an installed provider mod/)
    expect((await w.active()).version).toBe('1.0.0')
  })

  it.each([
    ['a new secret name', { credentials: { methods: ['apiKey'], secrets: [{ name: 'device_key' }] } }],
    ['readsSecrets turned on', { credentials: { methods: ['apiKey'], readsSecrets: true } }],
    ['a new requestNeeds value', { requestNeeds: ['body'] }],
    ['a new signNeeds value', { signNeeds: 'digest' }],
    ['a new provider id', { __extra: true }],
  ])('%s parks the update', async (_label, over) => {
    const w = await world()
    if ('__extra' in over) {
      await serve(w, '1.1.0', { main: providerJson({ updates: { url: URL_A } }), more: providerJson({ updates: { url: URL_A } }) })
    } else {
      await w.publish('1.1.0', over)
    }
    await w.service.checkNow()
    const status = await statusOf(w.service)
    expect(status.state).toBe('needs-consent')
    expect(status.pending!.delta.widened).toBe(true)
  })

  it('a newer parked version replaces an older parked one, and removes its directory', async () => {
    const w = await world()
    await w.publish('1.1.0', WIDER)
    await w.service.checkNow()
    await w.publish('1.2.0', WIDER)
    const [status] = await w.service.checkNow()
    expect(status!.pending!.version).toBe('1.2.0')
    expect(w.paths().some(p => p.startsWith(`${DIR}/1.1.0/`))).toBe(false)
  })

  it('decline drops it and it is not offered again', async () => {
    const w = await world()
    await w.publish('1.1.0', WIDER)
    await w.service.checkNow()
    expect(await w.service.decline(ID, '1.1.0')).toMatchObject({ state: 'up-to-date', activeVersion: '1.0.0' })
    expect(w.paths().some(p => p.startsWith(`${DIR}/1.1.0/`))).toBe(false)
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'up-to-date', activeVersion: '1.0.0' })
    expect((await statusOf(w.service)).pending).toBeUndefined()
  })
})

async function serve(w: World, version: string, providers: Record<string, Record<string, unknown>>): Promise<void> {
  w.served.set(URL_A, { body: await pluginArchive({ version, providers }) })
}

describe('a failure keeps the old version and is recorded', () => {
  it('a network failure', async () => {
    const w = await world()
    w.served.set(URL_A, { body: 'down', status: 503 })
    const [status] = await w.service.checkNow()
    expect(status).toMatchObject({ state: 'failed', activeVersion: '1.0.0', failure: { kind: 'fetch' } })
    expect(status!.failure!.reason).toMatch(/503/)
    expect(w.host.swapPlugin).not.toHaveBeenCalled()
    // Recovering clears it.
    await w.publish('1.0.0')
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'up-to-date' })
    expect((await statusOf(w.service)).failure).toBeUndefined()
  })

  it('an http redirect target', async () => {
    const w = await world()
    w.served.set(URL_A, { body: await pluginArchive({ version: '1.1.0' }), url: 'http://evil.test/a.tar.gz' })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'failed', failure: { kind: 'fetch' } })
    expect((await w.active()).version).toBe('1.0.0')
  })

  it('an unknown providerApi is refused with a message that names it, and the staged directory is removed', async () => {
    const w = await world()
    await w.publish('2.0.0', { providerApi: 2 })
    const [status] = await w.service.checkNow()
    expect(status).toMatchObject({ state: 'failed', activeVersion: '1.0.0', failure: { kind: 'unsupported-provider-api', version: '2.0.0' } })
    expect(status!.failure!.reason).toContain('providerApi: 2 is not supported')
    expect(w.host.swapPlugin).not.toHaveBeenCalled()
    expect(w.paths().some(p => p.startsWith(`${DIR}/2.0.0/`))).toBe(false)
    expect(w.report.some(line => line.includes('unsupported-provider-api'))).toBe(true)
  })

  it('an unknown requestNeeds word is a manifest failure, not less data', async () => {
    const w = await world()
    await w.publish('1.1.0', { requestNeeds: ['telepathy'] })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'failed', failure: { kind: 'invalid-manifest' } })
  })

  it('a provider module the archive does not carry', async () => {
    const w = await world()
    await w.publish('1.1.0', { module: './providers/missing.js' })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'failed', failure: { kind: 'invalid-manifest' } })
    expect((await w.active()).version).toBe('1.0.0')
  })

  it('an archive for another plugin name', async () => {
    const w = await world()
    w.served.set(URL_A, { body: await pluginArchive({ name: 'other', version: '1.1.0', providers: { main: providerJson({ updates: { url: URL_A } }) } }) })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'failed', failure: { kind: 'name-mismatch' } })
  })

  it('a version with no provider left', async () => {
    const w = await world()
    w.served.set(URL_A, { body: await pluginArchive({ version: '1.1.0', providers: {} }) })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'failed', failure: { kind: 'no-providers' } })
  })

  it('an archive that is not an archive, or has a traversal-shaped version', async () => {
    const w = await world()
    w.served.set(URL_A, { body: 'not a tarball' })
    expect((await w.service.checkNow())[0]).toMatchObject({ failure: { kind: 'invalid-archive' } })
    w.served.set(URL_A, { body: await archive([{ name: '.claude-plugin/plugin.json', content: JSON.stringify({ name: 'acme', version: '../../x' }) }]) })
    expect((await w.service.checkNow())[0]).toMatchObject({ failure: { kind: 'invalid-archive' } })
    // (the install itself wrote the settings override that holds a provider plugin for consent)
    expect(w.paths().filter(p => !p.startsWith('/home/u/.velloc/plugins/') && p !== '/home/u/.velloc/settings.json')).toEqual([])
  })

  it('an admission refusal (the module does not compile) leaves the old version and removes the staged one', async () => {
    const w = await world()
    const service = w.make({ admit: async () => { throw new Error('it did not compile - line 3') } })
    await w.publish('1.1.0')
    const [status] = await service.checkNow()
    expect(status).toMatchObject({ state: 'failed', activeVersion: '1.0.0', failure: { kind: 'admission', reason: 'it did not compile - line 3' } })
    expect(w.paths().some(p => p.startsWith(`${DIR}/1.1.0/`))).toBe(false)
  })

  it('a swap the host refuses puts the registry back', async () => {
    const w = await world()
    w.host.swapPlugin.mockRejectedValueOnce(new Error('registration clash'))
    await w.publish('1.1.0')
    const [status] = await w.service.checkNow()
    expect(status).toMatchObject({ state: 'failed', activeVersion: '1.0.0', failure: { kind: 'activate' } })
    expect((await w.active()).installPath).toBe(`${DIR}/1.0.0`)
  })

  it('a failed later check does not hide a parked update', async () => {
    const w = await world()
    await w.publish('1.1.0', { domains: ['api.acme.test', 'cdn.acme.test'] })
    await w.service.checkNow()
    w.served.set(URL_A, { body: 'down', status: 500 })
    const [status] = await w.service.checkNow()
    expect(status).toMatchObject({ state: 'needs-consent', pending: { version: '1.1.0' }, failure: { kind: 'fetch' } })
  })
})

describe('an update pointer', () => {
  const POINTER = 'https://plugins.acme.test/latest.json'

  it('is read first: an unchanged version downloads no archive', async () => {
    const w = await world({ updatesUrl: POINTER })
    w.served.set(POINTER, { body: JSON.stringify({ version: '1.0.0', archive: 'acme.tar.gz' }), headers: { 'content-type': 'application/json' } })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'up-to-date' })
    expect(w.fetchImpl.calls).toEqual([POINTER])
  })

  it('a new version resolves its archive against the pointer, and the digest pin is enforced', async () => {
    const w = await world({ updatesUrl: POINTER })
    await w.publish('1.1.0', {}, 'https://plugins.acme.test/acme-1.1.0.tar.gz')
    const bytes = w.served.get('https://plugins.acme.test/acme-1.1.0.tar.gz')!.body as Uint8Array
    w.served.set(POINTER, { body: JSON.stringify({ version: '1.1.0', archive: 'acme-1.1.0.tar.gz', sha256: '0'.repeat(64) }) })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'failed', failure: { kind: 'integrity' } })
    w.served.set(POINTER, { body: JSON.stringify({ version: '1.1.0', archive: 'acme-1.1.0.tar.gz', sha256: await sha256Of(bytes) }) })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'up-to-date', activeVersion: '1.1.0' })
    expect((await w.active()).origin).toMatchObject({ source: 'https', url: 'https://plugins.acme.test/acme-1.1.0.tar.gz' })
  })

  it('refuses an archive URL that is not https', async () => {
    const w = await world({ updatesUrl: POINTER })
    w.served.set(POINTER, { body: JSON.stringify({ version: '1.1.0', archive: 'http://evil.test/a.tar.gz' }) })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'failed', failure: { kind: 'fetch' } })
  })
})

describe('rollback', () => {
  it('returns to the previous version, swaps the host, and does not offer the bad version again', async () => {
    const w = await world()
    await w.publish('1.1.0')
    await w.service.checkNow()
    w.host.swapPlugin.mockClear()
    const status = await w.service.rollback(ID)
    expect(status).toMatchObject({ activeVersion: '1.0.0', state: 'up-to-date' })
    expect(status.rollbackVersion).toBeUndefined()
    expect((await w.active()).installPath).toBe(`${DIR}/1.0.0`)
    expect((w.host.swapPlugin.mock.calls[0]![0] as { path: string }).path).toBe(`${DIR}/1.0.0`)
    expect(w.paths().some(p => p.startsWith(`${DIR}/1.1.0/`))).toBe(false)
    // The source still serves 1.1.0: it is skipped, not re-applied.
    expect((await w.service.checkNow())[0]).toMatchObject({ activeVersion: '1.0.0' })
    // A newer one is offered.
    await w.publish('1.2.0')
    expect((await w.service.checkNow())[0]).toMatchObject({ activeVersion: '1.2.0' })
  })

  it('rejects when there is nothing to go back to', async () => {
    const w = await world()
    await expect(w.service.rollback(ID)).rejects.toThrow(/no previous version/)
  })

  it('a rollback restores the grant that was consented then: a wider version offered later is parked again', async () => {
    const w = await world()
    await w.publish('1.1.0', { domains: ['api.acme.test', 'cdn.acme.test'] })
    await w.service.checkNow()
    await w.service.recordConsent(ID, '1.1.0')
    await w.service.rollback(ID)
    await w.publish('1.2.0', { domains: ['api.acme.test', 'cdn.acme.test'] })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'needs-consent', pending: { version: '1.2.0' } })
  })
})

describe('the schedule', () => {
  it('checkDue looks at a plugin once per interval', async () => {
    const w = await world()
    await w.service.checkDue()
    const first = w.fetchImpl.calls.length
    expect(first).toBe(1)
    w.clock.t += DEFAULT_UPDATE_INTERVAL_MS - 1
    await w.service.checkDue()
    expect(w.fetchImpl.calls.length).toBe(first)
    w.clock.t += 1
    await w.service.checkDue()
    expect(w.fetchImpl.calls.length).toBe(first + 1)
  })

  it('checkNow ignores the interval', async () => {
    const w = await world()
    await w.service.checkNow()
    await w.service.checkNow()
    expect(w.fetchImpl.calls.length).toBe(2)
  })

  it('startProviderModUpdateSchedule checks at once, then on every poll, until stopped', async () => {
    const calls: string[] = []
    const service = { checkDue: vi.fn(async () => { calls.push('due'); return [] }) } as unknown as ProviderModUpdateService
    let tick: (() => void) | undefined
    const clear = vi.fn()
    const stop = startProviderModUpdateSchedule(service, {
      setIntervalFn: (cb, ms) => {
        expect(ms).toBe(60 * 60 * 1000)
        tick = cb
        return 7
      },
      clearIntervalFn: clear,
    })
    expect(calls).toEqual(['due'])
    tick!()
    expect(calls).toEqual(['due', 'due'])
    stop()
    expect(clear).toHaveBeenCalledWith(7)
  })

  it('a failing background check is reported, never thrown', async () => {
    const lines: string[] = []
    const service = { checkDue: vi.fn(async () => { throw new Error('state file malformed') }) } as unknown as ProviderModUpdateService
    startProviderModUpdateSchedule(service, { setIntervalFn: () => 1, clearIntervalFn: () => {}, report: l => lines.push(l) })
    await Promise.resolve()
    await Promise.resolve()
    expect(lines.join('\n')).toMatch(/state file malformed/)
  })
})

describe('state and listeners', () => {
  it('a corrupt state file is not overwritten', async () => {
    const w = await world()
    await w.fs.writeFile(STATE, '{not json')
    await expect(w.service.checkNow()).rejects.toThrow(/refusing to overwrite/)
    expect(String(await w.fs.readFile(STATE, { encoding: 'utf-8' }))).toBe('{not json')
    // Reading the status still works.
    expect(await statusOf(w.service)).toMatchObject({ state: 'unchecked' })
  })

  it('subscribers hear a change; unsubscribing stops it', async () => {
    const w = await world()
    const listener = vi.fn()
    const off = w.service.subscribe(listener)
    await w.service.checkNow()
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    await w.service.checkNow()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('without a configured host the registry still switches (the next scan loads it)', async () => {
    const w = await world()
    const service = createProviderModUpdateService({
      ctx,
      fs: w.fs as unknown as RuntimeFs,
      fetchImpl: w.fetchImpl,
      now: () => w.clock.t,
      host: { isConfigured: () => false, swapPlugin: vi.fn() },
    })
    await w.publish('1.1.0')
    expect((await service.checkNow())[0]).toMatchObject({ activeVersion: '1.1.0' })
  })

  it('recordInitialConsent takes the grant of what runs now as the baseline', async () => {
    const w = await world()
    await w.service.recordInitialConsent(ID)
    await w.publish('1.1.0', { domains: ['api.acme.test', 'cdn.acme.test'] })
    expect((await w.service.checkNow())[0]).toMatchObject({ state: 'needs-consent' })
  })
})

describe('a marketplace id as the update source', () => {
  const MKT_URL = 'https://codeload.github.com/me/mkt/tar.gz/refs/heads/main'
  const ARCHIVE_1 = 'https://plugins.acme.test/mk-1.0.0.tar.gz'
  const ARCHIVE_11 = 'https://plugins.acme.test/mk-1.1.0.tar.gz'

  async function catalog(w: World, version: string, archiveUrl: string): Promise<void> {
    w.served.set(MKT_URL, {
      body: await archive(
        [{ name: '.claude-plugin/marketplace.json', content: JSON.stringify({ name: 'mkt', plugins: [{ name: 'acme', version, source: { source: 'https', url: archiveUrl } }] }) }],
        'me-mkt-abc',
      ),
    })
  }

  it('refreshes the catalog, fetches the new version beside the old and applies it', async () => {
    const w = await world({ install: false })
    const providers = { main: providerJson({ updates: { marketplace: 'mkt' } }) }
    await addMarketplace(ctx, w.fs as unknown as RuntimeFs, 'mkt', { source: 'github', repo: 'me/mkt' }, new Date(T0).toISOString())
    await catalog(w, '1.0.0', ARCHIVE_1)
    w.served.set(ARCHIVE_1, { body: await pluginArchive({ version: '1.0.0', providers }) })
    await setupPlugin(ctx, w.fs as unknown as RuntimeFs, 'mkt', 'acme', { fetchImpl: w.fetchImpl, refreshFirst: true })
    await w.service.recordInitialConsent('acme@mkt')

    expect((await w.service.checkNow('acme@mkt'))[0]).toMatchObject({ pluginId: 'acme@mkt', state: 'up-to-date', activeVersion: '1.0.0' })

    await catalog(w, '1.1.0', ARCHIVE_11)
    w.served.set(ARCHIVE_11, { body: await pluginArchive({ version: '1.1.0', providers }) })
    const [status] = await w.service.checkNow('acme@mkt')
    expect(status).toMatchObject({ state: 'up-to-date', activeVersion: '1.1.0', rollbackVersion: '1.0.0' })
    const { registry } = await loadInstalledPlugins(ctx, w.fs as unknown as RuntimeFs)
    expect(registry.plugins['acme@mkt']![0]!.installPath).toBe('/home/u/.velloc/plugins/cache/mkt/acme/1.1.0')
  })

  it('a marketplace that does not list the plugin any more is a recorded failure', async () => {
    const w = await world({ install: false })
    const providers = { main: providerJson({ updates: { marketplace: 'mkt' } }) }
    await addMarketplace(ctx, w.fs as unknown as RuntimeFs, 'mkt', { source: 'github', repo: 'me/mkt' }, new Date(T0).toISOString())
    await catalog(w, '1.0.0', ARCHIVE_1)
    w.served.set(ARCHIVE_1, { body: await pluginArchive({ version: '1.0.0', providers }) })
    await setupPlugin(ctx, w.fs as unknown as RuntimeFs, 'mkt', 'acme', { fetchImpl: w.fetchImpl, refreshFirst: true })
    await w.service.recordInitialConsent('acme@mkt')
    w.served.set(MKT_URL, { body: await archive([{ name: '.claude-plugin/marketplace.json', content: JSON.stringify({ name: 'mkt', plugins: [] }) }], 'me-mkt-abc') })
    expect((await w.service.checkNow('acme@mkt'))[0]).toMatchObject({ state: 'failed', failure: { kind: 'source-missing' } })
  })
})
