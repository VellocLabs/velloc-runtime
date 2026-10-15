/**
 * SessionStatusChannel: one session's status (phase, active tool, counters) from
 * its `session/<id>/state` topic (snapshot, then deltas). One subscription per
 * session, shared by its listeners and dropped with the last of them.
 */
import { topic } from '../runtimeProtocol'
import type { Unsubscribe } from '../runtimeTransport'
import type { NexusCurrentSessionPayload } from '../bridge/protocol/ui'
import type { RuntimeConnection } from './RuntimeConnection'

export type SessionStatusListener = (payload: NexusCurrentSessionPayload) => void

export interface SessionStatusChannel {
  /** Status of ONE session. Returns the unsubscribe. */
  subscribe(sessionId: string, listener: SessionStatusListener): Unsubscribe
}

export type SessionStatusChannelOptions = {
  connection: () => Promise<RuntimeConnection>
  onError?: (error: unknown) => void
}

type Entry = {
  listeners: Set<SessionStatusListener>
  /** Set once the topic subscription lands; a release before that bumps `generation`. */
  unsubscribe: Unsubscribe | null
  generation: number
}

export function createSessionStatusChannel(
  options: SessionStatusChannelOptions,
): SessionStatusChannel {
  const report =
    options.onError ?? (error => console.warn('[session status] subscribe failed:', error))
  const entries = new Map<string, Entry>()

  const hold = (sessionId: string, entry: Entry): void => {
    const mine = entry.generation
    void options.connection().then(conn => {
      // Every listener for this session left before the connection came up.
      if (entry.generation !== mine || entry.listeners.size === 0) return
      entry.unsubscribe = conn.subscribe(topic.session(sessionId, 'state'), event => {
        if (event.type !== 'session.currentState') return
        const payload = (event.payload as { payload?: NexusCurrentSessionPayload } | null)?.payload
        if (!payload) return
        for (const listener of Array.from(entry.listeners)) listener(payload)
      })
    }, report)
  }

  return {
    subscribe(sessionId, listener) {
      let entry = entries.get(sessionId)
      if (!entry) {
        entry = { listeners: new Set(), unsubscribe: null, generation: 0 }
        entries.set(sessionId, entry)
      }
      const held = entry
      held.listeners.add(listener)
      if (held.listeners.size === 1) hold(sessionId, held)
      return () => {
        held.listeners.delete(listener)
        if (held.listeners.size > 0) return
        held.generation += 1
        held.unsubscribe?.()
        held.unsubscribe = null
        entries.delete(sessionId)
      }
    },
  }
}
