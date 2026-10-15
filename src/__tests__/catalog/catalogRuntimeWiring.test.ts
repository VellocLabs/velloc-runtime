/**
 * The model catalog as the manager wires it (F-28): one service behind both
 * the hub's catalog capability (the Model data settings row) and `$.catalog`;
 * an fs that follows the current host port; and the egress rule for a custom
 * source url.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectPortBridgeTransport } from '../../browser/bridge/DirectPortBridgeTransport'
import { CapabilityRegistry } from '../../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../../browser/runtimeHub/TopicBroker'
import { registerCatalogCapability } from '../../browser/runtimeHub/catalogCapability'
import type { ConnectionInfo } from '../../browser/runtimeHub/types'
import { ManagerBootServices, type ManagerBootServicesHost } from '../../browser/worker/ManagerBootServices'
import { CATALOG_STATUS_TOPIC, type CatalogStatusState } from '../../catalog/catalogProtocol'
import { DEFAULT_SOURCE_URL } from '../../catalog/catalogFetcher'
import { acquireModelCatalog, configureModelCatalogSource } from '../../catalog/modelCatalogHolder'
import {
  getRuntimeModelCatalog,
  isLoopbackSourceUrl,
  resetRuntimeModelCatalog,
} from '../../catalog/runtimeModelCatalog'
import { catalogReaderOf, createProviderCatalogNoun } from '../../mods/provider/nouns/providerCatalogNoun'
import type { ProviderNounCall } from '../../mods/provider/ProviderModRuntime'
import { wipeSettingsMemos } from '../../settings/settingsStore'
import { createBrowserFsOperations } from '../../utils/BrowserFsOperations'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import sample from './fixtures/models-dev-sample.json'
import { awaitCatalogFigures, resetBuiltinCatalogFill } from '../../catalog/builtinCatalogFill'
import { catalogFiguresFor, resetCatalogFigures } from '../../config/nexusModelConfig/catalogFigures'
import { findConfiguredModel } from '../../config/nexusModelConfig/findConfiguredModel'

const ENC = new TextEncoder()
const DOC = JSON.stringify(sample)
const CATALOG = '/home/.velloc/catalog'

/** A host port: `fs` out of a map, `network.httpRequest` recorded. */
function hostPort(files: Record<string, string> = {}) {
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([k, v]) => [k, ENC.encode(v)]))
  const http: Array<Record<string, unknown>> = []
  let live = true
  const transport = {
    async request(req: unknown) {
      if (!live) throw new Error('Runtime scope was disposed.')
      const { route, payload } = req as {
        route: { capability: string; action: string }
        payload: Record<string, unknown>
      }
      if (route.capability === 'network') {
        http.push(payload)
        return { ok: true, result: { status: 200, headers: { etag: '"e"' }, body: ENC.encode(DOC) } }
      }
      const path = String(payload.path ?? '').split(String.fromCharCode(92)).join('/')
      switch (route.action) {
        case 'readFile': {
          const v = store.get(path)
          return v ? { ok: true, result: v } : { ok: false, error: { code: 'ENOENT', message: path } }
        }
        case 'writeFile':
          store.set(path, payload.content instanceof Uint8Array ? payload.content : ENC.encode(String(payload.content)))
          return { ok: true, result: undefined }
        case 'mkdir':
          return { ok: true, result: undefined }
        case 'stat': {
          const v = store.get(path)
          return v
            ? { ok: true, result: { size: v.length, isFile: true, isDirectory: false } }
            : { ok: false, error: { code: 'ENOENT', message: path } }
        }
        case 'unlink':
          store.delete(path)
          return { ok: true, result: undefined }
        case 'rename': {
          const from = String(payload.oldPath).split(String.fromCharCode(92)).join('/')
          const to = String(payload.newPath).split(String.fromCharCode(92)).join('/')
          if (store.has(to)) return { ok: false, error: { code: 'EEXIST', message: 'Destination already exists' } }
          store.set(to, store.get(from)!)
          store.delete(from)
          return { ok: true, result: undefined }
        }
        default:
          return { ok: false, error: { code: 'UNSUPPORTED', message: route.action } }
      }
    },
  } as unknown as DirectPortBridgeTransport
  return {
    transport,
    http,
    text: () => Object.fromEntries([...store].map(([k, v]) => [k, new TextDecoder().decode(v)])),
    kill: () => {
      live = false
    },
  }
}

