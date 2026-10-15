import { describe, expect, it } from 'vitest'
import { createBundledCatalog } from 'virtual:bundled-template-catalog'
import { createBundledRegistry } from 'virtual:bundled-template-registry'

import {
  BUNDLED_CATALOG_VIRTUAL_ID,
  BUNDLED_TEMPLATE_VIRTUAL_ID,
  bundledTemplateRegistryPlugin,
} from '../../vite/bundledTemplateRegistryPlugin'

/**
 * The bundled template data is served as two modules: the catalog (launchers
 * and welcome pages — what the page renders) and the registry (everything,
 * including the template bodies the runtime assembles prompts from). The
 * catalog must stay free of the bodies; the registry must agree with it.
 */

function loadVirtual(id: string): string {
  const plugin = bundledTemplateRegistryPlugin()
  const resolveId = plugin.resolveId as (id: string) => string | undefined
  const load = plugin.load as (this: { addWatchFile(file: string): void }, id: string) => string
  const resolved = resolveId(id)
  expect(resolved).toBeDefined()
  return load.call({ addWatchFile: () => {} }, resolved as string)
}

describe('bundled template catalog', () => {
  it('matches the registry on launchers and welcome pages', () => {
    const catalog = createBundledCatalog()
    const registry = createBundledRegistry()
    expect(catalog.launcherCatalog.length).toBeGreaterThan(0)
    expect(catalog.welcomeByType.size).toBeGreaterThan(0)
    expect(registry.launcherCatalog).toEqual(catalog.launcherCatalog)
    expect([...registry.launcherByType]).toEqual([...catalog.launcherByType])
    expect(registry.betaLauncherCatalog).toEqual(catalog.betaLauncherCatalog)
    expect([...registry.welcomeByType].map(([type, byLocale]) => [type, [...byLocale]]))
      .toEqual([...catalog.welcomeByType].map(([type, byLocale]) => [type, [...byLocale]]))
  })

  it('keys launchers by type over the catalog entries', () => {
    const { launcherCatalog, launcherByType } = createBundledCatalog()
    for (const meta of launcherCatalog) {
      expect(launcherByType.get(meta.type)).toBe(launcherCatalog.findLast(m => m.type === meta.type))
    }
  })

  it('returns fresh data on each call', () => {
    const a = createBundledCatalog()
    const b = createBundledCatalog()
    expect(a.launcherCatalog).not.toBe(b.launcherCatalog)
    expect(a.welcomeByType).not.toBe(b.welcomeByType)
  })

  it('carries no template body or holder text', () => {
    const catalogSource = loadVirtual(BUNDLED_CATALOG_VIRTUAL_ID)
    const registry = createBundledRegistry()
    const holderTexts = [
      ...registry.sharedHolders,
      ...[...registry.typeHolders.values()].flat(),
    ]
      .map(holder => holder.content.trim())
      .filter(text => text.length >= 80)
    expect(holderTexts.length).toBeGreaterThan(0)
    for (const text of holderTexts) {
      expect(catalogSource).not.toContain(JSON.stringify(text.slice(0, 80)).slice(1, -1))
    }
    expect(catalogSource).not.toContain('sharedHolders:')
    expect(catalogSource).not.toContain('templates: new Map')
  })

  it('builds the registry module on the catalog module', () => {
    const registrySource = loadVirtual(BUNDLED_TEMPLATE_VIRTUAL_ID)
    expect(registrySource).toContain(`from ${JSON.stringify(BUNDLED_CATALOG_VIRTUAL_ID)}`)
    expect(registrySource.length).toBeGreaterThan(loadVirtual(BUNDLED_CATALOG_VIRTUAL_ID).length)
  })
})
