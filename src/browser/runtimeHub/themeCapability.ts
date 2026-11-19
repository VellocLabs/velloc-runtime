/**
 * `theme` on the runtime protocol (F-25, F-35): `theme.useLook` and
 * `theme.clear`; shapes, scopes and the rule for what may run in
 * `mods/modThemeLooks.ts`. The runtime reads the built-in marketplace's cached
 * listing itself; a connection bound to a list of sessions reaches those alone.
 */
import { wireError } from '../runtimeProtocol'
import {
  THEME_ACTION_SCOPES,
  THEME_CAPABILITY,
  clearSessionTheme,
  isThemeClearPayload,
  isThemeUseLookPayload,
  useThemeLook,
  type ThemeClearPayload,
  type ThemeLookSlot,
  type ThemeUseLookPayload,
} from '../../mods/modThemeLooks'
import { modSlotFor } from '../../mods/modSlotRegistry'
import { BUILTIN_MARKETPLACE_KEY } from '../../pluginHost/builtinMarketplace'
import { readCachedManifest } from '../../pluginHost/builtinMarketplaceSeed'
import { loadInstalledPlugins } from '../../pluginHost/installedRegistry'
import { listingInstalls } from '../../pluginHost/themeListing'
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
  /** Default: the slot registry. */
  slotOf?: (sessionId: string) => ThemeLookSlot | undefined
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

  registry.registerCapability({
    cap: THEME_CAPABILITY,
    actions: {
      useLook: { scope: THEME_ACTION_SCOPES.useLook, guard: isThemeUseLookPayload },
      clear: { scope: THEME_ACTION_SCOPES.clear, guard: isThemeClearPayload },
    },
    handle: async request => {
      switch (request.route.act) {
        case 'useLook': {
          const payload = request.payload as ThemeUseLookPayload
          const slot = slotInScope(request.conn, payload.sessionId)
          let listings: CatalogListing[] | null
          let installed: Awaited<ReturnType<typeof loadInstalledPlugins>>['registry']['plugins'] = {}
          try {
            const fs = options.fs()
            const homeDir = await options.resolveHome()
            listings = await readCachedBuiltinListings(fs, homeDir, options.channel())
            installed = await loadInstalledPlugins({ homeDir }, fs).then(
              read => read.registry.plugins,
              () => ({}),
            )
          } catch {
            throw wireError('host_unavailable', 'theme: the host has no home folder yet')
          }
          const installsOf = (listing: CatalogListing) => listingInstalls(installed, listing, BUILTIN_MARKETPLACE_KEY)
          return useThemeLook({ marketplace: BUILTIN_MARKETPLACE_KEY, listings, installsOf, slot }, payload)
        }
        case 'clear':
          return clearSessionTheme(slotInScope(request.conn, (request.payload as ThemeClearPayload).sessionId))
        default:
          throw wireError('unknown_route', `theme has no action '${request.route.act}'`)
      }
    },
  })
}
