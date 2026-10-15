/**
 * Subscribe to a session's `session/<id>/state` broadcast for the topbar status
 * cluster, the composer gate and the running indicator. Snapshot replaces; delta
 * merges. Reset on `activeSessionId` change (the runtime sends a fresh snapshot).
 */

import { createContext, useContext, useEffect, useState } from 'react'

import type { SessionStatusChannel } from '../../runtimeClient'

import type {
  NexusCurrentSessionActive,
  NexusCurrentSessionCounters,
  NexusCurrentSessionPayload,
  NexusCurrentSessionPhase,
  NexusSessionPhase,
} from '../../bridge/protocol/ui'

export type NexusSessionStatus = {
  phase: NexusCurrentSessionPhase
  /**
   * The raw unified execution-state enum — the composer gate reads this
   * (input allowed only when `kind === 'idle'`). `phase`/`active` stay for
   * the topbar pill + running-indicator display.
   */
  sessionPhase: NexusSessionPhase
  active: NexusCurrentSessionActive | null
  counters: NexusCurrentSessionCounters
}

const IDLE_STATUS: NexusSessionStatus = {
  phase: 'idle',
  sessionPhase: { kind: 'idle' },
  active: null,
  counters: { tool: 0, toolFail: 0, mcp: 0, mcpFail: 0 },
}

/** The app-wide status feed. `null` on mock/dev hosts that wire no runtime. */
export const SessionStatusChannelContext = createContext<SessionStatusChannel | null>(null)

export function useSessionStatusChannel(): SessionStatusChannel | null {
  return useContext(SessionStatusChannelContext)
}

/**
 * @param channel         the app-wide status feed (null on mock/dev hosts)
 * @param activeSessionId the session whose status the topbar reflects
 */
export function useNexusSessionStatus(
  channel: SessionStatusChannel | null,
  activeSessionId: string | null | undefined,
): NexusSessionStatus {
  const [status, setStatus] = useState<NexusSessionStatus>(IDLE_STATUS)

  // Reset to idle whenever the active session changes — the worker will
  // re-broadcast a snapshot for the new session momentarily.
  useEffect(() => {
    setStatus(IDLE_STATUS)
  }, [activeSessionId])

  useEffect(() => {
    if (!channel || !activeSessionId) return
    return channel.subscribe(activeSessionId, payload => {
      // The topic is this session's, but a payload names its session: keep the
      // guard so a stray late delta cannot bleed in during a switch.
      if (payload.sessionId !== activeSessionId) return

      if (payload.kind === 'snapshot') {
        setStatus({
          phase: payload.phase,
          sessionPhase: payload.sessionPhase,
          active: payload.active,
          counters: payload.counters,
        })
        return
      }
      // delta — merge only the present fields.
      setStatus(prev => ({
        phase: payload.phase ?? prev.phase,
        sessionPhase: payload.sessionPhase ?? prev.sessionPhase,
        active: payload.active !== undefined ? payload.active : prev.active,
        counters: payload.counters
          ? { ...prev.counters, ...payload.counters }
          : prev.counters,
      }))
    })
  }, [channel, activeSessionId])

  return status
}
