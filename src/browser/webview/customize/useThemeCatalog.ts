import * as React from 'react'

import type { ThemeUseLookResult } from '../../../mods/modThemeLooks'
import { BUILTIN_MARKETPLACE_KEY } from '../../../pluginHost/builtinMarketplace'
import type { ThemeLook } from '../../../pluginHost/registryFormats'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { NexusSettingsBridge } from '../nexusSettingsBridge'
import { pluginsInstall, pluginsRefreshMarketplace } from '../settings/clients'
import {
  appliedLooks,
  askUseLook,
  forgetAppliedLooks,
  lookKey,
  readThemePlugins,
  useWaitingLooks,
  type ThemeFailure,
  type ThemePlugin,
} from '../mods/themeLooks'
import { askThemeOnEnable } from '../mods/themeModsView'
import { installKey, type InstallNotice } from './useMarketplaceCatalog'

export {
  lookInUse,
  lookKey,
  type ThemeFailure,
  type ThemePlugin,
  type ThemeStanding,
} from '../mods/themeLooks'

/** The session a look is applied to, as the shell names it. */
export type ThemeTarget = {
  sessionId: string
  title: string
  /** A turn is running: a look waits for it to end. */
  busy: boolean
}

type ThemeOutcome =
  | { kind: 'applied'; name: string; session: string }
  | { kind: 'failed'; name: string; reason: ThemeFailure; detail?: string }
  /** Picked while the session runs a turn: it applies when the turn ends. */
  | { kind: 'waiting'; name: string; session: string; sessionId: string; key: string }

/** How the last Use ended, for the line above the grid; a new `seq` is a new outcome. */
export type ThemeNotice = ThemeOutcome & { seq: number }

export type ThemeCatalogView = {
  status: 'loading' | 'ready' | 'notFetched' | 'failed'
  plugins: ThemePlugin[]
  /** Fetching the latest list from the marketplace's source. */
  refreshing: boolean
  /** Plugin names whose install is running / whose last install failed. */
  installing: ReadonlySet<string>
  installFailed: ReadonlySet<string>
  /** The look being applied now. */
  applying: string | null
  /** The look waiting for a turn to end, per session id (`waitingLooks`). */
  waiting: Readonly<Record<string, string>>
  /** The look last applied from this window, per session id; `lookInUse` weighs it against the standing theme. */
  inUse: Readonly<Record<string, string>>
  installs: readonly InstallNotice[]
  dismissInstall: (key: string) => void
  notice: ThemeNotice | null
  dismissNotice: () => void
  /** Fetches the list from its source and reads it again. */
  refresh: () => void
  /** Installs the plugin; with `then`, applies that look once it is in place. */
  /** `then`: a look to apply once installed, or only the session to start the plugin in (`theme.onEnable`). */
  add: (plugin: string, then?: { look?: ThemeLook; target: ThemeTarget }) => void
  use: (plugin: string, look: ThemeLook, target: ThemeTarget) => void
  /** Every theme plugin was switched off: no look is in use any more. */
  forgetApplied: () => void
}

const NONE: ReadonlySet<string> = new Set()

/** After an install, the open session loads the plugin in the background; Add & use asks again until it has. */
const AFTER_INSTALL_TRIES = 12
const AFTER_INSTALL_WAIT_MS = 500
const loadingYet = (result: ThemeUseLookResult) =>
  !result.ok && (result.reason === 'notLoaded' || result.reason === 'notOwnCommand')

/**
 * The theme directory (F-35): the built-in marketplace's theme listings,
 * read from the local copy at once and again after a fetch from its source.
 * A look is applied by the runtime (`theme.useLook`), which alone decides
 * what runs; this hook sends a session, a plugin and a look id. Nothing is
 * read until `active` is first true.
 */