function managerHost(current: () => DirectPortBridgeTransport | null): ManagerBootServicesHost {
  let n = 0
  return {
    getDirectBridgeTransport: current,
    createBridgeRequestId: () => `r-${++n}`,
    getHomeDir: () => '/home',
    storageRoot: () => null,
    spawnHeadlessSession: (() => null) as never,
    deliverRoutineToSession: (() => false) as never,
    canDeliverRoutineToSession: (() => false) as never,
    scheduleSummary: () => {},
    trace: () => {},
  }
}

async function settle() {
  for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 0))
}

const conn = { connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode: 'full', sessions: 'all' }, transport: 'message-port' } as unknown as ConnectionInfo

/** The status the capability publishes on its topic, as a subscriber sees it. */
async function topicStatus(): Promise<CatalogStatusState | undefined> {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const reg = registerCatalogCapability(registry, broker, { report: () => {} })
  const events: CatalogStatusState[] = []
  broker.subscribe(
    { conn, send: evt => events.push((evt as unknown as { payload: CatalogStatusState }).payload), bufferedBytes: () => 0 },
    CATALOG_STATUS_TOPIC,
  )
  await settle()
  ;(reg as { dispose?: () => void } | undefined)?.dispose?.()
  return events.at(-1)
}

/** A cache written by a fetch of the sample, as plain files. */
async function cacheFiles(): Promise<Record<string, string>> {
  const port = hostPort()
  resetRuntimeModelCatalog()
  const svc = getRuntimeModelCatalog({
    homeDir: '/home',
    fs: portFs(port.transport),
    transport: () => port.transport,
    fetchAsset: async () => undefined,
  })
  await svc.refresh()
  resetRuntimeModelCatalog()
  return Object.fromEntries(Object.entries(port.text()).filter(([k]) => k.startsWith(`${CATALOG}/`)))
}

function portFs(transport: DirectPortBridgeTransport): RuntimeFs {
  let n = 0
  return createBrowserFsOperations({ transport, createRequestId: () => `t-${++n}` }) as unknown as RuntimeFs
}

beforeEach(() => {
  wipeSettingsMemos()
  resetRuntimeModelCatalog()
  configureModelCatalogSource(null)
  // The bundle snapshot is not served in a unit test.
  vi.stubGlobal('fetch', async () => ({ ok: false, text: async () => '' }))
})
afterEach(() => {
  resetBuiltinCatalogFill()
  resetCatalogFigures()
  resetRuntimeModelCatalog()
  configureModelCatalogSource(null)
  vi.unstubAllGlobals()
})

