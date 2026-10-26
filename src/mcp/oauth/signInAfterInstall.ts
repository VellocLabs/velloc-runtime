/**
 * Install-time sign-in (F-10): once a connector or a plugin is installed,
 * each of its http servers that publishes OAuth metadata gets its sign-in
 * started, so the sign-in window opens without a first failing tool call.
 */
import type { PluginMcpServerListing } from '../../pluginHost/pluginMcpServerList'
import { currentMcpOAuthService } from './mcpOAuthHolder'

/** Starts the sign-in of each server at `urls` that asks for one. Never throws. */
export function startInstallSignIns(urls: Iterable<string | undefined>): void {
  const service = currentMcpOAuthService()
  if (!service) return
  for (const url of new Set(urls)) {
    if (!url) continue
    void service.signInIfRequired(url).catch(err => {
      console.warn('[mcp] install sign-in failed:', err instanceof Error ? err.message : err)
    })
  }
}

/** The http server URLs `plugin` declares, from the installed-plugin listing. */
export function pluginServerUrls(listings: readonly PluginMcpServerListing[], plugin: string): string[] {
  return listings.filter(listing => listing.plugin === plugin && listing.url).map(listing => listing.url!)
}
