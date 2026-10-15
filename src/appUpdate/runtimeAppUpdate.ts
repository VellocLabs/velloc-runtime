/**
 * Builds and starts the realm's update service when this runtime may update
 * the client (F-30): served from an official channel origin, on a Windows
 * host that serves every primitive the service uses.
 */
import { currentUpdateChannel } from '../branding/updateChannels'
import type { BrowserHostManifest } from '../browser/bridge/protocol/manifest'
import type { BrowserBridgeTransport } from '../browser/bridge/protocol/core'
import { configureAppUpdateService, currentAppUpdateService } from './appUpdateHolder'
import { AppUpdateService } from './AppUpdateService'
import { APP_UPDATE_PRIMITIVES, createBridgeAppUpdateHost } from './bridgeAppUpdateHost'
import { UPDATE_MANIFEST_URLS } from './updateManifest'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'

export type RuntimeAppUpdateDeps = {
  transport: () => BrowserBridgeTransport | null
  manifest: () => Pick<BrowserHostManifest, 'capabilities' | 'primitives'> | null
  createRequestId: () => string
  /** Default: the realm's origin. */
  channel?: () => 'stable' | 'beta' | null
}

let starting: Promise<string | null> | null = null

/**
 * Why the service was not started, or null when it runs. Calls made while a
 * start is in flight share it, so the realm never holds two services.
 */
export function installRuntimeAppUpdate(deps: RuntimeAppUpdateDeps): Promise<string | null> {
  if (currentAppUpdateService()) return Promise.resolve(null)
  if (!starting) {
    starting = startAppUpdate(deps).finally(() => {
      starting = null
    })
  }
  return starting
}

async function startAppUpdate(deps: RuntimeAppUpdateDeps): Promise<string | null> {
  const channel = (deps.channel ?? currentUpdateChannel)()
  if (!channel) return 'not served from an official channel'
  const primitives = deps.manifest()?.primitives ?? []
  const missing = APP_UPDATE_PRIMITIVES.filter(name => !primitives.includes(name))
  if (missing.length > 0) return `host lacks ${missing.join(', ')}`
  const transport = deps.transport()
  if (!transport) return 'the host port is not attached'
  const response = (await transport.request({
    id: deps.createRequestId(),
    route: createBridgeRoute('appInfo', 'getVersionInfo'),
    payload: {},
  })) as { ok: boolean; result?: { osName?: string } }
  if (!response.ok || !response.result?.osName?.startsWith('Windows')) return 'not a Windows host'

  const service = new AppUpdateService({
    host: createBridgeAppUpdateHost(deps),
    manifestUrl: UPDATE_MANIFEST_URLS[channel],
  })
  configureAppUpdateService(service)
  service.start()
  return null
}
