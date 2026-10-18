import { useRef } from 'react'

import type { ShellChannel } from '../runtimeClient/shellChannel'
import { useMainContentsLayout } from './useMainContentsLayout'

export type WebviewAreaProps = {
  /**
   * True while this placeholder is the one the native view follows: only the
   * active instance reports its rect (see useMainContentsLayout's contract).
   */
  active: boolean
  /** The runtime's shell channel — where this area's geometry is published. */
  shell?: ShellChannel | null
}

/**
 * The browser pane's body (F-9): the placeholder the native main-contents-view
 * is position-synced onto. Nothing interactive may sit inside it (native views
 * paint above the guest); the pane's header holds the controls.
 */
export function WebviewArea({ active, shell }: WebviewAreaProps) {
  const ref = useRef<HTMLDivElement>(null)
  useMainContentsLayout(ref, shell ?? null, active)
  return (
    <div
      ref={ref}
      data-testid="webview-area"
      aria-hidden
      className="min-h-0 flex-1 bg-muted/20"
    />
  )
}
