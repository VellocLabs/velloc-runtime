// Inline A2UI surface, rendered by the `a2ui_*` tool UIs at the tool-call's
// position in the conversation (no side panel). For each surfaceId, only its
// LATEST mention renders the live surface; earlier mentions render a "jump to
// latest" breadcrumb. The live card also carries a hover maximize control.
//
// This module imports the heavy @copilotkit renderer, so the `a2ui_*` tool UIs
// lazy-import it — the renderer chunk loads only when a surface actually
// renders, never for other generative tools.

import { Component, type ReactNode } from 'react'
import { A2UIRenderer } from '@copilotkit/a2ui-renderer'
import { CornerDownRightIcon, Maximize2Icon } from 'lucide-react'
import { useA2uiPresentationOptional } from './A2uiPresentationContext'
import { useT } from '../i18n'

class SurfaceErrorBoundary extends Component<
  { surfaceId: string; fallbackText: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(error: unknown): void {
    console.error('[a2ui] surface render error', this.props.surfaceId, error)
  }
  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-xs text-warning">
          {this.props.fallbackText}
        </div>
      )
    }
    return this.props.children
  }
}

// Scroll the live render of `surfaceId` into view + flash a ring. The live card
// is the only element with [data-slot="a2ui-surface"] for that id (older
// mentions render breadcrumbs), so the selector is unambiguous.
function jumpToSurface(surfaceId: string): void {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(surfaceId)
      : surfaceId
  const el = document.querySelector(
    `[data-slot="a2ui-surface"][data-surface-id="${escaped}"]`,
  )
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('ring-2', 'ring-primary', 'rounded-lg')
  window.setTimeout(() => {
    el.classList.remove('ring-2', 'ring-primary', 'rounded-lg')
  }, 1500)
}

export function A2uiInlineSurface({
  surfaceId,
  toolCallId,
}: {
  surfaceId?: string
  toolCallId: string
}) {
  // Optional: a tool UI can briefly render in the Suspense fallback tree while
  // the lazy A2uiProviderHost (which provides this context AND the @copilotkit
  // A2UIProvider) is still loading. Render nothing until both providers exist —
  // returning here BEFORE <A2UIRenderer> also avoids useA2UI() throwing. It
  // re-renders with the live surface once the provider mounts.
  const presentation = useA2uiPresentationOptional()
  const t = useT()
  if (!presentation || !surfaceId) return null
  const { latestToolCallIdBySurface, deletedSurfaceIds, busy, setMaximizedSurfaceId } =
    presentation

  // Deleted surfaces render nothing at any position (create/update/delete).
  if (deletedSurfaceIds.has(surfaceId)) return null

  const isLatest = latestToolCallIdBySurface.get(surfaceId) === toolCallId

  // Older mention → breadcrumb that jumps to the live render below.
  if (!isLatest) {
    return (
      <button
        type="button"
        data-slot="a2ui-breadcrumb"
        data-surface-id={surfaceId}
        onClick={() => jumpToSurface(surfaceId)}
        className="my-2 inline-flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <CornerDownRightIcon className="size-3.5" />
        {t('a2ui.moved', { id: surfaceId })}
      </button>
    )
  }

  // Latest mention → the live surface, with a hover maximize control. It spans
  // the FULL conversation column width (the message body is already capped at
  // --thread-max-width, and the catalog Card is width:100%, so it fills it).
  // The maximize control gives the full-pane overlay when more room is wanted.
  return (
    <div
      data-slot="a2ui-surface"
      data-surface-id={surfaceId}
      className="group relative my-2 w-full rounded-lg border bg-card p-1"
    >
      <button
        type="button"
        data-slot="a2ui-maximize-btn"
        title={t('a2ui.maximize')}
        aria-label={t('a2ui.maximizeSurface')}
        onClick={() => setMaximizedSurfaceId(surfaceId)}
        className="absolute right-2 top-2 z-10 rounded-md border bg-background/90 p-1 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Maximize2Icon className="size-3.5" />
      </button>
      <div
        aria-busy={busy || undefined}
        className={
          busy
            ? 'opacity-60 transition-opacity pointer-events-none select-none'
            : 'transition-opacity'
        }
      >
        <SurfaceErrorBoundary
          surfaceId={surfaceId}
          fallbackText={t('a2ui.renderFailed')}
        >
          <A2UIRenderer surfaceId={surfaceId} fallback={null} />
        </SurfaceErrorBoundary>
      </div>
    </div>
  )
}
