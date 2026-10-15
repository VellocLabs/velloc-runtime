/**
 * Security: registry of WebUI-callable bridge capabilities, an EXPLICIT ALLOW-LIST. A request is
 * dispatched only to a registered handler (no generic forward); otherwise `webui_capability_unregistered`
 * and the request never leaves the worker. Each owner decides what is safe to expose. Re-registering
 * overwrites; no de-registration.
 */

import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
} from '../../bridge/protocol/core'

/**
 * Shared context handed to every WebUI handler, stable for the manager's lifetime; `homeDir` is updated
 * on each port attach (last wins).
 */
export type WebUiBridgeContext = {
  /** User home directory. Forwarded from the page thread's init env
   *  through the attach message — the SharedWorker has no env of its
   *  own. */
  homeDir: string

  /** Worker-side `RuntimeFs`. Bridge-backed: every call ultimately
   *  routes to C++ via the `directBridgeTransport` the manager already
   *  owns. Lazily constructed on first WebUI port attach (the manager
   *  needs the direct bridge to be live first). */
  fs: RuntimeFs

  /** Push a worker → WebUI event to EVERY attached WebUI port.
   *  Idempotent and best-effort: a closed port is silently skipped.
   *  Use for state-change broadcasts (e.g. "features.changed" so other
   *  tabs' settings pages re-render). */
  broadcastEvent(route: BrowserBridgeRoute, payload: Record<string, unknown>): void

  /** Direct bridge to C++ (the `DirectPortBridgeTransport`). Available
   *  whenever the C++ side has registered a port via `bridge.setPort`
   *  before the WebUI attaches — i.e. the production path. Mock-host
   *  setups without a direct bridge get `null`, in which case
   *  capability handlers that need it must fall back gracefully (the
   *  features handler, for example, falls back to a `'.'` settings
   *  root when it can't resolve cwd). */
  directBridge: BrowserBridgeTransport | null

  /**
   * Push `worker.applyRuntimeSettings({ config })` to every session (best-effort). Optional: handlers MUST
   * treat `undefined` as "no live engines".
   */
  applyAgentSettingsToAllSessions?(config: Record<string, unknown>): void

  /**
   * Hot-reload plugins on every session after an enable/disable (best-effort; MCP changes wait for the
   * next session). Optional: handlers MUST treat `undefined` as "no live engines".
   */
  reloadPluginsOnAllSessions?(): void
}

export type WebUiBridgeHandler = (
  request: BrowserBridgeRequest,
  ctx: WebUiBridgeContext,
) => Promise<BrowserBridgeResponse>

const handlers = new Map<string, WebUiBridgeHandler>()

/**
 * Register the handler for one capability. Subsequent calls with the
 * same `capability` overwrite (last write wins). Returns the prior
 * handler (if any) so a wrapper can chain — `register('features',
 * wrapWithLogging(prev ?? handle))`.
 */
export function registerWebUiBridgeHandler(
  capability: string,
  handler: WebUiBridgeHandler,
): WebUiBridgeHandler | undefined {
  const previous = handlers.get(capability)
  handlers.set(capability, handler)
  return previous
}

export function getWebUiBridgeHandler(
  capability: string,
): WebUiBridgeHandler | undefined {
  return handlers.get(capability)
}

/** Snapshot of registered capability names. Stable order: insertion. */
export function getRegisteredWebUiBridgeCapabilities(): readonly string[] {
  return Array.from(handlers.keys())
}

/** Test-only: wipe the registry between cases. Never call in prod. */
export function __resetWebUiBridgeRegistryForTests(): void {
  handlers.clear()
}
