/**
 * Marketplace plugin updates (F-14) over an in-memory fs and a marketplace
 * tarball the test republishes: version ordering, the offer a check records,
 * the check throttle, update with its rollback target, the auto-update round
 * (off by default, enabled plugins only, never a rolled-back version), a
 * failed update keeping the installed version, and the plugins left out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import {
  registerPluginUpdatesCapability,
  startBuiltinMarketplaceSchedule,
} from '../browser/runtimeHub/pluginUpdatesCapability'
import type { BuiltinSeedOutcome } from '../pluginHost/builtinMarketplaceSeed'
import { setPluginEnabled } from '../pluginHost/enabledPlugins'
import { setupPlugin } from '../pluginHost/installSteps'
import { forgetRegistryFile, loadInstalledPlugins, recordPluginSetup } from '../pluginHost/installedRegistry'
import { addMarketplace, forgetCatalogs } from '../pluginHost/marketplaces'
import { createPluginUpdateService, startPluginUpdateSchedule } from '../pluginHost/pluginUpdates'
import {
  PLUGIN_UPDATES_ACTION_SCOPES,
  isPluginUpdatesAutoPayload,
  isPluginUpdatesCheckPayload,
  isPluginUpdatesPluginPayload,
} from '../pluginHost/pluginUpdatesProtocol'
import { comparePluginVersions, isNewerPluginVersion } from '../pluginHost/pluginVersionCompare'
import { wipeSettingsMemos } from '../settings/settingsStore'
import { makeMemFs } from './_helpers/memFs'
import { archive } from './_helpers/pluginArchive'

const HOME = '/home/u'
const ctx = { homeDir: HOME }
const ID = 'cool@my-mkt'

type Listing = { name: string; version: string; providers?: boolean; missing?: boolean }

async function marketplaceTarball(plugins: Listing[]): Promise<Uint8Array> {
  const files = [
    {
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: plugins.map(p => ({ name: p.name, source: `./plugins/${p.name}` })),
      }),
    },
    ...plugins
      .filter(p => !p.missing)
      .flatMap(p => [
        {
          name: `plugins/${p.name}/.claude-plugin/plugin.json`,
          content: JSON.stringify({
            name: p.name,
            version: p.version,
            ...(p.providers ? { providers: { main: { providerApi: 1 } } } : {}),
          }),
        },
        { name: `plugins/${p.name}/skills/hello/SKILL.md`, content: `v${p.version}\n` },
      ]),
  ]
  return archive(files, 'me-mkt-abc')
}

async function rig(initial: Listing[] = [{ name: 'cool', version: '1.0.0' }]) {
  const fs = makeMemFs()
  let tarball = await marketplaceTarball(initial)
  let status = 200
  const fetchImpl = vi.fn(async () =>
    status === 200 ? new Response(new Uint8Array(tarball), { status }) : new Response('down', { status }),
  ) as unknown as typeof fetch & { mock: { calls: unknown[] } }
  let clock = Date.parse('2026-10-12T00:00:00.000Z')
  const now = () => new Date(clock).toISOString()
  await addMarketplace(ctx, fs, 'my-mkt', { source: 'github', repo: 'me/mkt' }, now())
  for (const plugin of initial) await setupPlugin(ctx, fs, 'my-mkt', plugin.name, { nowIso: now(), fetchImpl, refreshFirst: true })
  let auto = false
  const reloadPluginsOnAllSessions = vi.fn()
  const service = createPluginUpdateService({
    homeDir: HOME,
    fs,
    fetchImpl: () => fetchImpl,
    readAutoUpdate: async () => auto,
    writeAutoUpdate: async on => {
      auto = on
    },
    reloadPluginsOnAllSessions,
    now,
    report: () => undefined,
  })
  return {
    fs,
    service,
    fetchImpl,
    reloadPluginsOnAllSessions,
    publish: async (plugins: Listing[]) => {
      tarball = await marketplaceTarball(plugins)
    },
    goDown: () => {
      status = 503
    },
    advance: (ms: number) => {
      clock += ms
    },
    installed: async (id = ID) => (await loadInstalledPlugins(ctx, fs)).registry.plugins[id]?.[0],
  }
}

beforeEach(() => {
  wipeSettingsMemos()
  forgetCatalogs()
  forgetRegistryFile()
})

describe('plugin version ordering', () => {
  it('orders dotted versions, a leading v, and prereleases', () => {
    expect(comparePluginVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(comparePluginVersions('v2.0', '2.0.0')).toBe(0)
    expect(comparePluginVersions('2.0.0-beta.2', '2.0.0-beta.10')).toBeLessThan(0)
    expect(comparePluginVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0)
    expect(comparePluginVersions('abc123', '1.0.0')).toBeNull()
  })

  it('treats an unordered version as newer only when it differs', () => {
    expect(isNewerPluginVersion('1.0.1', '1.0.0')).toBe(true)
    expect(isNewerPluginVersion('1.0.0', '1.0.1')).toBe(false)
    expect(isNewerPluginVersion('nightly-2', 'nightly-1')).toBe(true)
    expect(isNewerPluginVersion('v-x', '-x')).toBe(false)
  })
})

describe('plugin update service', () => {
  it('starts unchecked with auto-update off, then a check records the newer version', async () => {
    const r = await rig()
    let state = await r.service.snapshot()
    expect(state.autoUpdate).toBe(false)
    expect(state.plugins).toEqual([{ identifier: ID, version: '1.0.0', state: 'unchecked' }])

    await r.publish([{ name: 'cool', version: '1.1.0' }])
    state = await r.service.check()
    expect(state.lastCheckedAt).toBeDefined()
    expect(state.plugins[0]).toMatchObject({ state: 'available', offer: { version: '1.1.0' } })
  })

  it('reports up to date when the listing is not newer', async () => {
    const r = await rig()
    const state = await r.service.check()
    expect(state.plugins[0]!.state).toBe('up-to-date')
    expect(state.plugins[0]!.offer).toBeUndefined()
  })

  it('skips a refresh made in the last half hour unless forced', async () => {
    const r = await rig()
    const before = r.fetchImpl.mock.calls.length
    await r.service.check()
    await r.service.check()
    expect(r.fetchImpl.mock.calls.length).toBe(before + 1)
    await r.service.check({ force: true })
    expect(r.fetchImpl.mock.calls.length).toBe(before + 2)
    r.advance(31 * 60 * 1000)
    await r.service.check()
    expect(r.fetchImpl.mock.calls.length).toBe(before + 3)
  })

  it('checks again within the half hour when a plugin was installed after the last check', async () => {
    const r = await rig()
    await r.service.check()
    await r.publish([
      { name: 'cool', version: '1.0.0' },
      { name: 'late', version: '1.0.0' },
    ])
    await setupPlugin(ctx, r.fs, 'my-mkt', 'late', { nowIso: new Date().toISOString(), fetchImpl: r.fetchImpl, refreshFirst: true })
    await r.publish([
      { name: 'cool', version: '1.0.0' },
      { name: 'late', version: '1.2.0' },
    ])
    const before = r.fetchImpl.mock.calls.length
    const state = await r.service.check()
    expect(r.fetchImpl.mock.calls.length).toBe(before + 1)
    expect(state.plugins.find(p => p.identifier === 'late@my-mkt')).toMatchObject({ offer: { version: '1.2.0' } })
    await r.service.check()
    expect(r.fetchImpl.mock.calls.length).toBe(before + 1)
  })

  it('records an unreachable marketplace and keeps the plugin as it was', async () => {
    const r = await rig()
    r.goDown()
    const state = await r.service.check()
    expect(state.unreachable).toEqual([{ marketplace: 'my-mkt', reason: expect.any(String) }])
    expect(state.plugins[0]!.offer).toBeUndefined()
  })

  it('update installs the new version beside the old one and reloads the sessions', async () => {
    const r = await rig()
    const oldPath = (await r.installed())!.installPath
    await r.publish([{ name: 'cool', version: '1.1.0' }])
    await r.service.check()

    const status = await r.service.update(ID)
    expect(status).toMatchObject({ state: 'up-to-date', version: '1.1.0', rollbackVersion: '1.0.0' })
    expect(status.applied).toMatchObject({ version: '1.1.0', auto: false })
    const record = await r.installed()
    expect(record!.version).toBe('1.1.0')
    expect(record!.installPath).not.toBe(oldPath)
    expect(await r.fs.readFile(`${oldPath}/skills/hello/SKILL.md`, { encoding: 'utf-8' })).toBe('v1.0.0\n')
    expect(r.reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
  })

  it('rollback returns to the earlier version and keeps offering the newer one without installing it automatically', async () => {
    const r = await rig()
    await r.publish([{ name: 'cool', version: '1.1.0' }])
    await r.service.check()
    await r.service.update(ID)

    const back = await r.service.rollback(ID)
    expect(back).toMatchObject({ version: '1.0.0', state: 'available', offer: { version: '1.1.0' } })
    expect(back.rollbackVersion).toBeUndefined()

    await r.service.setAutoUpdate(true)
    r.advance(31 * 60 * 1000)
    await r.service.autoUpdate()
    expect((await r.installed())!.version).toBe('1.0.0')
  })

  it('an update that cannot install records the failure and leaves the registry alone', async () => {
    const r = await rig()
    await r.publish([{ name: 'cool', version: '1.1.0' }])
    await r.service.check()
    // The installed copy is what the listing would be copied from: take it away.
    const contentDir = `${HOME}/.velloc/plugins/marketplaces/my-mkt/plugins/cool`
    await r.fs.rm(contentDir)
    await expect(r.service.update(ID)).rejects.toThrow()
    const state = await r.service.snapshot()
    expect(state.plugins[0]).toMatchObject({ state: 'failed', offer: { version: '1.1.0' } })
    expect(state.plugins[0]!.failure!.version).toBe('1.1.0')
    expect((await r.installed())!.version).toBe('1.0.0')
    expect(r.reloadPluginsOnAllSessions).not.toHaveBeenCalled()
  })

  it('the auto-update round does nothing while the setting is off', async () => {
    const r = await rig()
    await r.publish([{ name: 'cool', version: '1.1.0' }])
    const before = r.fetchImpl.mock.calls.length
    await r.service.autoUpdate()
    expect(r.fetchImpl.mock.calls.length).toBe(before)
    expect((await r.installed())!.version).toBe('1.0.0')
  })

  it('with the setting on, the round installs enabled plugins and leaves disabled ones offered', async () => {
    const r = await rig([
      { name: 'cool', version: '1.0.0' },
      { name: 'quiet', version: '1.0.0' },
    ])
    await setPluginEnabled(ctx, r.fs, 'quiet@my-mkt', false)
    await r.publish([
      { name: 'cool', version: '1.1.0' },
      { name: 'quiet', version: '1.1.0' },
    ])
    await r.service.setAutoUpdate(true)
    await r.service.autoUpdate()
    expect((await r.installed())!.version).toBe('1.1.0')
    expect((await r.installed('quiet@my-mkt'))!.version).toBe('1.0.0')
    const state = await r.service.snapshot()
    expect(state.autoUpdate).toBe(true)
    expect(state.plugins.find(p => p.identifier === ID)!.applied).toMatchObject({ version: '1.1.0', auto: true })
    expect(state.plugins.find(p => p.identifier === 'quiet@my-mkt')!.state).toBe('available')
  })

  it('leaves out provider plugins and plugins recorded for a project', async () => {
    const r = await rig([
      { name: 'cool', version: '1.0.0' },
      { name: 'acme', version: '1.0.0', providers: true },
    ])
    await recordPluginSetup(ctx, r.fs, 'proj@my-mkt', {
      scope: 'project',
      projectPath: '/work/app',
      installPath: '/work/app/.velloc/plugins/proj',
      version: '1.0.0',
    })
    const state = await r.service.snapshot()
    expect(state.plugins.map(p => p.identifier)).toEqual([ID])
    await expect(r.service.update('acme@my-mkt')).rejects.toThrow(/not a marketplace plugin installed for this user/)
  })
})

describe('plugin update schedule', () => {
  it('runs the first round after the delay and then at the interval until stopped', async () => {
    const timers: Array<{ run: () => void; ms: number }> = []
    const autoUpdate = vi.fn(async () => undefined)
    const stop = startPluginUpdateSchedule(
      { autoUpdate },
      {
        firstDelayMs: 5,
        intervalMs: 50,
        setTimer: (run, ms) => {
          timers.push({ run, ms })
          return timers.length
        },
        clearTimer: () => undefined,
      },
    )
    expect(timers.map(t => t.ms)).toEqual([5])
    timers[0]!.run()
    await vi.waitFor(() => expect(timers.map(t => t.ms)).toEqual([5, 50]))
    expect(autoUpdate).toHaveBeenCalledTimes(1)
    stop()
    timers[1]!.run()
    await vi.waitFor(() => expect(autoUpdate).toHaveBeenCalledTimes(2))
    expect(timers).toHaveLength(2)
  })
})

describe('plugin updates protocol', () => {
  it('needs the full grant for every action', () => {
    expect(Object.values(PLUGIN_UPDATES_ACTION_SCOPES)).toEqual(['full', 'full', 'full', 'full'])
  })

  it('accepts only the fields each action knows', () => {
    expect(isPluginUpdatesCheckPayload(undefined)).toBe(true)
    expect(isPluginUpdatesCheckPayload({ force: true })).toBe(true)
    expect(isPluginUpdatesCheckPayload({ force: 'yes' })).toBe(false)
    expect(isPluginUpdatesPluginPayload({ identifier: ID })).toBe(true)
    expect(isPluginUpdatesPluginPayload({ identifier: ID, path: '/x' })).toBe(false)
    expect(isPluginUpdatesPluginPayload({ identifier: '' })).toBe(false)
    expect(isPluginUpdatesAutoPayload({ on: false })).toBe(true)
    expect(isPluginUpdatesAutoPayload({ on: 1 })).toBe(false)
  })
})

describe('syncMarketplace', () => {
  it('installs the offers of one marketplace whatever the setting says, over listings handed in', async () => {
    const r = await rig()
    await r.publish([{ name: 'cool', version: '1.1.0' }])
    // The listings come from the caller; the origin is down, so nothing is downloaded.
    const listings = [{ name: 'cool', source: { source: 'local' as const, path: 'plugins/cool' } }]
    await r.service.check({ force: true })
    r.goDown()
    const result = await r.service.syncMarketplace('my-mkt', listings)
    expect(result).toEqual({ updated: [ID], failed: [] })
    expect((await r.installed())?.version).toBe('1.1.0')
    expect(r.reloadPluginsOnAllSessions).toHaveBeenCalled()
    const status = (await r.service.snapshot()).plugins.find(p => p.identifier === ID)
    expect(status).toMatchObject({ version: '1.1.0', applied: { version: '1.1.0', auto: true }, rollbackVersion: '1.0.0' })
  })

  it('leaves an explicit-off plugin and a rolled-back version alone', async () => {
    const r = await rig()
    await r.publish([{ name: 'cool', version: '1.1.0' }])
    await setPluginEnabled(ctx, r.fs, ID, false)
    expect(await r.service.syncMarketplace('my-mkt')).toEqual({ updated: [], failed: [] })
    expect((await r.installed())?.version).toBe('1.0.0')
    await setPluginEnabled(ctx, r.fs, ID, null)
    expect(await r.service.syncMarketplace('my-mkt')).toEqual({ updated: [ID], failed: [] })
    await r.service.rollback(ID)
    expect((await r.installed())?.version).toBe('1.0.0')
    expect(await r.service.syncMarketplace('my-mkt')).toEqual({ updated: [], failed: [] })
    expect((await r.installed())?.version).toBe('1.0.0')
  })

  it('touches only that marketplace: the global check stamp and other records stay', async () => {
    const r = await rig()
    await r.service.check({ force: true })
    const before = await r.service.snapshot()
    await r.publish([{ name: 'cool', version: '1.1.0' }])
    r.advance(1000)
    await r.service.syncMarketplace('other-mkt')
    const after = await r.service.snapshot()
    expect(after.lastCheckedAt).toBe(before.lastCheckedAt)
    expect(after.plugins).toEqual(before.plugins)
  })
})

describe('built-in marketplace schedule', () => {
  it('retries while the host has no home folder, then runs once per interval, and stops on dispose', async () => {
    const timers: Array<{ run: () => void; ms: number }> = []
    const cleared: unknown[] = []
    let handles = 0
    let ready = false
    let runs = 0
    const stop = startBuiltinMarketplaceSchedule(
      async () => {
        if (!ready) return 'not-ready'
        runs += 1
        return 'ran'
      },
      {
        firstDelayMs: 1,
        retryDelayMs: 5,
        intervalMs: 100,
        setTimer: (run, ms) => {
          timers.push({ run, ms })
          handles += 1
          return handles
        },
        clearTimer: handle => cleared.push(handle),
        report: () => undefined,
      },
    )
    const fire = async () => {
      const next = timers.shift()!
      next.run()
      await new Promise(resolve => setTimeout(resolve, 0))
      return next.ms
    }
    expect(await fire()).toBe(1)
    expect(timers[0]!.ms).toBe(5)
    ready = true
    expect(await fire()).toBe(5)
    expect(runs).toBe(1)
    expect(timers[0]!.ms).toBe(100)
    stop()
    expect(cleared).toEqual([3])
  })

  it('runs the seeder over the capability\'s home and service, and reports the outcome', async () => {
    const registry = new CapabilityRegistry()
    const outcomes: BuiltinSeedOutcome[] = []
    const timers: Array<() => void> = []
    const r = registerPluginUpdatesCapability(registry, new TopicBroker(), {
      context: () => ({ fs: makeMemFs(), directBridge: null }),
      resolveHome: async () => HOME,
      schedule: { setTimer: () => 0, clearTimer: () => undefined },
      builtinMarketplace: {
        channel: () => 'stable',
        autoInstall: async () => false,
        setTimer: run => {
          timers.push(run)
          return timers.length
        },
        clearTimer: () => undefined,
        onRun: outcome => outcomes.push(outcome),
      },
    })
    timers.shift()!()
    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    expect(outcomes[0]).toMatchObject({ ran: false, installed: [] })
    r.dispose()
  })
})

describe('plugin updates capability', () => {
  function capability(resolveHome: () => Promise<string>) {
    const registry = new CapabilityRegistry()
    const homes: string[] = []
    const r = registerPluginUpdatesCapability(registry, new TopicBroker(), {
      context: () => ({ fs: makeMemFs(), directBridge: null }),
      resolveHome,
      createService: deps => {
        homes.push(deps.homeDir)
        return {
          snapshot: async () => ({ autoUpdate: false, checking: false, unreachable: [], plugins: [] }),
          check: async () => ({ autoUpdate: false, checking: false, lastCheckedAt: 'now', unreachable: [], plugins: [] }),
          update: async () => {
            throw new Error('unused')
          },
          syncMarketplace: async () => ({ updated: [], failed: [] }),
          rollback: async () => {
            throw new Error('unused')
          },
          setAutoUpdate: async () => ({ autoUpdate: true, checking: false, unreachable: [], plugins: [] }),
          autoUpdate: async () => undefined,
          subscribe: () => () => undefined,
        }
      },
      schedule: false,
    })
    const ask = (act: string, payload: unknown = {}) =>
      registry
        .resolve('pluginUpdates', act)!
        .handle({ id: '1', route: { cap: 'pluginUpdates', act }, payload, conn: {} } as never, {} as never)
    return { ask, homes, dispose: r.dispose }
  }

  it('asks the host for the home folder when the runtime has none yet', async () => {
    const c = capability(async () => HOME)
    await expect(c.ask('check')).resolves.toMatchObject({ lastCheckedAt: 'now' })
    expect(c.homes).toEqual([HOME])
    c.dispose()
  })

  it('answers host_unavailable while the host cannot name the home folder', async () => {
    const c = capability(async () => {
      throw new Error('no host')
    })
    await expect(c.ask('check')).rejects.toMatchObject({ code: 'host_unavailable' })
    c.dispose()
  })
})
