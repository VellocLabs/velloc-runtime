/**
 * Theme mods on the runtime protocol (F-25); shapes and scopes in
 * `mods/themeMods.ts`. The state is read from the user's settings at every
 * snapshot and `read`, so what a session recorded since is in it.
 */
import { wireError, type TopicId } from '../runtimeProtocol'
import {
  DEFAULT_THEME_BACKDROP_SCOPE,
  THEME_MODS_ACTION_SCOPES,
  THEME_MODS_CAPABILITY,
  THEME_MODS_EVENT,
  THEME_MODS_TOPIC,
  isThemeModsReadPayload,
  isThemeModsScopePayload,
  type ThemeModsScopePayload,
  type ThemeModsState,
} from '../../mods/themeMods'
import { readLayerFresh, updateSectionInSource } from '../../settings/settingsStore'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

export type ThemeModsCapabilityOptions = {
  /** Where the runtime stands now. */
  context: () => { fs: RuntimeFs }
  /** The host user's home; rejects while the host cannot say. */
  resolveHome: () => Promise<string>
  report?: (line: string) => void
}

const EMPTY: ThemeModsState = { mods: [], backdropScope: DEFAULT_THEME_BACKDROP_SCOPE }

export function registerThemeModsCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: ThemeModsCapabilityOptions,
): { publish(): Promise<void> } {
  const report = options.report ?? (line => console.warn(`[theme-mods] ${line}`))

  const state = async (): Promise<ThemeModsState> => {
    try {
      const homeDir = await options.resolveHome().catch(() => '')
      if (!homeDir) return EMPTY
      const { settings } = await readLayerFresh('userSettings', { homeDir }, options.context().fs)
      return {
        mods: settings.mods?.themeMods ?? [],
        backdropScope: settings.mods?.backdropScope ?? DEFAULT_THEME_BACKDROP_SCOPE,
      }
    } catch (error) {
      report(`the theme mods could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return EMPTY
    }
  }

  const provider: TopicProvider = {
    matches: (id: TopicId) => id === THEME_MODS_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'observe'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { type: THEME_MODS_EVENT, payload: await state() }
    },
  }
  broker.registerProvider(provider)

  const publish = async (): Promise<void> => {
    if (broker.subscribersOf(THEME_MODS_TOPIC as TopicId).length === 0) return
    broker.publish(THEME_MODS_TOPIC as TopicId, await state(), { type: THEME_MODS_EVENT })
  }

  registry.registerCapability({
    cap: THEME_MODS_CAPABILITY,
    actions: {
      read: { scope: THEME_MODS_ACTION_SCOPES.read, guard: isThemeModsReadPayload },
      setBackdropScope: { scope: THEME_MODS_ACTION_SCOPES.setBackdropScope, guard: isThemeModsScopePayload },
    },
    handle: async request => {
      const act = request.route.act
      if (act === 'read') {
        const next = await state()
        // Every reader of the topic sees what this ask found.
        if (broker.subscribersOf(THEME_MODS_TOPIC as TopicId).length > 0) {
          broker.publish(THEME_MODS_TOPIC as TopicId, next, { type: THEME_MODS_EVENT })
        }
        return next
      }
      if (act !== 'setBackdropScope') throw wireError('unknown_route', `themeMods has no action '${act}'`)
      const { scope } = request.payload as ThemeModsScopePayload
      const homeDir = await options.resolveHome().catch(() => '')
      if (!homeDir) throw wireError('host_unavailable', 'themeMods: the host did not report a home folder')
      try {
        await updateSectionInSource('userSettings', { homeDir }, options.context().fs, 'mods', previous => {
          const next = { ...(previous ?? {}) }
          if (scope === DEFAULT_THEME_BACKDROP_SCOPE) delete next.backdropScope
          else next.backdropScope = scope
          return Object.keys(next).length > 0 ? next : undefined
        })
      } catch (error) {
        throw wireError('conflict', error instanceof Error ? error.message : String(error))
      }
      await publish()
      return state()
    },
  })

  return { publish }
}
