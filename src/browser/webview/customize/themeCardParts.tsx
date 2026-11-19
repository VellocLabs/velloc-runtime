import * as React from 'react'
import { CircleAlertIcon, CircleCheckIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import { useT } from '../i18n'
import { INSTALL_TOAST_MS } from './InstallToasts'
import { AVATAR_TINT, avatarHue } from './ItemAvatar'

/** The theme grid (F-35): three columns at full width, two and one by the section's own width. */
export const THEME_GRID = 'grid grid-cols-1 gap-3 @[36rem]:grid-cols-2 @[56rem]:grid-cols-3'

/** A look's picture, or the name's initial on its own tint when there is none to show. */
export function LookPreview({ name, url }: { name: string; url: string }) {
  const t = useT()
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => setBroken(false), [url])
  if (broken || !/^https?:\/\//.test(url)) {
    return (
      <div
        aria-hidden
        data-testid="customize-theme-preview-fallback"
        style={{ '--avatar-hue': avatarHue(name) } as React.CSSProperties}
        className={cn(
          'flex aspect-[16/10] w-full items-center justify-center text-2xl font-semibold uppercase',
          AVATAR_TINT,
        )}
      >
        {name.trim().charAt(0) || '?'}
      </div>
    )
  }
  return (
    <img
      data-testid="customize-theme-preview"
      src={url}
      alt={t('customize.themes.previewAlt', { name })}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="aspect-[16/10] w-full bg-background object-cover"
      onError={() => setBroken(true)}
    />
  )
}

/**
 * The line above a theme grid saying how the last ask ended. Success leaves
 * after a few seconds; a failure stays until dismissed or a new `seq` comes.
 */
export function ThemeNoticeShell({
  testId,
  kind,
  seq,
  failed,
  persist = false,
  onDismiss,
  children,
}: {
  testId: string
  kind: string
  seq: number
  failed: boolean
  /** Stays until replaced or dismissed, like a failure, without reading as one. */
  persist?: boolean
  onDismiss: () => void
  children: React.ReactNode
}) {
  const t = useT()
  const dismiss = React.useRef(onDismiss)
  dismiss.current = onDismiss
  React.useEffect(() => {
    if (failed || persist) return
    const timer = window.setTimeout(() => dismiss.current(), INSTALL_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [seq, failed, persist])
  return (
    <div
      role={failed ? 'alert' : 'status'}
      data-testid={testId}
      data-kind={kind}
      className="sticky top-2 z-10 my-1 flex items-start gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-sm"
    >
      {failed ? (
        <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
      )}
      {children}
      <button
        type="button"
        data-testid={`${testId}-dismiss`}
        aria-label={t('customize.install.toast.dismiss')}
        title={t('customize.install.toast.dismiss')}
        onClick={onDismiss}
        className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:focus-ring"
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
