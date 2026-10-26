/**
 * The directory offer's runtime calls (F-35): the public listing over
 * `fetch`, and the `plugins` / `mcpSettings` WebUI handlers the Settings
 * pages use, called in-process with the runtime's own bridge context — the
 * same install path, blocklist and settings writer as a Settings install.
 */
import type { BrowserBridgeRequest, BrowserBridgeRoute } from '../browser/bridge/protocol/core'
import type { WebUiBridgeContext, WebUiBridgeHandler } from '../browser/worker/webUiBridge/registry'
import type { DirectoryOfferDeps } from './directoryOffer'

export type DirectoryOfferHostOptions = {
  getContext: () => WebUiBridgeContext
  /** Populates the handler registry (idempotent), then reads one handler. */
  getHandler: (capability: string) => WebUiBridgeHandler | undefined
  createRequestId: () => string
  fetchImpl?: typeof fetch
}

export function createDirectoryOfferDeps(options: DirectoryOfferHostOptions): DirectoryOfferDeps {
  const call = async <T>(capability: 'plugins' | 'mcpSettings', action: string, payload: unknown): Promise<T> => {
    const handler = options.getHandler(capability)
    if (!handler) throw new Error(`no '${capability}' handler`)
    const route = { namespace: 'nexus', capability, action } as BrowserBridgeRoute
    const response = await handler(
      { id: options.createRequestId(), route, payload } as BrowserBridgeRequest,
      options.getContext(),
    )
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result as T
  }
  return {
    fetchJson: async url => {
      const response = await (options.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    },
    listMarketplaces: async () =>
      (await call<{ marketplaces: Array<{ name: string; source: never; isOfficial?: boolean }> }>(
        'plugins', 'listMarketplaces', {},
      )).marketplaces,
    listMarketplaceListings: async marketplace =>
      (await call<{ manifest: { plugins: never[] } | null }>('plugins', 'listMarketplacePlugins', { marketplace }))
        .manifest?.plugins ?? [],
    listInstalledPlugins: async () =>
      (await call<{ plugins: Array<{ name: string; marketplace: string; codeSource?: never; gitCommitSha?: string }> }>(
        'plugins', 'listInstalled', {},
      )).plugins.map(plugin => ({
        identifier: `${plugin.name}@${plugin.marketplace}`,
        ...(plugin.codeSource ? { codeSource: plugin.codeSource } : {}),
        ...(plugin.gitCommitSha ? { gitCommitSha: plugin.gitCommitSha } : {}),
      })),
    installFromDirectory: async spec =>
      (await call<{ identifier: string }>('plugins', 'installFromDirectory', spec)).identifier,
    listMcpServers: async () => (await call<{ servers: Record<string, never> }>('mcpSettings', 'list', {})).servers,
    upsertMcpServer: async (id, config) => {
      await call('mcpSettings', 'upsert', { id, config })
    },
  }
}
