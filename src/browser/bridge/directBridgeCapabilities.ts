import type { BrowserBridgeCapability } from './browserBridgeProtocol'

/**
 * Capabilities the SharedWorker routes over the host's DIRECT bridge port; mirrors
 * the C++ guest port's `RegisterCapability(...)` list. The runtime makes ALL its
 * own host calls here, never through a client; a missing one fails at the router.
 */
export const NEXUS_DIRECT_BRIDGE_CAPABILITIES: ReadonlySet<BrowserBridgeCapability> =
  new Set<BrowserBridgeCapability>([
    'browser',
    'files',
    'exec',
    'fs',
    'model',
    'network',
    'search',
    'session',
    'shell',
    'sqlite',
    'ui',
    'systemPrefs',
    'appInfo',
    'appearance',
    'browserTools',
    'providerAuth',
    // The desktop's embedded-relay status + configure. The runtime
    // gates its getStatus call on the manifest advertisement.
    'remoteAccess',
    // Native primitives (P-3): origin-bound secrets and
    // persisted alarms. Both manifest-gated by their callers.
    'secrets',
    'alarms',
    // Single-web windows (F-29); manifest-gated by its caller.
    'webWindow',
  ])
