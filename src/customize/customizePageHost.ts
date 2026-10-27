/**
 * The Customize page's host calls over the runtime's own port (F-35): the
 * `ui` utility-tab actions, the native `pageScript` primitive, and
 * `webWindow.open` (else `ui.openUrl`) for pages off the directory's site. One host
 * object per transport, so the service can tell a replaced port.
 */
import type { BrowserBridgeTransport, BrowserHostManifest } from '../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import { createNativePrimitives } from '../browser/bridge/nativePrimitives'
import type { CustomizePageHost } from './CustomizePageService'

export type CustomizePageHostSourceOptions = {
  getTransport: () => BrowserBridgeTransport | null
  getManifest: () => Pick<BrowserHostManifest, 'capabilities' | 'primitives'> | undefined
  createRequestId: () => string
}

export function createCustomizePageHostSource(options: CustomizePageHostSourceOptions): () => CustomizePageHost | null {
  let cached: { transport: BrowserBridgeTransport; host: CustomizePageHost } | null = null
  return () => {
    const transport = options.getTransport()
    if (!transport) return null
    if (cached?.transport === transport) return cached.host
    const manifest = options.getManifest()
    const request = async (action: 'openUtilityTab' | 'navigateUtilityTab' | 'openUrl', payload: Record<string, unknown>) => {
      const response = (await transport.request({
        id: options.createRequestId(),
        route: createBridgeRoute('ui', action),
        payload,
      } as Parameters<BrowserBridgeTransport['request']>[0])) as
        | { ok: true; result: unknown }
        | { ok: false; error: { code: string; message: string } }
      if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      return response.result
    }
    const servesPageScript = !manifest || manifest.capabilities.includes('pageScript')
    const servesWebWindow = !!manifest?.capabilities.includes('webWindow')
    const primitives = createNativePrimitives({ transport, createRequestId: options.createRequestId, manifest })
    const host: CustomizePageHost = {
      openUtilityTab: async (key, url) =>
        (await request('openUtilityTab', { key, url })) as { tabId: number; created: boolean },
      navigateUtilityTab: async (tabId, url) => {
        await request('navigateUtilityTab', { tabId, url })
      },
      pageScript: servesPageScript && transport.subscribeEvents ? primitives.pageScript : null,
      openWindow: servesWebWindow
        ? async url => {
            await primitives.webWindow.open(url)
          }
        : null,
      openUrl: async url => {
        await request('openUrl', { url })
      },
    }
    cached = { transport, host }
    return host
  }
}
