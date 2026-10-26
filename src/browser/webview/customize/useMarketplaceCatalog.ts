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
  /** Official marketplaces first; null until the first read answers. */
  marketplaces: PluginMarketplaceUiEntry[] | null
  failed: boolean
}

/** The marketplaces registered here (F-35), read once per mount. */
export function useMarketplaceList(bridge: NexusSettingsBridge | null): MarketplaceListView {
  const [view, setView] = React.useState<MarketplaceListView>({ marketplaces: null, failed: false })
  React.useEffect(() => {
    if (!bridge) {
      setView({ marketplaces: [], failed: false })
      return
    }
    let live = true
    pluginsListMarketplaces(bridge).then(
      result => {
        if (!live) return
        const marketplaces = [...result.marketplaces].sort(
          (a, b) => Number(b.isOfficial) - Number(a.isOfficial) || a.name.localeCompare(b.name),
        )
        setView({ marketplaces, failed: false })
      },
      () => {
        if (live) setView({ marketplaces: [], failed: true })
      },
    )
    return () => {
      live = false
    }
  }, [bridge])
  return view
}

export type MarketplacePluginsView = {
  /** `notFetched`: the marketplace was added but has no local copy yet. */
  status: 'loading' | 'ready' | 'notFetched' | 'failed'
  plugins: PluginAvailableUiEntry[]
  /** Plugin names whose install is running. */
  installing: ReadonlySet<string>
  /** Plugin names whose last install failed. */
  installFailed: ReadonlySet<string>
  downloading: boolean
  install: (plugin: string) => void
  download: () => void
}

const NONE: ReadonlySet<string> = new Set()

/**
 * One marketplace's plugins (F-35) from its local copy, never fetched on
 * read; `download` fetches it, and `install` installs `<plugin>@<marketplace>`
 * and re-reads the list.
 */
export function useMarketplacePlugins(
  bridge: NexusSettingsBridge | null,
  marketplace: string | null,
): MarketplacePluginsView {
  const [status, setStatus] = React.useState<MarketplacePluginsView['status']>('loading')
  const [plugins, setPlugins] = React.useState<PluginAvailableUiEntry[]>([])
  const [installing, setInstalling] = React.useState<ReadonlySet<string>>(NONE)
  const [installFailed, setInstallFailed] = React.useState<ReadonlySet<string>>(NONE)
  const [downloading, setDownloading] = React.useState(false)
  const current = React.useRef(marketplace)
  current.current = marketplace

  const read = React.useCallback(
    (name: string) => {
      if (!bridge) return Promise.resolve()
      return pluginsListMarketplacePlugins(bridge, name).then(
        result => {
          if (current.current !== name) return
          setPlugins(result.manifest?.plugins ?? [])
          setStatus(result.manifest ? 'ready' : 'notFetched')
        },
        () => {
          if (current.current === name) setStatus('failed')
        },
      )
    },
    [bridge],
  )

  React.useEffect(() => {
    setPlugins([])
    setInstalling(NONE)
    setInstallFailed(NONE)
    setDownloading(false)
    if (!marketplace) return
    if (!bridge) {
      setStatus('failed')
      return
    }
    setStatus('loading')
    void read(marketplace)
  }, [bridge, marketplace, read])

  const install = React.useCallback(
    (plugin: string) => {
      const name = marketplace
      if (!bridge || !name) return
      const without = (set: ReadonlySet<string>) => new Set([...set].filter(p => p !== plugin))
      setInstalling(set => new Set(set).add(plugin))
      setInstallFailed(without)
      pluginsInstall(bridge, `${plugin}@${name}`)
        .then(
          () => read(name),
          () => {
            if (current.current === name) setInstallFailed(set => new Set(set).add(plugin))
          },
        )
        .finally(() => {
          if (current.current === name) setInstalling(without)
        })
    },
    [bridge, marketplace, read],
  )

  const download = React.useCallback(() => {
    const name = marketplace
    if (!bridge || !name) return
    setDownloading(true)
    pluginsRefreshMarketplace(bridge, name)
      .then(
        () => read(name),
        () => {
          if (current.current === name) setStatus('failed')
        },
      )
      .finally(() => {
        if (current.current === name) setDownloading(false)
      })
  }, [bridge, marketplace, read])

  return { status, plugins, installing, installFailed, downloading, install, download }
}

/**
 * The directory's details for `marketplace`'s plugins (F-35), keyed by
 * plugin name; empty while they are read and when they cannot be. Read once
 * per selected marketplace.
 */
export function useMarketplaceDetails(
  describe: (marketplace: string) => Promise<CustomizeMarketplaceDescription>,
  marketplace: string | null,
): Record<string, DirectoryItemDetails> {
  const [details, setDetails] = React.useState<Record<string, DirectoryItemDetails>>({})
  React.useEffect(() => {
    setDetails({})
    if (!marketplace) return
    let live = true
    describe(marketplace).then(
      result => {
        if (live) setDetails(result.plugins)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [describe, marketplace])
  return details
}
