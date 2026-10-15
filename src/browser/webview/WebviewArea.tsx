import { useRef } from 'react'
import { GlobeIcon, XIcon } from 'lucide-react'

import type { ShellChannel } from '../runtimeClient/shellChannel'
import { useT } from './i18n'
import { useMainContentsLayout } from './useMainContentsLayout'

export type WebviewAreaProps = {
  /**
   * True when this area belongs to the ACTIVE session — only the active
   * instance reports its rect (see useMainContentsLayout's contract).
   */
  active: boolean
  /** Shared (cross-session) width in px; owned by MultiSessionShell. */
  width: number
  /** The runtime's shell channel — where this area's geometry is published. */
  shell?: ShellChannel | null
  /**
   * Invoked when the user clicks the header's close (X) button. The shell
   * dismisses the docked browser view for the active session until the next
   * session switch or new browser-tool activity re-reveals it.
   */
  onHide?: () => void
}

/**
 * Per-session docked browser view: a guest header bar over the placeholder the native
 * main-contents-view is synced onto. The header MUST stay outside the measured
 * `webview-area` div (native views paint above the guest); the placeholder is non-interactive.
 */
export function WebviewArea({
  active,
  width,
  shell,
  onHide,
}: WebviewAreaProps) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  useMainContentsLayout(ref, shell ?? null, active)
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ width, flex: '0 1 auto', maxWidth: '70%' }}
    >
      <div
        data-testid="webview-area-header"
        className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-2"
      >
        <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground text-xs">
          {t('webviewArea.title')}
        </span>
        <button
          type="button"
          aria-label={t('webviewArea.hideAria')}
          data-testid="webview-area-hide"
          onClick={onHide}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div
        ref={ref}
        data-testid="webview-area"
        aria-hidden
        className="min-h-0 flex-1 bg-muted/20"
      />
    </div>
  )
}
