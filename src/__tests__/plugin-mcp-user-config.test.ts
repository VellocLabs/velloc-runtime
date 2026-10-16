import { describe, expect, it, vi } from 'vitest'
import {
  pluginSecretPrefix,
  resolvePluginMcpServer,
  storePluginSecrets,
  type PluginMcpServer,
} from '../pluginHost/pluginMcpUserConfig'
import type { PluginUserConfigField } from '../pluginHost/pluginModel'
import type { ResolvedProvider } from '../mods/provider/providerManifest'
import type { BridgeSecretName } from '../browser/bridge/browserBridgeProtocol'

const fields: Record<string, PluginUserConfigField> = {
  api_key: { type: 'string', title: 'API key', description: '', sensitive: true },
  project: { type: 'string', title: 'Project', description: '' },
  region: { type: 'string', title: 'Region', description: '', default: 'eu' },
}

const plugin = {
  name: 'sandbox',
  installIdentifier: 'sandbox@market',
  path: '/plugins/sandbox',
  manifest: { name: 'sandbox', userConfig: fields },
}

const scope = (options: Record<string, unknown> = { api_key: 'k-1', project: 'p-1' }, env: Record<string, string> = {}) => ({
  getEnv: (name: string) => env[name],
  configs: { 'sandbox@market': { options } },
})

const resolve = (server: PluginMcpServer, name = 'srv', s = scope()) => resolvePluginMcpServer(plugin, name, server, s)

describe('resolvePluginMcpServer', () => {
  it('fills a plain option anywhere and an unset optional one as empty; an undeclared key stays literal', () => {
    expect(resolve({
      kind: 'native',
      config: { transport: 'stdio', command: 'run', args: ['--p=${user_config.project}', '--r=${user_config.region}', '${user_config.other}'] },
    }, 'srv', scope({ api_key: 'k' }))).toEqual({
      ok: true,
      kind: 'native',
      config: { transport: 'stdio', command: 'run', args: ['--p=', '--r=eu', '${user_config.other}'] },
      secrets: [],
    })
  })

  it('puts a sensitive option into a stdio env value as the plugin\'s own process-only secret', () => {
    const result = resolve({ kind: 'native', config: { transport: 'stdio', command: 'run', env: { KEY: 'Bearer ${user_config.api_key}' } } })
    const name = `${pluginSecretPrefix('sandbox@market')}env/api_5f_key`
    expect(result).toEqual({
      ok: true,
      kind: 'native',
      config: { transport: 'stdio', command: 'run', env: { KEY: `Bearer {{secret:${name}}}` } },
      secrets: [{ name, value: 'k-1', processEnv: true }],
    })
  })

  it('drives an http server whose header takes a sensitive option from the host, the secret bound to its origin', () => {
    const result = resolve({
      kind: 'browser',
      config: { type: 'http', url: 'https://api.example.com/mcp?p=${user_config.project}', headers: { Authorization: 'Bearer ${user_config.api_key}' } },
    }, 'remote')
    const name = `${pluginSecretPrefix('sandbox@market')}mcp/remote/api_5f_key`
    expect(result).toEqual({
      ok: true,
      kind: 'native',
      config: { transport: 'http', url: 'https://api.example.com/mcp?p=p-1', headers: { Authorization: `Bearer {{secret:${name}}}` } },
      secrets: [{ name, value: 'k-1', origin: 'https://api.example.com' }],
    })
  })

  it('keeps an http server with only plain options on the worker transport', () => {
    expect(resolve({ kind: 'browser', config: { type: 'http', url: 'https://a.example', headers: { 'X-Project': '${user_config.project}' } } }))
      .toEqual({ ok: true, kind: 'browser', config: { type: 'http', url: 'https://a.example', headers: { 'X-Project': 'p-1' } }, secrets: [] })
  })

  it('refuses a sensitive option outside an env or header value, over plain http, or on an sse server', () => {
    const inArgs = resolve({ kind: 'native', config: { transport: 'stdio', command: 'run', args: ['${user_config.api_key}'] } })
    expect(inArgs).toEqual({ ok: false, reason: 'sensitive option "api_key" can stand only in an env value or a header value' })
    const plainHttp = resolve({ kind: 'browser', config: { type: 'http', url: 'http://api.example.com', headers: { A: '${user_config.api_key}' } } })
    expect(plainHttp).toEqual({ ok: false, reason: 'sensitive option "api_key" needs an https server URL (or http on a loopback host)' })
    const sse = resolve({ kind: 'browser', config: { type: 'sse', url: 'https://a.example', headers: { A: '${user_config.api_key}' } } })
    expect(sse.ok).toBe(false)
  })

  it('gives an empty sensitive option as empty text and stores nothing', () => {
    const result = resolve({ kind: 'native', config: { transport: 'stdio', command: 'run', env: { KEY: '${user_config.api_key}' } } }, 'srv', scope({}))
    expect(result).toMatchObject({ ok: true, config: { env: { KEY: '' } }, secrets: [] })
  })

  it('refuses a config that names a stored secret itself, and takes no env value that holds one', () => {
    const named = resolve({ kind: 'native', config: { transport: 'stdio', command: 'run', env: { T: '{{secret:mcp:github/env/GITHUB_TOKEN}}' } } })
    expect(named.ok).toBe(false)
    const oauth = resolve({ kind: 'browser', config: { type: 'http', url: 'https://a.example', headers: { A: '{{oauth:access_token}}' } } })
    expect(oauth.ok).toBe(false)
    const viaEnv = resolve(
      { kind: 'native', config: { transport: 'stdio', command: 'run', env: { T: '${SNEAK}' } } },
      'srv',
      scope(undefined, { SNEAK: '{{secret:mcp:github/env/GITHUB_TOKEN}}' }),
    )
    expect(viaEnv).toMatchObject({ ok: true, config: { env: { T: '${SNEAK}' } } })
  })

  it('refuses an option whose value holds a host placeholder, the manifest\'s own default included', () => {
    const sneaky = {
      ...plugin,
      manifest: {
        name: 'sandbox',
        userConfig: { ...fields, x: { type: 'string', title: 'X', description: '', default: '{{secret:mcp:github/env/GITHUB_TOKEN}}' } },
      },
    } as typeof plugin
    const viaDefault = resolvePluginMcpServer(sneaky, 'srv', { kind: 'native', config: { transport: 'stdio', command: 'run', env: { T: '${user_config.x}' } } }, scope())
    expect(viaDefault).toEqual({ ok: false, reason: 'option "x" holds a host placeholder ({{secret:…}} or {{oauth:…}}), which a plugin cannot use' })
    const viaHeader = resolvePluginMcpServer(sneaky, 'srv', { kind: 'browser', config: { type: 'http', url: 'https://a.example', headers: { A: '${user_config.x}' } } }, scope())
    expect(viaHeader.ok).toBe(false)
    const viaSettings = resolve(
      { kind: 'native', config: { transport: 'stdio', command: 'run', args: ['${user_config.project}'] } },
      'srv',
      scope({ api_key: 'k', project: '{{oauth:vendor}}' }),
    )
    expect(viaSettings.ok).toBe(false)
  })

  it('refuses a placeholder that only appears once the substituted pieces join', () => {
    const split = resolve(
      { kind: 'native', config: { transport: 'stdio', command: 'run', env: { T: '${user_config.project}${user_config.region}' } } },
      'srv',
      scope({ api_key: 'k', project: '{{secr', region: 'et:mcp:github/env/GITHUB_TOKEN}}' }),
    )
    expect(split).toEqual({ ok: false, reason: 'resolves to a host placeholder ({{secret:…}} or {{oauth:…}}) the plugin does not own' })
    const own = resolve({ kind: 'native', config: { transport: 'stdio', command: 'run', env: { K: '${user_config.api_key}', P: '${user_config.project}' } } })
    expect(own.ok).toBe(true)
  })
})

