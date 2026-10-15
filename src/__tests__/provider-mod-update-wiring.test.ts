/**
 * Provider mods (PM-9b) - the production pieces the update service is given:
 * a fetch that is https or nothing (and whose final URL `downloadHttps` can
 * check), and an admission that compiles and scans a staged version exactly as
 * the runtime would load it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { downloadHttps, HttpsSourceError } from '../pluginHost/httpsSource'
import { resolveProviders } from '../mods/provider/providerManifest'
import { createProviderModAdmit, httpsOnlyBridgeFetch } from '../mods/provider/providerModUpdateWiring'
import type { ActivePlugin } from '../pluginHost/pluginModel'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

function bridge(result: Record<string, unknown>): { transport: BrowserBridgeTransport; requests: unknown[] } {
  const requests: unknown[] = []
  const transport = {
    request: vi.fn(async (request: unknown) => {
      requests.push(request)
      return { ok: true, result }
    }),
  } as unknown as BrowserBridgeTransport
  return { transport, requests }
}

describe('httpsOnlyBridgeFetch', () => {
  it('refuses a request that is not https before the host is asked', async () => {
    const { transport, requests } = bridge({})
    const fetchImpl = httpsOnlyBridgeFetch(() => transport)
    await expect(fetchImpl('http://example.com/a.tgz')).rejects.toThrow(/only https/)
    await expect(fetchImpl('https://user:pw@example.com/a.tgz')).rejects.toThrow(/credentials/)
    await expect(fetchImpl('file:///etc/passwd')).rejects.toThrow(/only https/)
    expect(requests).toEqual([])
  })

  it('fails when the host connection is gone', async () => {
    await expect(httpsOnlyBridgeFetch(() => null)('https://example.com/a')).rejects.toThrow(/no host connection/)
  })

  it('goes through network.httpGet and reports the final URL, so a redirect to http is caught by the https source', async () => {
    const { transport, requests } = bridge({
      status: 200,
      statusText: 'OK',
      finalUrl: 'http://evil.example/a.tgz',
      headers: {},
      body: new Uint8Array([1, 2, 3]),
    })
    const fetchImpl = httpsOnlyBridgeFetch(() => transport)
    await expect(downloadHttps('https://example.com/a.tgz', fetchImpl, 1024)).rejects.toBeInstanceOf(HttpsSourceError)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      route: { capability: 'network', action: 'httpGet' },
      payload: { url: 'https://example.com/a.tgz', followRedirects: true },
    })
  })

  it('serves an https answer, and the source still enforces its size cap', async () => {
    const body = new Uint8Array(2048)
    const { transport } = bridge({ status: 200, statusText: 'OK', finalUrl: 'https://cdn.example/a.tgz', headers: {}, body })
    const fetchImpl = httpsOnlyBridgeFetch(() => transport)
    const ok = await downloadHttps('https://example.com/a.tgz', fetchImpl, 4096)
    expect(ok.bytes.byteLength).toBe(2048)
    await expect(downloadHttps('https://example.com/a.tgz', fetchImpl, 1024)).rejects.toThrow(/larger than|bytes/)
  })
})

const ROOT = '/home/u/.velloc/plugins/cache/shop/acme/2.0.0'

function planted(files: Record<string, string>): RuntimeFs {
  return {
    readFile: async (path: string) => {
      const text = files[path.replace(/\\/g, '/')]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    writeFile: async () => {},
    mkdir: async () => {},
    stat: async () => ({}),
  } as unknown as RuntimeFs
}

function pluginWith(modulePath: string): ActivePlugin {
  const manifest = {
    providerApi: 1,
    displayName: 'Zen',
    defaultBaseUrl: 'https://opencode.ai/zen/v1',
    domains: ['opencode.ai'],
    format: 'openai-chat' as const,
    credentials: { methods: ['apiKey' as const] },
    module: modulePath,
  }
  return {
    name: 'acme',
    manifest: { name: 'acme', version: '2.0.0' },
    path: ROOT,
    source: 'marketplace:acme@shop',
    providers: resolveProviders('acme', ROOT, { zen: manifest } as never),
  }
}

describe('createProviderModAdmit - the runtime\'s own admission, at update time', () => {
  const admit = (files: Record<string, string>) =>
    createProviderModAdmit({ homeDir: '/home/u', fs: planted(files), report: () => {} })

  it('lets a module that hooks provider events through', async () => {
    const path = `${ROOT}/providers/zen.js`
    await expect(
      admit({ [path]: "export function register(on) { on('provider.models', async ($) => []) }" })(pluginWith('./providers/zen.js')),
    ).resolves.toBeUndefined()
  })

  it('refuses a module that hooks a session event', async () => {
    const path = `${ROOT}/providers/zen.js`
    await expect(
      admit({ [path]: "export function register(on) { on('session.start', () => {}) }" })(pluginWith('./providers/zen.js')),
    ).rejects.toThrow(/session\.start/)
  })

  it('refuses a module that calls $.session', async () => {
    const path = `${ROOT}/providers/zen.js`
    await expect(
      admit({
        [path]: "export function register(on) { on('provider.models', async ($) => { await $.session.cwd(); return [] }) }",
      })(pluginWith('./providers/zen.js')),
    ).rejects.toThrow(/session/)
  })

  it('refuses a module that is not there', async () => {
    await expect(admit({})(pluginWith('./providers/zen.js'))).rejects.toThrow(/could not be read/)
  })
})
