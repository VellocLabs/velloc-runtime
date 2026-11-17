import * as React from 'react'
import { CircleAlertIcon, CircleCheckIcon, Loader2Icon, PackageXIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { useT } from '../i18n'
import type { MessageKey } from '../i18n/messages/en'
import type { InstallNotice } from './useMarketplaceCatalog'

/** How long a finished install's toast stays before it leaves on its own. */
export const INSTALL_TOAST_MS = 6000

const TEXT = {
  running: ['customize.install.toast.running', 'customize.install.toast.runningDetail'],
  installed: ['customize.install.toast.installed', 'customize.install.toast.installedDetail'],
  notListed: ['customize.install.toast.notListed', 'customize.install.toast.notListedDetail'],
  failed: ['customize.install.toast.failed', 'customize.install.toast.failedDetail'],
} as const satisfies Record<InstallNotice['phase'], readonly [MessageKey, MessageKey]>

/**
 * The installs started on the Customize screen, in the window's lower right
 * corner (F-35): one toast per install, saying it runs in the background
 * while the marketplace downloads, then how it ended. A finished toast
 * leaves after a few seconds or when dismissed.
 */
export function InstallToasts({
  notices,
  onDismiss,
}: {
  notices: readonly InstallNotice[]
  onDismiss: (key: string) => void
}) {
  if (notices.length === 0) return null
  return (
    <div
      data-testid="customize-install-toasts"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {notices.map(notice => (
        <InstallToast key={notice.key} notice={notice} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function InstallToast({ notice, onDismiss }: { notice: InstallNotice; onDismiss: (key: string) => void }) {
  const t = useT()
  const { key, phase } = notice
  React.useEffect(() => {
    if (phase === 'running') return
    const timer = window.setTimeout(() => onDismiss(key), INSTALL_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [key, phase, onDismiss])

  const [title, detail] = TEXT[phase]
  const params = { name: notice.plugin, marketplace: notice.marketplace }
  return (
    <div
      role={phase === 'failed' || phase === 'notListed' ? 'alert' : 'status'}
      data-testid="customize-install-toast"
      data-phase={phase}
      data-key={key}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-xl border bg-popover p-3.5 text-popover-foreground shadow-lg',
        'animate-in fade-in-0 slide-in-from-bottom-2',
      )}
    >
      <ToastIcon phase={phase} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-sm font-medium">{t(title, params)}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{t(detail, params)}</p>
      </div>
      {phase === 'running' ? null : (
        <button
          type="button"
          data-testid="customize-install-toast-dismiss"
          aria-label={t('customize.install.toast.dismiss')}
          title={t('customize.install.toast.dismiss')}
          onClick={() => onDismiss(key)}
          className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:focus-ring"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function ToastIcon({ phase }: { phase: InstallNotice['phase'] }) {
  const box = 'mt-0.5 size-4 shrink-0'
  switch (phase) {
    case 'running':
      return <Loader2Icon aria-hidden className={cn(box, 'animate-spin text-muted-foreground')} />
    case 'installed':
      return <CircleCheckIcon aria-hidden className={cn(box, 'text-primary')} />
    case 'notListed':
      return <PackageXIcon aria-hidden className={cn(box, 'text-destructive')} />
    case 'failed':
      return <CircleAlertIcon aria-hidden className={cn(box, 'text-destructive')} />
  }
}
