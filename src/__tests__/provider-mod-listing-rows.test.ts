import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  registerModProviderDefinition,
  resetModProviderDefinitions,
} from '../config/nexusModelConfig/providers'
import { reapplyProviderCatalog, resetCustomProviderRecords } from '../config/customProviderRegistry'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { modProviderDefinition } from '../mods/provider/modProviderDefinition'
import { resolveProviders } from '../mods/provider/providerManifest'
import {
  configureRuntimeProviders,
  refreshConfiguredRuntimeProviderModels,
  refreshRuntimeProviderModels,
  resetRuntimeProviders,
  runtimeProviderCatalogRows,
  setRuntimeProviderConfigs,
  type RuntimeProvidersHost,
} from '../models/drivers/runtimeProviders'
import { contextWindowOf, getDefaultMaxOutputTokensForModel } from '../engine/contextWindow'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { ProviderModelInfo } from '../config/nexusModelConfig/providerDefinition'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * A provider mod's listed models keep their figures when the mod is registered
 * again while its listing is still fresh: nothing is fetched then, so the rows
 * must come from the listing already held.
 */

const ID = 'mod.acme.main'
const MODEL = 'vendor/wide-9.1-flash'
const ENTRY = 'vendor/wide-*-flash@latest'
const transport = { request: vi.fn() } as unknown as BrowserBridgeTransport
const LISTED: ProviderModelInfo[] = [{ id: MODEL, supportsTools: true, contextWindow: 1_048_576 }]
const STORED: Record<string, NexusProviderConfig> = {
  [ID]: {
    source: 'mod',
    modVersion: '1.0.0',
    apiKey: 'sealed',
    modelEntries: [{ family: 'vendor/wide-*-flash', version: 'latest', id: MODEL }],
  },
}
const list = vi.fn(async () => ({ models: LISTED }))

function register(): void {
  const { manifest, errors } = checkPluginDescriptor({
    name: 'acme',
    version: '1.0.0',
    providers: {
      main: {
        providerApi: 1,
        displayName: { en: 'Acme' },
        defaultBaseUrl: 'https://api.acme.example/v1',
        domains: ['api.acme.example'],
        // Any wire format: a built-in's own.
        format: BUILTIN_PROVIDER_DEFINITIONS.find(d => d.config.wire)!.config.wire!.format,
        credentials: { methods: ['apiKey'] },
        module: './providers/main.js',
      },
    },
  })
  expect(errors).toEqual([])
  const provider = resolveProviders('acme', '/p/acme', manifest!.providers!)[0]!
  registerModProviderDefinition(
    modProviderDefinition({ plugin: 'acme', pluginVersion: '1.0.0', provider, isLoaded: () => true, list }),
  )
  reapplyProviderCatalog()
}

function runtimeHost(cached?: string): void {
  const host: RuntimeProvidersHost = {
    writeProviderConfig: vi.fn(async () => {}),
    readCache: vi.fn(async () => cached),
    writeCache: vi.fn(async () => {}),
  }
  configureRuntimeProviders(host)
}

/** What a request for the entry reads: its window and first-request allowance. */
function figures(): [number, number | undefined] {
  runtimeProviderCatalogRows()
  return [contextWindowOf(ENTRY, ID), getDefaultMaxOutputTokensForModel(ENTRY, ID)]
}

beforeEach(() => {
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
  list.mockClear()
})

afterEach(() => {
  resetModProviderDefinitions()
  resetRuntimeProviders()
  configureRuntimeProviders(undefined)
})

describe('a provider mod registered again while its listing is fresh', () => {
  it('keeps the figures of a fetched listing, without another fetch', async () => {
    runtimeHost()
    register()
    setRuntimeProviderConfigs(STORED)
    await refreshRuntimeProviderModels(transport, ID)
    expect(figures()).toEqual([1_048_576, 128_000])

    register()
    await refreshRuntimeProviderModels(transport, ID)
    expect(list).toHaveBeenCalledTimes(1)
    expect(figures()).toEqual([1_048_576, 128_000])
  })

  it('keeps the figures of a listing read from the cache', async () => {
    runtimeHost(JSON.stringify({ models: LISTED, fetchedAt: Date.now() }))
    register()
    setRuntimeProviderConfigs(STORED)
    await refreshConfiguredRuntimeProviderModels(transport)
    expect(figures()).toEqual([1_048_576, 128_000])

    register()
    await refreshConfiguredRuntimeProviderModels(transport)
    expect(list).not.toHaveBeenCalled()
    expect(figures()).toEqual([1_048_576, 128_000])
  })
})

describe('a listing that states how long it stays fresh', () => {
  const T = 1_800_000_000_000

  it('is asked for again once its ttlMs has passed, not an hour later', async () => {
    runtimeHost()
    register()
    setRuntimeProviderConfigs(STORED)
    list.mockResolvedValueOnce({ models: LISTED, ttlMs: 60_000 } as never)
    await refreshRuntimeProviderModels(transport, ID, { now: T })
    await refreshRuntimeProviderModels(transport, ID, { now: T + 59_000 })
    expect(list).toHaveBeenCalledTimes(1)
    await refreshRuntimeProviderModels(transport, ID, { now: T + 61_000 })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('without ttlMs it stays fresh for MODEL_LISTING_TTL_MS', async () => {
    runtimeHost()
    register()
    setRuntimeProviderConfigs(STORED)
    await refreshRuntimeProviderModels(transport, ID, { now: T })
    await refreshRuntimeProviderModels(transport, ID, { now: T + 61_000 })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('holds a cached ttlMs within the bounds', async () => {
    runtimeHost(JSON.stringify({ models: LISTED, fetchedAt: T, ttlMs: 1 }))
    register()
    setRuntimeProviderConfigs(STORED)
    await refreshRuntimeProviderModels(transport, ID, { now: T + 29_000 })
    expect(list).not.toHaveBeenCalled()
    await refreshRuntimeProviderModels(transport, ID, { now: T + 31_000 })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('keeps its ttlMs through the cache', async () => {
    runtimeHost(JSON.stringify({ models: LISTED, fetchedAt: T, ttlMs: 60_000 }))
    register()
    setRuntimeProviderConfigs(STORED)
    await refreshRuntimeProviderModels(transport, ID, { now: T + 30_000 })
    expect(list).not.toHaveBeenCalled()
    await refreshRuntimeProviderModels(transport, ID, { now: T + 61_000 })
    expect(list).toHaveBeenCalledTimes(1)
  })
})
