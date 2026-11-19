/**
 * `theme` on the runtime protocol (F-25, F-35): `theme.useLook`,
 * `theme.onEnable` and `theme.clear`; shapes, scopes and the rule for what
 * may run in `mods/modThemeLooks.ts`. The runtime reads the built-in marketplace's cached
 * listing itself; a connection bound to a list of sessions reaches those alone.
 */
import { wireError } from '../runtimeProtocol'
import {
  THEME_ACTION_SCOPES,
  THEME_CAPABILITY,
  clearSessionTheme,
  isThemeClearPayload,
  isThemeOnEnablePayload,
  isThemeUseLookPayload,
  runThemeOnEnable,
  useThemeLook,
  useThemeLookOnceLoaded,
  type ThemeClearPayload,
  type ThemeLookSlot,
  type ThemeLookTarget,
  type ThemeOnEnablePayload,
  type ThemeOnEnableTiming,
  type ThemeUseLookPayload,
} from '../../mods/modThemeLooks'
import { modSlotFor } from '../../mods/modSlotRegistry'
import { BUILTIN_MARKETPLACE_KEY } from '../../pluginHost/builtinMarketplace'
import { readCachedManifest } from '../../pluginHost/builtinMarketplaceSeed'
import { loadInstalledPlugins } from '../../pluginHost/installedRegistry'
import { listingInstalls } from '../../pluginHost/themeListing'
import { keepOneThemePlugin, keepOnlyListedThemePlugin, turnOnListedThemePlugin } from '../../mods/themePlugins'
import { listingsVisibleOn } from '../../pluginHost/marketplaces'
import type { CatalogListing } from '../../pluginHost/registryFormats'
import type { UpdateChannel } from '../../branding/updateChannels'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { CapabilityRegistry } from './CapabilityRegistry'
import type { ConnectionInfo } from './types'

export type ThemeCapabilityOptions = {
  /** Where the runtime reads files now. */
  fs: () => RuntimeFs
  /** The host user's home; rejects while the host cannot say. */
  resolveHome: () => Promise<string>
  channel: () => UpdateChannel
  /** Every open session loads its plugins again. */
  reload?: () => void
  /** Default: the slot registry. */
  slotOf?: (sessionId: string) => ThemeLookSlot | undefined
  /** How `theme.onEnable`, and a look whose plugin was just switched on, wait for a plugin that is still loading. */
  onEnableTiming?: ThemeOnEnableTiming
}

/** The built-in marketplace's cached listings for `channel`; null when none is cached or readable. */
export async function readCachedBuiltinListings(
  fs: RuntimeFs,
  homeDir: string,
  channel: UpdateChannel,
): Promise<CatalogListing[] | null> {
  try {
    const manifest = await readCachedManifest({ homeDir }, fs)
    return manifest ? listingsVisibleOn(manifest.plugins, channel) : null
  } catch {
    return null
  }
}

export function registerThemeCapability(registry: CapabilityRegistry, options: ThemeCapabilityOptions): void {
  const slotOf = options.slotOf ?? modSlotFor
  const slotInScope = (conn: ConnectionInfo, sessionId: string): ThemeLookSlot | undefined => {
    if (conn.scope.sessions !== 'all' && !conn.scope.sessions.includes(sessionId)) {
      throw wireError('forbidden_scope', `session ${sessionId} is not in this connection's scope`)
    }
    return slotOf(sessionId)
  }
  /** The cached listings and how each maps to installs, read fresh. */
  const readTarget = async (): Promise<{ homeDir: string; fs: RuntimeFs } & Omit<ThemeLookTarget, 'slot'>> => {
    const fs = options.fs()
    try {
      const homeDir = await options.resolveHome()
      const listings = await readCachedBuiltinListings(fs, homeDir, options.channel())
      const installed = (await loadInstalledPlugins({ homeDir }, fs)).registry.plugins
      const installsOf = (listing: CatalogListing) => listingInstalls(installed, listing, BUILTIN_MARKETPLACE_KEY)
      return { homeDir, fs, marketplace: BUILTIN_MARKETPLACE_KEY, listings, installsOf }
    } catch {
      throw wireError('host_unavailable', 'theme: the host has no home folder yet')
    }
  }

  registry.registerCapability({
    cap: THEME_CAPABILITY,
    actions: {
      useLook: { scope: THEME_ACTION_SCOPES.useLook, guard: isThemeUseLookPayload },
      onEnable: { scope: THEME_ACTION_SCOPES.onEnable, guard: isThemeOnEnablePayload },
      clear: { scope: THEME_ACTION_SCOPES.clear, guard: isThemeClearPayload },
    },
    handle: async request => {
      switch (request.route.act) {
        case 'useLook': {
          const payload = request.payload as ThemeUseLookPayload
          const slot = slotInScope(request.conn, payload.sessionId)
          const { homeDir, fs, ...target } = await readTarget()
          const reload = options.reload ?? (() => {})
          const listing = target.listings?.find(candidate => candidate.name === payload.plugin)
          const loading: ThemeLookTarget = {
            ...target,
            get slot() {
              return slotOf(payload.sessionId)
            },
          }
          // With *Only one at a time* on, the look's plugin is made the one theme
          // plugin on first, so the command run is that plugin's and no other's.
          const sole =
            listing?.theme?.looks.some(look => look.id === payload.lookId) && !request.signal?.aborted
              ? await keepOnlyListedThemePlugin({ homeDir, fs, reload }, listing)
              : null
          if (sole) {
            return sole.switchedOn || sole.othersOff.length > 0
              ? useThemeLookOnceLoaded(loading, payload, options.onEnableTiming, request.signal, { othersOff: sole.othersOff })
              : useThemeLook({ ...target, slot }, payload)
          }
          let result = await useThemeLook({ ...target, slot }, payload)
          let switchedOn = false
          // Installed but switched off: the plugin goes on, and the look is asked
          // for again while the session loads it.
          if (!result.ok && result.reason === 'notLoaded') {
            if (listing && !request.signal?.aborted && (await turnOnListedThemePlugin({ homeDir, fs, reload }, listing))) {
              switchedOn = true
              result = await useThemeLookOnceLoaded(loading, payload, options.onEnableTiming, request.signal)
            }
          }
          // An applied look, or a plugin switched on here whatever its look answered:
          // with *Only one at a time* on, the other theme plugins go off.
          if (result.ok || switchedOn) {
            await keepOneThemePlugin({ homeDir, fs, reload }, { plugin: payload.plugin })
          }
          return result
        }
        case 'onEnable': {
          const payload = request.payload as ThemeOnEnablePayload
          slotInScope(request.conn, payload.sessionId)
          const { homeDir: _home, fs: _fs, ...listed } = await readTarget()
          // The session's runtime is looked up on every try: the plugin may still be loading.
          const target: ThemeLookTarget = {
            ...listed,
            get slot() {
              return slotOf(payload.sessionId)
            },
          }
          return runThemeOnEnable(target, payload.plugin, options.onEnableTiming, request.signal)
        }
        case 'clear':
          return clearSessionTheme(slotInScope(request.conn, (request.payload as ThemeClearPayload).sessionId))
        default:
          throw wireError('unknown_route', `theme has no action '${request.route.act}'`)
      }
    },
  })
}
