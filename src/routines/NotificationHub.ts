/**
 * NotificationHub: routes routine-run completions to optional sinks: in-app
 * (`nexusRoutinesUpdate`), OS push (per `notify_on`, only with no focused UI
 * tab) and an in-conversation reminder in the last active session. Missing
 * sinks are skipped.
 */

import type {
  NotifyPolicy,
  Routine,
  RoutineRunStatus,
  RoutineSignal,
} from './routineTypes'

export type NotificationEvent = {
  routine: Routine
  sessionId: string
  status: RoutineRunStatus
  summary: string
  signal?: RoutineSignal
  finishedAt: number
}

export type NotificationSink = {
  /** Broadcast to subscribed UI ports. Idempotent. */
  inApp?: (event: NotificationEvent) => void
  /**
   * OS-level push notification (browser notification API or platform
   * bridge). Implementations should check whether the user is
   * currently focused on a UI tab and skip the push if so.
   */
  osPush?: (event: NotificationEvent) => void
  /**
   * Queue a system-reminder message to be injected into the next UI
   * session the user opens. The receiver decides which session.
   */
  inConversation?: (event: NotificationEvent) => void
  /** Optional log sink. */
  logEvent?: (event: string, data: Record<string, unknown>) => void
}

export class NotificationHub {
  constructor(private readonly sinks: NotificationSink = {}) {}

  dispatch(event: NotificationEvent): void {
    if (!warrantsAlert(event)) {
      this.sinks.logEvent?.('nexus_routine_notify_skipped', {
        routineId: event.routine.id,
        status: event.status,
        notifyOn: event.routine.notifyOn,
      })
      return
    }
    try {
      this.sinks.inApp?.(event)
    } catch (err) {
      this.sinks.logEvent?.('nexus_routine_notify_inapp_failed', {
        routineId: event.routine.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (shouldOsPush(event)) {
      try {
        this.sinks.osPush?.(event)
      } catch (err) {
        this.sinks.logEvent?.('nexus_routine_notify_push_failed', {
          routineId: event.routine.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (shouldReminder(event)) {
      try {
        this.sinks.inConversation?.(event)
      } catch (err) {
        this.sinks.logEvent?.('nexus_routine_notify_reminder_failed', {
          routineId: event.routine.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}

function warrantsAlert(event: NotificationEvent): boolean {
  return matchesPolicy(event, event.routine.notifyOn, 'inApp')
}

function shouldOsPush(event: NotificationEvent): boolean {
  return matchesPolicy(event, event.routine.notifyOn, 'osPush')
}

function shouldReminder(event: NotificationEvent): boolean {
  return matchesPolicy(event, event.routine.notifyOn, 'inConversation')
}

function matchesPolicy(
  event: NotificationEvent,
  policy: NotifyPolicy,
  sink: 'inApp' | 'osPush' | 'inConversation',
): boolean {
  switch (policy) {
    case 'silent':
      return false
    case 'always':
      // OS push only when the run is interesting enough — successful
      // routine completion shouldn't ding the user phone every time.
      if (sink === 'osPush') {
        return event.status !== 'success' || event.signal?.priority === 'urgent'
      }
      return true
    case 'on_error':
      return event.status === 'error'
    case 'on_signal':
      if (!event.signal) return false
      if (sink === 'osPush') {
        return event.signal.priority !== 'low'
      }
      return true
  }
}
