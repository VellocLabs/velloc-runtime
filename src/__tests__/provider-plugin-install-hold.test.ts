/**
 * Provider mods (PM-9b) - a plugin that adds model providers is installed OFF
 * (an explicit `false` override) so it cannot run before the person has seen
 * its grant; a plugin without providers installs exactly as before. Both
 * install paths: the https source and a marketplace listing.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { getEnabledPluginsMap } from '../pluginHost/enabledPlugins'
import { installFromHttps } from '../pluginHost/httpsSource'
import { forgetRegistryFile } from '../pluginHost/installedRegistry'
import { setupPlugin } from '../pluginHost/installSteps'
import { addMarketplace, forgetCatalogs } from '../pluginHost/marketplaces'
import { consentCovers, manifestDeclaresProviders, readConsentedPluginIds } from '../pluginHost/providerPluginConsent'
import { createProviderModUpdateService } from '../pluginHost/providerModUpdates'
import { wipeSettingsMemos } from '../settings/settingsStore'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { archive, pluginArchive, providerJson, servedFetch, type Served } from './_helpers/pluginArchive'
import { makeMemFs } from './_helpers/memFs'

const ctx = { homeDir: '/home/u' }
const URL_A = 'https://plugins.acme.test/acme.tar.gz'

beforeEach(() => {
  forgetRegistryFile()
  forgetCatalogs()
  wipeSettingsMemos()
})

const enabled = (fs: RuntimeFs) => getEnabledPluginsMap(ctx, fs)

describe('install leaves a provider plugin disabled', () => {
  it('https: a plugin with providers gets an explicit false; one without gets nothing', async () => {
    const fs = makeMemFs() as unknown as RuntimeFs
    const served = new Map<string, Served>()
    const fetchImpl = servedFetch(served)
    served.set(URL_A, { body: await pluginArchive({ version: '1.0.0' }) })
    await installFromHttps(ctx, fs, { url: URL_A }, { fetchImpl })
    expect(await enabled(fs)).toEqual({ 'acme@direct': false })

    served.set('https://plugins.acme.test/plain.tar.gz', {
      body: await archive([{ name: '.claude-plugin/plugin.json', content: JSON.stringify({ name: 'plain', version: '1.0.0' }) }]),
    })
    await installFromHttps(ctx, fs, { url: 'https://plugins.acme.test/plain.tar.gz' }, { fetchImpl })
    expect(await enabled(fs)).toEqual({ 'acme@direct': false })
  })

  it('marketplace: the same, through setupPlugin', async () => {
    const fs = makeMemFs() as unknown as RuntimeFs
    const served = new Map<string, Served>()
    const fetchImpl = servedFetch(served)
    const MKT_URL = 'https://codeload.github.com/me/mkt/tar.gz/refs/heads/main'
    await addMarketplace(ctx, fs, 'mkt', { source: 'github', repo: 'me/mkt' }, '2026-10-09T00:00:00.000Z')
    const listing = (plugins: unknown[]) =>
      archive([{ name: '.claude-plugin/marketplace.json', content: JSON.stringify({ name: 'mkt', plugins }) }], 'me-mkt-abc')
    served.set(MKT_URL, {
      body: await listing([
        { name: 'acme', version: '1.0.0', source: { source: 'https', url: 'https://plugins.acme.test/a.tar.gz' } },
        { name: 'plain', version: '1.0.0', source: { source: 'https', url: 'https://plugins.acme.test/p.tar.gz' } },
      ]),
    })
    served.set('https://plugins.acme.test/a.tar.gz', { body: await pluginArchive({ version: '1.0.0' }) })
    served.set('https://plugins.acme.test/p.tar.gz', {
      body: await archive([{ name: '.claude-plugin/plugin.json', content: JSON.stringify({ name: 'plain', version: '1.0.0' }) }]),
    })
    await setupPlugin(ctx, fs, 'mkt', 'plain', { fetchImpl, refreshFirst: true })
    expect(await enabled(fs)).toEqual({})
    await setupPlugin(ctx, fs, 'mkt', 'acme', { fetchImpl })
    expect(await enabled(fs)).toEqual({ 'acme@mkt': false })
  })

  it('installing again a plugin the person approved keeps it on', async () => {
    const fs = makeMemFs() as unknown as RuntimeFs
    const served = new Map<string, Served>()
    const fetchImpl = servedFetch(served)
    served.set(URL_A, { body: await pluginArchive({ version: '1.0.0', providers: { main: providerJson({ updates: { url: URL_A } }) } }) })
    await installFromHttps(ctx, fs, { url: URL_A }, { fetchImpl })
    const service = createProviderModUpdateService({ ctx, fs, fetchImpl })
    await service.recordInitialConsent('acme@direct')
    expect((await readConsentedPluginIds(ctx, fs)).has('acme@direct')).toBe(true)
    // The person turned it on; a reinstall does not turn it off again.
    const { setPluginEnabled } = await import('../pluginHost/enabledPlugins')
    await setPluginEnabled(ctx, fs, 'acme@direct', true)
    await installFromHttps(ctx, fs, { url: URL_A }, { fetchImpl })
    expect(await enabled(fs)).toEqual({ 'acme@direct': true })
  })

  it('installing again a version that asks for more than was approved turns it off, and its consent no longer covers it', async () => {
    const fs = makeMemFs() as unknown as RuntimeFs
    const served = new Map<string, Served>()
    const fetchImpl = servedFetch(served)
    const v1 = providerJson({ updates: { url: URL_A } })
    served.set(URL_A, { body: await pluginArchive({ version: '1.0.0', providers: { main: v1 } }) })
    await installFromHttps(ctx, fs, { url: URL_A }, { fetchImpl })
    await createProviderModUpdateService({ ctx, fs, fetchImpl }).recordInitialConsent('acme@direct')
    const { setPluginEnabled } = await import('../pluginHost/enabledPlugins')
    await setPluginEnabled(ctx, fs, 'acme@direct', true)
    expect(await consentCovers(ctx, fs, 'acme@direct', { providers: { main: v1 } })).toBe(true)

    const v2 = providerJson({ updates: { url: URL_A }, domains: ['api.acme.test', 'collector.example'], requestNeeds: ['body'] })
    served.set(URL_A, { body: await pluginArchive({ version: '1.1.0', providers: { main: v2 } }) })
    await installFromHttps(ctx, fs, { url: URL_A }, { fetchImpl })
    expect(await enabled(fs)).toEqual({ 'acme@direct': false })
    expect(await consentCovers(ctx, fs, 'acme@direct', { providers: { main: v2 } })).toBe(false)
    // Narrower than approved is still covered.
    expect(await consentCovers(ctx, fs, 'acme@direct', { providers: {} })).toBe(true)
    expect(await consentCovers(ctx, fs, 'other@direct', { providers: { main: v1 } })).toBe(false)
  })
})

describe('manifestDeclaresProviders', () => {
  it('is true for a non-empty providers object only', () => {
    expect(manifestDeclaresProviders({ providers: { main: {} } })).toBe(true)
    expect(manifestDeclaresProviders({ providers: {} })).toBe(false)
    expect(manifestDeclaresProviders({ providers: [] })).toBe(false)
    expect(manifestDeclaresProviders({})).toBe(false)
    expect(manifestDeclaresProviders(null)).toBe(false)
  })
})

describe('no baseline is invented', () => {
  it('a check of a plugin with no consent on file does nothing; approval then makes it checkable', async () => {
    const fs = makeMemFs()
    const fsStat = {
      ...fs,
      async stat(path: string) {
        const norm = path.replace(/\\/g, '/').replace(/\/+$/, '')
        if (fs.dump().some(key => key === norm || key.startsWith(`${norm}/`))) return {} as never
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      },
    } as unknown as RuntimeFs
    const served = new Map<string, Served>()
    const fetchImpl = servedFetch(served)
    served.set(URL_A, { body: await pluginArchive({ version: '1.0.0', providers: { main: providerJson({ updates: { url: URL_A } }) } }) })
    await installFromHttps(ctx, fsStat, { url: URL_A }, { fetchImpl })
    fetchImpl.calls.length = 0
    let approvedAfter = 0
    const service = createProviderModUpdateService({ ctx, fs: fsStat, fetchImpl, afterConsent: async () => { approvedAfter += 1 } })
    const [before] = await service.checkNow()
    expect(before).toMatchObject({ pluginId: 'acme@direct', consented: false, state: 'unchecked' })
    expect(fetchImpl.calls).toEqual([])
    expect((await readConsentedPluginIds(ctx, fsStat)).size).toBe(0)
    const approved = await service.recordInitialConsent('acme@direct')
    expect(approved.consented).toBe(true)
    expect(approvedAfter).toBe(1)
    const [after] = await service.checkNow()
    expect(after).toMatchObject({ state: 'up-to-date', consented: true })
    expect(fetchImpl.calls).toEqual([URL_A])
  })
})
