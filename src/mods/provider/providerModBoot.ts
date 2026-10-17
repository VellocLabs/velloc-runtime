/**
 * The realm's provider-mod boot and reload entry, kept light. Scans the PERSON's
 * plugins (user directory and marketplace installs, never a project's).
 */

import type { ProviderModUpdateService } from '../../pluginHost/providerModUpdates'
import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import { providerWireBaseUrl } from '../../models/drivers/driverRegistry'
import {
  isProviderSetUp,
  onRuntimeProviderConfigsChanged,
  refreshRuntimeProviderModels,
} from '../../models/drivers/runtimeProviders'
import { runtimeProviderGate } from '../../pluginHost/providerGate'
import { getModUiContributionsHost } from '../ui/contributionsHost'
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import { getEnabledPluginsMap } from '../../pluginHost/enabledPlugins'
import { loadEffectiveEnabledPlugins } from '../../pluginHost/enabledStore'
import { getPluginConfigsMap } from '../../pluginHost/pluginConfigs'
import { gatherPlugins, loadMarketplaceInstallState } from '../../pluginHost/loadPlugins'
import { traceLine } from '../../utils/debugLog'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { ActivePlugin } from '../../pluginHost/pluginModel'
import { providerCodeCalls } from './providerCodeCalls'
import { providerSettingValues } from './nouns/providerSettingsNoun'
import type { ProviderManifest } from './providerManifest'
import {
  acquireProviderModUpdateService,
  configureProviderModUpdates,
  notifyProviderModUpdatesChanged,
} from '../../pluginHost/providerModUpdateHolder'
import { consentCovers } from '../../pluginHost/providerPluginConsent'
import {
  getProviderModHost,
  isGlobalPluginSource,
  onProviderModRegistered,
  type ProviderPluginScan,
} from './providerModHost'

export type ProviderModBootDeps = {
  homeDir: string
  /** An fs that keeps working when the transport is replaced. */
  fs: RuntimeFs
  /** The host transport the listing path fetches through, when there is one. */
  transport?: () => BrowserBridgeTransport | null | undefined
  /** The most recently attached window's locale. A manager with no window
   *  yet has none: `en`. No bridge call is made to find out. */
  locale?: () => string | undefined
  /** Some plugin moved between in effect and waiting (`requires`): every
   *  session's plugins load again. */
  onRequirementsChanged?: () => void
}

let current: ProviderModBootDeps | undefined

const report = (line: string): void => {
  traceLine(`[provider-mods] ${line}`, { level: 'warn' })
  console.warn(`[provider-mods] ${line}`)
}

/** The plugin loader reads environment variables only to find a home; the
 *  home is given, so none is read. */
const NO_ENV = { getEnv: () => undefined } as unknown as RuntimeConfig

/** Every plugin of the person, enabled and not. Exported for tests. */
export async function scanProviderPlugins(deps: ProviderModBootDeps): Promise<ProviderPluginScan & { enabled: ActivePlugin[] }> {
  const { homeDir, fs } = deps
  const [{ installRegistry }, enabledIds, enabledDirs] = await Promise.all([
    loadMarketplaceInstallState({ homeDir }, fs),
    getEnabledPluginsMap({ homeDir }, fs),
    // The user-scope allowlist; the project scope is deliberately not read.
    loadEffectiveEnabledPlugins({ cwd: homeDir, homeDir, fs }),
  ])
  const scan = await gatherPlugins({
    cwd: homeDir,
    runtimeConfig: NO_ENV,
    homeDir,
    fs,
    installRegistry,
    enabledPluginIdentifiers: enabledIds,
    ...(enabledDirs ? { enabledPlugins: enabledDirs } : {}),
  })
  for (const issue of scan.errors) {
    if (issue.type === 'manifest-validation-error' && issue.validationErrors.some(error => error.startsWith('providers'))) {
      report(`${issue.plugin ?? issue.source}: ${issue.validationErrors.filter(error => error.startsWith('providers')).join('; ')}`)
    } else if (issue.type === 'path-not-found' && issue.component === 'providers') {
      report(`${issue.plugin ?? issue.source}: provider module not found: ${issue.path}`)
    }
  }
  return { enabled: scan.enabled, disabled: scan.disabled }
}