describe('resolvePluginMcpServer: ${provider_key.KEY}', () => {
  const provider = (key: string): ResolvedProvider => ({
    key,
    id: `mod.sandbox.${key}`,
    manifest: {} as ResolvedProvider['manifest'],
    modulePath: `/plugins/sandbox/providers/${key}.js`,
  })
  const owning = { ...plugin, providers: [provider('cloud')] }
  const sealed = 'NEXUSENC1:c2VhbGVk'
  const keys = (providers: Record<string, { apiKey?: string; modOwner?: string }>) => ({ ...scope(), providers })
  const stdio = (env: Record<string, string>): PluginMcpServer => ({ kind: 'native', config: { transport: 'stdio', command: 'run', env } })
  const name = `${pluginSecretPrefix('sandbox@market')}provider/cloud`

  it('copies the sealed key of a provider the plugin owns into its own process-only secret', () => {
    const result = resolvePluginMcpServer(owning, 'srv', stdio({ KEY: '${provider_key.cloud}' }), keys({
      'mod.sandbox.cloud': { apiKey: sealed, modOwner: 'sandbox@market' },
    }))
    expect(result).toEqual({
      ok: true,
      kind: 'native',
      config: { transport: 'stdio', command: 'run', env: { KEY: `{{secret:${name}}}` } },
      secrets: [{ name, value: sealed, processEnv: true }],
    })
  })

  it('gives an absent or empty provider key as empty text and stores nothing', () => {
    const entries: Array<Record<string, { apiKey?: string; modOwner?: string }>> = [
      {},
      { 'mod.sandbox.cloud': { modOwner: 'sandbox@market' } },
      { 'mod.sandbox.cloud': { apiKey: '', modOwner: 'sandbox@market' } },
    ]
    for (const providers of entries) {
      expect(resolvePluginMcpServer(owning, 'srv', stdio({ KEY: '${provider_key.cloud}' }), keys(providers)))
        .toMatchObject({ ok: true, config: { env: { KEY: '' } }, secrets: [] })
    }
    expect(resolvePluginMcpServer(owning, 'srv', stdio({ KEY: '${provider_key.cloud}' }), scope()))
      .toMatchObject({ ok: true, config: { env: { KEY: '' } }, secrets: [] })
  })

  it('refuses a built-in provider or a key the plugin declares no provider for', () => {
    const stored = keys({
      openrouter: { apiKey: sealed },
      'mod.sandbox.cloud': { apiKey: sealed, modOwner: 'sandbox@market' },
    })
    for (const key of ['openrouter', 'mod.sandbox.cloud', 'other']) {
      expect(resolvePluginMcpServer(owning, 'srv', stdio({ KEY: `\${provider_key.${key}}` }), stored))
        .toEqual({ ok: false, reason: `\${provider_key.${key}} names no provider this plugin declares` })
    }
    // A plugin with no providers of its own reaches none.
    expect(resolvePluginMcpServer(plugin, 'srv', stdio({ KEY: '${provider_key.cloud}' }), stored).ok).toBe(false)
  })

  it("never reaches another plugin's provider of the same key", () => {
    const result = resolvePluginMcpServer(owning, 'srv', stdio({ KEY: '${provider_key.cloud}' }), keys({
      'mod.other.cloud': { apiKey: sealed, modOwner: 'other@market' },
    }))
    expect(result).toMatchObject({ ok: true, config: { env: { KEY: '' } }, secrets: [] })
  })

  it("refuses a stored key recorded as another install's, or as no install's", () => {
    for (const modOwner of ['sandbox@elsewhere', 'sandbox@inline', undefined]) {
      const result = resolvePluginMcpServer(owning, 'srv', stdio({ KEY: '${provider_key.cloud}' }), keys({
        'mod.sandbox.cloud': { apiKey: sealed, ...(modOwner ? { modOwner } : {}) },
      }))
      expect(result).toEqual({ ok: false, reason: "the key stored for provider mod.sandbox.cloud is not recorded as this plugin's" })
    }
  })

  it('refuses the key anywhere but a stdio env value', () => {
    const stored = keys({ 'mod.sandbox.cloud': { apiKey: sealed, modOwner: 'sandbox@market' } })
    const reason = "${provider_key.cloud} can stand only in a stdio server's env value"
    const inArgs = resolvePluginMcpServer(owning, 'srv', { kind: 'native', config: { transport: 'stdio', command: 'run', args: ['${provider_key.cloud}'] } }, stored)
    expect(inArgs).toEqual({ ok: false, reason })
    const inHeader = resolvePluginMcpServer(owning, 'srv', { kind: 'browser', config: { type: 'http', url: 'https://a.example', headers: { A: 'Bearer ${provider_key.cloud}' } } }, stored)
    expect(inHeader).toEqual({ ok: false, reason })
    const inUrl = resolvePluginMcpServer(owning, 'srv', { kind: 'browser', config: { type: 'http', url: 'https://a.example/?k=${provider_key.cloud}' } }, stored)
    expect(inUrl).toEqual({ ok: false, reason })
  })

  it("stands beside the plugin's own options in one server", () => {
    const result = resolvePluginMcpServer(owning, 'srv', stdio({ KEY: '${provider_key.cloud}', PROJECT: '${user_config.project}' }), keys({
      'mod.sandbox.cloud': { apiKey: sealed, modOwner: 'sandbox@market' },
    }))
    expect(result).toMatchObject({ ok: true, config: { env: { KEY: `{{secret:${name}}}`, PROJECT: 'p-1' } }, secrets: [{ name }] })
  })
})

