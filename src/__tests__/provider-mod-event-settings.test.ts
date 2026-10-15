/**
 * Provider mods (PM-3c) — `e.settings` of the catalog-side events is the same
 * record `$.provider.settings()` answers, read from `pluginConfigs.<id>.options`
 * (`providerEventSettings`, wired by `providerModBoot.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderManifest } from '../mods/provider/providerManifest'
import { providerEventSettings } from '../mods/provider/providerModBoot'
import { providerSettingValues } from '../mods/provider/nouns/providerSettingsNoun'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const HOME = '/home/test'
const MANIFEST = {
  providerApi: 1,
  displayName: 'Zen',
  defaultBaseUrl: 'https://api.zen.example/v1',
  domains: ['api.zen.example'],
  format: 'openai-chat',
  module: './zen.js',
  credentials: { methods: ['apiKey'], prompts: [{ type: 'text', key: 'org', message: 'Org' }] },
  settings: {
    region: { type: 'string', title: 'Region', default: 'eu', options: ['eu', 'us'] },
    token: { type: 'string', title: 'Token', sensitive: true },
  },
} as unknown as ProviderManifest

function fsWith(options: Record<string, unknown> | undefined): RuntimeFs {
  const settings = options ? { version: 1, pluginConfigs: { 'zen@inline': { options } } } : {}
  const text = JSON.stringify(settings)
  return {
    readFile: vi.fn(async (path: string) => {
      if (path !== `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    }),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
  } as unknown as RuntimeFs
}

beforeEach(() => wipeSettingsMemos())

describe('providerEventSettings', () => {
  it('reads the stored options through the noun\'s own shaping', async () => {
    const stored = { region: 'us', token: 'sk-secret', 'signin.org': 'acme' }
    const settings = await providerEventSettings({ homeDir: HOME, fs: fsWith(stored) }, { manifest: MANIFEST, configId: 'zen@inline' })
    expect(settings).toEqual(providerSettingValues(MANIFEST, stored))
    expect(settings).toEqual({ region: 'us', signin: { org: 'acme' } })
    expect(JSON.stringify(settings)).not.toContain('sk-secret')
  })

  it('fills the defaults when nothing is stored', async () => {
    const settings = await providerEventSettings({ homeDir: HOME, fs: fsWith(undefined) }, { manifest: MANIFEST, configId: 'zen@inline' })
    expect(settings).toEqual({ region: 'eu', signin: {} })
  })

  it('a registration with no settings id reads nothing; an unregistered provider has none', async () => {
    const fs = fsWith({ region: 'us' })
    expect(await providerEventSettings({ homeDir: HOME, fs }, { manifest: MANIFEST })).toEqual({ region: 'eu', signin: {} })
    expect(await providerEventSettings({ homeDir: HOME, fs }, undefined)).toEqual({})
  })
})
