/**
 * Confirmation for deleting a session from the sidebar, and the order the
 * confirmed deletion runs in. A session with child sessions nested under it
 * offers to take them along, off by default, and says when any of them is
 * still working. (F-36)
 */
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useUnsavedEditsGate } from '@/glic/unsavedEditsGate'
import { useT } from './i18n'
import type { ListableSession } from './sessionListView'
import { readSessionListView } from './sessionListView'
import { sidebarSessionTree } from './sessionPinning'
import { descendantSessionIds, type SessionTree, type TreeableSession } from './sessionTree'

type DeletableSession = TreeableSession & ListableSession & { title: string; starting?: boolean }

/** The part of the sidebar's tree the delete reads. */
type DeleteTree<T> = Pick<SessionTree<T>, 'byId' | 'childrenOf'>

/** A session that a delete would interrupt: starting, mid-turn, or waiting on the person. */
function isBusy(session: { running?: boolean; starting?: boolean; needsAnswer?: boolean }): boolean {
  return !!session.running || !!session.starting || !!session.needsAnswer
}

/**
 * What the dialog shows for `sessionId`: the row's title, how many rows the
 * sidebar nests under it (`tree`), and how many of those are busy. `null`
 * with no target, or when the row is no longer listed (deleted elsewhere
 * meanwhile), which closes the dialog.
 */
export function sessionDeleteInfoFor<T extends DeletableSession>(
  sessions: readonly T[],
  tree: DeleteTree<T>,
  sessionId: string | null,
): { sessionId: string; title: string; childCount: number; busyChildCount: number } | null {
  if (sessionId === null) return null
  const row = sessions.find(item => item.sessionId === sessionId)
  if (!row) return null
  const childIds = descendantSessionIds(row.sessionId, tree.childrenOf)
  return {
    sessionId: row.sessionId,
    title: row.title,
    childCount: childIds.length,
    busyChildCount: childIds.filter(id => {
      const child = tree.byId.get(id)
      return child !== undefined && isBusy(child)
    }).length,
  }
}

/**
 * The sessions a confirmed delete of `sessionId` removes, in the order to
 * remove them: the session alone, or with every row nested under it in
 * `childrenOf` when `withChildren`. The active session always comes last,
 * since deleting it re-points the shell and a later delete could take that
 * successor away.
 */
export function sessionDeletionOrder<T extends TreeableSession>(
  childrenOf: ReadonlyMap<string, T[]>,
  sessionId: string,
  withChildren: boolean,
  activeSessionId: string,
): string[] {
  const doomed = withChildren
    ? [sessionId, ...descendantSessionIds(sessionId, childrenOf)]
    : [sessionId]
  return [
    ...doomed.filter(id => id !== activeSessionId),
    ...doomed.filter(id => id === activeSessionId),
  ]
}

/**
 * The shell's delete confirmation for `targetId` (`null` = none shown). It
 * nests `sessions` exactly as the docked list does, so the count, the busy
 * warning and the deletion cover the rows drawn under the target. Confirm
 * calls `onDelete` once per session, in {@link sessionDeletionOrder}, then
 * `onClose`; cancel calls only `onClose`.
 */
export function SessionDeleteConfirm<T extends DeletableSession>({
  targetId,
  sessions,
  activeSessionId,
  onDelete,
  onClose,
}: {
  targetId: string | null
  sessions: readonly T[]
  activeSessionId: string
  onDelete: (sessionId: string) => void
  onClose: () => void
}) {
  const tree = useMemo(
    () => (targetId === null ? null : sidebarSessionTree(sessions, readSessionListView())),
    [sessions, targetId],
  )
  const info = tree ? sessionDeleteInfoFor(sessions, tree, targetId) : null
  if (!tree || !info) return null
  return (
    <SessionDeleteDialog
      title={info.title}
      childCount={info.childCount}
      busyChildCount={info.busyChildCount}
      onCancel={onClose}
      onConfirm={withChildren => {
        for (const id of sessionDeletionOrder(tree.childrenOf, info.sessionId, withChildren, activeSessionId)) {
          onDelete(id)
        }
        onClose()
      }}
    />
  )
}

/**
 * Asks before a session is deleted. `childCount` > 0 adds a checkbox, off by
 * default, that extends the delete to the sessions under it; while it is
 * ticked, `busyChildCount` > 0 adds a line saying those will be stopped.
 * `onConfirm` says whether it was ticked. Backdrop click and Escape cancel.
 */
export function SessionDeleteDialog({
  title,
  childCount,
  busyChildCount = 0,
  onCancel,
  onConfirm,
}: {
  title: string
  childCount: number
  busyChildCount?: number
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
            {t(
              childCount === 1 ? 'sidebar.sessionDeleteChildrenOne' : 'sidebar.sessionDeleteChildren',
              { count: childCount },
            )}
          </label>
        )}
        {childCount > 0 && withChildren && busyChildCount > 0 && (
          <p
            className="mt-2 text-sm text-destructive"
            data-testid="session-delete-busy"
            role="status"
          >
            {t(
              busyChildCount === 1 ? 'sidebar.sessionDeleteBusyOne' : 'sidebar.sessionDeleteBusy',
              { count: busyChildCount },
            )}
          </p>
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
