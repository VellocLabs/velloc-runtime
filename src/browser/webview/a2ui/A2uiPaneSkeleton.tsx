// A loading placeholder for the A2UI side pane (F-1): a card and text lines
// that pulse, centred, while an app's first interface is on its way.
// Imports no renderer, so the shell loads it eagerly.

import type { ReactElement } from 'react'
import { useT } from '../i18n'

const BAR = 'rounded bg-muted'
const TEXT_WIDTHS = ['100%', '100%', '60%']

export function A2uiPaneSkeleton(): ReactElement {
  const t = useT()
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('pane.a2uiLoading')}
      data-slot="a2ui-pane-skeleton"
      className="absolute inset-0 flex items-center justify-center p-6"
    >
      <div className="flex w-full max-w-sm animate-pulse flex-col gap-4 motion-reduce:animate-none">
        <div className="flex w-full gap-3 rounded-xl border p-4">
          <div className={`${BAR} size-10 flex-none rounded-full`} />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <div className={`${BAR} h-3 w-1/3`} />
            <div className={`${BAR} h-3 w-full`} />
            <div className={`${BAR} h-3 w-4/5`} />
          </div>
        </div>
        <div className="flex w-full flex-col gap-2">
          {TEXT_WIDTHS.map((width, i) => (
            <div key={i} className={`${BAR} h-3`} style={{ width }} />
          ))}
        </div>
      </div>
    </div>
  )
}
