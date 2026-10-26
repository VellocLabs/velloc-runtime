import * as React from 'react'
import { ArrowLeftIcon, ChevronLeftIcon, GlobeIcon, HomeIcon, StoreIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { WindowDragRect } from '../../bridge/protocol/ui'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { ShellChannel } from '../../runtimeClient/shellChannel'
import { useT } from '../i18n'
import { useSettingsBridge } from '../nexusSettingsBridge'
import type { SettingsSectionId } from '../settings/settingsNav'
import { TOP_BAR_HEIGHT_CLASS } from '../topbar/barHeight'
import { useWindowDragRegions } from '../topbar/useWindowDragRegions'
import { WebviewArea } from '../WebviewArea'
import { AddItemDialog } from './AddItemDialog'
import { DirectoryItemStatus } from './DirectoryItemStatus'
import { MarketplacePluginList } from './MarketplacePluginList'
import { useCustomizeTab } from './useCustomizeTab'
import { useMarketplaceDetails, useMarketplaceList, useMarketplacePlugins } from './useMarketplaceCatalog'

export type CustomizeScreenProps = {
  runtimeConnection?: () => Promise<RuntimeConnection>
  /** Where the right column's placeholder publishes its rect. */
  shell: ShellChannel | null
  onClose: () => void
  onOpenSettings: (section: SettingsSectionId) => void
  onDragRegionsChange?: (regions: WindowDragRect[]) => void
}

/** The left list's selection: the directory page, or a marketplace by name. */
type Selection = { kind: 'directory' } | { kind: 'marketplace'; name: string }

const DIRECTORY: Selection = { kind: 'directory' }

/**
 * The Customize screen (F-35): takes the window like Settings does. Left,
 * the directory and the marketplaces registered here. Right, the directory
 * page in this window's `customize` utility tab (painted by the native tab
 * view), or the selected marketplace's plugins. The top bar centres the
 * page's Home / Back and its item's status; the page's own add button opens
 * a dialog that confirms and installs that item.
 */
export function CustomizeScreen({
  runtimeConnection,
  shell,
  onClose,
  onOpenSettings,
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
  const marketName = selection.kind === 'marketplace' ? selection.name : null
  const market = useMarketplacePlugins(bridge, marketName)
  const marketDetails = useMarketplaceDetails(tab.describeMarketplace, marketName)
  const [answeredSeq, setAnsweredSeq] = React.useState(0)
  const ask = tab.addRequest
  const askedItem =
    onDirectory && ask && ask.seq > answeredSeq && tab.pageItem?.id === ask.itemId ? tab.pageItem : null
  const closeAsk = React.useCallback(() => setAnsweredSeq(seq => Math.max(seq, ask?.seq ?? seq)), [ask])
  const showDirectory = !tab.unavailable && onDirectory
  const openInDirectory = (path: string) => {
    setSelection(DIRECTORY)
    tab.openPage(path)
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
        className={cn(
          'grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b px-3',
          TOP_BAR_HEIGHT_CLASS,
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="customize-back"
            data-app-region="no-drag"
            aria-label={t('customize.back')}
            title={t('customize.back')}
            onClick={onClose}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span data-testid="customize-title" className="truncate px-1 font-semibold text-base text-foreground">
            {onDirectory ? t('customize.directory.title') : selection.name}
          </span>
        </div>
        <div data-testid="customize-center" className="flex min-w-0 max-w-[min(44rem,60vw)] items-center gap-3">
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
          {showDirectory && tab.pageItem ? (
            <DirectoryItemStatus item={tab.pageItem} onAdd={tab.addPageItem} onOpenSettings={onOpenSettings} />
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
          {list.marketplaces === null ? (
            <p className="px-2 py-1 text-sm text-muted-foreground">{t('customize.loading')}</p>
          ) : (
            list.marketplaces.map(m => (
              <MarketRow
                key={m.name}
                testId="customize-market"
                name={m.name}
                selected={selection.kind === 'marketplace' && selection.name === m.name}
                icon={<StoreIcon className="size-4" />}
                badge={m.isOfficial ? t('customize.markets.official') : undefined}
                onSelect={() => setSelection({ kind: 'marketplace', name: m.name })}
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
          {selection.kind === 'marketplace' ? (
            <MarketplacePluginList
              marketplace={selection.name}
              view={market}
              details={marketDetails}
              onOpenInDirectory={openInDirectory}
              onOpenSettings={onOpenSettings}
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
          ) : askedItem ? (
            // The native view paints above the guest; it gives way while the dialog asks.
            <div data-testid="customize-page-held" aria-hidden className="min-h-0 flex-1 bg-muted/20" />
          ) : (
            <WebviewArea active shell={shell} />
          )}
        </div>
      </div>
      <AddItemDialog item={askedItem} onAdd={tab.addPageItem} onOpenSettings={onOpenSettings} onClose={closeAsk} />
    </div>
  )
}

function MarketRow({
  testId,
  name,
  detail,
  badge,
  icon,
  selected,
  onSelect,
}: {
  testId: string
  name: string
  detail?: string
  badge?: string
  icon: React.ReactNode
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-name={name}
      aria-current={selected ? 'page' : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'bg-accent',
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{name}</span>
        {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      {badge ? (
        <Badge variant="secondary" className="shrink-0">
          {badge}
        </Badge>
      ) : null}
    </button>
  )
}
