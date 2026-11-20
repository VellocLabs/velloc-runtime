/**
 * A chat run on a router that lists no route yet (F-27): nothing is sent, the
 * router is not asked, and the conversation names why — no listing yet, or a
 * failed one — through its own issue card.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { withModelProviders } from '../models/drivers/driverTransport'
import { registerProviderRouter, resetProviderRouters } from '../models/drivers/providerRouter'
import {
  refreshRuntimeProviderModels,
  resetRuntimeProviders,
  routerRoutesProblem,
  setRuntimeProviderConfigs,
} from '../models/drivers/runtimeProviders'
import {
  registerModProviderDefinition,
  resetModProviderDefinitions,
} from '../config/nexusModelConfig/providers'
import type { ProviderDefinition } from '../config/nexusModelConfig/providerDefinition'
import { classifyProviderConnectivityIssue } from '../utils/providerConnectivity'
import { en } from '../browser/webview/i18n/messages/en'

const ROUTER = 'mod.switch.router'

function defineRouter(): void {
  registerModProviderDefinition({
    config: { providerId: ROUTER, models: [] },
    runtimeOnly: true,
    router: true,
    label: 'Switch',
    catalogMod: { state: 'ready', plugin: 'switch', configId: 'switch@inline', kind: 'router', routesTo: '*', credentialMethods: ['anonymous'] },
  } as unknown as ProviderDefinition)
  setRuntimeProviderConfigs({ [ROUTER]: { source: 'mod', credentialMode: 'anonymous' } } as never)
}

function deadHost() {
  const request = vi.fn(async () => {
    throw new Error('host down')
  })
  return { transport: { request, subscribeEvents: () => () => {} } as unknown as BrowserBridgeTransport, request }
}

async function startOn(transport: BrowserBridgeTransport): Promise<string> {
  try {
    const answer = await withModelProviders(transport).request({
      id: 'r-1',
      route: { capability: 'model', action: 'streamStart' },
      payload: { providerId: ROUTER, model: 'route-1', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 100 },
    } as never) as { ok?: boolean; error?: { message?: string } }
    return answer.error?.message ?? JSON.stringify(answer)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

afterEach(() => {
  resetProviderRouters()
  resetRuntimeProviders()
  resetModProviderDefinitions()
})

describe('a run on a router with no listed route', () => {
  it('before its first listing: refused unsent, the router never asked, read as "no routes yet"', async () => {
    defineRouter()
    const route = vi.fn(async () => undefined)
    registerProviderRouter(ROUTER, { route }, { routesTo: '*' })
    const { transport, request } = deadHost()

    const message = await startOn(transport)

    expect(routerRoutesProblem(ROUTER)).toBe('unlisted')
    expect(message).toContain('router_unlisted:')
    expect(route).not.toHaveBeenCalled()
    expect(request.mock.calls.some(([req]: any) => req?.route?.action === 'rawStreamOpen')).toBe(false)
    expect(classifyProviderConnectivityIssue(message)).toMatchObject({
      kind: 'configuration',
      titleKey: 'providerIssue.routerUnlisted.title',
      summaryKey: 'providerIssue.routerUnlisted.summary',
      retryable: false,
      settingsRecommended: true,
    })
  })

  it('after a failed listing: read as "could not list its routes"', async () => {
    defineRouter()
    registerProviderRouter(ROUTER, { route: async () => undefined }, { routesTo: '*' })
    const { transport } = deadHost()
    const outcome = await refreshRuntimeProviderModels(transport, ROUTER, { force: true })
    expect(outcome.ok).toBe(false)

    const message = await startOn(transport)

    expect(routerRoutesProblem(ROUTER)).toBe('listing_failed')
    expect(message).toContain('router_listing_failed:')
    expect(classifyProviderConnectivityIssue(message)).toMatchObject({
      titleKey: 'providerIssue.routerListingFailed.title',
      summaryKey: 'providerIssue.routerListingFailed.summary',
      settingsRecommended: true,
    })
  })

  it('names both reasons in English', () => {
    for (const key of [
      'providerIssue.routerUnlisted.title',
      'providerIssue.routerUnlisted.summary',
      'providerIssue.routerListingFailed.title',
      'providerIssue.routerListingFailed.summary',
    ] as const) expect(en[key]).toBeTruthy()
  })
})
