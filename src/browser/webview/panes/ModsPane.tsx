import type { ReactElement, ReactNode } from 'react'
import { XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ModDockedPane } from '@/components/assistant-ui/mod-render'
import { ModUiContext, type ModUiContextValue } from '@/components/assistant-ui/mod-ui-context'

import { useT } from '../i18n'

/**
 * The Plugins pane's content (F-25, F-9): one tab per pane the session's
 * mods opened, in open order; the body draws the pane in front (the
 * runtime's `isShown`) with `placement: 'dock'`. A tab press shows its pane;
 * its close mark is the person's close (`ui.close`, origin `person`). Renders
 * outside the thread's providers, so it brings the session's mod UI value.
 */
export type ModsPaneProps = {
  modUi: ModUiContextValue
  onCloseTab: (pane: { plugin: string; id: string }) => void
  frame: (parts: { title: ReactNode; body: ReactNode }) => ReactNode
}

export function ModsPane({ modUi, onCloseTab, frame }: ModsPaneProps): ReactElement {
  const t = useT()
  const { panes } = modUi
  const shown = panes.find(pane => pane.isShown) ?? panes[panes.length - 1]
  const title = (
    <div
      role="tablist"
      aria-label={t('mods.pane.tabs')}
      data-testid="mods-pane-tabs"
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
    >
      {panes.map(pane => {
        const active = pane === shown
        return (
          <div
            key={`${pane.plugin}\u0000${pane.id}`}
            className={cn(
              'group flex min-w-0 items-center gap-0.5 rounded-md py-0.5 pe-0.5 ps-1.5 text-[12px]',
              active ? 'bg-muted' : 'hover:bg-muted/50',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`mod-pane-tab-${pane.plugin}-${pane.id}`}
              title={pane.plugin}
              onClick={() => void modUi.showPane?.(pane.plugin, pane.id)}
              className={cn(
                'min-w-0 max-w-[12rem] truncate outline-none',
                active ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {pane.title}
            </button>
            {modUi.closePane ? (
              <button
                type="button"
                aria-label={t('mods.pane.closeTab', { name: pane.title })}
                data-testid={`mod-pane-close-${pane.plugin}-${pane.id}`}
                onClick={() => onCloseTab({ plugin: pane.plugin, id: pane.id })}
                className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModUiContext.Provider value={modUi}>
        {shown ? <ModDockedPane key={`${shown.plugin}\u0000${shown.id}`} plugin={shown.plugin} id={shown.id} /> : null}
      </ModUiContext.Provider>
    </div>
  )
  return <>{frame({ title, body })}</>
}
