import * as React from 'react'
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, GlobeIcon, Loader2Icon, PlusIcon } from 'lucide-react'

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
import { installKey, type MarketplaceShelf, type MarketplaceShelvesView } from './useMarketplaceCatalog'

/** Cards a marketplace's section shows before "Show all". */
export const SECTION_LIMIT = 10

export type MarketplaceBrowserProps = {
  /** The browsed marketplaces, in the left list's order. */
  marketplaces: readonly string[]
  view: MarketplaceShelvesView
  /** The marketplace last chosen in the left list; a new `nonce` scrolls to it again. */
  focus: { name: string; nonce: number } | null
  /** Opens the add-marketplace dialog; offered when nothing is added yet. */
  onAdd?: () => void
  /** Shows a directory page (by path) in the plugin directory. */
  onOpenInDirectory: (path: string) => void
  onOpenSettings: (section: SettingsSectionId) => void
}

type Route =
  | { page: 'home' }
  | { page: 'all'; marketplace: string }
  | { page: 'detail'; marketplace: string; plugin: string; from: 'home' | 'all' }

/**
 * The marketplaces added here (F-35), browsed as the plugin directory is: a
 * start page with one section per marketplace (its first ten plugins as
 * cards, and Show all), a page per marketplace with every plugin, and a
 * detail page per plugin with Add. Choosing a marketplace in the left list
 * returns to the start page at its section.
 */
