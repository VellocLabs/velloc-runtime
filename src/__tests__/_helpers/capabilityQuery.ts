import type { RuntimeConnection } from '../../browser/runtimeClient/RuntimeConnection'
import { scopeAllows } from '../../browser/runtimeHub/CapabilityRegistry'
import { HOST_PROXY_TABLE } from '../../browser/runtimeHub/hostProxyTable'
import { LEGACY_WEBUI_CAPABILITIES } from '../../browser/runtimeHub/legacyWebUiCapabilities'
import {
  PROVIDER_UPDATES_ACTION_SCOPES,
  PROVIDER_UPDATES_CAPABILITY,
} from '../../pluginHost/providerUpdatesProtocol'
import {
  PLUGIN_UPDATES_ACTION_SCOPES,
  PLUGIN_UPDATES_CAPABILITY,
} from '../../pluginHost/pluginUpdatesProtocol'
import type { CapabilityAdvert, ScopeMode, WelcomeFrame } from '../../browser/runtimeProtocol'
import {
  WORKSPACE_ACTION_SCOPES,
  WORKSPACE_CAPABILITY,
} from '../../browser/runtimeProtocol/workspace'
import { capabilityQueryOf, type CapabilityQuery } from '../../browser/webview/useCan'
import { TERMINAL_ACTIONS, TERMINAL_CAPABILITY } from '../../terminal/protocol'
import {
  CUSTOMIZE_PAGE_ACTION_SCOPES,
  CUSTOMIZE_PAGE_CAPABILITY,
} from '../../customize/customizePageProtocol'

/**
 * A `CapabilityQuery` built like the live one, from a welcome's scope-filtered advert list via
 * `capabilityQueryOf`: a test lists the actions a grant holds; anything absent answers `can()` false.
 */
export function queryFor(capabilities: CapabilityAdvert[]): CapabilityQuery {
  const welcome = {
    kind: 'welcome',
    v: 1,
    connectionId: 'c1',
    resumed: false,
    scope: { mode: 'control', sessions: 'all' },
    server: { runtimeVersion: 'test', capabilities },
  } as WelcomeFrame
  const connection = {
    welcome,
    can(cap: string, act?: string) {
      const advert = welcome.server.capabilities.find(entry => entry.cap === cap)
      if (!advert) return false
      return act === undefined || advert.acts.includes(act)
    },
  } as unknown as RuntimeConnection
  return capabilityQueryOf(connection)
}

/**
 * The adverts a connection of `mode` is sent for the host-proxy (`ui`,
 * `appInfo`, …), legacy settings (`providers`, `memory`, …) and `workspace`
 * capabilities, and `customizePage` — read from the real scope tables and filtered the way
 * `CapabilityRegistry.advertise` filters them. Pass it to `queryFor` when a
 * test is about a SCOPE rather than one action: "a manager grant hides X"
 * then follows the tables, and fails if a route's scope moves under it.
 */
export function advertsForScope(mode: ScopeMode): CapabilityAdvert[] {
  const tables = {
    ...HOST_PROXY_TABLE,
    ...LEGACY_WEBUI_CAPABILITIES,
    [WORKSPACE_CAPABILITY]: WORKSPACE_ACTION_SCOPES,
    [PROVIDER_UPDATES_CAPABILITY]: PROVIDER_UPDATES_ACTION_SCOPES,
    [PLUGIN_UPDATES_CAPABILITY]: PLUGIN_UPDATES_ACTION_SCOPES,
    [CUSTOMIZE_PAGE_CAPABILITY]: CUSTOMIZE_PAGE_ACTION_SCOPES,
    // Every terminal action is `full`: a terminal runs programs on the host.
    [TERMINAL_CAPABILITY]: Object.fromEntries(TERMINAL_ACTIONS.map(act => [act, 'full'])),
  } as Record<string, Record<string, ScopeMode>>
  return Object.entries(tables).flatMap(([cap, acts]) => {
    const allowed = Object.entries(acts)
      .filter(([, needed]) => scopeAllows(mode, needed))
      .map(([act]) => act)
    return allowed.length > 0 ? [{ cap, acts: allowed }] : []
  })
}
