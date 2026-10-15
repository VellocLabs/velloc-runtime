import type { BrowserBridgeTransport } from '../bridge/protocol/core'
import { createBridgeRoute } from '../bridge/protocol/core'
import { publishBrokerProviderBaseUrls } from '../../models/endpoints/endpointTrust'

/**
 * Re-read the broker's provider registry (`providerAuth.list`) and publish
 * the base URL it holds per provider — the runtime's view of the providers
 * configured OUTSIDE settings.json (launch prefs, the legacy settings path),
 * which `resolveDocumentInputMode` reads alongside settings.json. Called at
 * worker boot and after every providers write reaches the broker.
 * Best-effort: a failed read keeps the previous view.
 */
export async function refreshBrokerProviderBaseUrls(
  transport: BrowserBridgeTransport,
  requestId: string,
): Promise<void> {
  try {
    const res = await transport.request({
      id: requestId,
      route: createBridgeRoute('providerAuth', 'list'),
      payload: {},
    })
    if (res.ok) {
      publishBrokerProviderBaseUrls(res.result.providers ?? [])
    }
  } catch {
    // Keep the previous view; the next providers write retries.
  }
}
