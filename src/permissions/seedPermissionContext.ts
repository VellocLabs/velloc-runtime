import type { WorkingState } from '../runtime/RuntimeTypes'
import type { NexusPermissionsSettings } from '../settings/settingsTypes'
import type { SettingsLayer } from '../settings/settingSources'
import type { ExtraWorkspaceRoot, RulesByOrigin } from '../toolkit/permissionVerdict'

/** One settings source's `permissions` block, in merge order. */
export type PermissionSettingsBySource = ReadonlyArray<{
  source: SettingsLayer
  permissions: NexusPermissionsSettings | undefined
}>

/**
 * Whether any source turns on the bypass killswitch
 * (`permissions.disableBypassPermissionsMode: 'disable'`). One source is
 * enough.
 */
export function isBypassPermissionsDisabledBySettings(
  perSource: PermissionSettingsBySource,
): boolean {
  return perSource.some(
    entry => entry.permissions?.disableBypassPermissionsMode === 'disable',
  )
}

/**
 * Merge settings-declared `additionalDirectories` into the context's
 * `additionalWorkingDirectories` map. Without
 * this, a directory the user granted via the ask banner's "Allow this folder"
 * (which PERSISTS to `permissions.additionalDirectories`) was silently dropped
 * on the next boot and the write re-prompted.
 */
function mergeAdditionalDirectories(
  existing: Map<string, ExtraWorkspaceRoot> | undefined,
  directories: readonly string[],
  source: SettingsLayer,
): Map<string, ExtraWorkspaceRoot> {
  const next = new Map(existing ?? [])
  for (const dir of directories) {
    if (!dir) continue
    // First writer wins: a runtime `addDirectories` grant already in the map
    // keeps its own source attribution.
    if (next.has(dir)) continue
    next.set(dir, { path: dir, source })
  }
  return next
}

/**
 * Apply the bypass killswitch to a seeded context: bypass becomes unavailable,
 * and a `defaultMode: 'bypassPermissions'` degrades to `default` (the mode is
 * refused rather than silently running unguarded).
 */
function applyBypassKillswitch(
  context: WorkingState['permissionRules'],
  perSource: PermissionSettingsBySource,
): WorkingState['permissionRules'] {
  if (!isBypassPermissionsDisabledBySettings(perSource)) return context
  return {
    ...context,
    bypassPermissionsModeDisabled: true,
    mode: context.mode === 'bypassPermissions' ? 'default' : context.mode,
  }
}

/**
 * Load rules per source into `alwaysAllowRules` / `alwaysDenyRules` /
 * `alwaysAskRules` at boot; the merged `ruleLists` is filled too.
 */
export function applyPermissionRulesBySource(
  context: WorkingState['permissionRules'],
  perSource: PermissionSettingsBySource,
): WorkingState['permissionRules'] {
  const next = { ...context }
  const allowBySource: RulesByOrigin = { ...(next.allowRuleBook ?? {}) }
  const denyBySource: RulesByOrigin = { ...(next.denyRuleBook ?? {}) }
  const askBySource: RulesByOrigin = { ...(next.askRuleBook ?? {}) }

  // Also build the merged flat lists for backwards compat.
  const mergedAllow: string[] = []
  const mergedDeny: string[] = []
  const mergedAsk: string[] = []

  for (const { source, permissions } of perSource) {
    if (!permissions) continue
    if (permissions.allow?.length) {
      allowBySource[source] = [...(allowBySource[source] ?? []), ...permissions.allow]
      mergedAllow.push(...permissions.allow)
    }
    if (permissions.deny?.length) {
      denyBySource[source] = [...(denyBySource[source] ?? []), ...permissions.deny]
      mergedDeny.push(...permissions.deny)
    }
    if (permissions.ask?.length) {
      askBySource[source] = [...(askBySource[source] ?? []), ...permissions.ask]
      mergedAsk.push(...permissions.ask)
    }
    if (permissions.additionalDirectories?.length) {
      next.extraWorkspaceRoots = mergeAdditionalDirectories(
        next.extraWorkspaceRoots,
        permissions.additionalDirectories,
        source,
      )
    }
    if (permissions.defaultMode) {
      next.mode = permissions.defaultMode
    }
  }

  next.allowRuleBook = allowBySource
  next.denyRuleBook = denyBySource
  next.askRuleBook = askBySource

  // Keep the flat ruleLists in sync (session rules added at runtime go here).
  if (mergedAllow.length || mergedDeny.length || mergedAsk.length) {
    next.ruleLists = {
      allow: [...new Set(mergedAllow)],
      deny: [...new Set(mergedDeny)],
      ask: [...new Set(mergedAsk)],
    }
  }

  // The killswitch is evaluated LAST so it also overrides a
  // `defaultMode: 'bypassPermissions'` adopted above.
  return applyBypassKillswitch(next, perSource)
}
