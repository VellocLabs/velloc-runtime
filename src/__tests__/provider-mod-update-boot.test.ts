/**
 * Provider mods: when the boot builds the update service and starts its schedule (no provider plugin: nothing; no
 * source: a service on demand, no schedule; a plugin with `updates`: the schedule, after the scan).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePlugin } from '../pluginHost/pluginModel'
import { resolveProviders } from '../mods/provider/providerManifest'

const events: string[] = []
let scanResult: { enabled: ActivePlugin[]; disabled: ActivePlugin[]; errors: unknown[] } = { enabled: [], disabled: [], errors: [] }
const stopSchedule = vi.fn(() => {
  events.push('schedule-stopped')
})
const startSchedule = vi.fn((_service: unknown, _options?: unknown) => {
  events.push('schedule-started')
  return stopSchedule
})
const fakeService = {
  status: vi.fn(async () => []),
  checkNow: vi.fn(),
  checkDue: vi.fn(),
  recordConsent: vi.fn(),
  decline: vi.fn(),
  rollback: vi.fn(),
  recordInitialConsent: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}
const createService = vi.fn((_deps: unknown) => fakeService)

vi.mock('../pluginHost/loadPlugins', async importOriginal => ({
  ...(await importOriginal<typeof import('../pluginHost/loadPlugins')>()),
  gatherPlugins: vi.fn(async () => scanResult),
  loadMarketplaceInstallState: vi.fn(async () => ({ installRegistry: {} })),
}))
vi.mock('../pluginHost/providerPluginConsent', async importOriginal => ({
  ...(await importOriginal<typeof import('../pluginHost/providerPluginConsent')>()),
  readConsentedPluginIds: vi.fn(async () => new Set(['acme@shop'])),
  consentCovers: vi.fn(async (_ctx: unknown, _fs: unknown, identifier: string) => identifier === 'acme@shop'),
}))
vi.mock('../pluginHost/enabledPlugins', () => ({ getEnabledPluginsMap: vi.fn(async () => ({})) }))
vi.mock('../pluginHost/enabledStore', () => ({ loadEffectiveEnabledPlugins: vi.fn(async () => undefined) }))
vi.mock('../pluginHost/providerModUpdates', async importOriginal => ({
  ...(await importOriginal<typeof import('../pluginHost/providerModUpdates')>()),
  startProviderModUpdateSchedule: startSchedule,
}))
vi.mock('../mods/provider/providerModUpdateWiring', () => ({ createProductionUpdateService: createService }))
vi.mock('../mods/provider/providerModRuntimeFactory', () => ({
  createProviderModRuntime: () => ({
    register: () => {
      events.push('registered')
    },
    replace: async () => {
      events.push('registered')
    },
    unregister: () => {},
    dispose: () => {},
    status: () => [],
  }),
}))

import { resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { resetCustomProviderRecords } from '../config/customProviderRegistry'
import {
  disposeProviderModBoot,
  hasProviderUpdateSource,
  providerUpdateScheduleRunning,
  recordProviderPluginConsent,
  reloadProviderMods,
  bootProviderMods,
} from '../mods/provider/providerModBoot'
import { getProviderModHost } from '../mods/provider/providerModHost'
import {
  acquireProviderModUpdateService,
  providerModUpdatesAvailable,
} from '../pluginHost/providerModUpdateHolder'

const PROVIDER = {
  providerApi: 1,
  displayName: 'Zen',
  defaultBaseUrl: 'https://opencode.ai/zen/v1',
  domains: ['opencode.ai'],
  format: 'openai-chat',
  credentials: { methods: ['apiKey'] },
  module: './providers/zen.ts',
}

function plugin(name: string, source: string, extra: Record<string, unknown> = {}): ActivePlugin {
  const path = `/home/u/.velloc/plugins/${name}`
  const providers = { zen: { ...PROVIDER, ...extra } }
  return {
    name,
    manifest: { name, version: '1.0.0', providers: providers as never },
    path,
    source,
    enabled: true,
    providers: resolveProviders(name, path, providers as never),
  }
}

const UPDATES = { updates: { url: 'https://example.com/acme.json' } }

async function boot(): Promise<void> {
  await bootProviderMods({
    homeDir: '/home/u',
    fs: {} as never,
    transport: () => null,
  })
}

beforeEach(() => {
  events.length = 0
  scanResult = { enabled: [], disabled: [], errors: [] }
  vi.clearAllMocks()
})

afterEach(() => {
  disposeProviderModBoot()
  getProviderModHost().dispose()
  resetModProviderDefinitions()
  resetCustomProviderRecords()
})

describe('hasProviderUpdateSource', () => {
  it('is true for a marketplace plugin whose provider names an update source, in either list', () => {
    expect(hasProviderUpdateSource({ enabled: [plugin('a', 'marketplace:a@shop', UPDATES)], disabled: [] })).toBe(true)
    expect(hasProviderUpdateSource({ enabled: [], disabled: [plugin('a', 'marketplace:a@shop', UPDATES)] })).toBe(true)
  })
  it('is false without one, and for a directory plugin (it has no registry entry to update)', () => {
    expect(hasProviderUpdateSource({ enabled: [plugin('a', 'marketplace:a@shop')], disabled: [] })).toBe(false)
    expect(hasProviderUpdateSource({ enabled: [plugin('a', 'user:/x', UPDATES)], disabled: [] })).toBe(false)
    expect(hasProviderUpdateSource({ enabled: [], disabled: [] })).toBe(false)
  })
})

describe('the boot and the update schedule', () => {
  it('a realm with no provider plugin has no service and no schedule', async () => {
    await boot()
    expect(providerModUpdatesAvailable()).toBe(false)
    expect(providerUpdateScheduleRunning()).toBe(false)
    expect(await acquireProviderModUpdateService()).toBeNull()
    expect(createService).not.toHaveBeenCalled()
    expect(startSchedule).not.toHaveBeenCalled()
  })

  it('provider plugins without an update source: a service on demand, no schedule', async () => {
    scanResult = { enabled: [plugin('acme', 'marketplace:acme@shop')], disabled: [], errors: [] }
    await boot()
    expect(providerModUpdatesAvailable()).toBe(true)
    // Not built until something asks.
    expect(createService).not.toHaveBeenCalled()
    expect(startSchedule).not.toHaveBeenCalled()
    expect(providerUpdateScheduleRunning()).toBe(false)
    expect(await acquireProviderModUpdateService()).toBe(fakeService)
    expect(createService).toHaveBeenCalledTimes(1)
    expect(startSchedule).not.toHaveBeenCalled()
  })

  it('an update source starts the schedule once - after the first scan was registered, not before', async () => {
    scanResult = { enabled: [plugin('acme', 'marketplace:acme@shop', UPDATES)], disabled: [], errors: [] }
    await boot()
    expect(events).toEqual(['registered', 'schedule-started'])
    expect(startSchedule).toHaveBeenCalledTimes(1)
    expect(providerUpdateScheduleRunning()).toBe(true)
    // A later scan (a plugin changed) does not start a second one, nor build a second service.
    await reloadProviderMods()
    await reloadProviderMods()
    expect(startSchedule).toHaveBeenCalledTimes(1)
    expect(createService).toHaveBeenCalledTimes(1)
  })

  it('removing the last update source, or the last provider plugin, stops the schedule', async () => {
    scanResult = { enabled: [plugin('acme', 'marketplace:acme@shop', UPDATES)], disabled: [], errors: [] }
    await boot()
    scanResult = { enabled: [plugin('acme', 'marketplace:acme@shop')], disabled: [], errors: [] }
    await reloadProviderMods()
    expect(stopSchedule).toHaveBeenCalledTimes(1)
    expect(providerUpdateScheduleRunning()).toBe(false)
    expect(providerModUpdatesAvailable()).toBe(true)
    scanResult = { enabled: [], disabled: [], errors: [] }
    await reloadProviderMods()
    expect(providerModUpdatesAvailable()).toBe(false)
  })

  it('disposing the boot stops the schedule', async () => {
    scanResult = { enabled: [plugin('acme', 'marketplace:acme@shop', UPDATES)], disabled: [], errors: [] }
    await boot()
    expect(providerUpdateScheduleRunning()).toBe(true)
    disposeProviderModBoot()
    expect(stopSchedule).toHaveBeenCalledTimes(1)
    expect(providerUpdateScheduleRunning()).toBe(false)
    expect(providerModUpdatesAvailable()).toBe(false)
  })

  it('a reload before the boot is a no-op: nothing is scanned, nothing scheduled', async () => {
    await reloadProviderMods()
    expect(startSchedule).not.toHaveBeenCalled()
  })
})

describe('the first consent at a built-in install', () => {
  const AT = { homeDir: '/home/at', fs: { at: true } as never }

  it('goes through the service the boot already has', async () => {
    scanResult = { enabled: [plugin('acme', 'marketplace:acme@shop')], disabled: [], errors: [] }
    await boot()
    await recordProviderPluginConsent('acme@shop', AT)
    expect(createService).toHaveBeenCalledTimes(1)
    expect(createService.mock.calls[0]![0]).toMatchObject({ homeDir: '/home/u' })
    expect(fakeService.recordInitialConsent).toHaveBeenCalledExactlyOnceWith('acme@shop')
  })

  it('builds a service over the booted home when no provider plugin was there to make one', async () => {
    await boot()
    await recordProviderPluginConsent('nebius@velloc', AT)
    expect(createService).toHaveBeenCalledTimes(1)
    expect(createService.mock.calls[0]![0]).toMatchObject({ homeDir: '/home/u' })
    expect(fakeService.recordInitialConsent).toHaveBeenCalledExactlyOnceWith('nebius@velloc')
  })

  it('before the boot records over the home it is given', async () => {
    await recordProviderPluginConsent('nebius@velloc', AT)
    expect(createService.mock.calls[0]![0]).toMatchObject({ homeDir: '/home/at', fs: AT.fs })
    expect(fakeService.recordInitialConsent).toHaveBeenCalledExactlyOnceWith('nebius@velloc')
  })

  it('rejects when the service refuses the plugin', async () => {
    fakeService.recordInitialConsent.mockRejectedValueOnce(new Error('nebius@velloc is not an installed provider mod'))
    await expect(recordProviderPluginConsent('nebius@velloc', AT)).rejects.toThrow('not an installed provider mod')
  })
})
