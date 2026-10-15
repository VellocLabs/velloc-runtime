// RuleEdit: the typed permission mutation. `applyPermissionUpdate` is a pure
// transform of `permissionRules`; `permissionUpdateToSettingsPatch` maps it to
// the settings.json change a persisted destination writes.

import type { WorkingState, ApprovalMode } from '../runtime/RuntimeTypes'
import type { NexusPermissionsSettings } from '../settings/settingsTypes'

type PermCtx = WorkingState['permissionRules']

export type PermissionRuleBehavior = 'allow' | 'deny' | 'ask'

/** Where a rule/mode/dir change is persisted. `session`/`cliArg` are
 *  runtime-only (never written to disk). */
export type RuleTarget =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

/** Destinations whose changes are written to a settings.json file. */
export const PERSISTED_UPDATE_DESTINATIONS: ReadonlySet<RuleTarget> =
  new Set(['userSettings', 'projectSettings', 'localSettings'])

export type RuleEdit =
  | {
      type: 'addRules'
      behavior: PermissionRuleBehavior
      rules: string[]
      destination: RuleTarget
    }
  | {
      type: 'replaceRules'
      behavior: PermissionRuleBehavior
      rules: string[]
      destination: RuleTarget
    }
  | {
      type: 'removeRules'
      behavior: PermissionRuleBehavior
      rules: string[]
      destination: RuleTarget
    }
  | { type: 'setMode'; mode: ApprovalMode; destination?: RuleTarget }
  | { type: 'addDirectories'; directories: string[]; destination: RuleTarget }
  | {
      type: 'removeDirectories'
      directories: string[]
      destination: RuleTarget
    }

const emptyRules = (): { allow: string[]; deny: string[]; ask: string[] } => ({
  allow: [],
  deny: [],
  ask: [],
})

function dedupeAppend(existing: readonly string[], added: readonly string[]): string[] {
  const seen = new Set(existing)
  const out = [...existing]
  for (const r of added) {
    if (r && !seen.has(r)) {
      seen.add(r)
      out.push(r)
    }
  }
  return out
}

/**
 * Apply a RuleEdit to a permissionRules, returning a NEW context
 * (pure; never mutates). Updates the live `ruleLists` (what the rule engine
 * reads), `mode`, and `additionalWorkingDirectories`. Persistence is separate
 * (see permissionUpdateToSettingsPatch). The `destination` field is not used
 * here — the live context is the union of all sources (flat model).
 */
export function applyPermissionUpdate(
  ctx: PermCtx,
  update: RuleEdit,
): PermCtx {
  switch (update.type) {
    case 'addRules': {
      const lists = ctx.ruleLists ?? emptyRules()
      return {
        ...ctx,
        ruleLists: {
          ...lists,
          [update.behavior]: dedupeAppend(lists[update.behavior], update.rules),
        },
      }
    }
    case 'replaceRules': {
      const lists = ctx.ruleLists ?? emptyRules()
      return {
        ...ctx,
        ruleLists: { ...lists, [update.behavior]: [...new Set(update.rules)] },
      }
    }
    case 'removeRules': {
      const lists = ctx.ruleLists ?? emptyRules()
      const remove = new Set(update.rules)
      return {
        ...ctx,
        ruleLists: {
          ...lists,
          [update.behavior]: lists[update.behavior].filter(r => !remove.has(r)),
        },
      }
    }
    case 'setMode':
      return { ...ctx, mode: update.mode }
    case 'addDirectories': {
      const dirs = new Map(ctx.extraWorkspaceRoots)
      for (const d of update.directories) if (d) dirs.set(d, { path: d, source: 'session' })
      return { ...ctx, extraWorkspaceRoots: dirs }
    }
    case 'removeDirectories': {
      const dirs = new Map(ctx.extraWorkspaceRoots)
      for (const d of update.directories) dirs.delete(d)
      return { ...ctx, extraWorkspaceRoots: dirs }
    }
    default:
      return ctx
  }
}

/** Apply a sequence of updates left-to-right. */
export function applyRuleEdits(
  ctx: PermCtx,
  updates: readonly RuleEdit[],
): PermCtx {
  return updates.reduce(applyPermissionUpdate, ctx)
}

/**
 * The change a PERSISTED update should make to a settings.json `permissions`
 * section, given the section's current value. Returns null for runtime-only
 * destinations (session/cliArg) or no-op updates. The worker applies this via
 * updateSectionInSource. (Pure — no fs.)
 */
// The persisted shape IS the settings `permissions` section, so the worker can
// hand the result straight to updateSectionInSource (no structural mismatch).
export type PermissionsSettingsPatch = NexusPermissionsSettings

const BEHAVIOR_KEY = {
  allow: 'allow',
  deny: 'deny',
  ask: 'ask',
} as const

export function permissionUpdateToSettingsPatch(
  prev: PermissionsSettingsPatch | undefined,
  update: RuleEdit,
): PermissionsSettingsPatch | null {
  if (
    update.type !== 'setMode' &&
    !PERSISTED_UPDATE_DESTINATIONS.has(update.destination)
  ) {
    return null
  }
  const base: PermissionsSettingsPatch = { ...(prev ?? {}) }
  switch (update.type) {
    case 'addRules': {
      const key = BEHAVIOR_KEY[update.behavior]
      base[key] = dedupeAppend(base[key] ?? [], update.rules)
      return base
    }
    case 'replaceRules': {
      base[BEHAVIOR_KEY[update.behavior]] = [...new Set(update.rules)]
      return base
    }
    case 'removeRules': {
      const key = BEHAVIOR_KEY[update.behavior]
      const remove = new Set(update.rules)
      base[key] = (base[key] ?? []).filter(r => !remove.has(r))
      return base
    }
    case 'setMode':
      if (update.destination && !PERSISTED_UPDATE_DESTINATIONS.has(update.destination)) {
        return null
      }
      // Only external modes are persisted to defaultMode; internal modes
      // (auto/bubble) are inert in this build and never reach here.
      base.defaultMode = update.mode as NexusPermissionsSettings['defaultMode']
      return base
    case 'addDirectories':
      base.additionalDirectories = dedupeAppend(
        base.additionalDirectories ?? [],
        update.directories,
      )
      return base
    case 'removeDirectories': {
      const remove = new Set(update.directories)
      base.additionalDirectories = (base.additionalDirectories ?? []).filter(
        d => !remove.has(d),
      )
      return base
    }
    default:
      return null
  }
}