// ── updates ──

/** The providers' plugins in a scan that are the person's own. */
function providerPluginsOf(scan: ProviderPluginScan): ProviderPluginScan['enabled'] {
  return [...scan.enabled, ...scan.disabled].filter(
    plugin => (plugin.providers?.length ?? 0) > 0 && isGlobalPluginSource(plugin.source),
  )
}

/** Whether some installed provider plugin names a place to look for updates. */
export function hasProviderUpdateSource(scan: ProviderPluginScan): boolean {
  return providerPluginsOf(scan).some(
    plugin =>
      plugin.source.startsWith('marketplace:') &&
      Object.values(plugin.manifest?.providers ?? {}).some(provider => provider.updates !== undefined),
  )
}

/** How the update service is built; ONE function, so the holder keeps the service it built. */
async function buildUpdateService(): Promise<ProviderModUpdateService> {
  const deps = current
  if (!deps) throw new Error('the provider mods are not booted')
  const { createProductionUpdateService } = await import('./providerModUpdateWiring')
  return createProductionUpdateService({
    homeDir: deps.homeDir,
    fs: deps.fs,
    transport: () => deps.transport?.(),
    report,
    afterConsent: () => reloadProviderMods(),
  })
}

let scheduleState: 'none' | 'starting' | 'running' = 'none'
let stopSchedule: (() => void) | undefined

function stopUpdateSchedule(): void {
  stopSchedule?.()
  stopSchedule = undefined
  scheduleState = 'none'
}

/**
 * Brings the update service to the plugins just scanned, only after the scan has
 * COMPLETED. Nothing is scheduled or fetched unless some plugin has `updates`.
 */
