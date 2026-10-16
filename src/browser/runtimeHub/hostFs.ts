/**
 * The runtime's own calls to the host's `fs` routes, for the capabilities it
 * implements itself (`fsx`, `workspace`). These routes are the runtime's
 * private business — never advertised to a client, never in the host-proxy
 * table — so the helpers live here and nowhere a client can reach.
 *
 * `ctx.host` follows the replaceable direct transport; read it per call.
 */
import type { BrowserBridgeRoute } from '../bridge/protocol/core'
import { wireError } from '../runtimeProtocol'
import { legacyBridgeErrorToWire } from './errors'
import type { HostBridge, RuntimeContext } from './types'

function fsRoute(action: string): BrowserBridgeRoute {
  return { namespace: 'nexus', capability: 'fs', action } as BrowserBridgeRoute
}

/** The host bridge right now, or `host_unavailable` (a boot-order window, retryable). */
export function hostOf(ctx: RuntimeContext): HostBridge {
  if (!ctx.host) throw wireError('host_unavailable', 'the runtime has no host bridge right now')
  return ctx.host
}

/** `fs.<action>` on the host; a host error becomes the matching `WireError`. */
export async function callHostFs<T>(host: HostBridge, action: string, payload: unknown): Promise<T> {
  const response = await host.request(fsRoute(action), payload)
  if (!response.ok) throw legacyBridgeErrorToWire(response.error)
  return response.result as T
}

/**
 * The host user's home: what the runtime already knows, else the host's
 * `fs.userHome`. `not_found` when the host names none; never the host's
 * `fs.cwd`, the browser's own folder.
 */
export async function resolveHostHome(ctx: RuntimeContext): Promise<string> {
  if (ctx.homeDir) return ctx.homeDir
  const path = await callHostFs<unknown>(hostOf(ctx), 'userHome', {}).catch(() => null)
  if (typeof path === 'string' && path.length > 0) return path
  throw wireError('not_found', 'the host did not report a home directory')
}
