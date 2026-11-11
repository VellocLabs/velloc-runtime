/**
 * The sign-in phase of an app plugin's own MCP servers, as its background
 * module hears it in `mcp.status` (F-40).
 * Security: a module is told of its own plugin's servers alone, by manifest
 * key; no URL, token, client id or error text leaves this file.
 */

import type { McpAuthPhase, McpAuthState } from '../../mcp/oauth/mcpAuthProtocol'
import { normalizeMcpServerUrl } from '../../mcp/oauth/oauthKeys'
import { pluginMcpServerListings } from '../../pluginHost/pluginMcpServerList'
import type { AppBackgroundMcpOwner } from './appBackgroundMcp'

/** The realm's sign-in state and its changes; `read` is null while there is no sign-in service. */
export type AppMcpStatusSource = {
  read(): McpAuthState | null
  onChange(listener: () => void): () => void
}

export type AppMcpStatusEvent = { server: string; phase: McpAuthPhase }

/** Manifest key → normalized URL of each http server of the plugin whose URL names no option. */
export function mcpServerUrlsOf(owner: Pick<AppBackgroundMcpOwner, 'name' | 'mcpServers' | 'nativeMcpServers'>): Map<string, string> {
  const urls = new Map<string, string>()
  for (const listing of pluginMcpServerListings([owner])) {
    const url = listing.url ? normalizeMcpServerUrl(listing.url) : null
    if (url && !urls.has(listing.name)) urls.set(listing.name, url)
  }
  return urls
}

/** Manifest key → URL as the manifest gives it, of the same servers: what a sign-in of one is asked with. */
export function mcpServerSignInUrlsOf(owner: Pick<AppBackgroundMcpOwner, 'name' | 'mcpServers' | 'nativeMcpServers'>): Map<string, string> {
  const urls = new Map<string, string>()
  for (const listing of pluginMcpServerListings([owner])) {
    if (listing.url && normalizeMcpServerUrl(listing.url) && !urls.has(listing.name)) urls.set(listing.name, listing.url)
  }
  return urls
}

/** Normalized URL → phase of every server the sign-in service reports. */
export function mcpPhasesByUrl(state: McpAuthState | null): Map<string, McpAuthPhase> {
  const phases = new Map<string, McpAuthPhase>()
  for (const server of state?.servers ?? []) {
    const url = normalizeMcpServerUrl(server.url)
    if (url) phases.set(url, server.phase)
  }
  return phases
}

/**
 * Whether a press may start the sign-in of the server at normalized `url`:
 * the service reads it as needing one, waiting on neither a client id nor a
 * key from the person. A server signed in, signing in, or not reported is
 * not one.
 */
export function mcpSignInDue(state: McpAuthState | null, url: string): boolean {
  const server = state?.servers.find(each => normalizeMcpServerUrl(each.url) === url)
  return server?.phase === 'needs-sign-in' && server.needsClient !== true && server.needsCredentials !== true
}

/**
 * What one module should hear and what it has heard. A server the service
 * does not report is left untold; one it stops reporting after the module
 * was told of it reads `needs-sign-in`, since it holds no sign-in.
 */
export class AppMcpStatusLedger {
  private readonly wanted = new Map<string, McpAuthPhase>()
  private readonly told = new Map<string, McpAuthPhase>()

  constructor(private readonly urls: ReadonlyMap<string, string>) {}

  /** Takes the service's phases; the keys whose phase to tell changed. */
  note(phases: ReadonlyMap<string, McpAuthPhase>): string[] {
    const changed: string[] = []
    for (const [key, url] of this.urls) {
      const phase = phases.get(url) ?? (this.wanted.has(key) ? 'needs-sign-in' : undefined)
      if (phase === undefined || this.wanted.get(key) === phase) continue
      this.wanted.set(key, phase)
      changed.push(key)
    }
    return changed
  }

  /** A new load of the module has heard nothing: every key with a phase is due again. */
  restart(): string[] {
    this.told.clear()
    return [...this.wanted.keys()]
  }

  /** The phase to tell for `key` now, recorded as told; undefined when the module already heard it. */
  take(key: string): McpAuthPhase | undefined {
    const phase = this.wanted.get(key)
    if (phase === undefined || this.told.get(key) === phase) return undefined
    this.told.set(key, phase)
    return phase
  }
}
