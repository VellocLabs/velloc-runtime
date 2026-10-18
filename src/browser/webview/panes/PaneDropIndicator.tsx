import type { ReactElement } from 'react'

/**
 * The one element drawn over the slot a drop would create (F-9). The drag
 * moves and shows it through the element; it mounts hidden.
 */
export type PaneDropIndicatorProps = {
  elementRef: (el: HTMLDivElement | null) => void
}

export function PaneDropIndicator(props: PaneDropIndicatorProps): ReactElement {
  return (
    <div
      ref={props.elementRef}
      aria-hidden
      data-testid="pane-drop-indicator"
      className="pointer-events-none absolute z-50 rounded-lg border border-primary bg-primary/15"
      style={{ display: 'none' }}
    />
  )
}
