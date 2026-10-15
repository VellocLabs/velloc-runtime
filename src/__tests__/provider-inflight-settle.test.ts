import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The per-provider in-flight maps (usage, model listing) must forget a task
 * once it settles — including one that fails before its first `await`, where
 * a clear inside the task ran ahead of the `inFlight.set` and left a finished
 * task registered as "running", so every later refresh returned it.
 * `providerDocuments` is mocked to throw synchronously to force that order.
 */
const docs = vi.hoisted(() => ({
  usage: vi.fn(),
  list: vi.fn(),
}))
vi.mock('../models/drivers/providerDocuments', async importOriginal => ({
  ...(await importOriginal<typeof import('../models/drivers/providerDocuments')>()),
  reportsUsage: () => true,
  fetchProviderUsage: docs.usage,
  listProviderModels: docs.list,
}))

import { refreshProviderUsage, resetProviderUsage } from '../models/drivers/providerUsageService'
import { refreshRuntimeProviderModels, resetRuntimeProviders } from '../models/drivers/runtimeProviders'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'

const transport = {} as BrowserBridgeTransport

afterEach(() => {
  resetProviderUsage()
  resetRuntimeProviders()
  vi.clearAllMocks()
})

describe('provider in-flight tasks settle out of the map', () => {
  it('usage: a synchronous failure does not pin the next refresh', async () => {
    docs.usage.mockImplementationOnce(() => { throw new Error('boom') })
    expect(await refreshProviderUsage(transport, 'openrouter', { force: true, now: 1 }))
      .toMatchObject({ error: 'boom' })
    docs.usage.mockResolvedValueOnce(undefined)
    expect(await refreshProviderUsage(transport, 'openrouter', { force: true, now: 2 }))
      .toEqual({ checkedAt: 2 })
    expect(docs.usage).toHaveBeenCalledTimes(2)
  })

  it('model listing: a synchronous failure does not pin the next refresh', async () => {
    docs.list.mockImplementationOnce(() => { throw new Error('boom') })
    expect(await refreshRuntimeProviderModels(transport, 'openrouter', { force: true, now: 1 }))
      .toEqual({ ok: false, error: 'boom' })
    docs.list.mockRejectedValueOnce(new Error('second'))
    expect(await refreshRuntimeProviderModels(transport, 'openrouter', { force: true, now: 2 }))
      .toEqual({ ok: false, error: 'second' })
    expect(docs.list).toHaveBeenCalledTimes(2)
  })
})
