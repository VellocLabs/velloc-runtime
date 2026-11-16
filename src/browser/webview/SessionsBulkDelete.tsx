/**
 * One confirmation for deleting every session picked on the Sessions page,
 * and the run that deletes them behind the session delete's progress cover.
 * (F-17)
 */
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useUnsavedEditsGate } from '@/glic/unsavedEditsGate'
import { useT } from './i18n'
import {
  isBusy,
  sessionToShowBeforeDelete,
  useSessionDeletionRun,
  type ShowableSession,
} from './SessionDeleteDialog'
import { sessionDisplayTitle, type SessionListItem } from './SessionRows'

/** How many picked titles the dialog names before "and N more". */
export const BULK_DELETE_NAMED_TITLES = 5

/**
 * The picked sessions still listed, in the order to delete them: the active
 * session last, since deleting it re-points the shell. Only the picked rows
 * go; a child left unpicked moves to the top level, as a single delete's
 * "Delete this session" does.
 */
export function bulkDeletionOrder(
  sessions: readonly { sessionId: string }[],
  picked: readonly string[],
  activeSessionId: string,
): string[] {
  const listed = new Set(sessions.map(session => session.sessionId))
  const ids = [...new Set(picked)].filter(id => listed.has(id))
  return [...ids.filter(id => id !== activeSessionId), ...ids.filter(id => id === activeSessionId)]
}

/**
 * The shell's bulk delete confirmation for `target` (`null` = none shown).
 * Confirm moves the screen off the session on screen when it is picked
 * ({@link sessionToShowBeforeDelete}), deletes the picks one at a time behind
 * the progress cover, then calls `onClose`; Cancel calls only `onClose`.
 * Nothing still listed to delete closes it.
 */
export function SessionsBulkDeleteConfirm<T extends ShowableSession & SessionListItem>({
  target,
  sessions,
  activeSessionId,
  onShow,
  onDelete,
  onClose,
}: {
  target: readonly string[] | null
  sessions: readonly T[]
  activeSessionId: string
  /** Shows a session; called once, before the first delete, when the one on screen is about to go. */
  onShow: (sessionId: string) => void
  /** Settles once the runtime has removed the session: `true`, or `false` when it gave up waiting. */
  onDelete: (sessionId: string) => Promise<boolean | void> | boolean | void
  onClose: () => void
}) {
  const run = useSessionDeletionRun()
  const order = target && !run.running ? bulkDeletionOrder(sessions, target, activeSessionId) : []
  const nothingLeft = target !== null && !run.running && order.length === 0
  useEffect(() => {
    if (nothingLeft) onClose()
  }, [nothingLeft, onClose])
  if (run.cover) return run.cover
  if (!target || order.length === 0) return null
  const byId = new Map(sessions.map(session => [session.sessionId, session] as const))
  const picked = order.map(id => byId.get(id)!).filter(Boolean)
  return (
    <SessionsBulkDeleteDialog
      sessions={picked}
      onCancel={onClose}
      onConfirm={() => {
        const show = sessionToShowBeforeDelete(sessions, order, activeSessionId, activeSessionId)
        if (show !== undefined) onShow(show)
        run.start(order, onDelete, onClose)
      }}
    />
  )
}

/**
 * Asks once before the picked sessions are deleted: how many, the first
 * {@link BULK_DELETE_NAMED_TITLES} titles, and how many are still working.
 * Backdrop click and Escape cancel.
 */
export function SessionsBulkDeleteDialog({
  sessions,
  onCancel,
  onConfirm,
}: {
  sessions: readonly SessionListItem[]
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useT()
  // Hand-rolled modal: hold the background updater's reload while it is up.
  useUnsavedEditsGate(true)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  const count = sessions.length
  const busyCount = sessions.filter(isBusy).length
  const named = sessions.slice(0, BULK_DELETE_NAMED_TITLES)
  const more = count - named.length
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sessions-bulk-delete-title"
      data-testid="sessions-bulk-delete-dialog"
      data-count={count}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <h2 id="sessions-bulk-delete-title" className="text-lg font-semibold text-foreground">
          {t(count === 1 ? 'sessionsPage.deleteTitleOne' : 'sessionsPage.deleteTitle', { count })}
        </h2>
        <ul className="mt-3 flex flex-col gap-1 text-sm text-foreground">
          {named.map(session => (
            <li key={session.sessionId} data-testid="sessions-bulk-delete-name" className="truncate">
              {sessionDisplayTitle(session, t)}
            </li>
          ))}
          {more > 0 && (
            <li className="text-muted-foreground">{t('sessionsPage.deleteMore', { count: more })}</li>
          )}
        </ul>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {t('sessionsPage.deleteBody')}
        </p>
        {busyCount > 0 && (
          <p data-testid="sessions-bulk-delete-busy" className="mt-2 text-sm leading-relaxed text-warning">
            {t(busyCount === 1 ? 'sessionsPage.deleteBusyOne' : 'sessionsPage.deleteBusy', { count: busyCount })}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" data-testid="sessions-bulk-delete-cancel" onClick={onCancel} autoFocus>
            {t('sessionsPage.deleteCancel')}
          </Button>
          <Button variant="destructive" data-testid="sessions-bulk-delete-confirm" onClick={onConfirm}>
            {t('sessionsPage.deleteConfirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
