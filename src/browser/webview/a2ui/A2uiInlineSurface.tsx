// Inline A2UI card, rendered by the `a2ui_*` tool UIs at the tool-call's
// position in the conversation (F-1). The surface itself renders in the side
// pane; the card names it and opens the pane on it. The latest mention of a
// surface reads "Open in panel"; an earlier one says the surface was updated.

import { CornerDownRightIcon, LayoutPanelLeftIcon } from 'lucide-react'
import { useA2uiPresentationOptional } from './A2uiPresentationContext'
import { useT } from '../i18n'

export function A2uiInlineSurface({
  surfaceId,
  toolCallId,
}: {
  surfaceId?: string
  toolCallId: string
}) {
  // A tool UI can render in a Suspense fallback before the lazy host mounts the
  // provider: render nothing until it exists.
  const presentation = useA2uiPresentationOptional()
  const t = useT()
  if (!presentation || !surfaceId) return null
  const { latestToolCallIdBySurface, deletedSurfaceIds, selectedSurfaceId, openSurface } =
    presentation

  if (deletedSurfaceIds.has(surfaceId)) return null

  const isLatest = latestToolCallIdBySurface.get(surfaceId) === toolCallId

  if (!isLatest) {
    return (
      <button
        type="button"
        data-slot="a2ui-breadcrumb"
        data-surface-id={surfaceId}
        onClick={() => openSurface(surfaceId)}
        className="my-2 inline-flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <CornerDownRightIcon className="size-3.5" />
        {t('a2ui.moved', { id: surfaceId })}
      </button>
    )
  }

  const selected = selectedSurfaceId === surfaceId
  return (
    <div
      data-slot="a2ui-card"
      data-surface-id={surfaceId}
      className="my-2 flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2"
    >
      <LayoutPanelLeftIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{surfaceId}</span>
      {selected && (
        <span className="shrink-0 text-xs text-muted-foreground">{t('a2ui.shownInPanel')}</span>
      )}
      <button
        type="button"
        data-slot="a2ui-open-in-panel"
        onClick={() => openSurface(surfaceId)}
        className="shrink-0 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {t('a2ui.openInPanel')}
      </button>
    </div>
  )
}
