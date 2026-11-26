/**
 * What the realm lends the provider runtime's nouns (bridge transport, host
 * environment, settings write path), each a function read when a noun is CALLED.
 * Type-only imports.
 */

import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import type { NexusProviderConfig } from '../../settings/settingsTypes'

export type ProviderHostSources = {
  /** The manager's direct bridge transport, or null before one is attached. */
  transport?: () => BrowserBridgeTransport | null
  /** The host half of the init payload the desktop page published. */
  hostEnvironment?: () => { userAgent?: string; locale?: string } | null | undefined
  /** The `providers.upsert` write path (sealing, publish and broadcast follow).
   *  `promote: false`: the write never makes the provider the active one. */
  writeProviderConfig?: (providerId: string, config: NexusProviderConfig, options?: { promote?: boolean }) => Promise<void>
  /** The `providers.remove` write path: the entry and its sealed values go. */
  removeProviderConfig?: (providerId: string) => Promise<void>
}

let sources: ProviderHostSources = {}

/** Lend (or replace) pieces; a piece not named is kept. */
export function lendProviderHostSources(next: ProviderHostSources): void {
  sources = { ...sources, ...next }
}

export function providerHostSources(): Readonly<ProviderHostSources> {
  return sources
}

/** Test seam. */
export function resetProviderHostSources(): void {
  sources = {}
}
