/**
 * The phone shell's top bar (F-24): the drawer button; a title pill with the open session's title
 * and, under it, its project's folder name, which opens the session's details; then the session's
 * running indicator, the `…` session menu and `i` for usage. It pads past the notch.
 */
import { EllipsisIcon, InfoIcon, LoaderCircleIcon, MenuIcon } from 'lucide-react'

import { useT } from '../browser/webview/i18n'

export type MobileTopBarProps = {
  title: string
  /** The project's folder name; absent for a session outside any project. */
  projectName?: string
  running: boolean
  onOpenDrawer: () => void
  onOpenMenu: () => void
  onOpenDetails: () => void
  onOpenUsage: () => void
}

export function MobileTopBar({
  title,
  projectName,
  running,
  onOpenDrawer,
  onOpenMenu,
  onOpenDetails,
  onOpenUsage,
}: MobileTopBarProps) {
  const t = useT()
  return (
    <header
      data-testid="mobile-topbar"
      className="flex min-h-12 shrink-0 items-center gap-1 border-border border-b px-1"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'max(0.25rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.25rem, env(safe-area-inset-right))',
      }}
    >
      <button
        type="button"
        data-testid="mobile-topbar-drawer"
        aria-label={t('mobile.topbar.openDrawer')}
        onClick={onOpenDrawer}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg active:bg-accent"
      >
        <MenuIcon aria-hidden className="size-5" />
      </button>
      <h1 className="min-w-0 flex-1">
        <button
          type="button"
          data-testid="mobile-topbar-details"
          aria-haspopup="dialog"
          aria-description={t('mobile.topbar.sessionDetails')}
          onClick={onOpenDetails}
          className="block w-full rounded-lg px-1 py-0.5 text-center active:bg-accent"
        >
          <span data-testid="mobile-topbar-title" className="block truncate font-medium text-body">
            {title}
          </span>
          {projectName ? (
            <span data-testid="mobile-topbar-project" className="block truncate text-muted-foreground text-xs">
              {projectName}
            </span>
          ) : null}
        </button>
      </h1>
      <span className="flex size-6 shrink-0 items-center justify-center">
        {running ? (
          <LoaderCircleIcon
            data-testid="mobile-topbar-running"
            role="img"
            aria-label={t('childSession.state.running')}
            className="size-4 animate-spin text-muted-foreground"
          />
        ) : null}
      </span>
      <button
        type="button"
        data-testid="mobile-topbar-menu"
        aria-label={t('mobile.topbar.sessionMenu')}
        aria-haspopup="dialog"
        onClick={onOpenMenu}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg active:bg-accent"
      >
        <EllipsisIcon aria-hidden className="size-5" />
      </button>
      <button
        type="button"
        data-testid="mobile-topbar-usage"
        aria-label={t('mobile.topbar.usage')}
        aria-haspopup="dialog"
        onClick={onOpenUsage}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg active:bg-accent"
      >
        <InfoIcon aria-hidden className="size-5" />
      </button>
    </header>
  )
}
