import * as React from 'react'

import { cn } from '@/lib/utils'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import { useT } from '../i18n'
import { PluginsSection } from '../settings/sections/PluginsSection'
import { settingsPageColumn } from '../settings/SettingsSubpageLayout'
import { PAGE_COLUMN } from './MarketplaceBrowser'
import { YourThemes, type YourThemesProps } from './YourThemes'

export type YoursTab = 'themes' | 'plugins'
const TABS: readonly YoursTab[] = ['themes', 'plugins']

export type YoursPaneProps = {
  tab: YoursTab
  onTab: (tab: YoursTab) => void
  themes: YourThemesProps
  /** For the Plugins tab: the same page as Settings → Plugins & mods. */
  runtimeConnection?: () => Promise<RuntimeConnection>
  revealPluginRequest?: { plugin: string; seq: number } | null
  onOpenModels?: () => void
}

/**
 * Customize → Yours (F-35): the person's theme plugins, and their plugins as Settings shows them.
 * The heading and tabs stay outside the scroller and paint no background, so a theme's page surface shows through.
 */
export function YoursPane({ tab, onTab, themes, runtimeConnection, revealPluginRequest, onOpenModels }: YoursPaneProps) {
  const t = useT()
  return (
    <div data-testid="customize-yours" className="flex min-h-0 flex-1 flex-col">
      <div className={PAGE_COLUMN}>
        <div className={cn(settingsPageColumn, 'flex flex-col gap-3 pt-6 pb-2')}>
          <h2 className="text-xl font-semibold text-foreground">{t('customize.yours.title')}</h2>
          <div
            role="tablist"
            aria-label={t('customize.yours.tabs.aria')}
            data-testid="customize-yours-tabs"
            className="flex w-fit items-center rounded-md border p-0.5"
          >
            {TABS.map(value => (
              <button
                key={value}
                type="button"
                role="tab"
                data-value={value}
                data-testid={`customize-yours-tab-${value}`}
                aria-selected={tab === value}
                onClick={() => onTab(value)}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:focus-ring',
                  tab === value && 'bg-muted text-foreground',
                )}
              >
                {t(`customize.yours.tab.${value}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div data-testid="customize-yours-scroller" className="min-h-0 flex-1 overflow-y-auto">
        <div className={PAGE_COLUMN}>
          <div role="tabpanel" className="pb-6">
            {tab === 'themes' ? (
              <div className={settingsPageColumn}>
                <YourThemes {...themes} />
              </div>
            ) : (
              <div data-testid="customize-yours-plugins" className="pt-2">
                <PluginsSection
                  runtimeConnection={runtimeConnection}
                  revealPluginRequest={revealPluginRequest}
                  onOpenModels={onOpenModels}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
