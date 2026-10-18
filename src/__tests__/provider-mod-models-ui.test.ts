import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { parseModelsAnswer } from '../mods/provider/providerModelsAnswer'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import { providersHandlers } from '../browser/bridge/adapter/providersBridgeAdapter'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  registerModProviderDefinition,
  resetModProviderDefinitions,
} from '../config/nexusModelConfig/providers'
import type { ProviderDefinition } from '../config/nexusModelConfig/providerDefinition'
import {
  sanitizeUserModels,
  userModelToInfo,
  withUserModels,
} from '../config/nexusModelConfig/userModels'

/**
 * A provider mod's aggregated "Add models" page: the manifest's `modelsUi`
 * block (groups, badges, intro, links, hand-added models), the `group` / `tags`
 * a listing row may carry, and the models a person adds by hand
 * (`providers.setUserModels`, merged into the listing).
 */

function providerManifest(modelsUi: unknown) {
  return {
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
        ...(modelsUi === undefined ? {} : { modelsUi }),
      },
    },
  }
}

const check = (modelsUi: unknown) => {
  const { manifest, errors } = checkPluginDescriptor(providerManifest(modelsUi))
  return { ui: manifest?.providers?.main?.modelsUi, errors }
}

describe('manifest modelsUi', () => {
  it('keeps a full block', () => {
    const { ui, errors } = check({
      intro: { en: 'Pick models' },
      empty: 'No models yet',
      links: [{ label: { en: 'Pricing' }, url: 'https://acme.example/pricing' }],
      groups: { openai: { label: { en: 'OpenAI' }, order: 1 }, custom: { label: 'Mine' } },
      tags: { beta: { label: { en: 'Beta' } } },
      customModels: { formats: ['openai-chat', 'anthropic-messages'] },
    })
    expect(errors).toEqual([])
    expect(ui?.links).toHaveLength(1)
    expect(ui?.groups?.openai?.order).toBe(1)
    expect(ui?.tags?.beta?.label).toEqual({ en: 'Beta' })
    expect(ui?.customModels?.formats).toEqual(['openai-chat', 'anthropic-messages'])
  })

  it('a custom-model wire may cut its base from the provider base, but not also name one', () => {
    const ok = check({ customModels: { wires: { 'gemini': { baseUrlTrim: '/v1' } } } })
    expect(ok.errors).toEqual([])
    expect(ok.ui?.customModels?.wires?.['gemini']).toEqual({ baseUrlTrim: '/v1' })
    expect(check({ customModels: { wires: { 'gemini': { baseUrlTrim: 'v1' } } } }).errors).not.toEqual([])
    expect(
      check({ customModels: { wires: { 'gemini': { baseUrlTrim: '/v1', baseUrl: 'https://a.example' } } } }).errors,
    ).not.toEqual([])
  })

  it('customModels with no formats allows every wire format', () => {
    expect(check({ customModels: {} }).ui?.customModels?.formats).toHaveLength(4)
  })

  it('is absent when not declared', () => {
    expect(check(undefined).ui).toBeUndefined()
  })

  it.each([
    ['a non-https link', { links: [{ label: 'x', url: 'http://acme.example' }] }, /https URL/],
    ['an unknown property', { colour: 'red' }, /unknown property/],
    ['a bad group name', { groups: { 'bad name': { label: 'x' } } }, /letters, digits/],
    ['an unknown format', { customModels: { formats: ['soap'] } }, /formats/],
    ['a non-object block', 'nope', /expected an object/],
  ])('refuses %s', (_name, block, message) => {
    const { errors } = check(block)
    expect(errors.join('\n')).toMatch(message)
  })
})

describe('provider.models rows: group and tags', () => {
  const parse = (rows: unknown) => parseModelsAnswer('mod.acme.main', rows, 'https://api.acme.example/v1')

  it('keeps group and de-duplicated tags, drops unusable ones', () => {
    const { models } = parse([
      { id: 'a', supportsTools: true, group: 'openai', tags: ['beta', 'beta', '', 7, 'new'] },
      { id: 'b', supportsTools: true, group: 3, tags: 'beta' },
    ])
    expect(models[0]).toMatchObject({ group: 'openai', tags: ['beta', 'new'] })
    expect(models[1]).not.toHaveProperty('group')
    expect(models[1]).not.toHaveProperty('tags')
  })

  it('a free tag is the platform Free flag, not a badge', () => {
    const { models } = parse([
      { id: 'a', supportsTools: true, tags: ['free', 'beta'] },
      { id: 'b', supportsTools: true, tags: ['free'] },
      { id: 'c', supportsTools: true, tags: ['free'], free: false },
    ])
    expect(models[0]).toMatchObject({ free: true, tags: ['beta'] })
    expect(models[1]).toMatchObject({ free: true })
    expect(models[1]).not.toHaveProperty('tags')
    expect(models[2]!.free).toBe(false)
  })
})

