import { CheckIcon, Loader2Icon } from 'lucide-react'

import { Button } from '@/components/ui/button'

import { useT } from '../i18n'
import { ItemAvatar } from './ItemAvatar'
import type { MarketplacePluginsView } from './useMarketplaceCatalog'

/**
 * One marketplace's plugins (F-35), in the same row shape the top bar uses
 * for a directory item: name and author, then Add or Installed.
 */
export function MarketplacePluginList({ marketplace, view }: { marketplace: string; view: MarketplacePluginsView }) {
  const t = useT()

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

  return (
    <ul data-testid="customize-market-plugins" data-marketplace={marketplace} className="flex flex-col divide-y overflow-y-auto">
      {view.plugins.map(plugin => {
        const installing = view.installing.has(plugin.name)
        return (
          <li
            key={plugin.name}
            data-testid="customize-market-plugin"
            data-name={plugin.name}
            className="flex items-center gap-3 px-4 py-3"
          >
            <ItemAvatar name={plugin.name} className="size-9" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-foreground">{plugin.name}</span>
              {plugin.author?.name ? (
                <span className="truncate text-xs text-muted-foreground">
                  {t('customize.item.byPublisher', { publisher: plugin.author.name })}
                </span>
              ) : null}
              {plugin.description ? (
                <span className="line-clamp-2 text-xs text-muted-foreground">{plugin.description}</span>
              ) : null}
              {view.installFailed.has(plugin.name) ? (
                <span className="text-xs text-destructive">{t('customize.item.failed.install')}</span>
              ) : null}
            </div>
            {plugin.installed ? (
              <span data-testid="customize-market-installed" className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <CheckIcon className="size-3.5" />
                {t('customize.item.installed')}
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={installing}
                data-testid="customize-market-add"
                onClick={() => view.install(plugin.name)}
              >
                {installing ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                {t(installing ? 'customize.item.adding' : 'customize.item.add')}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
