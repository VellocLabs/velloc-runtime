// The bar above an app's surface in the side pane (F-40): Reload, which builds
// the app's entry file again, and the latest build or data error. A build
// error's text is the compiler's own, shown as written.

import { useState } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { useT } from '../i18n'
import type { AppBoard } from './appSurfaceView'

export function AppSurfaceBar({ board }: { board: AppBoard }) {
  const t = useT()
  const [pending, setPending] = useState(false)
  const errors = board.state?.errors ?? []
  const buildError = errors.find(error => error.kind === 'build')
  const dataError = errors.find(error => error.kind === 'data')
  const reload = () => {
    if (pending) return
    setPending(true)
    void board
      .reload()
      .catch(error => console.warn('[mods/app] reload failed', error))
      .finally(() => setPending(false))
  }
  return (
    <div data-slot="app-surface-bar" className="mb-2 flex items-start gap-2">
      <div className="min-w-0 flex-1">
        {buildError || dataError ? (
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
        ) : null}
      </div>
      <button
        type="button"
        data-slot="app-reload"
        aria-label={t('apps.reload')}
        title={t('apps.reload')}
        disabled={pending}
        onClick={reload}
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <RefreshCwIcon aria-hidden className={'size-3.5' + (pending ? ' animate-spin' : '')} />
      </button>
    </div>
  )
}
