/**
 * SessionListChannel: the shell's session-list and background-task traffic on
 * the runtime connection (P-3). Requests `session.rename / fork / delete`,
 * `task.stop / resume / transcript / recoverBackground` and `presence.setViewing`;
 * `sessions` / `tasks` topic events reach listeners as manager messages, the
 * inverse of the hub's `eventToManagerMessage`. An answer arrives as a topic event
 * (`session.forked` carries the `requestId`), seen by every client on the topic.
 */
import { topic, type RouteKey, type TopicId } from '../runtimeProtocol'
import type { Unsubscribe } from '../runtimeTransport'
import type { RuntimeConnection } from './RuntimeConnection'
import { eventToManagerMessage } from './workerTransportOverConnection'

export type SessionListRoute =
  | 'session.rename'
  | 'session.fork'
  | 'session.delete'
  | 'task.stop'
  | 'task.resume'
  | 'task.transcript'
  | 'task.recoverBackground'
  | 'presence.setViewing'

export type SessionListMessage = { type: string } & Record<string, unknown>

export interface SessionListChannel {
  /**
   * Receive the `sessions` and `tasks` topics as manager messages. The first
   * listener subscribes; the `sessions` snapshot arrives as a `session.list`.
   */
  onMessage(listener: (message: SessionListMessage) => void): Unsubscribe
  /** Fire a session-list or task request; a failure is reported, not thrown. */
  request(route: SessionListRoute, payload: Record<string, unknown>): void
}

export type SessionListChannelOptions = {
  connection: () => Promise<RuntimeConnection>
  onError?: (error: unknown) => void
}

export function createSessionListChannel(options: SessionListChannelOptions): SessionListChannel {
  const report = options.onError ?? (error => console.warn('[sessions] runtime request failed:', error))
  const listeners = new Set<(message: SessionListMessage) => void>()
  let held: Unsubscribe[] | null = null
  let generation = 0

  const emit = (message: SessionListMessage): void => {
    for (const listener of Array.from(listeners)) listener(message)
  }

  const hold = (): void => {
    const mine = ++generation
    held = []
    void options.connection().then(
      conn => {
        // Every listener left before the connection came up.
        if (mine !== generation || held === null) return
        for (const id of [topic.sessions(), topic.tasks()] as TopicId[]) {
          held.push(
            conn.subscribe(id, event => {
              // A delta-only topic's baseline snapshot carries no message.
              if (event.form === 'snapshot' && event.payload === null) return
              const message = eventToManagerMessage(event)
              if (message) emit(message as SessionListMessage)
            }),
          )
        }
      },
      report,
    )
  }

  const release = (): void => {
    generation += 1
    for (const unsubscribe of held ?? []) unsubscribe()
    held = null
  }

  return {
    onMessage(listener) {
      listeners.add(listener)
      if (held === null) hold()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) release()
      }
    },
    request(route, payload) {
      void options
        .connection()
        .then(conn => conn.request(route as RouteKey, payload))
        .catch(report)
    },
  }
}
