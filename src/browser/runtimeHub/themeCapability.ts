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
  type ThemeOnEnableResult,
  type ThemeOnEnableTiming,
  type ThemeUseLookPayload,
  type ThemeUseLookResult,
} from '../../mods/modThemeLooks'
import { modSlotFor } from '../../mods/modSlotRegistry'
import { BUILTIN_MARKETPLACE_KEY } from '../../pluginHost/builtinMarketplace'
import { readCachedManifest } from '../../pluginHost/builtinMarketplaceSeed'
import { loadInstalledPlugins } from '../../pluginHost/installedRegistry'
import { listingInstalls } from '../../pluginHost/themeListing'
import {
  keepOneThemePlugin,
  keepOnlyListedThemePlugin,
  turnOnListedThemePlugin,
  type ThemePluginsDeps,
} from '../../mods/themePlugins'
import {
  enableSwitchKey,
  type ThemeSwitchBoard,
  type ThemeSwitchOutcome,
  type ThemeSwitchRun,
  type ThemeSwitchStepHandle,
} from '../../mods/themeSwitch'
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
  /**
   * Settles once the session runs no turn, calling `onWaiting` first when it
   * runs one; rejects when `signal` aborts. Absent: nothing waits.
   */
  whenIdle?: (sessionId: string, signal?: AbortSignal, onWaiting?: () => void) => Promise<void>
  /** Where each look and enable shows its steps (topic `theme/switch`). */
  switches?: ThemeSwitchBoard
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

/** A switch's steps as a look or command goes: plugins switched, loading, then the command once it runs. */
function stepsOf(run: ThemeSwitchRun | undefined) {
  let loading: ThemeSwitchStepHandle | undefined
  let command: ThemeSwitchStepHandle | undefined
  return {
    deps: (deps: ThemePluginsDeps): ThemePluginsDeps =>
      run
        ? {
            ...deps,
            onOn: plugin => run.record({ kind: 'turnOn', plugin }),
            onOff: plugins => run.record({ kind: 'turnOff', plugins }),
          }
        : deps,
    loading: (plugin: string) => {
      loading ??= run?.step({ kind: 'load', plugin })
    },
    onRun: (line: string) => {
      loading?.done()
      command?.fail()
      command = run?.step({ kind: 'command', command: line })
    },
  }
}

/** How a look's, or a plugin's own command's, answer ends its switch. */
function outcomeOf(result: { ok: true } | { ok: false; reason: string }): ThemeSwitchOutcome {
  if (result.ok || result.reason === 'none') return { ok: true }
  const reason = result.reason
  return reason === 'unknownLook' ||
    reason === 'notLoaded' ||
    reason === 'notOwnCommand' ||
    reason === 'unanswered' ||
    reason === 'commandFailed'
    ? { ok: false, reason }
    : { ok: false, reason: 'request' }
}

