import * as React from 'react'

import type { ThemeClearResult, ThemeUseLookResult } from '../../../mods/modThemeLooks'
import { THEME_CAPABILITY } from '../../../mods/modThemeLooks'
import { BUILTIN_MARKETPLACE_KEY } from '../../../pluginHost/builtinMarketplace'
import type { ThemeLook } from '../../../pluginHost/registryFormats'
import type { PluginAvailableUiEntry } from '../../bridge/protocol/plugins'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RouteKey } from '../../runtimeProtocol'
import type { NexusSettingsBridge } from '../nexusSettingsBridge'
import { pluginsInstall, pluginsListMarketplaceThemes, pluginsRefreshMarketplace } from '../settings/clients'
import { installKey, type InstallNotice } from './useMarketplaceCatalog'

/** The session a look is applied to, as the shell names it. */
export type ThemeTarget = {
  sessionId: string
  title: string
  /** A turn is running: a look waits for it to end. */
  busy: boolean
}

/** A theme plugin of the directory: a listing that carries looks. */
export type ThemePlugin = PluginAvailableUiEntry & { theme: NonNullable<PluginAvailableUiEntry['theme']> }

/** `<plugin>/<look id>`; the app's own look is `DEFAULT_LOOK`. */
export const lookKey = (plugin: string, lookId: string) => `${plugin}/${lookId}`
export const DEFAULT_LOOK = ''

export type ThemeFailure = Extract<ThemeUseLookResult, { ok: false }>['reason'] | 'request'

type ThemeOutcome =
  | { kind: 'applied'; name: string; session: string }
  | { kind: 'cleared'; session: string }
  | { kind: 'failed'; name: string; reason: ThemeFailure; detail?: string }

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
  /** The look last applied from this screen, per session id. */
  inUse: Readonly<Record<string, string>>
  installs: readonly InstallNotice[]
  dismissInstall: (key: string) => void
  notice: ThemeNotice | null
  dismissNotice: () => void
  /** Fetches the list from its source and reads it again. */
  refresh: () => void
  /** Installs the plugin; with `then`, applies that look once it is in place. */
  add: (plugin: string, then?: { look: ThemeLook; target: ThemeTarget }) => void
  use: (plugin: string, look: ThemeLook, target: ThemeTarget) => void
  /** Removes the session's theme. */
  clear: (target: ThemeTarget) => void
}

const NONE: ReadonlySet<string> = new Set()

const isThemePlugin = (entry: PluginAvailableUiEntry): entry is ThemePlugin =>
  Array.isArray(entry.theme?.looks) && entry.theme.looks.length > 0

/**
 * The theme directory (F-35): the built-in marketplace's theme listings,
 * read from the local copy at once and again after a fetch from its source.
 * A look is applied by the runtime (`theme.useLook`), which alone decides
 * what runs; this hook sends a session, a plugin and a look id.
 */
export function useThemeCatalog(
  bridge: NexusSettingsBridge | null,
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
): ThemeCatalogView {
  const [status, setStatus] = React.useState<ThemeCatalogView['status']>('loading')
  const [plugins, setPlugins] = React.useState<ThemePlugin[]>([])
  const [refreshing, setRefreshing] = React.useState(false)
  const [installing, setInstalling] = React.useState<ReadonlySet<string>>(NONE)
  const [installFailed, setInstallFailed] = React.useState<ReadonlySet<string>>(NONE)
  const [applying, setApplying] = React.useState<string | null>(null)
  const [inUse, setInUse] = React.useState<Readonly<Record<string, string>>>({})
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
    return pluginsListMarketplaceThemes(bridge, BUILTIN_MARKETPLACE_KEY).then(
      result => {
        if (!live.current) return
        setPlugins((result.manifest?.plugins ?? []).filter(isThemePlugin))
        setStatus(result.manifest ? 'ready' : 'notFetched')
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

  React.useEffect(() => {
    if (!bridge) {
      setStatus('failed')
      return
    }
    setStatus('loading')
    void read().then(fetchLatest)
  }, [bridge, read, fetchLatest])

  const refresh = React.useCallback(() => void fetchLatest(), [fetchLatest])

  const say = React.useCallback((next: ThemeOutcome) => {
    if (!live.current) return
    seq.current += 1
    setNotice({ ...next, seq: seq.current })
  }, [])

  const use = React.useCallback(
    (plugin: string, look: ThemeLook, target: ThemeTarget) => {
      if (!runtimeConnection) return
      const key = lookKey(plugin, look.id)
      const name = look.name ?? look.id
      setApplying(key)
      runtimeConnection()
        .then(conn =>
          conn.request(`${THEME_CAPABILITY}.useLook` as RouteKey, {
            sessionId: target.sessionId,
            plugin,
            lookId: look.id,
          }),
        )
        .then(
          answer => {
            const result = answer as ThemeUseLookResult
            if (!live.current) return
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

  const clear = React.useCallback(
    (target: ThemeTarget) => {
      if (!runtimeConnection) return
      setApplying(DEFAULT_LOOK)
      runtimeConnection()
        .then(conn => conn.request(`${THEME_CAPABILITY}.clear` as RouteKey, { sessionId: target.sessionId }))
        .then(
          answer => {
            if (!live.current || !(answer as ThemeClearResult).ok) return
            setInUse(all => ({ ...all, [target.sessionId]: DEFAULT_LOOK }))
            say({ kind: 'cleared', session: target.title })
          },
          () => say({ kind: 'failed', name: '', reason: 'request' }),
        )
        .finally(() => {
          if (live.current) setApplying(current => (current === DEFAULT_LOOK ? null : current))
        })
    },
    [runtimeConnection, say],
  )

  const add = React.useCallback(
    (plugin: string, then?: { look: ThemeLook; target: ThemeTarget }) => {
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
            if (result.ok && then) use(plugin, then.look, then.target)
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
    [bridge, read, use],
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
    inUse,
    installs,
    dismissInstall,
    notice,
    dismissNotice,
    refresh,
    add,
    use,
    clear,
  }
}
