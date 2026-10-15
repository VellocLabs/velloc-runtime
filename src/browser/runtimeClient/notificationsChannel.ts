/**
 * The client half of the `notifications` topic: the runtime publishes what a
 * user should be told, each client decides how to show it. Delta-only: nothing
 * published while a client was away is replayed.
 */
import { NOTIFICATIONS_TOPIC, isRuntimeNotification, type RuntimeNotification } from '../runtimeProtocol'
import type { Unsubscribe } from '../runtimeTransport'
import type { RuntimeConnection } from './RuntimeConnection'

export type NotificationsSubscription = {
  connection: () => Promise<RuntimeConnection>
  /** Show it. Never awaited — a client's rendering must not hold the topic up. */
  show: (notification: RuntimeNotification) => void
  onError?: (error: unknown) => void
}

export function subscribeRuntimeNotifications(options: NotificationsSubscription): Unsubscribe {
  const report =
    options.onError ?? (error => console.warn('[notifications] subscribe failed:', error))
  let cancelled = false
  let unsubscribe: Unsubscribe | null = null

  void options.connection().then(conn => {
    if (cancelled) return
    unsubscribe = conn.subscribe(NOTIFICATIONS_TOPIC, event => {
      if (!isRuntimeNotification(event.payload)) return
      options.show(event.payload)
    })
  }, report)

  return () => {
    cancelled = true
    unsubscribe?.()
    unsubscribe = null
  }
}
