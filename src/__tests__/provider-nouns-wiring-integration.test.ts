/**
 * Provider mods end to end: a real `ProviderModRuntime` over `ModWorkerHost`, nouns from `createProviderNounSet`
 * over a fake fs and transport; a module calls `$.provider.fetch`, `$.provider.settings` and `$.http.fetch`, and
 * `provider.sessionEnd` reaches it when a session is deleted.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import { MemoryKeyRecords, RecordedKeyVault } from '../mods/provider/nouns/keyVault'
import { createProviderModHttp, createProviderNounSet } from '../mods/provider/nouns/providerNounDeps'
import type { ProviderManifest } from '../mods/provider/providerManifest'
import { createSessionEnder } from '../mods/provider/providerSessionEnd'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const openPorts: MessagePort[] = []
const runtimes: ProviderModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
})

const SECRET = 'sk-live-123'

const MANIFEST = {
  providerApi: 1,
  displayName: 'Zen',
  defaultBaseUrl: 'https://api.zen.example/v1',
  domains: ['api.zen.example'],
  format: 'openai',
  module: './zen.js',
  credentials: { methods: ['apiKey'], secrets: [{ name: 'refresh' }], prompts: [{ type: 'text', key: 'org', message: 'Org' }] },
  settings: { region: { type: 'string', title: 'Region', default: 'eu' }, token: { type: 'string', title: 'Token', sensitive: true } },
} as unknown as ProviderManifest

const ZEN = `
  export function register(on) {
    on('provider.usage', async ($, e) => {
      const settings = await $.provider.settings()
      const models = await $.provider.fetch('/models?x=1', { headers: { Authorization: 'Bearer {{secret:api_key}}' } })
      const body = await models.json()
      const posted = await $.provider.fetch('/chat', { method: 'POST', body: JSON.stringify({ hi: 1 }), headers: { 'Content-Type': 'application/json' } })
      const refused = {}
      for (const [label, target] of [['other', 'https://evil.example/x'], ['userinfo', 'https://api.zen.example@evil.example/x'], ['suffix', 'https://api.zen.example.evil.example/x']]) {
        try { await $.provider.fetch(target); refused[label] = 'reached' } catch (error) { refused[label] = error.name }
      }
      let forbidden
      try { await $.provider.fetch('/m', { headers: { Cookie: 'a=b' } }) } catch (error) { forbidden = error.name }
      let undeclared
      try { await $.provider.fetch('/m', { headers: { A: '{{secret:other}}' } }) } catch (error) { undeclared = error.name }
      const meta = await $.http.fetch('https://docs.example/meta.json')
      let httpOther
      try { await $.http.post('https://docs.example/meta.json') } catch (error) { httpOther = error.name }
      const store = $.provider.sessionStore(e.session)
      await store.set('conv', 'c-1')
      const installId = await $.provider.installId()
      const device = await $.provider.device()
      await $.provider.setSecrets({ refresh: 'rt-1' })
      return {
        settings, status: models.status, ok: models.ok, headers: models.headers, body,
        postedStatus: posted.status, postedText: await posted.text(),
        refused, forbidden, undeclared, meta: { status: meta.status, text: meta.text },
        httpOther, installId, device,
      }
    })
    on('provider.sessionEnd', async ($, e) => {
      await $.provider.sessionStore(e.sessionId).set('ended', e.reason)
      await $.provider.sessionStore('ledger').set(e.sessionId, e.reason)
    })
  }
`

const COLD = `
  export function register(on) {
    on('provider.sessionEnd', async ($, e) => { await $.provider.sessionStore('ledger').set(e.sessionId, 'cold-heard') })
  }
`

function fakeHostTransport() {
  const seen: Array<{ route: string; payload: Record<string, any> }> = []
  let pending: Uint8Array | undefined
  const transport = {
    async request(request: { route: { capability: string; action: string }; payload: Record<string, any> }) {
      const route = `${request.route.capability}.${request.route.action}`
      seen.push({ route, payload: request.payload })
      switch (route) {
        case 'model.rawStreamOpen': {
          const { url, method, headers, body } = request.payload
          // The host's half: it substitutes the secret, checks it, and answers
          // about the request — never with the secret itself.
          const authorization = String(headers?.Authorization ?? '').replace('{{secret:api_key}}', SECRET)
          pending = new TextEncoder().encode(
            JSON.stringify({
              path: new URL(url).pathname + new URL(url).search,
              method: method ?? 'GET',
              authorized: authorization === `Bearer ${SECRET}`,
              received: new TextDecoder().decode(body),
            }),
          )
          return {
            ok: true,
            result: { streamId: 'st1', status: 200, statusText: 'OK', finalUrl: url, headers: { 'Content-Type': 'application/json', 'X-Trace': 't-9' } },
          }
        }
        case 'model.rawStreamRead': {
          const chunk = pending
          pending = undefined
          return { ok: true, result: chunk ? { done: false, chunk } : { done: true } }
        }
        case 'model.rawStreamCancel':
          return { ok: true, result: { ok: true } }
        case 'network.httpRequest':
          return {
            ok: true,
            result: { status: 200, statusText: 'OK', finalUrl: request.payload.url, headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode('{"meta":true}') },
          }
        case 'appInfo.getVersionInfo':
          return { ok: true, result: { appVersion: '1.149.1.38' } }
        default:
          return { ok: false, error: { code: 'UNEXPECTED', message: route } }
      }
    },
  } as unknown as BrowserBridgeTransport
  return { transport, seen }
}

function memoryFs() {
  const files = new Map<string, string>()
  const fs = {
    readFile: async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    writeFile: async (path: string, data: string | Uint8Array) => {
      files.set(path, String(data))
    },
    mkdir: async () => {},
    rm: async (path: string) => {
      for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key)
    },
  } as unknown as RuntimeFs
  return { fs, files }
}

function build() {
  const { transport, seen } = fakeHostTransport()
  const { fs, files } = memoryFs()
  const written: Array<[string, NexusProviderConfig]> = []
  const reports: string[] = []
  const stored: NexusProviderConfig = { source: 'mod', modVersion: '1.0.0', credentialMode: 'anonymous', account: 'ann', apiKey: 'SEALED' } as NexusProviderConfig
  const sources = {
    transport: () => transport,
    hostEnvironment: () => ({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', locale: 'de-DE' }),
    writeProviderConfig: async (id: string, config: NexusProviderConfig) => {
      written.push([id, config])
    },
  }
  const nouns = createProviderNounSet({
    homeDir: '/home/u',
    fs,
    report: line => reports.push(line),
    sources: () => sources,
    registrationOf: id =>
      ['mod.acme.zen', 'mod.cold.thing'].includes(id) ? { manifest: MANIFEST, configId: id === 'mod.acme.zen' ? 'acme@inline' : 'cold@inline' } : undefined,
    storedConfigOf: () => stored,
    readOptions: async configId =>
      configId === 'acme@inline' ? { region: 'us', token: 'sk-sensitive', 'signin.org': 'acme-org' } : undefined,
    vault: new RecordedKeyVault(new MemoryKeyRecords()),
  })
  const modules = new Map([
    ['acme/zen.js', ZEN],
    ['cold/thing.js', COLD],
  ])
  const opened: string[] = []
  const runtime = new ProviderModRuntime({
    readModule: async path => `${modules.get(path)}\n// ${Math.random()}`,
    openWorker: async ref => {
      opened.push(ref.plugin)
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      const handle: ModWorkerHandle = { port: channel.port1, closed: new Promise(() => {}), close() {} }
      return handle
    },
    window: { available: () => true, attached: async () => {} },
    providerNouns: nouns.table,
    http: createProviderModHttp({ transport: () => transport, denyRules: async () => undefined }),
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  runtime.register('acme', [{ plugin: 'acme', path: 'acme/zen.js', providers: ['mod.acme.zen'] }])
  runtime.register('cold', [{ plugin: 'cold', path: 'cold/thing.js', providers: ['mod.cold.thing'] }])
  return { runtime, nouns, seen, written, files, opened, reports }
}

describe('PM-4b over a real worker host', () => {
  it('a provider module fetches, reads its settings, fetches publicly and uses the nouns', async () => {
    const { runtime, seen, written, files } = build()
    const answer = (await runtime.call('mod.acme.zen', 'provider.usage', { session: 's1' })) as { raised: boolean; value: any }
    expect(answer.raised).toBe(true)
    const v = answer.value

    // $.provider.fetch: through the provider transport, the secret substituted by the host
    expect(v.status).toBe(200)
    expect(v.ok).toBe(true)
    expect(v.headers).toMatchObject({ 'content-type': 'application/json', 'x-trace': 't-9' })
    expect(v.body).toEqual({ path: '/v1/models?x=1', method: 'GET', authorized: true, received: '' })
    expect(JSON.parse(v.postedText)).toMatchObject({ path: '/v1/chat', method: 'POST', received: '{"hi":1}' })
    expect(v.postedStatus).toBe(200)
    const opens = seen.filter(s => s.route === 'model.rawStreamOpen')
    expect(opens.map(o => o.payload.url)).toEqual(['https://api.zen.example/v1/models?x=1', 'https://api.zen.example/v1/chat'])
    expect(opens[0]!.payload).toMatchObject({ providerId: 'mod.acme.zen', headers: { Authorization: 'Bearer {{secret:api_key}}' } })
    // refused before the transport saw them
    expect(v.refused).toEqual({ other: 'NotAllowedError', userinfo: 'NotAllowedError', suffix: 'NotAllowedError' })
    expect(v.forbidden).toBe('NotAllowedError')
    expect(v.undeclared).toBe('NotAllowedError')
    expect(opens).toHaveLength(2)
    // the secret's value never crossed to the module nor the transport
    expect(JSON.stringify(v)).not.toContain(SECRET)
    expect(JSON.stringify(seen.map(s => s.payload))).not.toContain(SECRET)

    // $.provider.settings: defaults and stored values, the sensitive field withheld, sign-in answers apart
    expect(v.settings).toEqual({ region: 'us', signin: { org: 'acme-org' } })
    expect(JSON.stringify(v)).not.toContain('sk-sensitive')

    // $.http.fetch: network.httpRequest, fetch alone
    expect(v.meta).toEqual({ status: 200, text: '{"meta":true}' })
    expect(seen.filter(s => s.route === 'network.httpRequest')).toHaveLength(1)
    expect(v.httpOther).toBeDefined()

    // the PM-8 nouns on the real deps
    expect(v.installId).toMatch(/^[0-9a-f-]{36}$/)
    expect(v.device).toEqual({ os: 'windows', arch: 'x64', appVersion: '1.149.1.38', locale: 'de-DE' })
    expect(written).toHaveLength(1)
    expect(written[0]![0]).toBe('mod.acme.zen')
    expect(written[0]![1]).toEqual({ source: 'mod', modVersion: '1.0.0', credentialMode: 'anonymous', account: 'ann', secrets: { refresh: 'rt-1' } })
    expect([...files.keys()].some(path => path.endsWith('/provider-sessions/s1/mod.acme.zen.json'))).toBe(true)
  })

  it('a deleted session raises provider.sessionEnd in the loaded module, never wakes the cold one, then deletes the stores', async () => {
    const { runtime, nouns, opened, files } = build()
    await runtime.call('mod.acme.zen', 'provider.usage', { session: 's1' })
    expect(opened).toEqual(['acme'])
    expect(runtime.hasHook('mod.acme.zen', 'provider.sessionEnd')).toBe(true)
    expect(runtime.hasHook('mod.cold.thing', 'provider.sessionEnd')).toBeUndefined()

    const ender = createSessionEnder({
      runtime,
      providerIds: () => ['mod.acme.zen', 'mod.cold.thing'],
      end: nouns.endProviderSession,
      report: () => {},
    })
    const sessionFiles = () => [...files.keys()].filter(path => path.includes('/provider-sessions/s1/'))
    expect(sessionFiles()).toHaveLength(1)
    await ender('s1')
    // the hook ran (its ledger write is in another session's directory), the cold module was not started
    const ledger = [...files.entries()].find(([path]) => path.includes('/provider-sessions/ledger/'))
    expect(ledger?.[1]).toContain('s1')
    expect(ledger?.[1]).toContain('deleted')
    expect(ledger?.[1]).not.toContain('cold-heard')
    expect(opened).toEqual(['acme'])
    // …and the session's own stores are gone, the hook's late write to it included
    expect(sessionFiles()).toHaveLength(0)
  })
})

describe('the refusal of a provider that is not the module’s', () => {
  it('fetch under a provider the module does not own is refused', async () => {
    const { nouns } = build()
    await expect(
      nouns.table.fetch!({ plugin: 'acme', noun: 'provider', method: 'fetch', args: ['/m', { provider: 'mod.other.x' }], providers: ['mod.acme.zen'] } as never),
    ).rejects.toMatchObject({ name: 'NotAllowedError' })
  })
})