async function followUpdates(scan: ProviderPluginScan): Promise<void> {
  if (providerPluginsOf(scan).length === 0) {
    stopUpdateSchedule()
    configureProviderModUpdates(null)
    return
  }
  configureProviderModUpdates(buildUpdateService)
  if (!hasProviderUpdateSource(scan)) {
    stopUpdateSchedule()
  } else if (scheduleState === 'none') {
    scheduleState = 'starting'
    try {
      const { startProviderModUpdateSchedule } = await import('../../pluginHost/providerModUpdates')
      const service = await acquireProviderModUpdateService()
      if (service && scheduleState === 'starting' && current) {
        stopSchedule = startProviderModUpdateSchedule(service, { report })
        scheduleState = 'running'
      } else if (scheduleState === 'starting') {
        scheduleState = 'none'
      }
    } catch (error) {
      scheduleState = 'none'
      report(`the update schedule did not start: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  notifyProviderModUpdatesChanged()
}

/** Whether the background update check is running (tests, diagnostics). */
export function providerUpdateScheduleRunning(): boolean {
  return scheduleState === 'running'
}

/** Stop the schedule and forget the boot (the realm going away; tests). */
export function disposeProviderModBoot(): void {
  stopUpdateSchedule()
  configureProviderModUpdates(null)
  stopGateWatch?.()
  stopGateWatch = undefined
  current = undefined
}

/**
 * `e.settings` of `provider.models` / `.verify` / `.usage`: the same values
 * `$.provider.settings()` answers (declared settings over the plugin's stored
 * options, defaults filled, sensitive ones left out, the sign-in answers under
 * `signin`). An unregistered provider has none. Exported for tests.
 */
export async function providerEventSettings(
  deps: Pick<ProviderModBootDeps, 'homeDir' | 'fs'>,
  registration: { manifest: ProviderManifest; configId?: string } | undefined,
): Promise<Record<string, unknown>> {
  if (!registration) return {}
  const stored =
    registration.configId !== undefined
      ? (await getPluginConfigsMap({ homeDir: deps.homeDir }, deps.fs))[registration.configId]?.options
      : undefined
  return providerSettingValues(registration.manifest, stored)
}

/**
 * Configure the host and sync it with the installed plugins. Registers
 * manifests only: no worker starts. Never rejects.
 */
export async function bootProviderMods(deps: ProviderModBootDeps): Promise<void> {
  current = deps
  const host = getProviderModHost()
  // `provider.models` / `.verify` / `.usage`: what the runtime's listing,
  // key check and usage paths call for a provider mod.
  const calls = providerCodeCalls({
    runtime: () => host.runtime(),
    connected: isProviderSetUp,
    baseUrl: providerWireBaseUrl,
    // The same values `$.provider.settings()` answers: the declared settings
    // over the plugin's stored options.
    settings: providerId => providerEventSettings(deps, host.registered().find(entry => entry.providerId === providerId)),
    report,
  })
  host.configure({
    report,
    readText: path => deps.fs.readFile(path, { encoding: 'utf-8' }),
    // A registry- or https-installed plugin registers nothing until the person
    // approved its grant (the consent dialog), and nothing wider than they
    // approved; directory plugins are exempt.
    consented: plugin =>
      consentCovers({ homeDir: deps.homeDir }, deps.fs, plugin.source.slice('marketplace:'.length), plugin.manifest),
    createRuntime: async () => {
      const { createProviderModRuntime } = await import('./providerModRuntimeFactory')
      return createProviderModRuntime({
        homeDir: deps.homeDir,
        fs: deps.fs,
        report,
        ...(deps.locale ? { locale: deps.locale } : {}),
      })
    },
    listModels: calls.listModels,
    verify: calls.verify,
    usage: calls.usage,
    refreshListing: async providerId => {
      const transport = deps.transport?.()
      if (!transport || !isProviderSetUp(providerId)) return
      await refreshRuntimeProviderModels(transport, providerId, { pickDefaults: true })
    },
  })
  configureContributions(deps)
  await reloadProviderMods()
}

let stopGateWatch: (() => void) | undefined

/** The templates and topbar items the same scan carries (F-25), and the
 *  `requires` gate judged again whenever the provider state changes. */
function configureContributions(deps: ProviderModBootDeps): void {
  const contributions = getModUiContributionsHost()
  contributions.configure({
    readText: path => deps.fs.readFile(path, { encoding: 'utf-8' }),
    listFiles: async path => {
      try {
        return (await deps.fs.readdir(path)).filter(entry => entry.isFile()).map(entry => entry.name)
      } catch {
        return []
      }
    },
    gate: runtimeProviderGate,
    report: line => {
      traceLine(`[mods] ${line}`, { level: 'warn' })
      console.warn(`[mods] ${line}`)
    },
  })
  stopGateWatch?.()
  const recheck = (): void => contributions.recheckGate()
  const offConfigs = onRuntimeProviderConfigsChanged(recheck)
  const offRegistered = onProviderModRegistered(() => {
    recheck()
  })
  const offGate = contributions.onGateChanged(() => deps.onRequirementsChanged?.())
  stopGateWatch = () => {
    offConfigs()
    offRegistered()
    offGate()
  }
}

/** A plugin was enabled, disabled, installed or updated: scan again. A no-op
 *  until the boot has run. Never rejects. */
export async function reloadProviderMods(): Promise<void> {
  if (!current) return
  let scan: Awaited<ReturnType<typeof scanProviderPlugins>>
  try {
    scan = await scanProviderPlugins(current)
    await getProviderModHost().sync(scan)
    await getModUiContributionsHost().sync(scan)
  } catch (error) {
    report(`sync failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  // The first scan has finished: only now may an update be looked for.
  try {
    await followUpdates(scan)
  } catch (error) {
    report(`the update service could not follow the plugins: ${error instanceof Error ? error.message : String(error)}`)
  }
}
