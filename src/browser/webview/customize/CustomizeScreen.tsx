import * as React from 'react'
import { ArrowLeftIcon, ChevronLeftIcon, GlobeIcon, HomeIcon, PlusIcon, StoreIcon, Trash2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { WindowDragRect } from '../../bridge/protocol/ui'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { ShellChannel } from '../../runtimeClient/shellChannel'
import type { DirectoryPageItem } from '../../../customize/directoryOffer'
import { useT } from '../i18n'
import { useSettingsBridge } from '../nexusSettingsBridge'
import type { SettingsSectionId } from '../settings/settingsNav'
import { TOP_BAR_HEIGHT_CLASS } from '../topbar/barHeight'
import { useWindowDragRegions } from '../topbar/useWindowDragRegions'
import { WebviewArea } from '../WebviewArea'
import { AddItemDialog } from './AddItemDialog'
import { DirectoryItemStatus } from './DirectoryItemStatus'
import { pluginsAddMarketplace, pluginsRemoveMarketplace } from '../settings/clients'
import { MarketplaceBrowser } from './MarketplaceBrowser'
import { AddMarketplaceDialog, RemoveMarketplaceDialog } from './MarketplaceDialogs'
import { useCustomizeTab } from './useCustomizeTab'
import { useMarketplaceList, useMarketplaceShelves } from './useMarketplaceCatalog'

export type CustomizeScreenProps = {
  runtimeConnection?: () => Promise<RuntimeConnection>
  /** Where the right column's placeholder publishes its rect. */
  shell: ShellChannel | null
  onClose: () => void
  onOpenSettings: (section: SettingsSectionId) => void
  /** Settings → Plugins, scrolled to the plugin `name`'s row, which flashes. */
  onOpenPluginSettings?: (name: string) => void
  /** Settings → MCP, scrolled to the server `id`'s row, which flashes. */
  onOpenMcpServerSettings?: (id: string) => void
  onDragRegionsChange?: (regions: WindowDragRect[]) => void
}

/**
 * The left list's selection: the directory page, or the marketplaces' start
 * page scrolled to the one last chosen (a new `nonce` scrolls to it again).
 */
type Selection = { kind: 'directory' } | { kind: 'browse'; focus: { name: string; nonce: number } | null }

const DIRECTORY: Selection = { kind: 'directory' }

/**
 * The Customize screen (F-35): takes the window like Settings does. Left,
 * the directory and the marketplaces added here. Right, the directory page
 * in this window's `customize` utility tab (painted by the native tab view),
 * or those marketplaces' start page. Over the right column the top bar
 * holds the page's Home / Back at its left edge and the page item's status
 * in its centre; the page's own add button opens a confirming dialog.
 */
export function CustomizeScreen({
  runtimeConnection,
  shell,
  onClose,
  onOpenSettings,
  onOpenPluginSettings,
  onOpenMcpServerSettings,
  onDragRegionsChange,
}: CustomizeScreenProps) {
  const t = useT()
  const headerRef = React.useRef<HTMLElement | null>(null)
  useWindowDragRegions(headerRef, onDragRegionsChange)
  const [selection, setSelection] = React.useState<Selection>(DIRECTORY)
  const onDirectory = selection.kind === 'directory'
  const tab = useCustomizeTab(runtimeConnection, onDirectory)
  const bridge = useSettingsBridge()
  const list = useMarketplaceList(bridge)
  const names = React.useMemo(() => (list.marketplaces ?? []).map(m => m.name), [list.marketplaces])
  const shelves = useMarketplaceShelves(bridge, names, tab.describeMarketplace)
  const [addingMarket, setAddingMarket] = React.useState(false)
  const [removing, setRemoving] = React.useState<string | null>(null)
  const nonce = React.useRef(0)
  const browse = React.useCallback((name: string | null) => {
    nonce.current += 1
    setSelection({ kind: 'browse', focus: name === null ? null : { name, nonce: nonce.current } })
  }, [])
  const addMarket = React.useCallback(
    async (source: string) => {
      if (!bridge) throw new Error('')
      const result = await pluginsAddMarketplace(bridge, source)
      if (result.status === 'added') await list.reload()
      return result
    },
    [bridge, list],
  )
  const removeMarket = React.useCallback(
    async (name: string) => {
      if (!bridge) throw new Error('')
      await pluginsRemoveMarketplace(bridge, name)
      await list.reload()
    },
    [bridge, list],
  )
  const [answeredSeq, setAnsweredSeq] = React.useState(0)
  const ask = tab.addRequest
  const askedItem =
    onDirectory && ask && ask.seq > answeredSeq && tab.pageItem?.id === ask.itemId ? tab.pageItem : null
  const closeAsk = React.useCallback(() => setAnsweredSeq(seq => Math.max(seq, ask?.seq ?? seq)), [ask])
  const showDirectory = !tab.unavailable && onDirectory
  // The native view paints above the guest; it gives way while a dialog asks.
  const holdPage = askedItem !== null || addingMarket || removing !== null
  const openInDirectory = (path: string) => {
    setSelection(DIRECTORY)
    tab.openPage(path)
  }
  const managePlugin = (name: string) =>
    onOpenPluginSettings ? onOpenPluginSettings(name) : onOpenSettings('plugins')
  const manageItem = (item: DirectoryPageItem) => {
    const name = item.installedAs
    if (item.kind === 'plugin') {
      if (name) managePlugin(name.split('@')[0]!)
      else onOpenSettings('plugins')
    } else if (name && onOpenMcpServerSettings) onOpenMcpServerSettings(name)
    else onOpenSettings('mcp')
  }

  return (
    <div
      data-testid="nexus-customize"
      className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-background"
    >
      {/* Replaces the topbar: the window's drag surface and caption reserve
          while the screen is up. */}
      <header
        ref={headerRef}
        data-testid="customize-header"
        className={cn('flex shrink-0 items-center border-b', TOP_BAR_HEIGHT_CLASS)}
      >
        <div data-testid="customize-header-start" className="flex w-64 min-w-0 shrink-0 items-center gap-2 px-3">
          <Button
            variant="ghost"
            size="sm"
            data-testid="customize-back"
            data-app-region="no-drag"
            aria-label={t('customize.back')}
            title={t('customize.back')}
            onClick={onClose}
            className="min-w-0 font-semibold text-base text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
            <span data-testid="customize-title" className="truncate">
              {t(onDirectory ? 'customize.directory.title' : 'customize.browse.title')}
            </span>
          </Button>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 self-stretch px-2">
          <div data-testid="customize-page-nav" className="flex min-w-0 items-center">
            {showDirectory ? (
              <div
                role="group"
                aria-label={t('customize.page.navAria')}
                data-app-region="no-drag"
                className="flex shrink-0 items-center rounded-md border"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-e-none"
                  data-testid="customize-page-home"
                  aria-label={t('customize.page.home')}
                  title={t('customize.page.home')}
                  onClick={tab.goHome}
                >
                  <HomeIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-s-none border-s"
                  data-testid="customize-page-back"
                  aria-label={t('customize.page.back')}
                  title={t('customize.page.back')}
                  disabled={!tab.canGoBack}
                  onClick={tab.goBack}
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
              </div>
            ) : null}
          </div>
          <div data-testid="customize-center" className="flex min-w-0 max-w-[min(44rem,50vw)] items-center justify-center">
            {showDirectory && tab.pageItem ? (
              <DirectoryItemStatus
                item={tab.pageItem}
                onAdd={tab.addPageItem}
                onRemove={tab.removePageItem}
                onManage={manageItem}
              />
            ) : null}
          </div>
          <div className="flex min-w-0 items-center justify-end self-stretch">
            <div
              aria-hidden
              data-testid="customize-caption-inset"
              className="shrink-0 self-stretch"
              style={{ width: 'var(--nexus-caption-inset, 0px)' }}
            />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav
          aria-label={t('customize.markets.aria')}
          data-testid="customize-markets"
          className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2"
        >
          <MarketRow
            testId="customize-market-directory"
            selected={onDirectory}
            icon={<GlobeIcon className="size-4" />}
            name={t('customize.directory.title')}
            detail={t('customize.markets.directoryDetail')}
            onSelect={() => setSelection(DIRECTORY)}
          />
          <div className="mt-3 flex items-center gap-1 px-2 pb-1">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
              {t('customize.markets.yours')}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6"
              data-testid="customize-market-add-open"
              aria-label={t('customize.addMarket.open')}
              title={t('customize.addMarket.open')}
              disabled={!bridge}
              onClick={() => setAddingMarket(true)}
            >
              <PlusIcon className="size-4" />
            </Button>
          </div>
          {list.marketplaces === null ? (
            <p className="px-2 py-1 text-sm text-muted-foreground">{t('customize.loading')}</p>
          ) : list.marketplaces.length === 0 ? (
            <p data-testid="customize-markets-none" className="px-2 py-1 text-xs text-muted-foreground">
              {t('customize.markets.none')}
            </p>
          ) : (
            list.marketplaces.map(m => (
              <MarketRow
                key={m.name}
                testId="customize-market"
                name={m.name}
                selected={selection.kind === 'browse' && selection.focus?.name === m.name}
                icon={<StoreIcon className="size-4" />}
                onSelect={() => browse(m.name)}
                onRemove={() => setRemoving(m.name)}
                removeLabel={t('customize.removeMarket.open', { name: m.name })}
              />
            ))
          )}
          {list.failed ? (
            <p role="status" className="px-2 py-1 text-sm text-destructive">
              {t('customize.markets.loadFailed')}
            </p>
          ) : null}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selection.kind === 'browse' ? (
            <MarketplaceBrowser
              marketplaces={names}
              view={shelves}
              focus={selection.focus}
              onAdd={bridge ? () => setAddingMarket(true) : undefined}
              onOpenInDirectory={openInDirectory}
              onOpenSettings={onOpenSettings}
              onManagePlugin={managePlugin}
            />
          ) : tab.unavailable ? (
            <div
              role="status"
              data-testid="customize-unavailable"
              className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
            >
              <p className="text-sm text-muted-foreground">{t('customize.unavailable')}</p>
              <Button type="button" variant="outline" size="sm" data-testid="customize-retry" onClick={tab.retry}>
                {t('customize.retry')}
              </Button>
            </div>
          ) : holdPage ? (
            <div data-testid="customize-page-held" aria-hidden className="min-h-0 flex-1 bg-muted/20" />
          ) : (
            <WebviewArea active shell={shell} />
          )}
        </div>
      </div>
      <AddItemDialog item={askedItem} onAdd={tab.addPageItem} onOpenSettings={onOpenSettings} onClose={closeAsk} />
      <AddMarketplaceDialog
        open={addingMarket}
        onAdd={addMarket}
        onShow={browse}
        onClose={() => setAddingMarket(false)}
      />
      <RemoveMarketplaceDialog name={removing} onRemove={removeMarket} onClose={() => setRemoving(null)} />
    </div>
  )
}

/** A row of the left list; with `onRemove`, a remove button shows on hover, focus, or selection. */
function MarketRow({
  testId,
  name,
  detail,
  icon,
  selected,
  onSelect,
  onRemove,
  removeLabel,
}: {
  testId: string
  name: string
  detail?: string
  icon: React.ReactNode
  selected: boolean
  onSelect: () => void
  onRemove?: () => void
  removeLabel?: string
}) {
  return (
    <div
      data-testid={`${testId}-row`}
      data-name={name}
      className={cn('group relative flex items-center rounded-md hover:bg-accent', selected && 'bg-accent')}
    >
      <button
        type="button"
        data-testid={testId}
        data-name={name}
        aria-current={selected ? 'page' : undefined}
        onClick={onSelect}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          onRemove && 'pe-9',
        )}
      >
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-foreground">{name}</span>
          {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
        </span>
      </button>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="customize-market-remove"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
          className={cn(
            'absolute end-1 size-7 text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100',
            selected && 'opacity-100',
          )}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