export function MarketplaceBrowser(props: MarketplaceBrowserProps) {
  const { marketplaces, view, focus } = props
  const t = useT()
  const [chosen, setRoute] = React.useState<Route>({ page: 'home' })
  // A page of a marketplace that was removed falls back to the start page.
  const route: Route = chosen.page === 'home' || marketplaces.includes(chosen.marketplace) ? chosen : { page: 'home' }
  const scroller = React.useRef<HTMLDivElement | null>(null)
  const sections = React.useRef(new Map<string, HTMLElement>())

  React.useEffect(() => {
    if (focus) setRoute({ page: 'home' })
  }, [focus])
  React.useEffect(() => {
    if (!focus || route.page !== 'home') return
    sections.current.get(focus.name)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [focus, route.page])
  React.useEffect(() => {
    if (route.page !== 'home') scroller.current?.scrollTo?.({ top: 0 })
  }, [route])

  const shelfOf = (name: string): MarketplaceShelf =>
    view.shelves[name] ?? { status: 'loading', plugins: [], refreshing: false, details: {} }

  if (route.page === 'detail') {
    const shelf = shelfOf(route.marketplace)
    const plugin = shelf.plugins.find(p => p.name === route.plugin)
    if (plugin) {
      return (
        <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <PluginDetail
            {...props}
            marketplace={route.marketplace}
            plugin={plugin}
            details={shelf.details[plugin.name]}
            backLabel={
              route.from === 'all'
                ? t('customize.detail.backTo', { name: route.marketplace })
                : t('customize.browse.backHome')
            }
            onBack={() =>
              setRoute(route.from === 'all' ? { page: 'all', marketplace: route.marketplace } : { page: 'home' })
            }
          />
        </div>
      )
    }
  }

  if (route.page === 'all') {
    const shelf = shelfOf(route.marketplace)
    return (
      <div ref={scroller} data-testid="customize-market-all" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="px-6 pt-4">
          <Button type="button" variant="ghost" size="sm" data-testid="customize-market-all-back" onClick={() => setRoute({ page: 'home' })}>
            <ArrowLeftIcon className="size-4" />
            {t('customize.browse.backHome')}
          </Button>
        </div>
        <Section
          marketplace={route.marketplace}
          shelf={shelf}
          view={view}
          onOpen={plugin => setRoute({ page: 'detail', marketplace: route.marketplace, plugin, from: 'all' })}
        />
      </div>
    )
  }

  return (
    <div ref={scroller} data-testid="customize-browse" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-1 px-6 pt-6 pb-2">
        <h2 className="text-xl font-semibold text-foreground">{t('customize.browse.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('customize.browse.subtitle')}</p>
      </div>
      {marketplaces.length === 0 ? (
        <div role="status" data-testid="customize-browse-empty" className="flex flex-col items-start gap-3 px-6 py-4">
          <p className="text-sm text-muted-foreground">{t('customize.browse.empty')}</p>
          {props.onAdd ? (
            <Button type="button" size="sm" data-testid="customize-browse-add" onClick={props.onAdd}>
              <PlusIcon className="size-4" />
              {t('customize.addMarket.open')}
            </Button>
          ) : null}
        </div>
      ) : (
        marketplaces.map(name => (
          <Section
            key={name}
            marketplace={name}
            shelf={shelfOf(name)}
            view={view}
            limit={SECTION_LIMIT}
            sectionRef={el => {
              if (el) sections.current.set(name, el)
              else sections.current.delete(name)
            }}
            onShowAll={() => setRoute({ page: 'all', marketplace: name })}
            onOpen={plugin => setRoute({ page: 'detail', marketplace: name, plugin, from: 'home' })}
          />
        ))
      )}
    </div>
  )
}

/** One marketplace: its name, how many plugins it lists, and its cards (the first `limit`, else all). */
function Section({
  marketplace,
  shelf,
  view,
  limit,
  sectionRef,
  onShowAll,
  onOpen,
}: {
  marketplace: string
  shelf: MarketplaceShelf
  view: MarketplaceShelvesView
  limit?: number
  sectionRef?: (el: HTMLElement | null) => void
  onShowAll?: () => void
  onOpen: (plugin: string) => void
}) {
  const t = useT()
  const shown = limit === undefined ? shelf.plugins : shelf.plugins.slice(0, limit)
  const more = shelf.plugins.length > shown.length

  let body: React.ReactNode
  if (shelf.status === 'loading') {
    body = <p className="text-sm text-muted-foreground">{t('customize.loading')}</p>
  } else if (shelf.status === 'failed') {
    body = (
      <p data-testid="customize-market-failed" className="text-sm text-destructive">
        {t('customize.market.loadFailed')}
      </p>
    )
  } else if (shelf.status === 'notFetched') {
    body = (
      <div data-testid="customize-market-not-fetched" className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          {t(shelf.refreshing ? 'customize.browse.downloading' : 'customize.market.notFetched')}
        </p>
        {shelf.refreshing ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="customize-market-download"
            onClick={() => view.refresh(marketplace)}
          >
            {t('customize.market.download')}
          </Button>
        )}
      </div>
    )
  } else if (shelf.plugins.length === 0) {
    body = (
      <p data-testid="customize-market-empty" className="text-sm text-muted-foreground">
        {t('customize.market.empty')}
      </p>
    )
  } else {
    body = (
      <ul
        data-testid="customize-market-plugins"
        data-marketplace={marketplace}
        className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3"
      >
        {shown.map(plugin => (
          <PluginCard
            key={plugin.name}
            marketplace={marketplace}
            plugin={plugin}
            details={shelf.details[plugin.name]}
            view={view}
            onOpen={() => onOpen(plugin.name)}
          />
        ))}
      </ul>
    )
  }

  return (
    <section
      ref={sectionRef}
      data-testid="customize-market-section"
      data-marketplace={marketplace}
      aria-label={marketplace}
      className="flex scroll-mt-2 flex-col gap-3 px-6 py-4"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="truncate text-base font-semibold text-foreground">{marketplace}</h3>
        {shelf.status === 'ready' ? (
          <span className="shrink-0 text-sm text-muted-foreground">
            {t('customize.market.count', { count: String(shelf.plugins.length) })}
          </span>
        ) : null}
        {shelf.refreshing && shelf.status !== 'notFetched' ? (
          <span data-testid="customize-market-refreshing" className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            {t('customize.browse.updating')}
          </span>
        ) : null}
        {more && onShowAll ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ms-auto shrink-0"
            data-testid="customize-market-show-all"
            onClick={onShowAll}
          >
            {t('customize.browse.showAll', { count: String(shelf.plugins.length) })}
            <ChevronRightIcon className="size-4" />
          </Button>
        ) : null}
      </div>
      {body}
    </section>
  )
}

function PluginCard({
  marketplace,
  plugin,
  details,
  view,
  onOpen,
}: {
  marketplace: string
  plugin: PluginAvailableUiEntry
  details: DirectoryItemDetails | undefined
  view: MarketplaceShelvesView
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
      {view.installFailed.has(installKey(marketplace, plugin.name)) ? (
        <p role="status" className="text-xs text-destructive">
          {t('customize.item.failed.install')}
        </p>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2">
        <PartCounts parts={details?.components} />
        <span className="relative ms-auto shrink-0">
          <AddButton marketplace={marketplace} plugin={plugin} view={view} size="xs" />
        </span>
      </div>
    </li>
  )
}

/** Add, Adding…, or Installed, for one plugin of a marketplace. */
function AddButton({
  marketplace,
  plugin,
  view,
  size = 'sm',
}: {
  marketplace: string
  plugin: PluginAvailableUiEntry
  view: MarketplaceShelvesView
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
  const installing = view.installing.has(installKey(marketplace, plugin.name))
  return (
    <Button
      type="button"
      size={size}
      disabled={installing}
      data-testid="customize-market-add"
      onClick={() => view.install(marketplace, plugin.name)}
    >
      {installing ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
      {t(installing ? 'customize.item.adding' : 'customize.item.add')}
    </Button>
  )
}

function PluginDetail({
  marketplace,
  view,
  plugin,
  details,
  backLabel,
  onBack,
  onOpenInDirectory,
  onOpenSettings,
}: MarketplaceBrowserProps & {
  marketplace: string
  plugin: PluginAvailableUiEntry
  details: DirectoryItemDetails | undefined
  backLabel: string
  onBack: () => void
}) {
  const t = useT()
  const formatDate = useFormatDate()
  const publisher = details?.publisher ?? plugin.author?.name
  const publisherUrl = details?.publisherUrl ?? plugin.author?.url
  const summary = details?.summary ?? plugin.description
  const description = details?.description ?? (details?.summary ? plugin.description : undefined)
  const failed = view.installFailed.has(installKey(marketplace, plugin.name))

  return (
    <div data-testid="customize-market-detail" data-name={plugin.name} className="flex flex-col">
      <div className="px-6 pt-4">
        <Button type="button" variant="ghost" size="sm" data-testid="customize-market-detail-back" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
          {backLabel}
        </Button>
      </div>

      <header className="flex flex-wrap items-start gap-4 px-6 pt-3 pb-5">
        <ItemAvatar name={details?.name ?? plugin.name} iconUrl={details?.iconUrl} className="size-16 rounded-xl text-xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="truncate text-xl font-semibold text-foreground">{plugin.name}</h2>
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{t('customize.item.kind.plugin')}</span>
            {publisher ? <span className="truncate">· {t('customize.item.byPublisher', { publisher })}</span> : null}
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
          <AddButton marketplace={marketplace} plugin={plugin} view={view} />
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
