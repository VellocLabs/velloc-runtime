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
  isThemeModsSinglePayload,
  isThemeModsTurnOffPayload,
  type ThemeModsTurnOffPayload,
  type ThemeModsScopePayload,
  type ThemeModsSinglePayload,
  type ThemeModsState,
  type ThemeModsTurnOffResult,
} from '../../mods/themeMods'
import { themePluginRows, turnOffThemePlugins } from '../../mods/themePlugins'
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
  /** Every open session loads its plugins again. */
  reload?: () => void
  report?: (line: string) => void
}

const EMPTY: ThemeModsState = { mods: [], plugins: [], backdropScope: DEFAULT_THEME_BACKDROP_SCOPE, single: true, on: 0 }

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
      const fs = options.context().fs
      const { settings } = await readLayerFresh('userSettings', { homeDir }, fs)
      const plugins = await themePluginRows(homeDir, fs).catch(error => {
        report(`the theme plugins could not be read: ${error instanceof Error ? error.message : String(error)}`)
        return []
      })
      const on = plugins.filter(row => row.enabled).length
      return {
        mods: settings.mods?.themeMods ?? [],
        plugins,
        backdropScope: settings.mods?.backdropScope ?? DEFAULT_THEME_BACKDROP_SCOPE,
        single: settings.mods?.singleThemeMod !== false,
        on,
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
      setSingle: { scope: THEME_MODS_ACTION_SCOPES.setSingle, guard: isThemeModsSinglePayload },
      turnOffAll: { scope: THEME_MODS_ACTION_SCOPES.turnOffAll, guard: isThemeModsTurnOffPayload },
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
      if (act !== 'setBackdropScope' && act !== 'setSingle' && act !== 'turnOffAll') {
        throw wireError('unknown_route', `themeMods has no action '${act}'`)
      }
      const homeDir = await options.resolveHome().catch(() => '')
      if (!homeDir) throw wireError('host_unavailable', 'themeMods: the host did not report a home folder')
      if (act === 'turnOffAll') {
        // Every theme plugin off: their themes go as they unload, and the app's own look stands.
        let turnedOff: number
        try {
          const keep = (request.payload as ThemeModsTurnOffPayload | undefined)?.keep
          turnedOff = await turnOffThemePlugins({ homeDir, fs: options.context().fs, reload: options.reload ?? (() => {}) }, keep)
        } catch (error) {
          throw wireError('conflict', error instanceof Error ? error.message : String(error))
        }
        await publish()
        return { ok: true, turnedOff } satisfies ThemeModsTurnOffResult
      }
      try {
        await updateSectionInSource('userSettings', { homeDir }, options.context().fs, 'mods', previous => {
          const next = { ...(previous ?? {}) }
          if (act === 'setSingle') {
            if ((request.payload as ThemeModsSinglePayload).on) delete next.singleThemeMod
            else next.singleThemeMod = false
          } else {
            const { scope } = request.payload as ThemeModsScopePayload
            if (scope === DEFAULT_THEME_BACKDROP_SCOPE) delete next.backdropScope
            else next.backdropScope = scope
          }
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
