// An app's controls in the side pane (F-40): Help and Refresh in the pane
// header, which every app gets, and the bar above the surface with
// the latest build or data error. A build error's text is the compiler's own,
// shown as written.

import { useState, type ReactNode } from 'react'
import { MessageCircleIcon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { focusSessionComposer } from '@/components/assistant-ui/composer-passages'
import { requestPane } from '../a2ui/a2uiPaneBus'
import { isMacPlatform } from '../attachSelectionShortcut'
import { useT } from '../i18n'
import type { AppBoard } from './appSurfaceView'

const FOCUS_FRAMES = 10

/** Help: the app's chat shown beside it, its composer focused once it can be. */
export function openAppChat(sessionId: string): void {
  requestPane({ sessionId, restore: true })
  let frames = 0
  const focus = () => {
    if (focusSessionComposer(sessionId) || ++frames >= FOCUS_FRAMES) return
    requestAnimationFrame(focus)
  }
  requestAnimationFrame(focus)
}

function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Help and Refresh, before the pane's own Expand and Close. Refresh builds
 * the entry again and raises the app's `app.show`; a Ctrl+click (Cmd+click on
 * macOS) reinstalls the page: the plugin's seed is copied over the app folder
 * first, config and data kept. A failed build keeps the previous page; the
 * bar below shows the error.
 */
export function AppPaneActions({ board, sessionId, busy = false }: { board: AppBoard; sessionId: string; busy?: boolean }) {
  const t = useT()
  const [pending, setPending] = useState<'refresh' | 'reinstall' | null>(null)
  const run = (kind: 'refresh' | 'reinstall') => {
    if (pending || busy || !board.refresh) return
    setPending(kind)
    void board
      .refresh(kind === 'reinstall')
      .then(result => {
        if (result && !result.ok) console.warn(`[mods/app] ${kind} failed: ${result.message}`)
      })
      .catch(error => console.warn(`[mods/app] ${kind} failed`, error))
      .finally(() => setPending(null))
  }
  const help = t('apps.help')
  const mac = typeof navigator !== 'undefined' && isMacPlatform(navigator.platform)
  const refresh = t('apps.refreshTooltip', { key: mac ? 'Cmd' : 'Ctrl' })
  // Portaled into the pane header, so outside the pane's own provider.
  return (
    <TooltipProvider>
      <Tip label={t('apps.helpTooltip')}>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-7 gap-1 px-1.5 max-sm:w-7 max-sm:px-0"
          data-slot="app-help"
          aria-label={t('apps.helpTooltip')}
          onClick={() => openAppChat(sessionId)}
        >
          <MessageCircleIcon aria-hidden className="size-3.5" />
          <span data-slot="app-help-label" className="text-xs max-sm:hidden">
            {help}
          </span>
        </Button>
      </Tip>
      <Tip label={refresh}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-7"
          data-slot="app-refresh"
          aria-label={refresh}
          disabled={pending !== null || busy}
          onClick={event => run((mac ? event.metaKey : event.ctrlKey) ? 'reinstall' : 'refresh')}
        >
          <RefreshCwIcon aria-hidden className={'size-3.5' + (pending !== null ? ' animate-spin' : '')} />
        </Button>
      </Tip>
    </TooltipProvider>
  )
}

export function AppSurfaceBar({ board }: { board: AppBoard }) {
  const t = useT()
  const errors = board.state?.errors ?? []
  const buildError = errors.find(error => error.kind === 'build')
  const dataError = errors.find(error => error.kind === 'data')
  if (!buildError && !dataError) return null
  return (
    <div data-slot="app-surface-bar" className="mb-2">
      <div
        data-slot="app-board-error"
        data-error-kind={buildError ? 'build' : 'data'}
        role="status"
        className="rounded-md border border-warning/50 bg-warning/10 px-2 py-1 text-xs text-warning"
      >
        {t(buildError ? 'apps.buildFailed' : 'apps.dataFileError')}
        {buildError ? (
          <pre data-slot="app-build-message" className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">
            {buildError.message}
          </pre>
        ) : null}
      </div>
    </div>
  )
}