export function registerThemeCapability(
  registry: CapabilityRegistry,
  options: ThemeCapabilityOptions,
): { cancelWaiting(): void } {
  const slotOf = options.slotOf ?? modSlotFor
  /** The looks and enables waiting for a turn to end, from every client. */
  const waits = new Set<AbortController>()
  const slotInScope = (conn: ConnectionInfo, sessionId: string): ThemeLookSlot | undefined => {
    if (conn.scope.sessions !== 'all' && !conn.scope.sessions.includes(sessionId)) {
      throw wireError('forbidden_scope', `session ${sessionId} is not in this connection's scope`)
    }
    return slotOf(sessionId)
  }
  /** Waits for `sessionId`'s turn to end, shown as a step of `run`; false when the wait was cancelled. */
  const waitForTurn = async (
    sessionId: string,
    signal: AbortSignal | undefined,
    run: ThemeSwitchRun | undefined,
  ): Promise<boolean> => {
    if (!options.whenIdle) return true
    const stop = new AbortController()
    waits.add(stop)
    let step: ThemeSwitchStepHandle | undefined
    try {
      await options.whenIdle(sessionId, signal ? AbortSignal.any([signal, stop.signal]) : stop.signal, () => {
        step = run?.step({ kind: 'waitTurn' })
      })
      step?.done()
      return true
    } catch {
      run?.finish({ ok: false, reason: 'cancelled' })
      return false
    } finally {
      waits.delete(stop)
    }
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
  /** The look's name as the cached listing gives it; its id when none is readable. */
  const lookName = async (payload: ThemeUseLookPayload): Promise<string> => {
    try {
      const listings = await readCachedBuiltinListings(options.fs(), await options.resolveHome(), options.channel())
      const listing = listings?.find(each => each.name === payload.plugin)
      return listing?.theme?.looks.find(each => each.id === payload.lookId)?.name ?? payload.lookId
    } catch {
      return payload.lookId
    }
  }

  const useLook = async (
    payload: ThemeUseLookPayload,
    signal: AbortSignal | undefined,
    run: ThemeSwitchRun | undefined,
  ): Promise<ThemeUseLookResult> => {
    // A look picked while the session runs a turn applies once it ends:
    // its plugins reload only between turns.
    if (!(await waitForTurn(payload.sessionId, signal, run))) {
      return { ok: false, reason: 'notLoaded' }
    }
    const steps = stepsOf(run)
    const slot = slotOf(payload.sessionId)
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
      listing?.theme?.looks.some(look => look.id === payload.lookId) && !signal?.aborted
        ? await keepOnlyListedThemePlugin(steps.deps({ homeDir, fs, reload }), listing)
        : null
    if (sole) {
      if (!sole.switchedOn && sole.othersOff.length === 0) {
        return useThemeLook({ ...target, slot }, payload, undefined, steps.onRun)
      }
      steps.loading(payload.plugin)
      return useThemeLookOnceLoaded(loading, payload, options.onEnableTiming, signal, {
        othersOff: sole.othersOff,
        onRun: steps.onRun,
      })
    }
    let result = await useThemeLook({ ...target, slot }, payload, undefined, steps.onRun)
    let switchedOn = false
    // Installed but switched off: the plugin goes on, and the look is asked
    // for again while the session loads it.
    if (!result.ok && result.reason === 'notLoaded') {
      if (listing && !signal?.aborted && (await turnOnListedThemePlugin(steps.deps({ homeDir, fs, reload }), listing))) {
        switchedOn = true
        steps.loading(payload.plugin)
        result = await useThemeLookOnceLoaded(loading, payload, options.onEnableTiming, signal, { onRun: steps.onRun })
      }
    }
    // An applied look, or a plugin switched on here whatever its look answered:
    // with *Only one at a time* on, the other theme plugins go off.
    if (result.ok || switchedOn) {
      await keepOneThemePlugin(steps.deps({ homeDir, fs, reload }), { plugin: payload.plugin })
    }
    return result
  }

  const onEnable = async (
    payload: ThemeOnEnablePayload,
    signal: AbortSignal | undefined,
    run: ThemeSwitchRun | undefined,
  ): Promise<ThemeOnEnableResult> => {
    // The command would land in a running turn: it waits for the turn to end.
    if (!(await waitForTurn(payload.sessionId, signal, run))) return { ok: false, reason: 'notLoaded' }
    const { homeDir: _home, fs: _fs, ...listed } = await readTarget()
    // The session's runtime is looked up on every try: the plugin may still be loading.
    const target: ThemeLookTarget = {
      ...listed,
      get slot() {
        return slotOf(payload.sessionId)
      },
    }
    const steps = stepsOf(run)
    if (listed.listings?.find(each => each.name === payload.plugin)?.theme?.onEnable) steps.loading(payload.plugin)
    return runThemeOnEnable(target, payload.plugin, options.onEnableTiming, signal, steps.onRun)
  }

  /** Runs `work` as `run`, which ends with its answer, or as a failed request when it throws. */
  const shown = async <R extends { ok: true } | { ok: false; reason: string }>(
    run: ThemeSwitchRun | undefined,
    work: () => Promise<R>,
  ): Promise<R> => {
    try {
      const result = await work()
      run?.finish(outcomeOf(result))
      return result
    } catch (error) {
      run?.finish({ ok: false, reason: 'request' })
      throw error
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
          slotInScope(request.conn, payload.sessionId)
          const run = options.switches?.start({ kind: 'look', plugin: payload.plugin, look: await lookName(payload) })
          return shown(run, () => useLook(payload, request.signal, run))
        }
        case 'onEnable': {
          const payload = request.payload as ThemeOnEnablePayload
          slotInScope(request.conn, payload.sessionId)
          // Carries on the switch the plugin's enable started, else starts one.
          const run =
            options.switches?.join(enableSwitchKey(payload.plugin)) ??
            options.switches?.start({ kind: 'enable', plugin: payload.plugin })
          return shown(run, () => onEnable(payload, request.signal, run))
        }
        case 'clear':
          return clearSessionTheme(slotInScope(request.conn, (request.payload as ThemeClearPayload).sessionId))
        default:
          throw wireError('unknown_route', `theme has no action '${request.route.act}'`)
      }
    },
  })
  return {
    /** Every look or enable waiting for a turn stops waiting and runs nothing (`notLoaded`). */
    cancelWaiting: () => {
      for (const stop of [...waits]) stop.abort()
    },
  }
}
