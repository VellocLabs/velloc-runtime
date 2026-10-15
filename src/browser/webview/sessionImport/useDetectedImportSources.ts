import { useEffect, useState } from 'react'

import { createBridgeRoute } from '../../bridge/protocol/core'
import type { DetectedImportSource } from '../../bridge/protocol/sessionImport'
import type { NexusSettingsBridge } from '../nexusSettingsBridge'
import { mayIssue, type CapabilityQuery } from '../useCan'

const NO_SOURCES: DetectedImportSource[] = []

/**
 * Session import: which agent products keep transcripts on this machine; probed once
 * per bridge. Security: `sessionImport.detect` is `full` — a connection without it,
 * or whose grant is still unknown (`mayIssue`), never sends the probe.
 */
export function useDetectedImportSources(
  settingsBridge: NexusSettingsBridge | undefined,
  capabilities: CapabilityQuery,
): DetectedImportSource[] {
  const canDetect = mayIssue(capabilities, 'sessionImport', 'detect')
  const [sources, setSources] = useState<DetectedImportSource[]>(NO_SOURCES)

  useEffect(() => {
    if (!settingsBridge || !canDetect) return
    let cancelled = false
    settingsBridge
      .request(createBridgeRoute('sessionImport', 'detect'), {})
      .then(result => {
        if (!cancelled) setSources(result.sources)
      })
      .catch(() => {
        // An older worker without the capability, or a mock host: no button.
        if (!cancelled) setSources(NO_SOURCES)
      })
    return () => {
      cancelled = true
    }
  }, [settingsBridge, canDetect])

  // A reconnect that comes back without the action drops the buttons too.
  return canDetect ? sources : NO_SOURCES
}
