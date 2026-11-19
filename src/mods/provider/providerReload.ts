/**
 * A provider mod asked again for what it shows (F-27): its model listing,
 * through the runtime's ordinary forced listing path (a failure keeps the rows
 * already shown), and its status view, read again from its store.
 */

import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import { isProviderSetUp, publishListingsChanged, refreshRuntimeProviderModels } from '../../models/drivers/runtimeProviders'
import { refreshProviderStatus } from './providerStatusService'

/** Never rejects; a failed listing is reported. */
export async function reloadModProvider(
  providerId: string,
  transport: () => BrowserBridgeTransport | null,
  report: (line: string) => void,
): Promise<void> {
  const host = transport()
  if (host && isProviderSetUp(providerId)) {
    try {
      const listed = await refreshRuntimeProviderModels(host, providerId, { force: true })
      if (listed.ok) await publishListingsChanged([providerId])
    } catch (error) {
      report(`${providerId}: its models could not be listed again: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    await refreshProviderStatus(providerId)
  } catch (error) {
    report(`${providerId}: its status could not be read again: ${error instanceof Error ? error.message : String(error)}`)
  }
}
