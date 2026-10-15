import { useEffect } from 'react'

import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import { setSessionActive } from './nexusBridgeActions'
import { mayIssue, type CapabilityQuery } from './useCan'

/**
 * Mirror the active session to the host (boot and every switch), which foregrounds the session's tab and
 * replies with its tab counts. Best-effort: a host without `session.setActiveSession` leaves the counts
 * untouched. The route is `full`: a connection without it never sends, and it waits while the grant is
 * unknown (`mayIssue`). `capabilities` is a parameter because the caller provides the capability context.
 */
export function useActiveSessionOnHost(
  transport: BrowserBridgeTransport,
  activeSessionId: string | null | undefined,
  capabilities: CapabilityQuery,
  onTabCounts: (sessionId: string, nexus: number, total: number) => void,
): void {
  const canSetActive = mayIssue(capabilities, 'session', 'setActiveSession')

  useEffect(() => {
    if (!activeSessionId || !canSetActive) return
    let cancelled = false
    void setSessionActive(transport, activeSessionId)
      .then(result => {
        if (cancelled) return
        onTabCounts(activeSessionId, result.nexusTabCount, result.totalTabCount)
      })
      .catch(() => {
        /* see above */
      })
    return () => {
      cancelled = true
    }
  }, [transport, activeSessionId, canSetActive, onTabCounts])
}
