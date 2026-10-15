/**
 * The realm's one model catalog (F-28), bound to runtime seams: `http` (the
 * host's `network.httpRequest`, egress policy applies, 8 MiB cap),
 * `fetchAsset` (same-origin snapshot files, soft-failing) and `sourceUrl`.
 * Nothing runs at construction. The fs must survive a host reconnect.
 */
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { readUserLayer } from '../settings/settingsStore'
import { createBrowserNetworkOperations } from '../utils/BrowserNetworkOperations'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { DEFAULT_SOURCE_URL, type CatalogHttp } from './catalogFetcher'
import { createModelCatalogService } from './createModelCatalogService'
import type { ModelCatalog } from './modelCatalog'
import { configureModelCatalogSource } from './modelCatalogHolder'

export type RuntimeModelCatalogDeps = {
  homeDir: string
  fs: RuntimeFs
  /** The direct bridge transport, null before one is attached. */
  transport: () => BrowserBridgeTransport | null
  /** Test seam: replaces the asset fetch. */
  fetchAsset?: (assetPath: string) => Promise<string | undefined>
  /** Test seam: replaces the host http. */
  http?: CatalogHttp
}

const REQUEST_TIMEOUT_MS = 60_000

function assetUrl(assetPath: string): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL
  const base = env && env.length > 0 ? env : '/'
  const origin =
    (globalThis as unknown as { location?: { origin?: string } }).location?.origin || 'http://localhost'
  return new URL(`${base.endsWith('/') ? base : `${base}/`}${assetPath}`, origin).toString()
}

/**
 * A source on this machine: `localhost`, 127.0.0.0/8 or ::1. Only such a
 * source may reach a private address; any other custom url keeps the default
 * egress policy, like the built-in source.
 */
export function isLoopbackSourceUrl(url: string): boolean {
  if (url === DEFAULT_SOURCE_URL) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** Same-origin asset text; any failure (offline, 404, no fetch) is undefined. */
export async function fetchBundleAsset(assetPath: string): Promise<string | undefined> {
  try {
    const response = await fetch(assetUrl(assetPath))
    return response.ok ? await response.text() : undefined
  } catch {
    return undefined
  }
}

function hostCatalogHttp(transport: () => BrowserBridgeTransport | null): CatalogHttp {
  return async req => {
    const bridge = transport()
    if (!bridge) throw new Error('the host is not connected')
    const network = createBrowserNetworkOperations({
      transport: bridge,
      createRequestId: () => `catalog-http-${crypto.randomUUID()}`,
    })
    if (!network.httpRequest) throw new Error('this host cannot make requests')
    const result = await network.httpRequest({
      url: req.url,
      method: 'GET',
      headers: req.headers,
      followRedirects: true,
      maxRedirects: 5,
      maxResponseBytes: req.maxBytes,
      timeoutMs: REQUEST_TIMEOUT_MS,
      // A source the person pointed the hidden setting at may run on this
      // machine; every other url (the built-in one included) keeps the
      // default policy.
      ...(isLoopbackSourceUrl(req.url) ? { allowPrivateNetwork: true } : {}),
    })
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(result.headers ?? {})) headers[name.toLowerCase()] = String(value)
    const body = result.body instanceof Uint8Array ? result.body : new Uint8Array(0)
    return {
      status: result.status,
      ...(headers.etag ? { etag: headers.etag } : {}),
      body: new TextDecoder('utf-8').decode(body),
    }
  }
}

let shared: ModelCatalog | undefined

/** The realm's catalog, built on first use. */
export function getRuntimeModelCatalog(deps: RuntimeModelCatalogDeps): ModelCatalog {
  if (shared) return shared
  shared = createModelCatalogService({
    fs: deps.fs,
    homeDir: deps.homeDir,
    http: deps.http ?? hostCatalogHttp(deps.transport),
    fetchAsset: deps.fetchAsset ?? fetchBundleAsset,
    sourceUrl: async () => (await readUserLayer(deps.homeDir, deps.fs)).settings.catalog?.sourceUrl,
  })
  return shared
}

/**
 * Point the hub's catalog capability at the realm's service. The service is
 * still built on first use (a status read or a `$.catalog` lookup), and both
 * reach the same one. Called by the manager once it has a home and a host.
 */
export function installRuntimeModelCatalog(deps: RuntimeModelCatalogDeps): void {
  configureModelCatalogSource(() => getRuntimeModelCatalog(deps))
}

/** Test seam. */
export function resetRuntimeModelCatalog(): void {
  shared = undefined
}