describe('provider.models rows: description and deprecated', () => {
  const parse = (rows: unknown) => parseModelsAnswer('mod.acme.main', rows, 'https://api.acme.example/v1')

  it('keeps a localizable one-line description and a deprecated flag, drops malformed ones', () => {
    const { models } = parse([
      { id: 'a', supportsTools: true, description: { en: 'Fast', 'zh-CN': '快' }, deprecated: true },
      { id: 'b', supportsTools: true, description: 'Plain text' },
      { id: 'c', supportsTools: true, description: 7, deprecated: 'yes' },
      { id: 'd', supportsTools: true, description: 'x'.repeat(301) },
    ])
    expect(models[0]).toMatchObject({ description: { en: 'Fast', 'zh-CN': '快' }, deprecated: true })
    expect(models[1]!.description).toBe('Plain text')
    expect(models[2]).not.toHaveProperty('description')
    expect(models[2]).not.toHaveProperty('deprecated')
    expect(models[3]).not.toHaveProperty('description')
  })
})

describe('manifest modelsUi.filters', () => {
  it('keeps a list of tag names', () => {
    expect(check({ filters: ['new', 'new', 'beta'] }).ui?.filters).toEqual(['new', 'beta'])
  })

  it('drops a free chip and a free tag label: the page offers free models itself', () => {
    const { ui, errors } = check({ filters: ['free', 'beta'], tags: { free: { label: 'Free' }, beta: { label: 'Beta' } } })
    expect(errors).toEqual([])
    expect(ui?.filters).toEqual(['beta'])
    expect(Object.keys(ui?.tags ?? {})).toEqual(['beta'])
    expect(check({ filters: ['free'] }).ui?.filters).toBeUndefined()
  })

  it.each([
    ['a non-list', { filters: 'free' }],
    ['a bad name', { filters: ['bad name'] }],
    ['too many', { filters: Array.from({ length: 9 }, (_, i) => `t${i}`) }],
  ])('refuses %s', (_name, block) => {
    expect(check(block).errors.join('\n')).toMatch(/filters/)
  })
})

describe('manifest modelsUi.starterModels', () => {
  it('keeps a list of model ids, ids with slashes and colons included', () => {
    expect(check({ starterModels: ['a/b:free', 'a/b:free', 'plain'] }).ui?.starterModels).toEqual(['a/b:free', 'plain'])
  })

  it.each([
    ['a non-list', { starterModels: 'a' }],
    ['an id with a space', { starterModels: ['a b'] }],
    ['an empty id', { starterModels: [''] }],
    ['too many', { starterModels: Array.from({ length: 9 }, (_, i) => `m${i}`) }],
  ])('refuses %s', (_name, block) => {
    expect(check(block).errors.join('\n')).toMatch(/starterModels/)
  })
})

