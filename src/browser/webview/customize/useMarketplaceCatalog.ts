import * as React from 'react'

import type { CustomizeMarketplaceDescription } from '../../../customize/customizePageProtocol'
import type { DirectoryItemDetails } from '../../../customize/directoryOffer'
import type { PluginAvailableUiEntry, PluginMarketplaceUiEntry } from '../../bridge/protocol/plugins'
import type { NexusSettingsBridge } from '../nexusSettingsBridge'
import {
  pluginsInstall,
  pluginsListMarketplacePlugins,
  pluginsListMarketplaces,
  pluginsRefreshMarketplace,
} from '../settings/clients'

export type MarketplaceListView = {
  /** The marketplaces the screen browses; null until the first read answers. */
  marketplaces: PluginMarketplaceUiEntry[] | null
  failed: boolean
  /** Reads the list again (after an add or a remove). */
  reload: () => Promise<void>
}

/**
 * The marketplaces added here that the screen browses (F-35), by name.
 * Official marketplaces are left out (the plugin directory already shows
 * their plugins), and so is the built-in one.
 */
export function useMarketplaceList(bridge: NexusSettingsBridge | null): MarketplaceListView {
  const [state, setState] = React.useState<Omit<MarketplaceListView, 'reload'>>({
    marketplaces: null,
    failed: false,
  })
  const live = React.useRef(true)
  const reload = React.useCallback(async () => {
    if (!bridge) {
      if (live.current) setState({ marketplaces: [], failed: false })
      return
    }
    try {
      const result = await pluginsListMarketplaces(bridge)
      const marketplaces = result.marketplaces
        .filter(m => !m.isOfficial && !m.isBuiltin)
        .sort((x, y) => x.name.localeCompare(y.name))
      if (live.current) setState({ marketplaces, failed: false })
    } catch {
      if (live.current) setState(prev => ({ marketplaces: prev.marketplaces ?? [], failed: true }))
    }
  }, [bridge])
  React.useEffect(() => {
    live.current = true
    void reload()
    return () => {
      live.current = false
    }
  }, [reload])
  return { ...state, reload }
}

/** One marketplace's plugins as the screen shows them. */
export type MarketplaceShelf = {
  /** `notFetched`: added, with no local copy yet. */
  status: 'loading' | 'ready' | 'notFetched' | 'failed'
  plugins: PluginAvailableUiEntry[]
  /** Fetching the latest list from the marketplace's source. */
  refreshing: boolean
  /** The directory's details per plugin name, for the plugins it carries. */
  details: Record<string, DirectoryItemDetails>
}

export type MarketplaceShelvesView = {
  shelves: Record<string, MarketplaceShelf>
  /** `<plugin>@<marketplace>` keys whose install is running / whose last install failed. */
  installing: ReadonlySet<string>
  installFailed: ReadonlySet<string>
  install: (marketplace: string, plugin: string) => void
  /** Fetches a marketplace's list from its source and reads it again. */
  refresh: (marketplace: string) => void
}

const NONE: ReadonlySet<string> = new Set()
const LOADING: MarketplaceShelf = { status: 'loading', plugins: [], refreshing: false, details: {} }

export const installKey = (marketplace: string, plugin: string) => `${plugin}@${marketplace}`

/**
 * Every browsed marketplace's plugins (F-35). Each is read from its local
 * copy at once, then fetched from its source in the background — every time
 * the screen mounts, and when it joins the list — and read again; the
 * directory's details for its plugins follow. `install` installs
 * `<plugin>@<marketplace>` and reads that list again.
 */
export function useMarketplaceShelves(
  bridge: NexusSettingsBridge | null,
  names: readonly string[],
  describe: (marketplace: string) => Promise<CustomizeMarketplaceDescription>,
): MarketplaceShelvesView {
  const [shelves, setShelves] = React.useState<Record<string, MarketplaceShelf>>({})
  const [installing, setInstalling] = React.useState<ReadonlySet<string>>(NONE)
  const [installFailed, setInstallFailed] = React.useState<ReadonlySet<string>>(NONE)
  const live = React.useRef(true)
  React.useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const patch = React.useCallback((name: string, change: Partial<MarketplaceShelf>) => {
    if (!live.current) return
    setShelves(all => (name in all ? { ...all, [name]: { ...all[name]!, ...change } } : all))
  }, [])

  const read = React.useCallback(
    (name: string) => {
      if (!bridge) return Promise.resolve()
      return pluginsListMarketplacePlugins(bridge, name).then(
        result =>
          patch(name, {
            plugins: result.manifest?.plugins ?? [],
            status: result.manifest ? 'ready' : 'notFetched',
          }),
        () => patch(name, { status: 'failed' }),
      )
    },
    [bridge, patch],
  )

  const fetchLatest = React.useCallback(
    (name: string): Promise<void> => {
      if (!bridge) return Promise.resolve()
      patch(name, { refreshing: true })
      return pluginsRefreshMarketplace(bridge, name)
        .then(
          () => read(name),
          () => undefined,
        )
        .finally(() => patch(name, { refreshing: false }))
    },
    [bridge, patch, read],
  )
  const refresh = React.useCallback((name: string) => void fetchLatest(name), [fetchLatest])

  // The names already started, per bridge: a name joining the list starts on
  // its own, without reading the others again.
  const started = React.useRef<{ bridge: NexusSettingsBridge | null; names: Set<string> }>({
    bridge: null,
    names: new Set(),
  })
  const key = names.join('\n')
  React.useEffect(() => {
    const list = key ? key.split('\n') : []
    if (!bridge) {
      setShelves(Object.fromEntries(list.map(n => [n, { ...LOADING, status: 'failed' as const }])))
      return
    }
    if (started.current.bridge !== bridge) started.current = { bridge, names: new Set() }
    const seen = started.current.names
    const fresh = list.filter(n => !seen.has(n))
    for (const name of seen) if (!list.includes(name)) seen.delete(name)
    for (const name of fresh) seen.add(name)
    setShelves(all => {
      const next: Record<string, MarketplaceShelf> = {}
      for (const name of list) next[name] = fresh.includes(name) ? LOADING : (all[name] ?? LOADING)
      return next
    })
    for (const name of fresh) {
      void read(name)
        .then(() => fetchLatest(name))
        .then(() => describe(name))
        .then(
          result => patch(name, { details: result.plugins }),
          () => undefined,
        )
    }
  }, [bridge, key, read, fetchLatest, describe, patch])

  const install = React.useCallback(
    (marketplace: string, plugin: string) => {
      if (!bridge) return
      const id = installKey(marketplace, plugin)
      const without = (set: ReadonlySet<string>) => new Set([...set].filter(k => k !== id))
      setInstalling(set => new Set(set).add(id))
      setInstallFailed(without)
      pluginsInstall(bridge, id)
        .then(
          () => read(marketplace),
          () => {
            if (live.current) setInstallFailed(set => new Set(set).add(id))
          },
        )
        .finally(() => {
          if (live.current) setInstalling(without)
        })
    },
    [bridge, read],
  )

  return { shelves, installing, installFailed, install, refresh }
}
