/**
 * The phone shell's top bar (F-24): the drawer button; a title pill with the open session's title
 * and, under it, its project's folder name; then the session's running indicator and the `…`
 * session menu. It pads past the notch.
 */
import { EllipsisIcon, LoaderCircleIcon, MenuIcon } from 'lucide-react'

import { useT } from '../browser/webview/i18n'

export type MobileTopBarProps = {
  title: string
  /** The project's folder name; absent for a session outside any project. */
  projectName?: string
  running: boolean
  onOpenDrawer: () => void
  onOpenMenu: () => void
}

export function MobileTopBar({ title, projectName, running, onOpenDrawer, onOpenMenu }: MobileTopBarProps) {
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
      <div className="min-w-0 flex-1 px-1 text-center">
        <h1 data-testid="mobile-topbar-title" className="truncate font-medium text-body">
          {title}
        </h1>
        {projectName ? (
          <p data-testid="mobile-topbar-project" className="truncate text-muted-foreground text-xs">
            {projectName}
          </p>
        ) : null}
      </div>
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
    </header>
  )
}
