/**
 * Provider mods — a registered provider is plugged into the request seam, and
 * one whose request hooks cannot be attached fails closed instead of sending
 * its requests untransformed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  providerRequestSeamFor,
  resetProviderRequestSeams,
  type ProviderRequestEvent,
} from '../models/drivers/providerRequestSeam'
import type { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import type { ProviderRegistration } from '../mods/provider/providerModHost'
import type { ProviderManifest } from '../mods/provider/providerManifest'
import { providerSeamListener, seamForRegistration } from '../mods/provider/providerSeamWiring'

afterEach(() => resetProviderRequestSeams())

function fakeRuntime(hooks: boolean | undefined = true) {
  const calls: Array<{ providerId: string; event: string }> = []
  const runtime = {
    hasHook: () => hooks,
    whenLoaded: async () => {},
    call: async (providerId: string, event: string) => {
      calls.push({ providerId, event })
      return { raised: true as const, value: { headers: { 'x-vendor': '1' } } }
    },
  } as unknown as ProviderModRuntime
  return { runtime, calls }
}

function registration(
  runtime: ProviderModRuntime,
  manifest: Partial<ProviderManifest> = {},
): ProviderRegistration {
  return {
    providerId: 'mod.acme.zen',
    plugin: 'acme',
    manifest: manifest as ProviderManifest,
    runtime,
  }
}

const EVENT = {
  provider: 'mod.acme.zen',
  model: 'm',
  format: 'openai-chat',
  method: 'POST',
  url: 'https://api.acme.test/v1/chat',
  headers: {},
  context: { purpose: 'turn', querySource: 'sdk', requestId: 'r', attempt: 1, nowMs: 0 },
} as unknown as ProviderRequestEvent

describe('seamForRegistration', () => {
  it('hands the manifest needs to the adapter, and a `digest` sign need is no need', () => {
    const { runtime } = fakeRuntime()
    const seam = seamForRegistration(
      registration(runtime, { requestNeeds: ['system'], signNeeds: 'digest' }),
      () => {},
    )
    expect(seam.requestNeeds).toEqual(['system'])
    expect(seam.signNeeds).toBeUndefined()
    const withBody = seamForRegistration(registration(runtime, { signNeeds: 'body' }), () => {})
    expect(withBody.signNeeds).toBe('body')
  })

  it('raises the module\'s request hook through the runtime', async () => {
    const { runtime, calls } = fakeRuntime()
    const seam = seamForRegistration(registration(runtime), () => {})
    await expect(seam.request!(EVENT)).resolves.toEqual({ headers: { 'x-vendor': '1' } })
    expect(calls).toEqual([{ providerId: 'mod.acme.zen', event: 'provider.request' }])
  })

  it('a declaration the adapter refuses leaves a seam whose request always fails', async () => {
    const { runtime } = fakeRuntime()
    const report = vi.fn()
    const seam = seamForRegistration(
      registration(runtime, { requestNeeds: ['everything'] as unknown as ProviderManifest['requestNeeds'] }),
      report,
    )
    expect(report).toHaveBeenCalledOnce()
    expect(String(report.mock.calls[0]![0])).toContain('its requests will fail')
    expect(() => seam.request!(EVENT)).toThrow(/could not be attached/)
    expect(seam.sign).toBeUndefined()
    expect(seam.retry).toBeUndefined()
  })
})

describe('providerSeamListener', () => {
  it('plugs the seam in for the provider and takes it out again', () => {
    const { runtime } = fakeRuntime()
    const cleanup = providerSeamListener(() => {})(registration(runtime))
    expect(providerRequestSeamFor('mod.acme.zen')).toBeDefined()
    expect(typeof cleanup).toBe('function')
    ;(cleanup as () => void)()
    expect(providerRequestSeamFor('mod.acme.zen')).toBeUndefined()
  })

  it('a failing seam is still a seam: the provider is not left unhooked', () => {
    const { runtime } = fakeRuntime()
    providerSeamListener(() => {})(
      registration(runtime, { requestNeeds: ['bogus'] as unknown as ProviderManifest['requestNeeds'] }),
    )
    const seam = providerRequestSeamFor('mod.acme.zen')!
    expect(seam).toBeDefined()
    expect(() => seam.request!(EVENT)).toThrow()
  })
})