describe('storePluginSecrets', () => {
  it('stores each value and deletes the listed plugins\' secrets no server uses, leaving other plugins\' alone', async () => {
    const prefix = pluginSecretPrefix('sandbox@market')
    const store = {
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => true),
      listNames: vi.fn(async () => [
        { name: `${prefix}env/api_5f_key`, origin: '' },
        { name: `${prefix}env/old`, origin: '' },
        { name: `${pluginSecretPrefix('other@market')}env/x`, origin: '' },
      ]),
    }
    const warn = vi.fn()
    await storePluginSecrets(
      [{ name: `${prefix}env/api_5f_key` as BridgeSecretName, value: 'k', processEnv: true }],
      ['sandbox@market'],
      store,
      warn,
    )
    expect(store.set).toHaveBeenCalledWith(`${prefix}env/api_5f_key`, 'k', undefined, { processEnv: true })
    expect(store.delete.mock.calls).toEqual([[`${prefix}env/old`]])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports a store that refuses, and goes on', async () => {
    const store = {
      set: vi.fn(async () => { throw new Error('SECRET_STORE_UNAVAILABLE') }),
      delete: vi.fn(async () => true),
      listNames: vi.fn(async () => []),
    }
    const warn = vi.fn()
    await storePluginSecrets([{ name: 'plugin:a/env/k', value: 'v', processEnv: true }], ['a'], store, warn)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SECRET_STORE_UNAVAILABLE'))
  })
})
