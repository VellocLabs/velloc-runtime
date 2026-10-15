/**
 * Provider mods (PM-9a) — swapping ONE plugin to another version in the host:
 * the others stay put, no worker starts, a disabled plugin stays unregistered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import type { ActivePlugin } from '../pluginHost/pluginModel'
import { resolveProviders } from '../mods/provider/providerManifest'
import { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import { ProviderModHost, type ProviderPluginFacts } from '../mods/provider/providerModHost'
import { resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { configureRuntimeProviders, resetRuntimeProviders } from '../models/drivers/runtimeProviders'
import { resetCustomProviderRecords } from '../config/customProviderRegistry'
import { providerJson } from './_helpers/pluginArchive'

function plugin(name: string, version: string, dir = `/p/${name}-${version}`): ProviderPluginFacts & ActivePlugin {
  const { manifest, errors } = checkPluginDescriptor({ name, version, providers: { main: providerJson() } })
  expect(errors).toEqual([])
  return {
    name,
    manifest: manifest!,
    path: dir,
    source: `marketplace:${name}@direct`,
    enabled: true,
    providers: resolveProviders(name, dir, manifest!.providers!),
    installIdentifier: `${name}@direct`,
  }
}

const hosts: ProviderModHost[] = []

function rig() {
  const openWorker = vi.fn(async () => {
    throw new Error('a worker must not start')
  })
  const runtime = new ProviderModRuntime({
    readModule: async () => '',
    openWorker,
    report: () => {},
    window: { available: () => true, attached: async () => {} },
  })
  const host = new ProviderModHost()
  host.configure({
    createRuntime: async () => runtime,
    readText: async () => '',
    report: () => {},
    adopt: async () => {},
    publish: async () => {},
    hasStoredConfigs: () => false,
  })
  hosts.push(host)
  return { host, runtime, openWorker }
}

beforeEach(() => {
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
})

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose()
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
  configureRuntimeProviders(undefined)
})

describe('ProviderModHost.swapPlugin', () => {
  it('registers the new version of one plugin and leaves the others alone', async () => {
    const { host, runtime, openWorker } = rig()
    await host.sync({ enabled: [plugin('acme', '1.0.0'), plugin('beta', '1.0.0')], disabled: [] })
    const betaBefore = runtime.status().find(m => m.plugin === 'beta')!
    expect(host.registeredVersion('acme')).toBe('1.0.0')

    const result = await host.swapPlugin(plugin('acme', '2.0.0'))

    expect(result.registered).toEqual(['mod.acme.main'])
    expect(result.removed).toEqual([])
    expect(host.registeredVersion('acme')).toBe('2.0.0')
    expect(host.registeredVersion('beta')).toBe('1.0.0')
    const status = runtime.status()
    expect(status.find(m => m.plugin === 'acme')!.path).toContain('acme-2.0.0')
    expect(status.find(m => m.plugin === 'beta')).toEqual(betaBefore)
    // The module is read at its next call; swapping starts nothing.
    expect(openWorker).not.toHaveBeenCalled()
    expect(host.registered().map(r => r.providerId).sort()).toEqual(['mod.acme.main', 'mod.beta.main'])
  })

  it('swapping to what is already registered does nothing (no churn)', async () => {
    const { host } = rig()
    await host.sync({ enabled: [plugin('acme', '1.0.0')], disabled: [] })
    expect(await host.swapPlugin(plugin('acme', '1.0.0'))).toMatchObject({ registered: [], removed: [], published: false })
  })

  it('a later full sync agrees with the swap (the scan is kept)', async () => {
    const { host } = rig()
    await host.sync({ enabled: [plugin('acme', '1.0.0'), plugin('beta', '1.0.0')], disabled: [] })
    await host.swapPlugin(plugin('acme', '2.0.0'))
    const again = await host.sync({ enabled: [plugin('acme', '2.0.0'), plugin('beta', '1.0.0')], disabled: [] })
    expect(again).toMatchObject({ registered: [], removed: [] })
  })

  it('a disabled plugin stays unregistered', async () => {
    const { host, runtime } = rig()
    await host.sync({ enabled: [], disabled: [plugin('acme', '1.0.0')] })
    const result = await host.swapPlugin(plugin('acme', '2.0.0'))
    expect(result.registered).toEqual([])
    expect(runtime.owns('mod.acme.main')).toBe(false)
    expect(host.registeredVersion('acme')).toBeUndefined()
  })

  it('rejects when the host is not configured', async () => {
    const host = new ProviderModHost()
    await expect(host.swapPlugin(plugin('acme', '1.0.0'))).rejects.toThrow(/not configured/)
  })
})