describe('the manager wiring', () => {
  it('the capability says available once the manager has a host, and it is the service $.catalog reads', async () => {
    const port = hostPort()
    const services = new ManagerBootServices(managerHost(() => port.transport))
    expect((await topicStatus())?.available).toBe(false)

    services.onDirectTransportAttached(port.transport)
    await settle()

    const state = await topicStatus()
    expect(state?.available).toBe(true)
    // One service: the capability's and the one a provider module's noun binds.
    const viaCapability = await acquireModelCatalog()
    const viaNoun = getRuntimeModelCatalog({ homeDir: '/elsewhere', fs: {} as RuntimeFs, transport: () => null })
    expect(viaCapability).toBe(viaNoun)

    // A refresh through the capability's service reaches the host's http once,
    // and $.catalog answers from what it wrote.
    await viaCapability!.refresh()
    expect(port.http.length).toBe(1)
    const noun = createProviderCatalogNoun(catalogReaderOf(viaNoun))
    const hit = (await noun.table.model({ plugin: 'oc', noun: 'catalog', method: 'model', args: ['opencode', 'gpt-5.4'], providers: [] } as unknown as ProviderNounCall)) as { match: string }
    expect(hit.match).toBe('exact')
  })

  it('the built-in rows read the cached figures at start, nothing is fetched, and the host gets them', async () => {
    const port = hostPort(await cacheFiles())
    const sent: Array<{ route: { capability: string; action: string }; payload: Record<string, unknown> }> = []
    const request = port.transport.request.bind(port.transport)
    ;(port.transport as unknown as { request: typeof request }).request = async req => {
      sent.push(req as (typeof sent)[number])
      return request(req)
    }
    const services = new ManagerBootServices(managerHost(() => port.transport))
    services.onDirectTransportAttached(port.transport)
    await settle()
    await awaitCatalogFigures(5_000)
    await settle()

    // DeepSeek's Flash row leaves its window to the catalog: the cache's.
    expect(catalogFiguresFor('deepseek', 'deepseek-flash')?.contextWindow).toBe(1_000_000)
    expect(findConfiguredModel('deepseek', 'deepseek-flash')!.contextWindow).toBe(1_000_000)
    // Nothing went to the network: the read is the cache's, passively.
    expect(port.http.length).toBe(0)
    // The host was sent the model config again, carrying the figure.
    const publishes = sent.filter(r => r.route.capability === 'model' && r.route.action === 'publishCatalog')
    expect(publishes.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(publishes[0]!.payload)).not.toContain('"contextWindow":1000000')
    expect(JSON.stringify(publishes.at(-1)!.payload)).toContain('"contextWindow":1000000')
  })

  it('a replaced host port is the one the next catalog read uses', async () => {
    const files = await cacheFiles()
    expect(Object.keys(files).some(k => k.endsWith('/index.json'))).toBe(true)
    const first = hostPort()
    const second = hostPort(files)
    let current: DirectPortBridgeTransport | null = first.transport
    const services = new ManagerBootServices(managerHost(() => current))
    services.onDirectTransportAttached(first.transport)
    await settle()
    const svc = await acquireModelCatalog()
    expect(svc).toBeDefined()

    // The first window closes; another one's port replaces it.
    first.kill()
    current = second.transport
    services.onDirectTransportAttached(second.transport)

    const st = await svc!.status()
    expect(st.source).toBe('cache')
    expect(st.models).toBeGreaterThan(0)
    // …and a refresh goes out on the new port, not the dead one.
    await svc!.refresh()
    expect(second.http.length).toBe(1)
    expect(first.http.length).toBe(0)
  })
})

describe('a custom source url and the egress policy', () => {
  it('only a loopback host is a local source', () => {
    for (const url of ['http://localhost:8080/api.json', 'http://127.0.0.1:1/x.json', 'http://127.5.6.7/x', 'http://[::1]:9/x.json']) {
      expect(isLoopbackSourceUrl(url), url).toBe(true)
    }
    for (const url of [
      DEFAULT_SOURCE_URL,
      'https://mirror.example.com/api.json',
      'http://192.168.1.5/api.json',
      'http://10.0.0.1/api.json',
      'http://127.0.0.1.example.com/x',
      'http://localhost.example.com/x',
      'not a url',
    ]) {
      expect(isLoopbackSourceUrl(url), url).toBe(false)
    }
  })

  async function requestFor(sourceUrl: string): Promise<Record<string, unknown>> {
    const port = hostPort({ '/home/.velloc/settings.json': JSON.stringify({ version: 1, catalog: { sourceUrl } }) })
    resetRuntimeModelCatalog()
    const svc = getRuntimeModelCatalog({
      homeDir: '/home',
      fs: portFs(port.transport),
      transport: () => port.transport,
      fetchAsset: async () => undefined,
    })
    await svc.refresh()
    expect(port.http.length).toBe(1)
    return port.http[0]
  }

  it('a loopback source may reach a private address', async () => {
    const req = await requestFor('http://127.0.0.1:4100/api.json')
    expect(req.url).toBe('http://127.0.0.1:4100/api.json')
    expect(req.allowPrivateNetwork).toBe(true)
  })

  it('any other custom source keeps the default policy', async () => {
    const req = await requestFor('https://mirror.example.com/api.json')
    expect(req.url).toBe('https://mirror.example.com/api.json')
    expect(req.allowPrivateNetwork).toBeUndefined()
  })
})
