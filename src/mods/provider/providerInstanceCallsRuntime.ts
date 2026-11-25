/**
 * The instance calls (`providerInstanceCalls.ts`) over this realm's provider
 * host, settings and health ledger. One per app background runtime.
 */

import { clearProviderState } from '../../models/drivers/providerHealthLedger'
import { isProviderSetUp, mergedModels, runtimeProviderConfigs } from '../../models/drivers/runtimeProviders'
import { readUserLayer } from '../../settings/settingsStore'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { providerHostSources } from './providerHostSources'
import { createInstanceCalls, type InstanceCalls } from './providerInstanceCalls'
import { getProviderModHost } from './providerModHost'

const unavailable = (what: string): Error => {
  const error = new Error(`provider instances cannot be ${what} here: the settings write path is not attached`)
  error.name = 'NotSupportedError'
  return error
}

export function createRuntimeInstanceCalls(options: {
  fs: RuntimeFs
  homeDir: string
  relist: (routerId: string) => Promise<void>
  locale?: () => string | undefined
  random?: () => number
}): InstanceCalls {
  return createInstanceCalls({
    managedBy: routerId => getProviderModHost().managedDefinitions(routerId),
    configs: runtimeProviderConfigs,
    retiredSlots: async definitionId =>
      (await readUserLayer(options.homeDir, options.fs)).settings.providers?.retiredInstances?.[definitionId] ?? [],
    writeConfig: async (providerId, config) => {
      const write = providerHostSources().writeProviderConfig
      if (!write) throw unavailable('stored')
      await write(providerId, config)
    },
    removeConfig: async providerId => {
      const remove = providerHostSources().removeProviderConfig
      if (!remove) throw unavailable('removed')
      await remove(providerId)
    },
    resync: () => getProviderModHost().resync(),
    forgetState: providerId => clearProviderState(providerId),
    relist: options.relist,
    isSetUp: isProviderSetUp,
    models: mergedModels,
    locale: () => options.locale?.() ?? 'en',
    now: Date.now,
    ...(options.random ? { random: options.random } : {}),
  })
}
