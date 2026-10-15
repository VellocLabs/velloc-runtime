/**
 * Provider mods — `$.provider.settings()` (PM-4b): the manifest's declared
 * settings as stored under `pluginConfigs.<id>.options`, defaults filled,
 * sensitive fields withheld, the non-secret sign-in answers under `signin`.
 */
import { describe, expect, it } from 'vitest'
import type { ProviderNounCall } from '../mods/provider/ProviderModRuntime'
import type { ProviderManifest } from '../mods/provider/providerManifest'
import { createProviderSettings, providerSettingValues } from '../mods/provider/nouns/providerSettingsNoun'

const MANIFEST = {
  providerApi: 1,
  displayName: 'Zen',
  defaultBaseUrl: 'https://api.zen.example/v1',
  domains: ['api.zen.example'],
  format: 'openai',
  module: './zen.js',
  credentials: {
    methods: ['apiKey', 'login'],
    secrets: [{ name: 'session_token' }],
    prompts: [
      { type: 'text', key: 'region_code', message: 'Region' },
      { type: 'text', key: 'passcode', message: 'Passcode', secret: true },
      { type: 'select', key: 'plan', message: 'Plan', options: [{ label: 'Free', value: 'free' }] },
    ],
  },
  settings: {
    region: { type: 'string', title: 'Region', default: 'eu', options: ['eu', 'us'] },
    verbose: { type: 'boolean', title: 'Verbose' },
    limit: { type: 'number', title: { en: 'Limit' }, default: 10 },
    token: { type: 'string', title: 'Token', sensitive: true },
    tags: { type: 'string', title: 'Tags', multiple: true },
  },
} as unknown as ProviderManifest

describe('provider setting values', () => {
  it('fills defaults, takes stored values, and leaves a sensitive field out', () => {
    expect(providerSettingValues(MANIFEST, undefined)).toEqual({ region: 'eu', verbose: '', limit: 10, tags: '', signin: {} })
    expect(
      providerSettingValues(MANIFEST, { region: 'us', verbose: true, limit: 3, token: 'sk-secret', tags: ['a', 'b'], stray: 'x' }),
    ).toEqual({ region: 'us', verbose: true, limit: 3, tags: ['a', 'b'], signin: {} })
  })

  it('never carries a sensitive value, stored or defaulted', () => {
    const withDefault = {
      ...MANIFEST,
      settings: { key: { type: 'string', title: 'Key', sensitive: true, default: 'sk-default' } },
    } as unknown as ProviderManifest
    expect(JSON.stringify(providerSettingValues(MANIFEST, { token: 'sk-secret' }))).not.toContain('sk-secret')
    expect(JSON.stringify(providerSettingValues(withDefault, { key: 'sk-stored' }))).not.toContain('sk-')
  })

  it('sets aside a stored value that is off its choices', () => {
    expect(providerSettingValues(MANIFEST, { region: 'mars' }).region).toBe('eu')
  })

  it('returns the sign-in answers under signin, without the answers to a secret prompt', () => {
    const values = providerSettingValues(MANIFEST, {
      'signin.region_code': 'NL',
      'signin.plan': 'free',
      'signin.passcode': '1234',
      'signin.': 'empty-key',
      'signin.object': { a: 1 },
    })
    expect(values.signin).toEqual({ region_code: 'NL', plan: 'free' })
    expect(JSON.stringify(values)).not.toContain('1234')
  })

  it('a manifest with no settings still answers (an empty record and signin)', () => {
    const bare = { ...MANIFEST, settings: undefined } as unknown as ProviderManifest
    expect(providerSettingValues(bare, { 'signin.plan': 'free' })).toEqual({ signin: { plan: 'free' } })
  })
})

describe('the noun', () => {
  const call = (providers: readonly string[], args: unknown[] = []) =>
    ({ plugin: 'acme', noun: 'provider', method: 'settings', args, providers }) as unknown as ProviderNounCall

  function noun(options: Record<string, Record<string, unknown>> = {}) {
    const reads: string[] = []
    return {
      reads,
      run: createProviderSettings({
        registrationOf: id => (id === 'mod.acme.zen' ? { manifest: MANIFEST, configId: 'acme@inline' } : undefined),
        readOptions: async configId => {
          reads.push(configId)
          return options[configId]
        },
      }),
    }
  }

  it('reads the plugin config of the provider, fresh each call', async () => {
    const options: Record<string, Record<string, unknown>> = { 'acme@inline': { region: 'us' } }
    const { run, reads } = noun(options)
    expect((await run(call(['mod.acme.zen']))).region).toBe('us')
    options['acme@inline'] = { region: 'eu', limit: 7 }
    expect(await run(call(['mod.acme.zen']))).toMatchObject({ region: 'eu', limit: 7 })
    expect(reads).toEqual(['acme@inline', 'acme@inline'])
  })

  it('scopes by provider like every noun, and refuses a provider that is not registered', async () => {
    const { run } = noun()
    await expect(run(call(['mod.acme.zen', 'mod.acme.pro']))).rejects.toThrow('say which')
    await expect(run(call(['mod.acme.zen'], [{ provider: 'mod.other.zen' }]))).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(run(call(['mod.acme.pro']))).rejects.toMatchObject({ name: 'NotSupportedError' })
  })

  it('a registration without a settings id gets defaults and reads nothing', async () => {
    const reads: string[] = []
    const run = createProviderSettings({
      registrationOf: () => ({ manifest: MANIFEST }),
      readOptions: async id => {
        reads.push(id)
        return {}
      },
    })
    expect((await run(call(['mod.acme.zen']))).region).toBe('eu')
    expect(reads).toEqual([])
  })
})
