/**
 * The phone shell's session drawer (F-24): a full-height modal panel from the left edge,
 * min(85vw, 320px) wide, over a dimmed backdrop. It closes on a backdrop tap, Escape, choosing a
 * session, or a leftward swipe on the panel; scrolling the list does not close it. Holds a title
 * filter, the session list, New session, and the switch to the desktop shell.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { MonitorIcon, PlusIcon } from 'lucide-react'

import type { ShellSwitchOutcome } from '../browser/boot/mobileEntry'
import { useT } from '../browser/webview/i18n'
import { buildMobileSessionGroups, type MobileListSession } from './mobileSessionGroups'
import { MobileSessionList } from './MobileSessionList'
import { useClickSwallow } from './useClickSwallow'

/** A leftward swipe this far, mostly horizontal, closes the drawer. */
export const DRAWER_SWIPE_CLOSE_PX = 60

export type MobileDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: readonly MobileListSession[]
  running: ReadonlySet<string>
  needsAnswer: ReadonlySet<string>
  activeSessionId: string
  onSelectSession: (sessionId: string) => void
  onSessionMenu: (sessionId: string) => void
  onNewSession: () => void
  /** The switch to the desktop shell; `storage-blocked` is reported under the button. */
  onDesktopView: () => ShellSwitchOutcome
}

export function MobileDrawer(props: MobileDrawerProps) {
  const { open, onOpenChange, sessions, running, needsAnswer } = props
  const t = useT()
  const [query, setQuery] = useState('')
  const [desktopViewBlocked, setDesktopViewBlocked] = useState(false)
  // The filter and the switch's message belong to one opening: a closed drawer starts from the whole list.
  if (!open && (query !== '' || desktopViewBlocked)) {
    setQuery('')
    setDesktopViewBlocked(false)
  }
  // One clock per opening, so every row ages against the same instant.
  const now = useMemo(() => Date.now(), [open])
  const groups = useMemo(
    () => buildMobileSessionGroups(sessions, { query, running, needsAnswer, now }),
    [sessions, query, running, needsAnswer, now],
  )
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  const swallow = useClickSwallow()

  // A drag that starts in a text field moves its caret, so it is never a swipe.
  const onPointerDown = (event: ReactPointerEvent) => {
    const target = event.target as HTMLElement | null
    swipeStart.current = target?.closest?.('input, textarea, [contenteditable="true"]')
      ? null
      : { x: event.clientX, y: event.clientY }
  }
  const onPointerUp = (event: ReactPointerEvent) => {
    const from = swipeStart.current
    swipeStart.current = null
    if (!from) return
    const dx = event.clientX - from.x
    const dy = event.clientY - from.y
    if (dx <= -DRAWER_SWIPE_CLOSE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swallow.armForGesture()
      onOpenChange(false)
    }
  }
  const hasSessions = groups.length > 0
  const filtering = query.trim() !== ''

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-testid="mobile-drawer-backdrop"
          className="fixed inset-0 z-40 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          data-testid="mobile-drawer"
          aria-describedby={undefined}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          // A swipe that ends on a row or a button must not also tap it.
          onClickCapture={swallow.onClickCapture}
          onPointerCancel={() => {
            swipeStart.current = null
          }}
          className="fixed inset-y-0 left-0 z-40 flex w-[min(85vw,320px)] flex-col border-border border-r bg-background shadow-lg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
          style={{
            touchAction: 'pan-y',
            paddingTop: 'env(safe-area-inset-top)',
            paddingBottom: 'env(safe-area-inset-bottom)',
            paddingLeft: 'env(safe-area-inset-left)',
          }}
        >
          <div className="shrink-0 px-4 pt-3 pb-2">
            <DialogPrimitive.Title className="font-semibold text-body">{t('mobile.drawer.title')}</DialogPrimitive.Title>
            <input
              type="search"
              data-testid="mobile-drawer-filter"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('mobile.drawer.filterPlaceholder')}
              aria-label={t('mobile.drawer.filterPlaceholder')}
              className="mt-2 h-10 w-full rounded-lg border border-border bg-muted/40 px-3 text-body focus-visible:focus-ring"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="mobile-drawer-scroll">
            {hasSessions ? (
              <MobileSessionList
                groups={groups}
                now={now}
                activeSessionId={props.activeSessionId}
                onSelect={props.onSelectSession}
                onLongPress={props.onSessionMenu}
              />
            ) : (
              <p data-testid="mobile-drawer-empty" className="px-4 py-6 text-center text-muted-foreground text-sm">
                {filtering ? t('mobile.drawer.noMatches') : t('mobile.drawer.empty')}
              </p>
            )}
          </div>
          <div className="shrink-0 border-border border-t p-2">
            <button
              type="button"
              data-testid="mobile-drawer-new-session"
              onClick={props.onNewSession}
              className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 font-medium text-body active:bg-accent"
            >
              <PlusIcon aria-hidden className="size-5 shrink-0" />
              {t('mobile.drawer.newSession')}
            </button>
            <button
              type="button"
              data-testid="mobile-drawer-desktop-view"
              onClick={() => {
                if (props.onDesktopView() === 'storage-blocked') setDesktopViewBlocked(true)
              }}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-muted-foreground text-sm active:bg-accent"
            >
              <MonitorIcon aria-hidden className="size-5 shrink-0" />
              {t('mobile.drawer.desktopView')}
            </button>
            {desktopViewBlocked ? (
              <p
                role="alert"
                data-testid="mobile-drawer-desktop-view-blocked"
                className="px-3 pb-1 text-muted-foreground text-xs"
              >
                {t('remote.shell.switchBlocked')}
              </p>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
