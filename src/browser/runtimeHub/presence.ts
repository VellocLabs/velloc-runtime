/**
 * `presence` — which session each client is viewing (P-3): a set, at most one session per
 * connection, set only by that connection and removed when it goes away. Each
 * connection also reports when its person used the page and whether it is
 * visible, which the render-cache policy reads as activity.
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
  private readonly visibleByConnection = new Map<string, boolean>()
  private readonly activityListeners = new Set<() => void>()

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
    if (this.visibleByConnection.delete(connectionId)) this.emitActivity()
  }

  /** `connectionId`'s person used its page, or its page was shown or hidden. */
  reportActivity(connectionId: string, visible: boolean): void {
    this.visibleByConnection.set(connectionId, visible)
    this.emitActivity()
  }

  /** Some connection last reported its page visible. */
  anyVisible(): boolean {
    for (const visible of this.visibleByConnection.values()) if (visible) return true
    return false
  }

  onActivity(listener: () => void): () => void {
    this.activityListeners.add(listener)
    return () => {
      this.activityListeners.delete(listener)
    }
  }

  private emitActivity(): void {
    for (const listener of [...this.activityListeners]) {
      try {
        listener()
      } catch (error) {
        console.warn('[presence] an activity listener failed:', error)
      }
    }
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

export type ReportActivityPayload = { visible: boolean }

function isReportActivityPayload(value: unknown): value is ReportActivityPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === 'visible' && typeof (value as { visible?: unknown }).visible === 'boolean'
}

/**
 * `presence.setViewing { sessionId | null }` — `observe`: saying what you look
 * at changes nothing but who is told about it. A scoped connection may only
 * name a session inside its scope.
 *
 * `presence.reportActivity { visible }` — `observe`: it only postpones the
 * render-cache purge, and carries no session.
 */
export function registerPresenceCapability(registry: CapabilityRegistry, table: PresenceTable): void {
  registry.registerCapability({
    cap: PRESENCE_CAPABILITY,
    actions: {
      setViewing: { scope: 'observe', guard: isSetViewingPayload },
      reportActivity: { scope: 'observe', guard: isReportActivityPayload },
    },
    handle: async request => {
      if (request.route.act === 'reportActivity') {
        table.reportActivity(request.conn.connectionId, (request.payload as ReportActivityPayload).visible)
        return undefined
      }
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
