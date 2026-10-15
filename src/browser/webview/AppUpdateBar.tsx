import { useState } from 'react'
import { RefreshCwIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import { useT } from './i18n'
import { useCan } from './useCan'
import { useAppUpdateStatus } from './appUpdateView'

/**
 * The bottom-of-sidebar notice that an installed update waits for a restart
 * (F-30). Renders only in phase `ready` and only for a connection allowed to
 * relaunch the host; no dismissal, it leaves when the app restarts.
 */
export function AppUpdateBar({
  runtimeConnection,
  variant,
}: {
  runtimeConnection?: () => Promise<RuntimeConnection>
  /** `bar` under the session list; `rail` as an icon in the collapsed rail. */
  variant: 'bar' | 'rail'
}) {
  const t = useT()
  const canRelaunch = useCan('appUpdate', 'relaunch')
  const { state, relaunch } = useAppUpdateStatus(runtimeConnection)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  if (!canRelaunch || state?.phase !== 'ready' || !state.target) return null

  const version = state.target
  const restart = () => {
    setPending(true)
    setFailed(false)
    relaunch().catch(() => {
      setPending(false)
      setFailed(true)
    })
  }

  if (variant === 'rail') {
    const label = t('appUpdate.restartAria', { version })
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-testid="app-update-rail"
        aria-label={label}
        title={failed ? t('appUpdate.restartFailed') : label}
        disabled={pending}
        className="relative mb-1 size-9 shrink-0 hover:bg-muted"
        onClick={restart}
      >
        <RefreshCwIcon className="size-4" />
        <span aria-hidden className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary" />
      </Button>
    )
  }

  return (
    <div
      data-testid="app-update-bar"
      role="status"
      className="mx-2 mb-2 flex shrink-0 flex-col gap-2 rounded-md border bg-background px-3 py-2.5 text-xs"
    >
      <div className="flex items-center gap-2">
        <RefreshCwIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">{t('appUpdate.ready', { version })}</span>
      </div>
      {failed && <span className="text-destructive">{t('appUpdate.restartFailed')}</span>}
      <Button
        type="button"
        size="sm"
        data-testid="app-update-restart"
        disabled={pending}
        className="h-7 w-full text-xs"
        onClick={restart}
      >
        {pending ? t('appUpdate.restarting') : t('appUpdate.restart')}
      </Button>
    </div>
  )
}
