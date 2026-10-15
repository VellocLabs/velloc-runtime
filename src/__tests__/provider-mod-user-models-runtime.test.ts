import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerModProviderDefinition, resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { reapplyProviderCatalog, resetCustomProviderRecords } from '../config/customProviderRegistry'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { modProviderDefinition } from '../mods/provider/modProviderDefinition'
import { resolveProviders } from '../mods/provider/providerManifest'
import {
  configureRuntimeProviders,
  resetRuntimeProviders,
  runtimeProviderCatalogRows,
  setRuntimeProviderConfigs,
  type RuntimeProvidersHost,
} from '../models/drivers/runtimeProviders'
import { listedModelInfo } from '../models/drivers/runtimeProviders'
import { providerModelFamilies } from '../models/drivers/modelFamilies'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { ProviderModelInfo } from '../config/nexusModelConfig/providerDefinition'
import type { NexusProviderConfig } from '../settings/settingsTypes'

/**
 * The models a person adds by hand to a provider mod read as listed models:
 * the families the picker offers include them (in the custom group, flagged),
 * a picked one survives the next refresh (its listing no longer carries it, the
 * merged listing does), and a listed model with the same id wins.
 */

const ID = 'mod.acme.main'
const transport = { request: vi.fn() } as unknown as BrowserBridgeTransport
let listed: ProviderModelInfo[] = []

function register() {
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
        modelsUi: {
          customModels: {
            formats: ['openai-chat', 'anthropic-messages'],
            wires: {
              'openai-chat': { compat: { maxTokensField: 'max_tokens' } },
              'anthropic-messages': {
                baseUrl: 'https://api.acme.example',
                headers: { 'x-api-key': '{{secret:api_key}}' },
              },
            },
          },
        },
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
    writeProviderConfig: vi.fn(async () => {}),
    readCache: vi.fn(async () => undefined),
    writeCache: vi.fn(async () => {}),
  }
  configureRuntimeProviders(host)
  return host
}

const KEYED: NexusProviderConfig = { source: 'mod', modVersion: '1.0.0', apiKey: 'sealed' }

beforeEach(() => {
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
  listed = [{ id: 'listed-a', supportsTools: true, group: 'chat' }]
  runtimeHost()
  register()
})

afterEach(() => {
  resetModProviderDefinitions()
  resetRuntimeProviders()
  configureRuntimeProviders(undefined)
})

const idsOf = async () => {
  const result = await providerModelFamilies(transport, ID, { force: true })
  return result.families.flatMap(f => f.versions.map(v => v.id)).sort()
}

describe('hand-added models in a provider mod\'s families', () => {
  it('offers them beside the listed ones, in the custom group and flagged', async () => {
    setRuntimeProviderConfigs({ [ID]: { ...KEYED, userModels: [{ id: 'mine', name: 'Mine', contextWindow: 9000 }] } })
    const result = await providerModelFamilies(transport, ID, { force: true })
    expect(result.ok).toBe(true)
    expect(await idsOf()).toEqual(['listed-a', 'mine'])
    const mine = result.families.find(f => f.versions.some(v => v.id === 'mine'))!
    expect(mine.group).toBe('custom')
    expect(mine.versions[0]).toMatchObject({ userAdded: true, contextWindow: 9000, tags: ['custom'] })
    expect(result.families.find(f => f.versions.some(v => v.id === 'listed-a'))!.group).toBe('chat')
  })

  it('a listed model with the same id wins', async () => {
    setRuntimeProviderConfigs({ [ID]: { ...KEYED, userModels: [{ id: 'listed-a', contextWindow: 1 }] } })
    const result = await providerModelFamilies(transport, ID, { force: true })
    const family = result.families.find(f => f.versions.some(v => v.id === 'listed-a'))!
    expect(family.group).toBe('chat')
    expect(family.versions[0]!.userAdded).toBeUndefined()
  })

  it('changing the list changes the families without a refetch', async () => {
    setRuntimeProviderConfigs({ [ID]: KEYED })
    expect(await idsOf()).toEqual(['listed-a'])
    setRuntimeProviderConfigs({ [ID]: { ...KEYED, userModels: [{ id: 'mine' }] } })
    const cached = await providerModelFamilies(transport, ID)
    expect(cached.families.flatMap(f => f.versions.map(v => v.id)).sort()).toEqual(['listed-a', 'mine'])
    setRuntimeProviderConfigs({ [ID]: KEYED })
    const after = await providerModelFamilies(transport, ID)
    expect(after.families.flatMap(f => f.versions.map(v => v.id))).toEqual(['listed-a'])
  })

  it('a picked hand-added model survives a refresh of the provider\'s own listing', async () => {
    setRuntimeProviderConfigs({
      [ID]: {
        ...KEYED,
        userModels: [{ id: 'mine' }],
        modelEntries: [
          { family: 'mine', version: 'latest' },
          { family: 'listed-a', version: 'latest' },
        ],
      },
    })
    await providerModelFamilies(transport, ID, { force: true })
    const row = runtimeProviderCatalogRows().find(r => r.id === ID)!
    expect(row.models.map(m => m.entry?.family).sort()).toEqual(['listed-a', 'mine'])
  })

  it('gives a hand-added model the wire its manifest declares for its format', async () => {
    setRuntimeProviderConfigs({
      [ID]: {
        ...KEYED,
        userModels: [{ id: 'plain' }, { id: 'anthropic-style', format: 'anthropic-messages' }],
      },
    })
    await providerModelFamilies(transport, ID, { force: true })
    // No format named: the provider's own (openai-chat) wire facts.
    expect(listedModelInfo(ID, 'plain')?.wire).toEqual({ compat: { maxTokensField: 'max_tokens' } })
    expect(listedModelInfo(ID, 'anthropic-style')?.wire).toEqual({
      format: 'anthropic-messages',
      baseUrl: 'https://api.acme.example',
      headers: { 'x-api-key': '{{secret:api_key}}' },
    })
  })
})
