/**
 * The settings capabilities (`providers`, `features`, `agent`, `profile`,
 * `memory`, `sessionModels`, `mcpSettings`, `plugins`, `skills`, `sessionImport`)
 * on the runtime connection (P-3): requests through the hub, `*.changed`
 * broadcasts as `settings/<cap>` deltas. Same `request` / `subscribeEvents` /
 * `dispose` shape as the bridge; this app opens no WebUI settings port.
 */
import type {
  BridgeEventEnvelope,
  BridgeEventHandler,
  BridgeEventUnsubscribe,
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequestPayload,
  BrowserBridgeResult,
  BrowserBridgeRoute,
} from '../bridge/protocol/core'
import { LEGACY_WEBUI_CAPABILITIES } from '../runtimeHub/legacyWebUiCapabilities'
import { isBlobRef, topic, type BlobRef, type RouteKey, type TopicId } from '../runtimeProtocol'
import type { Unsubscribe } from '../runtimeTransport'
import { isRuntimeRequestError, type RuntimeConnection } from './RuntimeConnection'
import { wireErrorToLegacy } from './hostBridgeOverConnection'

/**
 * What the settings UI holds. Implemented over the runtime connection; the
 * type is what the ~20 consumer files depend on.
 */
export interface SettingsBridge {
  /** One settings request (`providers.list`, `features.setEnabled`, …). */
  request<C extends BrowserBridgeCapability, A extends BrowserBridgeAction<C>>(
    route: BrowserBridgeRoute<C, A>,
    payload: BrowserBridgeRequestPayload<C, A>,
  ): Promise<BrowserBridgeResult<C, A>>
  /** Worker → client pushes (`providers.changed`, `mcpSettings.changed`, …). */
  subscribeEvents(handler: BridgeEventHandler): BridgeEventUnsubscribe
  dispose(): void
}

export type SettingsBridgeOverConnectionOptions = {
  connection: () => Promise<RuntimeConnection>
  onError?: (error: unknown) => void
}

const SETTINGS_TOPICS: readonly TopicId[] = Object.keys(LEGACY_WEBUI_CAPABILITIES).map(cap =>
  topic.settings(cap),
)

/** A `settings/<cap>` event back into the legacy envelope callers match on. */
function eventToEnvelope(capability: string, type: string | undefined, payload: unknown): BridgeEventEnvelope | null {
  if (!type) return null
  return {
    route: { namespace: 'nexus', capability, action: type } as BridgeEventEnvelope['route'],
    payload: (payload ?? {}) as BridgeEventEnvelope['payload'],
  }
}

/**
 * The inverse of the runtime's `offerNestedBytes`: every `BlobRef` inside a
 * result, at any depth, becomes the bytes it names. A result with none is
 * returned untouched (the same object).
 */
export async function readNestedBlobs(
  value: unknown,
  read: (ref: BlobRef) => Promise<Uint8Array>,
): Promise<unknown> {
  if (isBlobRef(value)) return read(value)
  if (Array.isArray(value)) {
    const out = await Promise.all(value.map(item => readNestedBlobs(item, read)))
    return out.some((item, i) => item !== value[i]) ? out : value
  }
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await readNestedBlobs(item, read)] as const),
    )
    const changed = entries.some(([key, item]) => item !== (value as Record<string, unknown>)[key])
    return changed ? Object.fromEntries(entries) : value
  }
  return value
}

export function createSettingsBridgeOverConnection(
  options: SettingsBridgeOverConnectionOptions,
): SettingsBridge {
  const report =
    options.onError ?? (error => console.warn('[settings] runtime request failed:', error))
  const handlers = new Set<BridgeEventHandler>()
  let held: Unsubscribe[] | null = null
  let generation = 0
  let disposed = false

  const hold = (): void => {
    const mine = ++generation
    held = []
    void options.connection().then(conn => {
      // Every handler left (or the bridge was disposed) before the connection came up.
      if (mine !== generation || held === null) return
      for (const id of SETTINGS_TOPICS) {
        const capability = id.slice('settings/'.length)
        held.push(
          conn.subscribe(id, event => {
            // A delta-only topic opens with an empty baseline snapshot.
            if (event.form === 'snapshot' && event.payload === null) return
            const envelope = eventToEnvelope(capability, event.type, event.payload)
            if (!envelope) return
            for (const handler of Array.from(handlers)) handler(envelope)
          }),
        )
      }
    }, report)
  }

  const release = (): void => {
    generation += 1
    for (const unsubscribe of held ?? []) unsubscribe()
    held = null
  }

  return {
    async request(route, payload) {
      const conn = await options.connection()
      try {
        const result = await conn.request(
          `${route.capability}.${route.action}` as RouteKey,
          payload as Record<string, unknown>,
        )
        // The runtime offers any bytes in a result as blobs (`offerNestedBytes`),
        // so a websocket's JSON frames carry them; put the bytes back.
        return (await readNestedBlobs(result, ref => conn.readBlob(ref))) as never
      } catch (error) {
        // Settings sections SHOW `error.message` (an install failure, a bad
        // MCP config), and the legacy bridge threw `"<code>: <message>"`.
        // Keep that text: the hub's code is the legacy one folded back.
        if (isRuntimeRequestError(error)) {
          const legacy = wireErrorToLegacy(error.wire)
          throw new Error(`${legacy.code}: ${legacy.message}`)
        }
        throw error
      }
    },
    subscribeEvents(handler) {
      if (disposed) return () => {}
      handlers.add(handler)
      if (held === null) hold()
      return () => {
        handlers.delete(handler)
        if (handlers.size === 0) release()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      handlers.clear()
      release()
    },
  }
}
