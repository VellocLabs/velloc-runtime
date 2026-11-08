// An app's controls in the side pane (F-40): Reload, which builds the app's
// entry file again and sits in the pane header, and the bar above the surface
// with the latest build or data error. A build error's text is the
// compiler's own, shown as written.

import { useState } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '../i18n'
import type { AppBoard } from './appSurfaceView'

export function AppReloadButton({ board, busy = false }: { board: AppBoard; busy?: boolean }) {
  const t = useT()
  const [pending, setPending] = useState(false)
  const reload = () => {
    if (pending || busy) return
    setPending(true)
    void board
      .reload()
      .catch(error => console.warn('[mods/app] reload failed', error))
      .finally(() => setPending(false))
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-7"
      data-slot="app-reload"
      aria-label={t('apps.reload')}
      title={t('apps.reload')}
      disabled={pending || busy}
      onClick={reload}
    >
      <RefreshCwIcon aria-hidden className={'size-3.5' + (pending ? ' animate-spin' : '')} />
    </Button>
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
