/**
 * The realm's MCP sign-in service (F-10), for the pools, the runtime hub and
 * the install flows. Unset: servers that answer 401 still read as needing a
 * sign-in, and `mcpAuth` reports `available: false`.
 */
import { createRealmHolder } from '../../utils/realmHolder'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { getMcpHost } from '../mcpHost'
import { isMcpUnauthorized } from '../unauthorized'
import { createBridgeMcpOAuthHost, hostServesMcpOAuth } from './bridgeMcpOAuthHost'
import { McpOAuthService } from './McpOAuthService'

const holder = createRealmHolder<McpOAuthService>('mcp-oauth')

export function configureMcpOAuthService(next: McpOAuthService | null): void {
  holder.set(next)
}

export function currentMcpOAuthService(): McpOAuthService | null {
  return holder.get()
}

export function onMcpOAuthServiceChanged(listener: () => void): () => void {
  return holder.onChanged(listener)
}

export type RuntimeMcpOAuthDeps = {
  homeDir: () => string | null
  fs: () => RuntimeFs
  createRequestId: () => string
}

/** Builds the realm's service once; its host is the current MCP host port. */
export function installRuntimeMcpOAuth(deps: RuntimeMcpOAuthDeps): McpOAuthService {
  const existing = holder.get()
  if (existing) return existing
  const service = new McpOAuthService({
    homeDir: deps.homeDir,
    fs: deps.fs,
    host: serverUrl => {
      const host = getMcpHost()
      return host && hostServesMcpOAuth(host) ? createBridgeMcpOAuthHost(host, deps.createRequestId, serverUrl) : null
    },
  })
  configureMcpOAuthService(service)
  void service.load().catch(err => {
    console.warn('[mcp] loading sign-in records failed:', err instanceof Error ? err.message : err)
  })
  return service
}

/** `config` plus the sign-in header its http server holds, if any (F-10). */
export async function withHeldSignIn(config: unknown): Promise<unknown> {
  const url = signInUrlOf(config)
  const service = holder.get()
  if (!url || !service) return config
  const auth = await service.connectAuth(url).catch(() => null)
  return auth && auth !== 'required' ? withHeaders(config as object, auth.headers) : config
}

/**
 * Runs `probe` on `config` with its held sign-in; a 401 for a sign-in it
 * carried renews the sign-in and probes once more (F-10).
 */
export async function probeWithHeldSignIn<R extends { ok: boolean; error?: string }>(
  config: unknown,
  probe: (config: unknown) => Promise<R>,
): Promise<R> {
  const signed = await withHeldSignIn(config)
  const result = await probe(signed)
  const url = signInUrlOf(config)
  const service = holder.get()
  if (result.ok || signed === config || !url || !service || !isMcpUnauthorized(result.error)) return result
  if (!(await service.handleUnauthorized(url).catch(() => false))) return result
  return probe(await withHeldSignIn(config))
}

function signInUrlOf(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null
  const url = (config as { url?: unknown }).url
  return typeof url === 'string' ? url : null
}

function withHeaders(config: object, extra: Record<string, string>): object {
  const headers = (config as { headers?: unknown }).headers
  return { ...config, headers: { ...(headers && typeof headers === 'object' ? headers : {}), ...extra } }
}
