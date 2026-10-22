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
import { substitutePluginMcpString } from '../pluginHost/substituteMcpVars'

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
    expect(plainHttp).toEqual({ ok: false, reason: 'sensitive option "api_key" needs an https server URL' })
    const loopback = resolve({ kind: 'browser', config: { type: 'http', url: 'http://127.0.0.1:8123/mcp', headers: { A: '${user_config.api_key}' } } })
    expect(loopback).toEqual({ ok: false, reason: 'sensitive option "api_key" needs an https server URL' })
    const sse = resolve({ kind: 'browser', config: { type: 'sse', url: 'https://a.example', headers: { A: '${user_config.api_key}' } } })
    expect(sse.ok).toBe(false)
  })

  it('refuses a header or env value that is not text', () => {
    const header = resolve({ kind: 'browser', config: { type: 'http', url: 'https://h/mcp', headers: { 'X-Retries': 3 as unknown as string } } })
    expect(header).toEqual({ ok: false, reason: 'a header or env value is not text' })
    const env = resolve({ kind: 'native', config: { transport: 'stdio', command: 'run', env: { N: null as unknown as string } } })
    expect(env).toEqual({ ok: false, reason: 'a header or env value is not text' })
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

  it('deletes nothing when told not to prune', async () => {
    const prefix = pluginSecretPrefix('sandbox@market')
    const store = {
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => true),
      listNames: vi.fn(async () => [{ name: `${prefix}env/old`, origin: '' }]),
    }
    await storePluginSecrets([], ['sandbox@market'], store, vi.fn(), { prune: false })
    expect(store.delete).not.toHaveBeenCalled()
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


describe('provider settings and named MCP credentials', () => {
  const provider: ResolvedProvider = {
    key: 'token-factory', id: 'mod.sandbox.token-factory', modulePath: '/provider.js',
    manifest: {
      providerApi: 1, displayName: 'Cloud', defaultBaseUrl: 'https://api.example/v1',
      domains: ['api.example'], format: 'openai-chat', module: './provider.js',
      credentials: { methods: ['apiKey'], secrets: [{ name: 'tavily_api_key' }] },
      settings: { project_id: { type: 'string', title: { en: 'Project', zh: '项目' }, default: 'default-project' } },
    },
  }
  const owning = { ...plugin, providers: [provider] }
  const reference = '${provider_secret.token-factory.tavily_api_key}'
  const stored = (value = 'NEXUSENC1:dGF2aWx5', modOwner: string | undefined = plugin.installIdentifier) => ({
    ...scope({ project_id: 'project-saved', project: 'old-option' }),
    providers: { [provider.id]: { modOwner, secrets: { tavily_api_key: value } } },
  })
  const http = (url = 'https://mcp.tavily.com/mcp'): PluginMcpServer => ({
    kind: 'browser', config: { type: 'http', url, headers: { Authorization: `Bearer ${reference}` } },
  })
  const stdio = (value = reference): PluginMcpServer => ({ kind: 'native', config: { transport: 'stdio', command: 'run', env: { TOKEN: value } } })

  it('resolves provider settings from the shared existing option keys alongside userConfig', () => {
    const server: PluginMcpServer = { kind: 'native', config: { transport: 'stdio', command: 'run', args: ['${user_config.project_id}', '${user_config.project}'] } }
    expect(resolvePluginMcpServer(owning, 'compute', server, stored())).toMatchObject({ ok: true, config: { args: ['project-saved', 'old-option'] } })
    expect(resolvePluginMcpServer(owning, 'compute', server, scope({}))).toMatchObject({ ok: true, config: { args: ['default-project', ''] } })
  })

  it('accepts matching value contracts despite localized labels and rejects conflicts safely', () => {
    const duplicate = { ...provider, key: 'other', manifest: { ...provider.manifest, settings: { project_id: { type: 'string' as const, title: 'Different label', default: 'default-project' } } } }
    expect(resolvePluginMcpServer({ ...owning, providers: [provider, duplicate] }, 's', stdio(), stored()).ok).toBe(true)
    for (const change of [{ sensitive: true }, { type: 'number' }, { required: true }, { default: 'different' }]) {
      const conflicting = { ...duplicate, manifest: { ...duplicate.manifest, settings: { project_id: { ...duplicate.manifest.settings.project_id, ...change } } } } as ResolvedProvider
      expect(resolvePluginMcpServer({ ...owning, providers: [provider, conflicting] }, 's', stdio(), stored())).toMatchObject({ ok: false, reason: expect.stringContaining('conflicting') })
    }
    expect(resolvePluginMcpServer({ ...owning, manifest: { ...plugin.manifest, userConfig: { project_id: { type: 'string', title: 'P', description: '', sensitive: true } } } }, 's', stdio(), stored()).ok).toBe(false)
  })

  it('promotes browser HTTP to native, with a per-server origin-bound sealed secret', () => {
    const a = resolvePluginMcpServer(owning, 'search', http(), stored())
    const b = resolvePluginMcpServer(owning, 'other', http('https://other.example/mcp'), stored())
    const env = resolvePluginMcpServer(owning, 'process', stdio(), stored())
    expect(a).toMatchObject({ ok: true, kind: 'native', config: { transport: 'http' }, secrets: [{ value: 'NEXUSENC1:dGF2aWx5', origin: 'https://mcp.tavily.com' }] })
    expect(b).toMatchObject({ ok: true, secrets: [{ origin: 'https://other.example' }] })
    expect(env).toMatchObject({ ok: true, secrets: [{ processEnv: true }] })
    if (!a.ok || !b.ok || !env.ok) throw new Error('resolution failed')
    expect(new Set([a.secrets[0]!.name, b.secrets[0]!.name, env.secrets[0]!.name]).size).toBe(3)
    expect(a.config.headers?.Authorization).toBe(`Bearer {{secret:${a.secrets[0]!.name}}}`)
    expect(JSON.stringify(a.config)).not.toContain('NEXUSENC1')
    expect(resolvePluginMcpServer(owning, 'native', { kind: 'native', config: { transport: 'http', url: 'https://native.example/mcp', headers: { Token: reference } } }, stored())).toMatchObject({ ok: true, secrets: [{ origin: 'https://native.example' }] })
  })

  it('requires both provider and secret declarations and the exact installation owner', () => {
    for (const value of ['${provider_secret.openrouter.tavily_api_key}', '${provider_secret.mod.sandbox.token-factory.tavily_api_key}', '${provider_secret.token-factory.undeclared}']) {
      expect(resolvePluginMcpServer(owning, 's', stdio(value), stored()).ok).toBe(false)
    }
    expect(resolvePluginMcpServer(plugin, 's', stdio(), stored()).ok).toBe(false)
    for (const owner of ['sandbox@elsewhere', 'other@market', '']) {
      expect(resolvePluginMcpServer(owning, 's', stdio(), stored('sealed', owner)).ok).toBe(false)
    }
    expect(resolvePluginMcpServer({ ...owning, providers: [{ ...provider, id: 'mod.other.token-factory' }] }, 's', stdio(), stored()).ok).toBe(false)
  })

  it('fails only the server needing an absent optional credential; rotations replace the sealed write', () => {
    for (const s of [scope(), { ...scope(), providers: {} }, stored(''), stored('   '), { ...scope(), providers: { [provider.id]: { modOwner: plugin.installIdentifier } } }]) {
      expect(resolvePluginMcpServer(owning, 'search', http(), s).ok).toBe(false)
      expect(resolvePluginMcpServer(owning, 'compute', stdio('${user_config.project_id}'), s).ok).toBe(true)
    }
    const a = resolvePluginMcpServer(owning, 'search', http(), stored('sealed-a'))
    const b = resolvePluginMcpServer(owning, 'search', http(), stored('sealed-b'))
    if (!a.ok || !b.ok) throw new Error('resolution failed')
    expect(a.secrets[0]!.name).toBe(b.secrets[0]!.name)
    expect(b.secrets[0]!.value).toBe('sealed-b')
  })

  it('refuses non-HTTPS, unsupported transports and secret references outside env/header values', () => {
    for (const url of ['http://mcp.tavily.com', 'http://127.0.0.1/mcp', 'ftp://host/mcp', 'invalid']) {
      expect(resolvePluginMcpServer(owning, 's', http(url), stored()).ok).toBe(false)
    }
    const bad: PluginMcpServer[] = [
      { kind: 'browser', config: { type: 'sse', url: 'https://host/mcp', headers: { A: reference } } },
      { kind: 'browser', config: { type: 'http', url: `https://host/?key=${reference}` } },
      { kind: 'native', config: { transport: 'stdio', command: reference } },
      { kind: 'native', config: { transport: 'stdio', command: 'run', args: [reference] } },
      { kind: 'native', config: { transport: 'stdio', command: 'run', cwd: reference } },
      { kind: 'native', config: { transport: 'http', url: 'https://host/mcp', env: { A: reference } } },
      { kind: 'native', config: { transport: 'stdio', command: 'run', env: { [reference]: 'value' } } },
    ]
    for (const server of bad) expect(resolvePluginMcpServer(owning, 's', server, stored()).ok).toBe(false)
  })

  it('routes named interpolation only to the scoped callback, never to arbitrary environment lookup', () => {
    const getEnv = vi.fn(() => 'should-not-be-used')
    expect(substitutePluginMcpString(reference, { pluginRoot: '/', getEnv })).toBe(reference)
    expect(substitutePluginMcpString('${provider_secret}', { pluginRoot: '/', getEnv })).toBe('${provider_secret}')
    expect(getEnv).not.toHaveBeenCalled()
    const providerSecret = vi.fn(() => 'scoped')
    expect(substitutePluginMcpString(reference, { pluginRoot: '/', getEnv, providerSecret }, 'header')).toBe('scoped')
    expect(providerSecret).toHaveBeenCalledWith('token-factory.tavily_api_key', 'header')
    expect(getEnv).not.toHaveBeenCalled()
  })

  it('rejects malformed references, indirect placeholders and arbitrary host-secret names', () => {
    for (const value of ['${provider_secret}', '${provider_secret.}', '${provider_secret.token-factory}', '${provider_secret.token-factory.tavily_api_key', '${provider_secret.token-factory.tavily_api_key:-fallback}', '${provider_secret.token-factory.tavily/api_key}', '{{secret:openrouter/api_key}}', '{{oauth:access_token}}']) {
      expect(resolvePluginMcpServer(owning, 's', stdio(value), stored()).ok).toBe(false)
    }
    expect(resolvePluginMcpServer(owning, 's', stdio('${user_config.project}'), { ...stored(), configs: { [plugin.installIdentifier]: { options: { project: reference } } } }).ok).toBe(false)
  })
})
