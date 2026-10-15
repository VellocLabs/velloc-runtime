/**
 * `presence` — which session each client is viewing (P-3): a set, at most one session per
 * connection, set only by that connection and removed when it goes away.
 */
import { wireError } from '../runtimeProtocol'
import type { CapabilityRegistry } from './CapabilityRegistry'

export const PRESENCE_CAPABILITY = 'presence'

export type PresenceChange = {
  /** The session the connection now views (`null`: none). */
  viewing: string | null
  /** The session it viewed before, if different. */
  previous: string | null
}

export class PresenceTable {
  private readonly byConnection = new Map<string, string>()

  constructor(private readonly onChange: (change: PresenceChange) => void = () => {}) {}

  /** What `connectionId` views now; returns whether anything changed. */
  set(connectionId: string, sessionId: string | null): boolean {
    const previous = this.byConnection.get(connectionId) ?? null
    if (previous === sessionId) return false
    if (sessionId === null) this.byConnection.delete(connectionId)
    else this.byConnection.set(connectionId, sessionId)
    this.onChange({ viewing: sessionId, previous })
    return true
  }

  /** The connection is gone: it views nothing. */
  remove(connectionId: string): void {
    this.set(connectionId, null)
  }

  isViewed(sessionId: string): boolean {
    for (const viewed of this.byConnection.values()) if (viewed === sessionId) return true
    return false
  }

  viewedSessions(): ReadonlySet<string> {
    return new Set(this.byConnection.values())
  }
}

export type SetViewingPayload = { sessionId: string | null }

function isSetViewingPayload(value: unknown): value is SetViewingPayload {
  if (!value || typeof value !== 'object') return false
  const sessionId = (value as { sessionId?: unknown }).sessionId
  return sessionId === null || (typeof sessionId === 'string' && sessionId.length > 0)
}

/**
 * `presence.setViewing { sessionId | null }` — `observe`: saying what you look
 * at changes nothing but who is told about it. A scoped connection may only
 * name a session inside its scope.
 */
export function registerPresenceCapability(registry: CapabilityRegistry, table: PresenceTable): void {
  registry.registerCapability({
    cap: PRESENCE_CAPABILITY,
    actions: {
      setViewing: { scope: 'observe', guard: isSetViewingPayload },
    },
    handle: async request => {
      if (request.route.act !== 'setViewing') {
        throw wireError('unknown_route', `presence has no action '${request.route.act}'`)
      }
      const { sessionId } = request.payload as SetViewingPayload
      // Viewing nothing is always allowed; naming a session is judged like any
      // session-bound action (not `sessionOf`, which would refuse the `null`).
      const sessions = request.conn.scope.sessions
      if (sessionId !== null && sessions !== 'all' && !sessions.includes(sessionId)) {
        throw wireError('forbidden_scope', `session '${sessionId}' is outside this connection's sessions`)
      }
      table.set(request.conn.connectionId, sessionId)
      return undefined
    },
  })
}
