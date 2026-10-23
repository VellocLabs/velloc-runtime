import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerModProviderDefinition, resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { reapplyProviderCatalog, resetCustomProviderRecords } from '../config/customProviderRegistry'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import { getAutoTierModel, getFastModelForProvider } from '../engine/contextWindow'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { modProviderDefinition } from '../mods/provider/modProviderDefinition'
import { resolveProviders } from '../mods/provider/providerManifest'
import {
  configureRuntimeProviders,
  resetRuntimeProviders,
  refreshRuntimeProviderModels,
  setRuntimeProviderConfigs,
  type RuntimeProvidersHost,
} from '../models/drivers/runtimeProviders'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { ProviderModelInfo } from '../config/nexusModelConfig/providerDefinition'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * A provider mod's `modelsUi.starterModels` are picked for the person on the
 * first verified connection (the way a built-in gateway's `starterModels` are),
 * skipping ids the listing lacks, and never second-guessing a person who has
 * picked, or emptied, their models. Its `modelsUi.tierModels` is the
 * provider's own tier ladder: each declared tier runs on the named model, an
 * undeclared tier names nothing, a malformed declaration refuses the manifest.
 */

const ID = 'mod.acme.main'
const transport = { request: vi.fn() } as unknown as BrowserBridgeTransport
let listed: ProviderModelInfo[] = []
let written: NexusProviderConfig | undefined

function descriptor(modelsUi: Record<string, unknown>) {
  return checkPluginDescriptor({
    name: 'acme',
    version: '1.0.0',
    providers: {
      main: {
        providerApi: 1,
        displayName: { en: 'Acme' },
        defaultBaseUrl: 'https://api.acme.example/v1',
        domains: ['api.acme.example'],
        format: 'openai-chat',
        credentials: { methods: ['apiKey'] },
        module: './providers/main.js',
        modelsUi,
      },
    },
  })
}

function register(modelsUi: Record<string, unknown>) {
  const { manifest, errors } = descriptor(modelsUi)
  expect(errors).toEqual([])
  const provider = resolveProviders('acme', '/p/acme', manifest!.providers!)[0]!
  registerModProviderDefinition(
    modProviderDefinition({
      plugin: 'acme',
      provider,
      isLoaded: () => true,
      list: async () => listed,
    }),
  )
  reapplyProviderCatalog()
}

function runtimeHost() {
  const host: RuntimeProvidersHost = {
    writeProviderConfig: vi.fn(async (_id: string, config: NexusProviderConfig) => { written = config }),
    readCache: vi.fn(async () => undefined),
    writeCache: vi.fn(async () => {}),
  }
  configureRuntimeProviders(host)
  return host
}

const KEYED: NexusProviderConfig = { source: 'mod', modVersion: '1.0.0', apiKey: 'sealed' }

function setUp(starterModels: string[] | null = ['gw/fast', 'gw/best', 'gw/gone']) {
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
  written = undefined
  listed = [
    { id: 'gw/fast', supportsTools: true },
    { id: 'gw/best', supportsTools: true },
    { id: 'gw/other', supportsTools: true },
  ]
  runtimeHost()
  register({ starterModels: starterModels ?? undefined })
}

afterEach(() => {
  resetModProviderDefinitions()
  resetRuntimeProviders()
  configureRuntimeProviders(undefined)
})

const connect = () => refreshRuntimeProviderModels(transport, ID, { force: true, pickDefaults: true })

describe('provider mod starter models', () => {
  it('picks the declared ids on a first connection and skips one the listing lacks', async () => {
    setUp()
    setRuntimeProviderConfigs({ [ID]: KEYED })
    expect((await connect()).ok).toBe(true)
    expect(written?.modelEntries?.map(e => e.id)).toEqual(['gw/fast', 'gw/best'])
    expect(written?.defaultModel).toBe('gw/fast@latest')
  })

  it('picks nothing when the manifest declares none', async () => {
    setUp(null)
    setRuntimeProviderConfigs({ [ID]: KEYED })
    await connect()
    expect(written?.modelEntries).toBeUndefined()
  })

  it('does not second-guess a person who emptied their models', async () => {
    setUp()
    setRuntimeProviderConfigs({ [ID]: { ...KEYED, modelEntries: [] } })
    await connect()
    expect(written?.modelEntries ?? []).toEqual([])
  })

  it("does not add to a person's own picks", async () => {
    setUp()
    setRuntimeProviderConfigs({ [ID]: { ...KEYED, modelEntries: [{ family: 'gw/other', version: 'latest', id: 'gw/other' }] } })
    await connect()
    expect(written?.modelEntries?.map(e => e.id) ?? ['gw/other']).toEqual(['gw/other'])
  })
})

describe('provider mod tier models', () => {
  const tiered = (tierModels: unknown) => {
    resetModProviderDefinitions()
    resetCustomProviderRecords()
    register({ starterModels: ['gw/fast', 'gw/best', 'gw/other'], tierModels })
  }

  it('runs each declared tier on its named model', () => {
    tiered({ best: 'gw/best', balanced: 'gw/other', fast: 'gw/fast' })
    expect(getAutoTierModel(ID, 'x/session', 'best', NEXUS_MODEL_CONFIG)).toBe('gw/best')
    expect(getAutoTierModel(ID, 'x/session', 'balanced', NEXUS_MODEL_CONFIG)).toBe('gw/other')
    expect(getAutoTierModel(ID, 'x/session', 'fast', NEXUS_MODEL_CONFIG)).toBe('gw/fast')
    expect(getFastModelForProvider(ID, NEXUS_MODEL_CONFIG)).toBe('gw/fast')
  })

  it('leaves an undeclared tier unnamed', () => {
    tiered({ best: 'gw/best' })
    expect(getAutoTierModel(ID, 'gw/other', 'best', NEXUS_MODEL_CONFIG)).toBe('gw/best')
    expect(getAutoTierModel(ID, 'gw/other', 'balanced', NEXUS_MODEL_CONFIG)).toBeUndefined()
    expect(getFastModelForProvider(ID, NEXUS_MODEL_CONFIG)).toBeUndefined()
  })

  it('names no tier when the manifest declares none', () => {
    tiered(undefined)
    expect(getAutoTierModel(ID, 'gw/other', 'best', NEXUS_MODEL_CONFIG)).toBeUndefined()
  })

  it.each([
    [{ ultra: 'gw/best' }, 'unknown property "ultra"'],
    [{ best: 'gw/*' }, 'tierModels.best: expected a model id'],
    [{ fast: 'gw fast' }, 'tierModels.fast: expected a model id'],
    [{ balanced: 7 }, 'tierModels.balanced: expected a model id'],
    [['gw/best'], 'tierModels: expected an object'],
  ])('refuses the malformed declaration %j', (tierModels, message) => {
    expect(descriptor({ tierModels }).errors.join(' ')).toContain(message)
  })
})
