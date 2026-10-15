import { useEffect, useState } from 'react'

import type { ProviderMissingPrompt } from '../bridge/browserBridgeProtocol'
import type { AgentRuntimeWorkerSnapshot } from '../worker/workerProtocol'
import { useCan } from './useCan'

/**
 * The host's strings for the provider-missing dialog, prefetched while the active session has no usable
 * provider; `null` until they arrive. `ui.getProviderMissingPrompt` is `full`: a connection without it
 * never reads, and the dialog uses its catalog strings. A failed read is retried on the next `snapshot`.
 */
export function useProviderMissingPrompt(
  load: (() => Promise<ProviderMissingPrompt>) | undefined,
  snapshot: AgentRuntimeWorkerSnapshot | null,
  hasValidProvider: boolean,
): ProviderMissingPrompt | null {
  const canLoad = useCan('ui', 'getProviderMissingPrompt')
  const [resources, setResources] = useState<ProviderMissingPrompt | null>(null)

  useEffect(() => {
    if (!load || !canLoad) return
    if (!snapshot) return
    if (hasValidProvider) return
    if (resources) return

    let cancelled = false
    load()
      .then(loaded => {
        if (!cancelled) setResources(loaded)
      })
      .catch(error => {
        console.warn('Failed to load provider-missing prompt:', error)
      })
    return () => {
      cancelled = true
    }
  }, [canLoad, hasValidProvider, load, resources, snapshot])

  return resources
}
