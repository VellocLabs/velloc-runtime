/**
 * Security: the update service's production wiring. `fetch` is https-only
 * (`downloadHttps` also checks size limits and every redirect); `admit` reads,
 * compiles and scans a staged version with the runtime's own admission, so a version
 * the runtime would refuse is refused at update time and the old one keeps running.
 */

import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import { createBridgeBackedFetch } from '../../pluginHost/bridgeBackedFetch'
import { assertHttpsUrl } from '../../pluginHost/httpsSource'
import { createProviderModUpdateService, type ProviderModUpdateService } from '../../pluginHost/providerModUpdates'
import type { ActivePlugin } from '../../pluginHost/pluginModel'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { admitProviderModule } from './ProviderModRuntime'
import { providerModuleRefs } from './providerModHost'
import { providerModuleLoaders } from './providerModuleLoaders'

export type ProviderModUpdateWiringDeps = {
  homeDir: string
  fs: RuntimeFs
  /** The host transport, asked at each request: it is replaced when a window reattaches. */
  transport: () => BrowserBridgeTransport | null | undefined
  report: (line: string) => void
  /** Called after a consent baseline was recorded (the host re-reads the plugins). */
  afterConsent?: () => Promise<void>
}

let requestSeq = 0

/** A `fetch` through the host that refuses any request that is not https. */
export function httpsOnlyBridgeFetch(transport: ProviderModUpdateWiringDeps['transport']): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    assertHttpsUrl(url)
    const bridge = transport()
    if (!bridge) throw new Error('no host connection to fetch an update through')
    const inner = createBridgeBackedFetch({
      transport: bridge,
      createRequestId: () => `provider-update-${Date.now().toString(36)}-${(requestSeq += 1)}`,
    })
    return inner(input, init)
  }) as typeof fetch
}

/** Admission of a staged version: each provider module, exactly as the runtime would load it. */
export function createProviderModAdmit(deps: Pick<ProviderModUpdateWiringDeps, 'homeDir' | 'fs' | 'report'>) {
  const loaders = providerModuleLoaders(deps)
  return async (plugin: ActivePlugin): Promise<void> => {
    for (const ref of providerModuleRefs(plugin)) await admitProviderModule(ref, loaders)
  }
}

export function createProductionUpdateService(deps: ProviderModUpdateWiringDeps): ProviderModUpdateService {
  return createProviderModUpdateService({
    ctx: { homeDir: deps.homeDir },
    fs: deps.fs,
    fetchImpl: httpsOnlyBridgeFetch(deps.transport),
    admit: createProviderModAdmit(deps),
    report: line => deps.report(`updates: ${line}`),
    ...(deps.afterConsent ? { afterConsent: deps.afterConsent } : {}),
  })
}
