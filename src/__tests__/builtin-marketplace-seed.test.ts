/**
 * The built-in marketplace (F-14) over an in-memory fs and a fake origin that
 * serves `index.json` and the tarball: the registry entry, the listing fields,
 * the first-launch install with its defaults, the channel filter, the sticky
 * uninstall, the daily check and the upgrade a new build triggers, and the
 * runs that do nothing (flag off, unreadable state, bad digest).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __setPluginBlocklistForTests } from '../pluginHost/blocklist'
import {
  BUILTIN_MARKETPLACE_KEY,
  BUILTIN_MARKETPLACE_SOURCE,
  builtinMarketplaceIndexUrl,
  builtinNameSourceProblem,
} from '../pluginHost/builtinMarketplace'
import {
  readBuiltinSeedState,
  seedBuiltinMarketplace,
  type BuiltinSeedDeps,
} from '../pluginHost/builtinMarketplaceSeed'
import { getEnabledPluginsMap, setPluginEnabled } from '../pluginHost/enabledPlugins'
import { setupPlugin, teardownPlugin } from '../pluginHost/installSteps'
import { forgetRegistryFile, loadInstalledPlugins } from '../pluginHost/installedRegistry'
import {
  addMarketplace,
  fetchCatalog,
  forgetCatalogs,
  listingsVisibleOn,
  loadKnownMarketplaces,
  parseMarketplaceManifest,
  removeMarketplace,
  sha256Hex,
} from '../pluginHost/marketplaces'
import { builtinMarketplaceStateFilePath, getKnownMarketplacesFilePath } from '../pluginHost/pluginDirs'
import { createPluginUpdateService } from '../pluginHost/pluginUpdates'
import { createProviderModUpdateService } from '../pluginHost/providerModUpdates'
import { consentCovers } from '../pluginHost/providerPluginConsent'
import { wipeSettingsMemos } from '../settings/settingsStore'
import { makeMemFs } from './_helpers/memFs'
import { archive, providerJson, servedFetch, type Served } from './_helpers/pluginArchive'

const HOME = '/home/u'
const ctx = { homeDir: HOME }
const MP = BUILTIN_MARKETPLACE_KEY
const TARBALL_URL = BUILTIN_MARKETPLACE_SOURCE.url
const INDEX_URL = builtinMarketplaceIndexUrl(BUILTIN_MARKETPLACE_SOURCE)!
const id = (name: string) => `${name}@${MP}`

type Listing = {
  name: string
  version: string
  onByDefault?: boolean
  betaOnly?: boolean
  providers?: boolean
}

const BASE: Listing[] = [
  { name: 'on-plugin', version: '1.0.0' },
  { name: 'off-plugin', version: '1.0.0', onByDefault: false },
  { name: 'beta-plugin', version: '1.0.0', betaOnly: true },
]

async function tarballOf(plugins: Listing[]): Promise<Uint8Array> {
  return archive(
    [
      {
        name: '.claude-plugin/marketplace.json',
        content: JSON.stringify({
          name: MP,
          plugins: plugins.map(p => ({
            name: p.name,
            source: `./plugins/${p.name}`,
            ...(p.onByDefault === undefined ? {} : { onByDefault: p.onByDefault }),
            ...(p.betaOnly === undefined ? {} : { betaOnly: p.betaOnly }),
          })),
        }),
      },
      ...plugins.flatMap(p => [
        {
          name: `plugins/${p.name}/.claude-plugin/plugin.json`,
          content: JSON.stringify({
            name: p.name,
            version: p.version,
            ...(p.providers ? { providers: { main: providerJson() } } : {}),
          }),
        },
        ...(p.providers ? [{ name: `plugins/${p.name}/providers/main.js`, content: 'export default {}\n' }] : []),
        { name: `plugins/${p.name}/skills/hello/SKILL.md`, content: `v${p.version}\n` },
      ]),
    ],
    'velloc-marketplace-abc1234',
  )
}

async function rig(plugins: Listing[] = BASE, options: { index?: boolean } = {}) {
  const fs = makeMemFs()
  const table = new Map<string, Served>()
  const fetchImpl = servedFetch(table)
  let clock = Date.parse('2026-10-13T08:00:00.000Z')
  const now = () => new Date(clock).toISOString()
  const publish = async (next: Listing[], buildId: string, sha256?: string | null) => {
    const bytes = await tarballOf(next)
    table.set(TARBALL_URL, { body: bytes })
    if (options.index === false) {
      table.delete(INDEX_URL)
      return
    }
    const digest = sha256 === null ? undefined : (sha256 ?? (await sha256Hex(bytes)))
    table.set(INDEX_URL, {
      body: JSON.stringify({ name: MP, buildId, ...(digest ? { sha256: digest } : {}) }),
      headers: { 'content-type': 'application/json' },
    })
  }
  await publish(plugins, 'b1')
  const lines: string[] = []
  const reloadPluginsOnAllSessions = vi.fn()
  const updates = createPluginUpdateService({
    homeDir: HOME,
    fs,
    fetchImpl: () => fetchImpl,
    readAutoUpdate: async () => false,
    writeAutoUpdate: async () => undefined,
    reloadPluginsOnAllSessions,
    now,
    report: line => lines.push(line),
  })
  let channel: 'stable' | 'beta' = 'stable'
  let auto = true
  const run = (over: Partial<BuiltinSeedDeps> = {}) =>
    seedBuiltinMarketplace({
      homeDir: HOME,
      fs,
      fetchImpl: () => fetchImpl,
      channel: () => channel,
      autoInstall: async () => auto,
      updates,
      reloadPluginsOnAllSessions,
      now,
      report: line => lines.push(line),
      ...over,
    })
  return {
    fs,
    fetchImpl,
    lines,
    reloadPluginsOnAllSessions,
    publish,
    run,
    setChannel: (next: 'stable' | 'beta') => {
      channel = next
    },
    setAuto: (next: boolean) => {
      auto = next
    },
    advance: (ms: number) => {
      clock += ms
    },
    now,
    installedVersion: async (name: string) =>
      (await loadInstalledPlugins(ctx, fs)).registry.plugins[id(name)]?.[0]?.version,
    tarballFetches: () => fetchImpl.calls.filter(url => url === TARBALL_URL).length,
    indexFetches: () => fetchImpl.calls.filter(url => url === INDEX_URL).length,
  }
}

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  wipeSettingsMemos()
  forgetCatalogs()
  forgetRegistryFile()
})

describe('built-in marketplace registry', () => {
  it('is registered on a fresh profile, beside the officials, at its own origin', async () => {
    const fs = makeMemFs()
    const { registry } = await loadKnownMarketplaces(ctx, fs, '2026-10-13T00:00:00.000Z')
    expect(registry[MP]?.source).toEqual(BUILTIN_MARKETPLACE_SOURCE)
    expect(Object.keys(registry).sort()).toEqual(['claude-plugins-community', 'claude-plugins-official', MP])
  })

  it('keeps an entry already on file under the built-in name, so a profile can point it elsewhere', async () => {
    const fs = makeMemFs()
    const mirror = { source: 'url', url: 'http://127.0.0.1:9/marketplace.tar.gz' } as const
    await fs.writeFile(
      getKnownMarketplacesFilePath(ctx),
      JSON.stringify({ [MP]: { source: mirror, installLocation: '/x', lastUpdated: '2026-01-01T00:00:00.000Z' } }),
      { encoding: 'utf-8' },
    )
    const { registry } = await loadKnownMarketplaces(ctx, fs, '2026-10-13T00:00:00.000Z')
    expect(registry[MP]?.source).toEqual(mirror)
    expect(builtinMarketplaceIndexUrl(mirror)).toBe('http://127.0.0.1:9/index.json')
  })

  it('cannot be removed, and its name cannot be taken by another source', async () => {
    const fs = makeMemFs()
    await expect(removeMarketplace(ctx, fs, MP, '2026-10-13T00:00:00.000Z')).rejects.toThrow(/built-in/)
    await expect(
      addMarketplace(ctx, fs, MP, { source: 'github', repo: 'someone/else' }, '2026-10-13T00:00:00.000Z'),
    ).rejects.toThrow(/built-in/)
    expect(builtinNameSourceProblem(MP, BUILTIN_MARKETPLACE_SOURCE)).toBeNull()
    expect(builtinNameSourceProblem('other', { source: 'github', repo: 'a/b' })).toBeNull()
  })
})

describe('listing fields', () => {
  it('reads onByDefault and betaOnly only as booleans, and hides betaOnly listings off beta', () => {
    const manifest = parseMarketplaceManifest(
      JSON.stringify({
        name: 'x',
        plugins: [
          { name: 'a', source: './a', onByDefault: false, betaOnly: true },
          { name: 'b', source: './b', onByDefault: 'no', betaOnly: 1 },
        ],
      }),
      'x',
    )
    expect(manifest.plugins[0]).toMatchObject({ name: 'a', onByDefault: false, betaOnly: true })
    expect(manifest.plugins[1]).toEqual({ name: 'b', source: { source: 'local', path: 'b' } })
    expect(listingsVisibleOn(manifest.plugins, 'stable').map(p => p.name)).toEqual(['b'])
    expect(listingsVisibleOn(manifest.plugins, 'beta').map(p => p.name)).toEqual(['a', 'b'])
  })
})

describe('first launch', () => {
  it('downloads the marketplace once and installs the listings with their defaults', async () => {
    const r = await rig()
    const outcome = await r.run()
    expect(outcome).toMatchObject({ ran: true, fetched: true, failed: [], skipped: [] })
    expect(outcome.installed.sort()).toEqual([id('off-plugin'), id('on-plugin')])
    expect(r.tarballFetches()).toBe(1)
    expect(await r.installedVersion('on-plugin')).toBe('1.0.0')
    expect(await r.installedVersion('beta-plugin')).toBeUndefined()
    const enabled = await getEnabledPluginsMap(ctx, r.fs)
    expect(enabled[id('off-plugin')]).toBe(false)
    expect(enabled[id('on-plugin')]).toBeUndefined()
    expect(r.reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
    const state = await readBuiltinSeedState(ctx, r.fs)
    expect(state?.buildId).toBe('b1')
    expect(Object.keys(state!.seeded).sort()).toEqual([id('off-plugin'), id('on-plugin')])
    expect(state!.seeded[id('on-plugin')]).toMatchObject({ channel: 'stable' })
  })

  it('installs without a build id when the origin serves no index.json', async () => {
    const r = await rig(BASE, { index: false })
    const outcome = await r.run()
    expect(outcome.installed).toHaveLength(2)
    expect((await readBuiltinSeedState(ctx, r.fs))?.buildId).toBeUndefined()
    expect(r.lines.some(line => /index\.json/.test(line))).toBe(true)
  })

  it('retries at the next run when the download fails, recording nothing', async () => {
    const r = await rig()
    r.fetchImpl.calls.length = 0
    const served = new Map<string, Served>()
    const down = servedFetch(served)
    const first = await r.run({ fetchImpl: () => down })
    expect(first).toMatchObject({ ran: true, fetched: false, installed: [] })
    expect((await readBuiltinSeedState(ctx, r.fs))?.seeded).toEqual({})
    const second = await r.run()
    expect(second.installed).toHaveLength(2)
  })

  it('does nothing while the auto-install flag is off', async () => {
    const r = await rig()
    r.setAuto(false)
    const before = r.fs.dump()
    const outcome = await r.run()
    expect(outcome.ran).toBe(false)
    expect(r.fetchImpl.calls).toEqual([])
    expect(r.fs.dump()).toEqual(before)
  })

  it('does nothing while the state file is unreadable', async () => {
    const r = await rig()
    await r.fs.writeFile(builtinMarketplaceStateFilePath(ctx), '{not json', { encoding: 'utf-8' })
    const outcome = await r.run()
    expect(outcome.ran).toBe(false)
    expect(r.fetchImpl.calls).toEqual([])
    expect(r.lines.some(line => /unreadable/.test(line))).toBe(true)
  })

  it('refuses a tarball whose digest is not the published one and leaves no content behind', async () => {
    const r = await rig()
    await r.publish(BASE, 'b1', 'deadbeef')
    const outcome = await r.run()
    expect(outcome).toMatchObject({ ran: true, fetched: false, installed: [] })
    expect(r.fs.dump().some(path => path.includes('marketplace.json'))).toBe(false)
    expect(r.lines.some(line => /digest/.test(line))).toBe(true)
  })

  it('records a listing the person installed by hand without installing it again', async () => {
    const r = await rig()
    await fetchCatalog(ctx, r.fs, MP, r.now(), r.fetchImpl)
    await setupPlugin(ctx, r.fs, MP, 'on-plugin', { fetchImpl: r.fetchImpl, nowIso: r.now() })
    const outcome = await r.run()
    expect(outcome.installed).toEqual([id('off-plugin')])
    expect(outcome.skipped).toEqual([id('on-plugin')])
    expect((await readBuiltinSeedState(ctx, r.fs))?.seeded[id('on-plugin')]).toBeDefined()
  })

  it('leaves a blocklisted listing out and never records it', async () => {
    const restore = __setPluginBlocklistForTests(['off-plugin'])
    try {
      const r = await rig()
      const outcome = await r.run()
      expect(outcome.installed).toEqual([id('on-plugin')])
      expect(outcome.skipped).toEqual([id('off-plugin')])
      expect((await readBuiltinSeedState(ctx, r.fs))?.seeded[id('off-plugin')]).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('holds a provider plugin for consent when nothing can record it, even when the listing says on', async () => {
    const r = await rig([{ name: 'prov', version: '1.0.0', providers: true }])
    await r.run()
    expect(await r.installedVersion('prov')).toBe('1.0.0')
    expect((await getEnabledPluginsMap(ctx, r.fs))['prov@velloc']).toBe(false)
  })

  it('consents to a provider plugin the listing leaves on, with the hold already lifted', async () => {
    const r = await rig([{ name: 'prov', version: '1.0.0', providers: true }])
    const seenAtConsent: Array<boolean | undefined> = []
    const consentProviders = vi.fn(async (pluginId: string) => {
      seenAtConsent.push((await getEnabledPluginsMap(ctx, r.fs))[pluginId])
    })
    const outcome = await r.run({ consentProviders })
    expect(outcome.installed).toEqual([id('prov')])
    expect(consentProviders).toHaveBeenCalledExactlyOnceWith(id('prov'))
    expect(seenAtConsent).toEqual([undefined])
    expect((await getEnabledPluginsMap(ctx, r.fs))[id('prov')]).toBeUndefined()
  })

  it('never consents to a provider plugin listed off, nor to a plugin without providers', async () => {
    const r = await rig([
      { name: 'prov-off', version: '1.0.0', providers: true, onByDefault: false },
      { name: 'plain', version: '1.0.0' },
    ])
    const consentProviders = vi.fn(async () => {})
    await r.run({ consentProviders })
    expect(consentProviders).not.toHaveBeenCalled()
    expect(await getEnabledPluginsMap(ctx, r.fs)).toEqual({ [id('prov-off')]: false })
  })

  it('puts the hold back when the consent cannot be recorded, and does not install again', async () => {
    const r = await rig([{ name: 'prov', version: '1.0.0', providers: true }])
    const consentProviders = vi.fn(async () => {
      throw new Error('no service')
    })
    const outcome = await r.run({ consentProviders })
    expect(outcome.installed).toEqual([id('prov')])
    expect((await getEnabledPluginsMap(ctx, r.fs))[id('prov')]).toBe(false)
    expect(r.lines.some(line => line.includes(`'${id('prov')}' stays off until it is approved: no service`))).toBe(true)
    expect((await readBuiltinSeedState(ctx, r.fs))?.seeded[id('prov')]).toBeDefined()
    await r.run({ consentProviders })
    expect(consentProviders).toHaveBeenCalledTimes(1)
  })

  it('records a baseline the consent gate accepts for the version installed', async () => {
    const r = await rig([{ name: 'prov', version: '1.0.0', providers: true }])
    const service = createProviderModUpdateService({ ctx, fs: r.fs, fetchImpl: r.fetchImpl })
    await r.run({ consentProviders: async pluginId => void (await service.recordInitialConsent(pluginId)) })
    expect((await getEnabledPluginsMap(ctx, r.fs))[id('prov')]).toBeUndefined()
    const manifest = { name: 'prov', version: '1.0.0', providers: { main: providerJson() } }
    expect(await consentCovers(ctx, r.fs, id('prov'), manifest)).toBe(true)
    // A version that asks for more is not covered by it.
    const wider = { ...manifest, providers: { main: providerJson({ domains: ['api.acme.test', 'collector.example'] }) } }
    expect(await consentCovers(ctx, r.fs, id('prov'), wider)).toBe(false)
  })
})

describe('later boots', () => {
  it('reads nothing from the network while the last check is fresh', async () => {
    const r = await rig()
    await r.run()
    r.fetchImpl.calls.length = 0
    r.advance(HOUR)
    const outcome = await r.run()
    expect(outcome).toMatchObject({ ran: true, fetched: false, installed: [] })
    expect(r.fetchImpl.calls).toEqual([])
  })

  it('never installs a seeded listing again after the person uninstalls it', async () => {
    const r = await rig()
    await r.run()
    await teardownPlugin(ctx, ctx, r.fs, id('on-plugin'))
    expect(await r.installedVersion('on-plugin')).toBeUndefined()
    r.advance(HOUR)
    const outcome = await r.run()
    expect(outcome.installed).toEqual([])
    expect(await r.installedVersion('on-plugin')).toBeUndefined()
  })

  it('installs the beta-only listing from the cached content when the channel turns beta', async () => {
    const r = await rig()
    await r.run()
    r.fetchImpl.calls.length = 0
    r.setChannel('beta')
    const outcome = await r.run()
    expect(outcome.installed).toEqual([id('beta-plugin')])
    expect(r.fetchImpl.calls).toEqual([])
    expect((await readBuiltinSeedState(ctx, r.fs))?.seeded[id('beta-plugin')]).toMatchObject({ channel: 'beta' })
  })

  it('after a day asks the origin for its build id and stamps the check when nothing changed', async () => {
    const r = await rig()
    await r.run()
    const checked = (await readBuiltinSeedState(ctx, r.fs))!.lastCheckedAt
    r.fetchImpl.calls.length = 0
    r.advance(25 * HOUR)
    const outcome = await r.run()
    expect(outcome.fetched).toBe(false)
    expect(r.indexFetches()).toBe(1)
    expect(r.tarballFetches()).toBe(0)
    const state = await readBuiltinSeedState(ctx, r.fs)
    expect(state!.lastCheckedAt).not.toBe(checked)
    expect(state!.buildId).toBe('b1')
  })

  it('a client upgrade asks the origin at once, whatever the clock says, and records the version', async () => {
    const r = await rig()
    await r.run({ clientVersion: async () => '1.0.0' })
    await setPluginEnabled(ctx, r.fs, id('on-plugin'), true)
    expect((await readBuiltinSeedState(ctx, r.fs))!.clientVersion).toBe('1.0.0')
    r.fetchImpl.calls.length = 0
    r.advance(HOUR)
    await r.run({ clientVersion: async () => '1.0.0' })
    expect(r.fetchImpl.calls).toEqual([])
    await r.publish(
      [
        { name: 'on-plugin', version: '1.1.0' },
        { name: 'off-plugin', version: '1.0.0', onByDefault: false },
        { name: 'beta-plugin', version: '1.0.0', betaOnly: true },
      ],
      'b2',
    )
    const outcome = await r.run({ clientVersion: async () => '1.0.1' })
    expect(outcome.fetched).toBe(true)
    expect(r.indexFetches()).toBe(1)
    expect(r.tarballFetches()).toBe(1)
    expect(outcome.updated).toEqual([id('on-plugin')])
    expect(await r.installedVersion('on-plugin')).toBe('1.1.0')
    expect(await readBuiltinSeedState(ctx, r.fs)).toMatchObject({ buildId: 'b2', clientVersion: '1.0.1' })
  })

  it('a client upgrade whose check cannot reach the origin is tried again at the next run', async () => {
    const r = await rig()
    await r.run({ clientVersion: async () => '1.0.0' })
    r.advance(HOUR)
    const down = servedFetch(new Map())
    await r.run({ clientVersion: async () => '1.0.1', fetchImpl: () => down })
    expect((await readBuiltinSeedState(ctx, r.fs))!.clientVersion).toBe('1.0.0')
    r.fetchImpl.calls.length = 0
    const outcome = await r.run({ clientVersion: async () => '1.0.1' })
    expect(outcome.fetched).toBe(false)
    expect(r.indexFetches()).toBe(1)
    expect((await readBuiltinSeedState(ctx, r.fs))!.clientVersion).toBe('1.0.1')
  })

  it('a host that names no version keeps the daily rhythm', async () => {
    const r = await rig()
    await r.run({ clientVersion: async () => '1.0.0' })
    r.fetchImpl.calls.length = 0
    r.advance(HOUR)
    const outcome = await r.run({ clientVersion: async () => undefined })
    expect(outcome.fetched).toBe(false)
    expect(r.fetchImpl.calls).toEqual([])
    expect((await readBuiltinSeedState(ctx, r.fs))!.clientVersion).toBe('1.0.0')
  })

  it('retries the check at the next run when the origin is unreachable', async () => {
    const r = await rig()
    await r.run()
    const checked = (await readBuiltinSeedState(ctx, r.fs))!.lastCheckedAt
    r.advance(25 * HOUR)
    const down = servedFetch(new Map())
    await r.run({ fetchImpl: () => down })
    expect((await readBuiltinSeedState(ctx, r.fs))!.lastCheckedAt).toBe(checked)
  })

  it('a new build downloads once, upgrades the installed plugins and installs what was added', async () => {
    const r = await rig()
    await r.run()
    await setPluginEnabled(ctx, r.fs, id('on-plugin'), true)
    r.fetchImpl.calls.length = 0
    await r.publish(
      [
        { name: 'on-plugin', version: '1.1.0' },
        { name: 'off-plugin', version: '1.1.0', onByDefault: false },
        { name: 'beta-plugin', version: '1.0.0', betaOnly: true },
        { name: 'added-plugin', version: '0.1.0' },
      ],
      'b2',
    )
    r.advance(25 * HOUR)
    const outcome = await r.run()
    expect(outcome.fetched).toBe(true)
    expect(r.tarballFetches()).toBe(1)
    expect(outcome.updated).toEqual([id('on-plugin')])
    expect(outcome.installed).toEqual([id('added-plugin')])
    expect(await r.installedVersion('on-plugin')).toBe('1.1.0')
    // Off by the person's choice (explicit false): left at its version.
    expect(await r.installedVersion('off-plugin')).toBe('1.0.0')
    expect(await r.installedVersion('added-plugin')).toBe('0.1.0')
    expect((await readBuiltinSeedState(ctx, r.fs))!.buildId).toBe('b2')
    const snapshot = await createPluginUpdateService({
      homeDir: HOME,
      fs: r.fs,
      fetchImpl: () => r.fetchImpl,
      readAutoUpdate: async () => false,
      writeAutoUpdate: async () => undefined,
      now: r.now,
    }).snapshot()
    expect(snapshot.plugins.find(p => p.identifier === id('on-plugin'))).toMatchObject({
      version: '1.1.0',
      applied: { version: '1.1.0', auto: true },
      rollbackVersion: '1.0.0',
    })
  })
})