export function useThemeCatalog(
  bridge: NexusSettingsBridge | null,
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  active = true,
): ThemeCatalogView {
  const [status, setStatus] = React.useState<ThemeCatalogView['status']>('loading')
  const [plugins, setPlugins] = React.useState<ThemePlugin[]>([])
  const [refreshing, setRefreshing] = React.useState(false)
  const [installing, setInstalling] = React.useState<ReadonlySet<string>>(NONE)
  const [installFailed, setInstallFailed] = React.useState<ReadonlySet<string>>(NONE)
  const [applying, setApplying] = React.useState<string | null>(null)
  const waiting = useWaitingLooks()
  const [inUse, setInUse] = React.useState<Readonly<Record<string, string>>>(appliedLooks)
  const [installs, setInstalls] = React.useState<readonly InstallNotice[]>([])
  const [notice, setNotice] = React.useState<ThemeNotice | null>(null)
  const seq = React.useRef(0)
  const live = React.useRef(true)
  React.useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const read = React.useCallback((): Promise<void> => {
    if (!bridge) return Promise.resolve()
    return readThemePlugins(bridge).then(
      result => {
        if (!live.current) return
        setPlugins(result.plugins)
        setStatus(result.fetched ? 'ready' : 'notFetched')
      },
      () => {
        if (live.current) setStatus('failed')
      },
    )
  }, [bridge])

  const fetchLatest = React.useCallback((): Promise<void> => {
    if (!bridge) return Promise.resolve()
    setRefreshing(true)
    return pluginsRefreshMarketplace(bridge, BUILTIN_MARKETPLACE_KEY)
      .then(
        () => read(),
        () => undefined,
      )
      .finally(() => {
        if (live.current) setRefreshing(false)
      })
  }, [bridge, read])

  const [started, setStarted] = React.useState(active)
  React.useEffect(() => {
    if (active) setStarted(true)
  }, [active])

  React.useEffect(() => {
    if (!started) return
    if (!bridge) {
      setStatus('failed')
      return
    }
    setStatus('loading')
    void read().then(fetchLatest)
  }, [started, bridge, read, fetchLatest])

  const refresh = React.useCallback(() => void fetchLatest(), [fetchLatest])

  const say = React.useCallback((next: ThemeOutcome) => {
    if (!live.current) return
    seq.current += 1
    setNotice({ ...next, seq: seq.current })
  }, [])

  const use = React.useCallback(
    (plugin: string, look: ThemeLook, target: ThemeTarget, tries = 1) => {
      if (!runtimeConnection) return
      const key = lookKey(plugin, look.id)
      const name = look.name ?? look.id
      // A turn is running: the look waits for it, and other looks stay pickable meanwhile.
      const waitForTurn = target.busy
      if (waitForTurn) say({ kind: 'waiting', name, session: target.title, sessionId: target.sessionId, key })
      else setApplying(key)
      const ask = async (left: number, first: boolean): Promise<ThemeUseLookResult | null> => {
        const result = await askUseLook(runtimeConnection, target.sessionId, plugin, look.id, {
          waitForTurn: first && waitForTurn,
        })
        if (result === null || left <= 1 || !loadingYet(result) || !live.current) return result
        await new Promise(resolve => setTimeout(resolve, AFTER_INSTALL_WAIT_MS))
        return ask(left - 1, false)
      }
      ask(tries, true)
        .then(
          result => {
            if (!live.current || result === null) return
            if (result.ok) {
              setInUse(all => ({ ...all, [target.sessionId]: key }))
              say({ kind: 'applied', name, session: target.title })
              return
            }
            const detail = result.reason === 'commandFailed' ? result.text : undefined
            say({ kind: 'failed', name, reason: result.reason, ...(detail ? { detail } : {}) })
          },
          () => say({ kind: 'failed', name, reason: 'request' }),
        )
        .finally(() => {
          if (live.current) setApplying(current => (current === key ? null : current))
        })
    },
    [runtimeConnection, say],
  )

  const forgetApplied = React.useCallback(() => {
    forgetAppliedLooks()
    if (live.current) setInUse({})
  }, [])

  const add = React.useCallback(
    (plugin: string, then?: { look?: ThemeLook; target: ThemeTarget }) => {
      if (!bridge) return
      const id = installKey(BUILTIN_MARKETPLACE_KEY, plugin)
      const without = (set: ReadonlySet<string>) => new Set([...set].filter(k => k !== plugin))
      const announce = (phase: InstallNotice['phase']) => {
        if (!live.current) return
        const entry: InstallNotice = { key: id, marketplace: BUILTIN_MARKETPLACE_KEY, plugin, phase }
        setInstalls(all => [...all.filter(n => n.key !== id), entry])
      }
      setInstalling(set => new Set(set).add(plugin))
      setInstallFailed(without)
      announce('running')
      pluginsInstall(bridge, id)
        .then(
          async result => {
            await read()
            announce(result.ok ? 'installed' : 'notListed')
            if (!result.ok || !then) return
            if (then.look) use(plugin, then.look, then.target, AFTER_INSTALL_TRIES)
            else if (runtimeConnection) askThemeOnEnable(runtimeConnection, then.target.sessionId, plugin)
          },
          () => {
            if (live.current) setInstallFailed(set => new Set(set).add(plugin))
            announce('failed')
          },
        )
        .finally(() => {
          if (live.current) setInstalling(without)
        })
    },
    [bridge, read, use, runtimeConnection],
  )

  const dismissInstall = React.useCallback((key: string) => {
    setInstalls(all => all.filter(n => n.key !== key || n.phase === 'running'))
  }, [])
  const dismissNotice = React.useCallback(() => setNotice(null), [])

  return {
    status,
    plugins,
    refreshing,
    installing,
    installFailed,
    applying,
    waiting,
    inUse,
    installs,
    dismissInstall,
    notice,
    dismissNotice,
    refresh,
    add,
    use,
    forgetApplied,
  }
}
