/**
 * Switching a plugin on or off reloads every session's plugins — and the
 * provider mods too, which are global, not any session's. With no session
 * loaded the fan-out reaches no session, so the manager rescans the provider
 * mods itself: a provider plugin switched on from Settings with no session
 * open still appears under Add provider.
 */
import { describe, expect, it, vi } from 'vitest'

const reloadProviderMods = vi.fn(async () => {})
vi.mock('../mods/provider/providerModBoot', () => ({ reloadProviderMods }))

import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'

describe('reloadPluginsOnAllSessions', () => {
  it('rescans the provider mods even when no session is loaded', async () => {
    const manager = new SharedWorkerSessionManager({
      createWorker: () => {
        throw new Error('no session is created by a plugin reload')
      },
    } as never)
    manager.reloadPluginsOnAllSessions()
    await vi.waitFor(() => expect(reloadProviderMods).toHaveBeenCalledTimes(1))
  })

  it('tells the hub the plugin set changed on a reload and when a session records a theme plugin', () => {
    const manager = new SharedWorkerSessionManager({
      createWorker: () => {
        throw new Error('no session is created by a plugin reload')
      },
    } as never)
    const hub = (manager as unknown as { runtimeHub: { pluginSetChanged(): void } }).runtimeHub
    const changed = vi.spyOn(hub, 'pluginSetChanged')
    manager.reloadPluginsOnAllSessions()
    expect(changed).toHaveBeenCalledTimes(1)
    manager.themeModRecorded()
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
