import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerModProviderDefinition, resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { reapplyProviderCatalog, resetCustomProviderRecords } from '../config/customProviderRegistry'
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
 * picked, or emptied, their models.
 */

const ID = 'mod.acme.main'
const transport = { request: vi.fn() } as unknown as BrowserBridgeTransport
let listed: ProviderModelInfo[] = []
let written: NexusProviderConfig | undefined

function register(starterModels: string[] | undefined) {
  const { manifest, errors } = checkPluginDescriptor({
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
        modelsUi: { starterModels },
      },
    },
  })
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
  register(starterModels ?? undefined)
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