describe('hand-added models', () => {
  it('sanitizes: trims, drops bad ids and duplicates, limits the format', () => {
    const rows = sanitizeUserModels(
      [
        { id: ' m1 ', name: ' One ', contextWindow: 1000.9, maxOutputTokens: -1, format: 'gemini' },
        { id: 'm1' },
        { id: 'has space' },
        { id: '' },
        { id: 'm2', format: 'soap', reasoning: true },
        null,
      ],
      ['openai-chat'],
    )
    expect(rows).toEqual([
      { id: 'm1', name: 'One', contextWindow: 1000 },
      { id: 'm2', reasoning: true },
    ])
    expect(sanitizeUserModels('nope')).toEqual([])
  })

  it('reads as a tool-capable listed model in the custom group', () => {
    expect(userModelToInfo({ id: 'm', reasoning: true, format: 'anthropic-messages' })).toMatchObject({
      id: 'm',
      supportsTools: true,
      group: 'custom',
      tags: ['custom'],
      thinkingTiers: ['low', 'medium', 'high'],
      wire: { format: 'anthropic-messages' },
    })
  })

  it('a wire with baseUrlTrim follows the base the person set', () => {
    const wires = { 'gemini': { baseUrlTrim: '/v1' } }
    const def = { id: 'm', format: 'gemini' } as const
    expect(userModelToInfo(def, { wires, providerBaseUrl: 'https://proxy.example/zen/go/v1/' }).wire).toEqual({
      format: 'gemini',
      baseUrl: 'https://proxy.example/zen/go',
    })
    // A base without the suffix leaves the model on the provider's own base.
    expect(userModelToInfo(def, { wires, providerBaseUrl: 'https://proxy.example/custom' }).wire).toEqual({
      format: 'gemini',
    })
  })

  it('a listed id wins over a hand-added one', () => {
    const merged = withUserModels(
      [{ id: 'm', name: 'Listed', supportsTools: true }],
      [{ id: 'm', name: 'Mine' }, { id: 'n' }],
    )
    expect(merged.map(m => [m.id, m.name])).toEqual([['m', 'Listed'], ['n', undefined]])
  })
})

describe('providers.setUserModels', () => {
  const HOME = '/home/test'
  const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
  function memoryFs() {
    const files = new Map<string, string>()
    const fs: Partial<RuntimeFs> = {
      readFile: vi.fn(async (path: string) => {
        const content = files.get(path)
        if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        return content
      }),
      writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
        files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
      }),
      mkdir: vi.fn(async () => {}),
    }
    return { fs: fs as RuntimeFs, files }
  }
  const stored = (files: Map<string, string>) => JSON.parse(files.get(SETTINGS_PATH)!)
  const register = (customModels?: { formats: string[] }) =>
    registerModProviderDefinition({
      config: { providerId: 'mod.acme.main', models: [] },
      runtimeOnly: true,
      catalogMod: { state: 'ready', plugin: 'acme', ...(customModels ? { modelsUi: { customModels } } : {}) },
    } as unknown as ProviderDefinition)

  beforeEach(() => {
    wipeSettingsMemos()
    resetModProviderDefinitions()
  })

  it('stores the sanitized list, keeps the rest of the config, and clears with []', async () => {
    register({ formats: ['openai-chat'] })
    const { fs, files } = memoryFs()
    const ctx = { homeDir: HOME, fs }
    await providersHandlers.upsert({ id: 'mod.acme.main', config: { source: 'mod', modVersion: '1.0.0' } }, ctx)
    await providersHandlers.setUserModels(
      { id: 'mod.acme.main', models: [{ id: 'm1', format: 'gemini' }, { id: 'm2', contextWindow: 5000 }] },
      ctx,
    )
    expect(stored(files).providers.configs['mod.acme.main']).toEqual({
      source: 'mod',
      modVersion: '1.0.0',
      userModels: [{ id: 'm1' }, { id: 'm2', contextWindow: 5000 }],
    })
    await providersHandlers.setUserModels({ id: 'mod.acme.main', models: [] }, ctx)
    expect(stored(files).providers.configs['mod.acme.main']).toEqual({ source: 'mod', modVersion: '1.0.0' })
  })

  it('the first write before any key still marks the config as a mod config', async () => {
    register({ formats: ['openai-chat'] })
    const { fs, files } = memoryFs()
    await providersHandlers.setUserModels({ id: 'mod.acme.main', models: [{ id: 'm1' }] }, { homeDir: HOME, fs })
    expect(stored(files).providers.configs['mod.acme.main']).toEqual({ source: 'mod', userModels: [{ id: 'm1' }] })
    await providersHandlers.setModelEntries(
      { id: 'mod.acme.main', entries: [{ family: 'm1', version: 'latest' }] },
      { homeDir: HOME, fs },
    )
    expect(stored(files).providers.configs['mod.acme.main']).toMatchObject({ source: 'mod', userModels: [{ id: 'm1' }] })
  })

  it('refuses a provider whose manifest does not allow hand-added models', async () => {
    register()
    const { fs } = memoryFs()
    await expect(
      providersHandlers.setUserModels({ id: 'mod.acme.main', models: [{ id: 'x' }] }, { homeDir: HOME, fs }),
    ).rejects.toThrow(/does not accept/)
  })
})
