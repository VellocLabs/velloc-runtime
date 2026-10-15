import { runtimeSharedWorkerName } from '../../branding/updateChannels'

/**
 * Canonical factory for the runtime SharedWorker. The boot path and the early warm-up script must get
 * the same instance, so keep the URL specifier and name identical. The name carries the page's off-channel
 * template preview (`#channel=…`, dev servers only), which the worker cannot read from the query string.
 */
export function createBrowserRuntimeSharedWorker(): SharedWorker {
  return new SharedWorker(
    new URL('../worker/agentRuntime.sharedworker.ts', import.meta.url),
    {
      type: 'module',
      name: runtimeSharedWorkerName(),
    },
  )
}
