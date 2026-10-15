/**
 * Safety net under `useCan` for `forbidden_scope` rejections: tells the user once, and marks the
 * rejection handled. A page-realm listener, since the rejections come from callbacks all over the app.
 */
import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'
import { useT } from './i18n'
import { isRuntimeRequestError } from '../runtimeClient/RuntimeConnection'

/** How long the notice stays up. Long enough to read one sentence. */
const NOTICE_TTL_MS = 6_000

/** True when `reason` is a runtime refusal for want of scope. */
export function isForbiddenScope(reason: unknown): boolean {
  return isRuntimeRequestError(reason) && reason.code === 'forbidden_scope'
}

/**
 * Catch unhandled `forbidden_scope` rejections and report them to `onNotice`.
 * Returns the unsubscribe. Exported so a test can drive it without a DOM tree.
 */
export function watchForbiddenScope(
  onNotice: () => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const handler = (event: Event): void => {
    const reason = (event as PromiseRejectionEvent).reason
    if (!isForbiddenScope(reason)) return
    // Handled: this is a refusal the UI is now explaining, not a crash.
    event.preventDefault()
    onNotice()
  }
  target.addEventListener('unhandledrejection', handler)
  return () => target.removeEventListener('unhandledrejection', handler)
}

/**
 * Renders the "this has to be done on the desktop" notice when a
 * `forbidden_scope` rejection goes unhandled. Renders nothing otherwise — on
 * the desktop, where every grant is `full`, that is always.
 */
export function ForbiddenScopeNotice({ className }: { className?: string }) {
  const t = useT()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = watchForbiddenScope(() => {
      setVisible(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setVisible(false), NOTICE_TTL_MS)
    })
    return () => {
      stop()
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (!visible) return null

  return (
    <div
      data-testid="forbidden-scope-notice"
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-card px-3 py-2 text-sm shadow-lg',
        className,
      )}
    >
      {t('remote.forbidden.toast')}
    </div>
  )
}
