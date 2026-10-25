import * as React from 'react'
import { ArrowLeftIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { WindowDragRect } from '../../bridge/protocol/ui'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { ShellChannel } from '../../runtimeClient/shellChannel'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n/messages/en'
import type { SettingsSectionId } from '../settings/settingsNav'
import { TOP_BAR_HEIGHT_CLASS } from '../topbar/barHeight'
import { useWindowDragRegions } from '../topbar/useWindowDragRegions'
import { WebviewArea } from '../WebviewArea'
import { CUSTOMIZE_SEGMENTS, type CustomizeSegment } from './customizeRoutes'
import { GROUP_SETTINGS_SECTION, INSTALLED_GROUPS, type InstalledGroup } from './installedRows'
import { useCustomizeTab } from './useCustomizeTab'
import { useInstalledInventory } from './useInstalledInventory'

export type CustomizeScreenProps = {
  runtimeConnection?: () => Promise<RuntimeConnection>
  /** Where the right column's placeholder publishes its rect. */
  shell: ShellChannel | null
  onClose: () => void
  onOpenSettings: (section: SettingsSectionId) => void
  onDragRegionsChange?: (regions: WindowDragRect[]) => void
}

const GROUP_LABEL: Record<InstalledGroup, MessageKey> = {
  plugins: 'customize.group.plugins',
  mods: 'customize.group.mods',
  skills: 'customize.group.skills',
  mcp: 'customize.group.mcp',
}

const GROUP_EMPTY: Record<InstalledGroup, MessageKey> = {
  plugins: 'customize.empty.plugins',
  mods: 'customize.empty.mods',
  skills: 'customize.empty.skills',
  mcp: 'customize.empty.mcp',
}

const SEGMENT_LABEL: Record<CustomizeSegment, MessageKey> = {
  skills: 'customize.tab.skills',
  connectors: 'customize.tab.connectors',
  plugins: 'customize.tab.plugins',
}

/**
 * The Customize screen (F-35): takes the window like Settings does. Left,
 * what is installed here (read-only; a row opens the Settings page that
 * manages it). Right, the marketplace pages in this window's `customize`
 * utility tab, which the native tab view paints over the placeholder.
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
  const inventory = useInstalledInventory(runtimeConnection, true)
  const tab = useCustomizeTab(runtimeConnection, true)

  return (
    <div
      data-testid="nexus-customize"
      data-segment={tab.segment}
      className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-background"
    >
      {/* Replaces the topbar: the window's drag surface and caption reserve
          while the screen is up. */}
      <header
        ref={headerRef}
        data-testid="customize-header"
        className={cn('flex shrink-0 items-center gap-2 border-b px-3', TOP_BAR_HEIGHT_CLASS)}
      >
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
        <button
          type="button"
          data-testid="customize-title"
          data-app-region="no-drag"
          title={t('customize.back')}
          onClick={onClose}
          className="rounded-md px-1 font-semibold text-base text-foreground hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('customize.title')}
        </button>
        <div
          aria-hidden
          data-testid="customize-caption-inset"
          className="ms-auto shrink-0 self-stretch"
          style={{ width: 'var(--nexus-caption-inset, 0px)' }}
        />
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          aria-label={t('customize.installedAria')}
          data-testid="customize-installed"
          data-loading={inventory.loading || undefined}
          className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r p-3"
        >
          {INSTALLED_GROUPS.map(group => {
            const rows = inventory.rows[group]
            return (
              <section key={group} data-testid={`customize-group-${group}`} className="flex flex-col gap-1">
                <h2 className="flex items-baseline justify-between px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>{t(GROUP_LABEL[group])}</span>
                  <span data-testid={`customize-count-${group}`} className="font-normal tabular-nums">
                    {rows.length}
                  </span>
                </h2>
                {rows.length === 0 ? (
                  <p className="px-1 text-sm text-muted-foreground">
                    {inventory.loading && group !== 'mods' ? t('customize.loading') : t(GROUP_EMPTY[group])}
                  </p>
                ) : (
                  <ul className="flex flex-col">
                    {rows.map(row => (
                      <li key={row.id}>
                        <button
                          type="button"
                          data-testid="customize-row"
                          data-group={group}
                          data-id={row.id}
                          title={t('customize.openInSettings')}
                          onClick={() => onOpenSettings(GROUP_SETTINGS_SECTION[group])}
                          className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="w-full truncate text-sm text-foreground">{row.name}</span>
                          {row.detail ? (
                            <span className="w-full truncate text-xs text-muted-foreground">{row.detail}</span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div role="tablist" data-testid="customize-segments" className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
            {CUSTOMIZE_SEGMENTS.map(segment => (
              <Button
                key={segment}
                type="button"
                role="tab"
                variant={segment === tab.segment ? 'secondary' : 'ghost'}
                size="sm"
                data-testid={`customize-segment-${segment}`}
                aria-selected={segment === tab.segment}
                onClick={() => tab.selectSegment(segment)}
              >
                {t(SEGMENT_LABEL[segment])}
              </Button>
            ))}
          </div>
          <WebviewArea active shell={shell} />
        </div>
      </div>
    </div>
  )
}
