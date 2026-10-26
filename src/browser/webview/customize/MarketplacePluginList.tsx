import * as React from 'react'
import { ArrowLeftIcon, CheckIcon, GlobeIcon, Loader2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'

import type { DirectoryItemDetails } from '../../../customize/directoryOffer'
import type { PluginAvailableUiEntry } from '../../bridge/protocol/plugins'
import { useT } from '../i18n'
import type { SettingsSectionId } from '../settings/settingsNav'
import { ItemAvatar } from './ItemAvatar'
import {
  FactsAndLinks,
  IncludedParts,
  PartCounts,
  Screenshots,
  VerifiedMark,
  useFormatDate,
} from './ItemDetailsSections'
import type { MarketplacePluginsView } from './useMarketplaceCatalog'

export type MarketplacePluginListProps = {
  marketplace: string
  view: MarketplacePluginsView
  /** The directory's details per plugin name, for the plugins it carries. */
  details: Record<string, DirectoryItemDetails>
  /** Shows a directory page (by path) in the plugin directory. */
  onOpenInDirectory: (path: string) => void
  onOpenSettings: (section: SettingsSectionId) => void
}

/**
 * One marketplace's plugins (F-35) laid out as the directory lays out its
 * own: cards with icon, name, publisher, summary and what each brings, and a
 * detail page per plugin with Add. The marketplace's listing is the source;
 * the directory's record of the same plugin fills in what the listing lacks.
 */
export function MarketplacePluginList(props: MarketplacePluginListProps) {
  const { marketplace, view } = props
  const t = useT()
  const [open, setOpen] = React.useState<string | null>(null)
  React.useEffect(() => setOpen(null), [marketplace])

  if (view.status === 'loading') {
    return (
      <div role="status" data-testid="customize-market-loading" className="p-6 text-sm text-muted-foreground">
        {t('customize.loading')}
      </div>
    )
  }
  if (view.status === 'failed') {
    return (
      <div role="status" data-testid="customize-market-failed" className="p-6 text-sm text-destructive">
        {t('customize.market.loadFailed')}
      </div>
    )
  }
  if (view.status === 'notFetched') {
    return (
      <div
        role="status"
        data-testid="customize-market-not-fetched"
        className="flex flex-col items-center gap-3 p-6 text-center"
      >
        <p className="text-sm text-muted-foreground">{t('customize.market.notFetched')}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={view.downloading}
          data-testid="customize-market-download"
          onClick={view.download}
        >
          {view.downloading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {t('customize.market.download')}
        </Button>
      </div>
    )
  }
  if (view.plugins.length === 0) {
    return (
      <div role="status" data-testid="customize-market-empty" className="p-6 text-sm text-muted-foreground">
        {t('customize.market.empty')}
      </div>
    )
  }

  const selected = open ? view.plugins.find(p => p.name === open) : undefined
  if (selected) return <PluginDetail {...props} plugin={selected} onClose={() => setOpen(null)} />

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-baseline gap-2 px-6 pt-5 pb-3">
        <h2 className="truncate text-lg font-semibold text-foreground">{marketplace}</h2>
        <span className="text-sm text-muted-foreground">
          {t('customize.market.count', { count: String(view.plugins.length) })}
        </span>
      </div>
      <ul
        data-testid="customize-market-plugins"
        data-marketplace={marketplace}
        className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3 px-6 pb-6"
      >
        {view.plugins.map(plugin => (
          <PluginCard
            key={plugin.name}
            plugin={plugin}
            details={props.details[plugin.name]}
            view={view}
            onOpen={() => setOpen(plugin.name)}
          />
        ))}
      </ul>
    </div>
  )
}

function PluginCard({
  plugin,
  details,
  view,
  onOpen,
}: {
  plugin: PluginAvailableUiEntry
  details: DirectoryItemDetails | undefined
  view: MarketplacePluginsView
  onOpen: () => void
}) {
  const t = useT()
  const publisher = details?.publisher ?? plugin.author?.name
  const summary = details?.summary ?? plugin.description
  return (
    <li
      data-testid="customize-market-plugin"
      data-name={plugin.name}
      className="relative flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/40"
    >
      <div className="flex min-w-0 items-start gap-3">
        <ItemAvatar name={details?.name ?? plugin.name} iconUrl={details?.iconUrl} className="size-10" />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The whole card opens the detail page; the stretched button keeps it one control. */}
          <button
            type="button"
            data-testid="customize-market-open"
            onClick={onOpen}
            className="truncate text-left text-sm font-medium text-foreground after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {plugin.name}
          </button>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {publisher ? <span className="truncate">{t('customize.item.byPublisher', { publisher })}</span> : null}
            <VerifiedMark details={details} />
          </span>
        </div>
      </div>
      {summary ? <p className="line-clamp-3 text-xs text-muted-foreground">{summary}</p> : null}
      {view.installFailed.has(plugin.name) ? (
        <p role="status" className="text-xs text-destructive">
          {t('customize.item.failed.install')}
        </p>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2">
        <PartCounts parts={details?.components} />
        <span className="relative ms-auto shrink-0">
          <AddButton plugin={plugin} view={view} size="xs" />
        </span>
      </div>
    </li>
  )
}

/** Add, Adding…, or Installed, for one plugin of the marketplace. */
function AddButton({
  plugin,
  view,
  size = 'sm',
}: {
  plugin: PluginAvailableUiEntry
  view: MarketplacePluginsView
  size?: 'xs' | 'sm'
}) {
  const t = useT()
  if (plugin.installed) {
    return (
      <span data-testid="customize-market-installed" className="flex items-center gap-1 text-xs text-muted-foreground">
        <CheckIcon className="size-3.5" />
        {t('customize.item.installed')}
      </span>
    )
  }
  const installing = view.installing.has(plugin.name)
  return (
    <Button
      type="button"
      size={size}
      disabled={installing}
      data-testid="customize-market-add"
      onClick={() => view.install(plugin.name)}
    >
      {installing ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
      {t(installing ? 'customize.item.adding' : 'customize.item.add')}
    </Button>
  )
}

function PluginDetail({
  marketplace,
  view,
  details: all,
  plugin,
  onClose,
  onOpenInDirectory,
  onOpenSettings,
}: MarketplacePluginListProps & { plugin: PluginAvailableUiEntry; onClose: () => void }) {
  const t = useT()
  const formatDate = useFormatDate()
  const details = all[plugin.name]
  const publisher = details?.publisher ?? plugin.author?.name
  const publisherUrl = details?.publisherUrl ?? plugin.author?.url
  const summary = details?.summary ?? plugin.description
  const description = details?.description ?? (details?.summary ? plugin.description : undefined)
  const failed = view.installFailed.has(plugin.name)

  return (
    <div data-testid="customize-market-detail" data-name={plugin.name} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="px-6 pt-4">
        <Button type="button" variant="ghost" size="sm" data-testid="customize-market-detail-back" onClick={onClose}>
          <ArrowLeftIcon className="size-4" />
          {t('customize.detail.backTo', { name: marketplace })}
        </Button>
      </div>

      <header className="flex flex-wrap items-start gap-4 px-6 pt-3 pb-5">
        <ItemAvatar name={details?.name ?? plugin.name} iconUrl={details?.iconUrl} className="size-16 rounded-xl text-xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="truncate text-xl font-semibold text-foreground">{plugin.name}</h2>
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{t('customize.item.kind.plugin')}</span>
            {publisher ? (
              <span className="truncate">· {t('customize.item.byPublisher', { publisher })}</span>
            ) : null}
            <VerifiedMark details={details} />
          </span>
          {summary ? <p className="mt-1 max-w-2xl text-sm text-foreground">{summary}</p> : null}
          {failed ? (
            <p role="status" className="text-sm text-destructive">
              {t('customize.item.failed.install')}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {details?.pagePath ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="customize-market-in-directory"
              onClick={() => onOpenInDirectory(details.pagePath!)}
            >
              <GlobeIcon className="size-3.5" />
              {t('customize.detail.openInDirectory')}
            </Button>
          ) : null}
          {plugin.installed ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenSettings('plugins')}>
              {t('customize.item.manage')}
            </Button>
          ) : null}
          <AddButton plugin={plugin} view={view} />
        </div>
      </header>

      <div className="grid gap-8 border-t px-6 py-5 md:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Screenshots urls={details?.screenshots} />
          {description ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-foreground">{t('customize.detail.about')}</h3>
              <p data-testid="customize-detail-description" className="whitespace-pre-line text-sm text-muted-foreground">
                {description}
              </p>
            </section>
          ) : null}
          {details?.components?.length ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-foreground">{t('customize.detail.included')}</h3>
              <IncludedParts parts={details.components} />
            </section>
          ) : null}
          {!details ? (
            <p data-testid="customize-detail-not-listed" className="text-xs text-muted-foreground">
              {t('customize.detail.notInDirectory')}
            </p>
          ) : null}
        </div>
        <FactsAndLinks
          details={details}
          homepage={plugin.homepage}
          facts={[
            { label: 'customize.detail.fact.version', value: plugin.version },
            { label: 'customize.detail.fact.category', value: plugin.category },
            { label: 'customize.detail.fact.publisher', value: publisher, href: publisherUrl },
            { label: 'customize.detail.fact.marketplace', value: marketplace },
            { label: 'customize.detail.fact.added', value: formatDate(details?.addedTime) },
            { label: 'customize.detail.fact.updated', value: formatDate(details?.updatedTime) },
          ]}
        />
      </div>
    </div>
  )
}
