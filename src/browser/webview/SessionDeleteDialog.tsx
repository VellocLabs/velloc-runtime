/**
 * Confirmation for deleting a session from the sidebar, and the order the
 * confirmed deletion runs in. A session with child sessions under it offers
 * to take them along, off by default. (F-36)
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useUnsavedEditsGate } from '@/glic/unsavedEditsGate'
import { useT } from './i18n'
import { descendantSessionIds, type TreeableSession } from './sessionTree'

/**
 * What the dialog shows for `sessionId`: the row's title and how many
 * sessions sit under it. `null` with no target, or when the row is no longer
 * listed (deleted elsewhere meanwhile), which closes the dialog.
 */
export function sessionDeleteInfoFor<T extends TreeableSession & { title: string; sideChat?: boolean }>(
  sessions: readonly T[],
  sessionId: string | null,
): { sessionId: string; title: string; childCount: number } | null {
  if (sessionId === null) return null
  const row = sessions.find(item => item.sessionId === sessionId)
  if (!row) return null
  return {
    sessionId: row.sessionId,
    title: row.title,
    childCount: descendantSessionIds(sessions, row.sessionId).length,
  }
}

/**
 * The sessions a confirmed delete of `sessionId` removes, in the order to
 * remove them: the session alone, or with every session nested under it when
 * `withChildren`. The active session always comes last, since deleting it
 * re-points the shell and a later delete could take that successor away.
 */
export function sessionDeletionOrder<T extends TreeableSession & { sideChat?: boolean }>(
  sessions: readonly T[],
  sessionId: string,
  withChildren: boolean,
  activeSessionId: string,
): string[] {
  const doomed = withChildren
    ? [sessionId, ...descendantSessionIds(sessions, sessionId)]
    : [sessionId]
  return [
    ...doomed.filter(id => id !== activeSessionId),
    ...doomed.filter(id => id === activeSessionId),
  ]
}

/**
 * Asks before a session is deleted. `childCount` > 0 adds a checkbox, off by
 * default, that extends the delete to the sessions under it; `onConfirm`
 * says whether it was ticked. Backdrop click and Escape cancel.
 */
export function SessionDeleteDialog({
  title,
  childCount,
  onCancel,
  onConfirm,
}: {
  title: string
  childCount: number
  onCancel: () => void
  onConfirm: (withChildren: boolean) => void
}) {
  const t = useT()
  const [withChildren, setWithChildren] = useState(false)
  // Hand-rolled modal, as the project delete dialog: holds the background
  // updater's reload while it is up. Mounted only while shown.
  useUnsavedEditsGate(true)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-delete-dialog-title"
      data-testid="session-delete-dialog"
      onClick={onCancel}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <h2
          id="session-delete-dialog-title"
          className="text-lg font-semibold text-foreground"
        >
          {t('sidebar.sessionDeleteTitle')}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t('sidebar.sessionDeleteBody', { title })}
        </p>
        {childCount > 0 && (
          <label className="mt-4 flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              data-testid="session-delete-children"
              checked={withChildren}
              onChange={event => setWithChildren(event.target.checked)}
            />
            {t('sidebar.sessionDeleteChildren', { count: childCount })}
          </label>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="outline"
            data-testid="session-delete-cancel"
            onClick={onCancel}
            autoFocus
          >
            {t('sidebar.sessionDeleteCancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="session-delete-confirm"
            onClick={() => onConfirm(withChildren)}
          >
            {t('sidebar.sessionDeleteConfirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
