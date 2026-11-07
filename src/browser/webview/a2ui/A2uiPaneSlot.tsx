// The A2UI side pane's body (F-1): a mount element the shown session's A2UI
// host portals its surfaces into, and an empty state when none does.
// Imports no renderer, so the shell loads it eagerly.

import { useCallback, useSyncExternalStore, type ReactElement } from 'react'
import { getOwner, setSlot, subscribeSlot } from './a2uiPaneBus'
import { useT } from '../i18n'

export function A2uiPaneSlot({ sessionId }: { sessionId: string | null }): ReactElement {
  const t = useT()
  const owner = useSyncExternalStore(subscribeSlot, getOwner, () => null)
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      setSlot(element, sessionId)
    },
    [sessionId],
  )
  const filled = owner !== null && owner === sessionId
  return (
    <div className="relative h-full min-h-0" data-testid="a2ui-pane">
      <div ref={ref} className="h-full min-h-0" />
      {!filled && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-body text-muted-foreground">
          {t('pane.noA2uiSurface')}
        </div>
      )}
    </div>
  )
}
