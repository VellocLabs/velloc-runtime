/**
 * Confirmation for deleting a session from the sidebar, the order the
 * confirmed deletion runs in, and the cover shown while it runs. A session
 * with child sessions nested under it offers to delete them too, and says
 * when any of them is still working. (F-36)
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useUnsavedEditsGate } from '@/glic/unsavedEditsGate'
import { useT } from './i18n'
import type { ListableSession } from './sessionListView'
import { readSectionCollapsed, readSessionListView } from './sessionListView'
import { projectSessionTree, sidebarRowOrder, sidebarSessionTree } from './sessionPinning'
import { descendantSessionIds, rootOf, type SessionTree, type TreeableSession } from './sessionTree'
import { hiddenSessionIds } from './sessionVisibility'

type DeletableSession = TreeableSession &
  ListableSession & { title: string; starting?: boolean; projectRoot?: string }

/** A session the screen may move to before a delete: a sidebar row, unless a teammate or side chat. */
export type ShowableSession = DeletableSession & { pinned?: boolean; spawnerSessionId?: string; sideChat?: boolean }

/**
 * Where a row's Delete was pressed: a Projects folder's list (`projectPath`,
 * the folder's normalized path) or, without one, the Pinned/Recents list.
 */
export type SessionDeleteOrigin = { projectPath?: string }

/** The session awaiting delete confirmation and the list it was picked from. */
export type SessionDeleteTarget = SessionDeleteOrigin & { sessionId: string }

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
 * The session to show before a delete starts, when the one on screen is among
 * `doomed`: the top-level row `targetId` sits under if it survives, else the
 * nearest surviving top-level row after it in sidebar order, else before it.
 * Hidden rows are never picked; collapsed ones only when no shown row would do.
 * `undefined` when the shown session survives or no top-level row would (the
 * shell then opens a fresh session as the last delete lands).
 */
export function sessionToShowBeforeDelete<T extends ShowableSession>(
  sessions: readonly T[],
  doomed: readonly string[],
  targetId: string,
  activeSessionId: string,
  now: number = Date.now(),
): string | undefined {
  const gone = new Set(doomed)
  if (!gone.has(activeSessionId)) return undefined
  const hidden = hiddenSessionIds(sessions)
  const view = readSessionListView()
  const tree = sidebarSessionTree(sessions, view)
  const top = rootOf(targetId, tree) ?? targetId
  if (!gone.has(top) && !hidden.has(top)) return top
  const everyParent = new Set(sessions.map(session => session.sessionId))
  // A teammate (it goes with its lead) and a side chat are never sidebar rows to land on.
  const rows = (collapsed: { pinned?: boolean; recents?: boolean }) =>
    sidebarRowOrder(sessions, view, now, collapsed, everyParent)
      .filter(session =>
        session.lineageKind !== 'team' && !session.spawnerSessionId && !session.sideChat &&
        !hidden.has(session.sessionId))
      .map(session => session.sessionId)
  const shown = rows({ pinned: readSectionCollapsed('pinned'), recents: readSectionCollapsed('recents') })
  return nearestSurvivor(shown, top, gone) ?? nearestSurvivor(rows({}), top, gone)
}

/** The first id after `from` in `order` that is not `gone`, else the nearest before it; any survivor when `from` is absent. */
function nearestSurvivor(order: readonly string[], from: string, gone: ReadonlySet<string>): string | undefined {
  const at = order.indexOf(from)
  if (at < 0) return order.find(id => !gone.has(id))
  return order.slice(at + 1).find(id => !gone.has(id)) ??
    order.slice(0, at).reverse().find(id => !gone.has(id))
}

/** How long one removal may take before the run stops waiting for confirmations. */
export const SESSION_REMOVAL_TIMEOUT_MS = 30_000

/**
 * Deletes `ids` in order. While the runtime confirms each removal, the next
 * delete starts only once the previous one is confirmed. The first delete
 * that resolves `false` (no confirmation in time) ends the waiting: the rest
 * are sent straight away, since the runtime queues deletes itself.
 * `onProgress` hears `done` after each one. A failed delete is counted and
 * the run goes on; never rejects.
 */
export async function runSessionDeletion(
  ids: readonly string[],
  deleteOne: (sessionId: string) => Promise<boolean | void> | boolean | void,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const warn = (id: string, err: unknown) => console.warn(`[sidebar] deleting session ${id} failed`, err)
  onProgress(0, ids.length)
  let waiting = true
  for (const [index, id] of ids.entries()) {
    try {
      const sent = Promise.resolve(deleteOne(id))
      if (waiting) {
        if ((await sent) === false) waiting = false
      } else {
        sent.catch(err => warn(id, err))
      }
    } catch (err) {
      warn(id, err)
    }
    onProgress(index + 1, ids.length)
  }
}

/**
 * One confirmed delete run at a time. `start` deletes `ids` with
 * {@link runSessionDeletion}, shows {@link SessionDeleteProgress} as `cover`
 * (`null` when idle) while it runs, then calls `onDone`. An empty `ids` calls
 * `onDone` at once, with no cover.
 */
export function useSessionDeletionRun(): {
  cover: ReactNode
  running: boolean
  start: (ids: readonly string[], deleteOne: (sessionId: string) => Promise<boolean | void> | boolean | void, onDone: () => void) => void
} {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const start = useCallback(
    (ids: readonly string[], deleteOne: (sessionId: string) => Promise<boolean | void> | boolean | void, onDone: () => void) => {
      if (ids.length === 0) {
        onDone()
        return
      }
      void runSessionDeletion(ids, deleteOne, (done, total) => setProgress({ done, total })).finally(() => {
        setProgress(null)
        onDone()
      })
    },
    [],
  )
  return {
    cover: progress ? <SessionDeleteProgress done={progress.done} total={progress.total} /> : null,
    running: progress !== null,
    start,
  }
}

/**
 * The shell's delete confirmation for `target` (`null` = none shown).
 * `sessions` is the list the Delete came from, nested as drawn there.
 * Confirm moves the screen off a session it will delete
 * ({@link sessionToShowBeforeDelete}), runs {@link runSessionDeletion} in
 * {@link sessionDeletionOrder} behind {@link SessionDeleteProgress}, then
 * calls `onClose`; cancel calls only `onClose`.
 */
export function SessionDeleteConfirm<T extends ShowableSession>({
  target,
  sessions,
  activeSessionId,
  onShow,
  onDelete,
  onClose,
}: {
  target: SessionDeleteTarget | null
  sessions: readonly T[]
  activeSessionId: string
  /** Shows a session; called once, before the first delete, when the one on screen is about to go. */
  onShow: (sessionId: string) => void
  /** Settles once the runtime has removed the session: `true`, or `false` when it gave up waiting. */
  onDelete: (sessionId: string) => Promise<boolean | void> | boolean | void
  onClose: () => void
}) {
  const run = useSessionDeletionRun()
  const targetId = target?.sessionId ?? null
  const projectPath = target?.projectPath
  const running = run.running
  const tree = useMemo(() => {
    if (running) return null
    if (targetId === null) return null
    const view = readSessionListView()
    return projectPath === undefined
      ? sidebarSessionTree(sessions, view)
      : projectSessionTree(sessions, view, projectPath)
  }, [sessions, targetId, projectPath, running])
  if (run.cover) return run.cover
  const info = tree ? sessionDeleteInfoFor(sessions, tree, targetId) : null
  if (!tree || !info) return null
  return (
    <SessionDeleteDialog
      title={info.title}
      childCount={info.childCount}
      busyChildCount={info.busyChildCount}
      onCancel={onClose}
      onConfirm={withChildren => {
        const ids = sessionDeletionOrder(tree.childrenOf, info.sessionId, withChildren, activeSessionId)
        const show = sessionToShowBeforeDelete(sessions, ids, info.sessionId, activeSessionId)
        if (show !== undefined) onShow(show)
        run.start(ids, onDelete, onClose)
      }}
    />
  )
}

/**
 * Asks before a session is deleted. Without children: Cancel or Delete.
 * With `childCount` > 0: the body says they move to the top level unless
 * deleted too, `busyChildCount` > 0 adds how many of them are still working,
 * and the choice is Delete this session or Delete all. `onConfirm` says
 * whether the children go too. Backdrop click and Escape cancel.
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
  const nested = childCount > 0
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
        className="w-full max-w-lg rounded-2xl border bg-background p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <h2
          id="session-delete-dialog-title"
          className="text-lg font-semibold text-foreground"
        >
          {t('sidebar.sessionDeleteTitle')}
        </h2>
        <p
          className="mt-2 text-sm leading-relaxed text-muted-foreground"
          data-testid="session-delete-body"
        >
          {nested
            ? t(childCount === 1 ? 'sidebar.sessionDeleteNestedBodyOne' : 'sidebar.sessionDeleteNestedBody', {
                title,
                count: childCount,
              })
            : t('sidebar.sessionDeleteBody', { title })}
        </p>
        {nested && busyChildCount > 0 && (
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
        <div className="mt-6 flex items-center gap-2">
          <Button
            variant="ghost"
            data-testid="session-delete-cancel"
            onClick={onCancel}
            autoFocus
          >
            {t('sidebar.sessionDeleteCancel')}
          </Button>
          <div className="ms-auto flex flex-wrap justify-end gap-2">
            {nested && (
              <Button
                variant="secondary"
                data-testid="session-delete-all"
                onClick={() => onConfirm(true)}
              >
                {t('sidebar.sessionDeleteAll', { count: childCount + 1 })}
              </Button>
            )}
            <Button
              variant="destructive"
              data-testid="session-delete-confirm"
              onClick={() => onConfirm(false)}
            >
              {t(nested ? 'sidebar.sessionDeleteOnlyThis' : 'sidebar.sessionDeleteConfirm')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Covers the whole window while a confirmed delete runs: nothing beneath it
 * takes a click or a key, and it shows how many of `total` are gone.
 */
export function SessionDeleteProgress({ done, total }: { done: number; total: number }) {
  const t = useT()
  useUnsavedEditsGate(true)
  const coverRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    coverRef.current?.focus()
    // Window capture runs before every document and element listener, so no shortcut gets through.
    const swallow = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const kinds = ['keydown', 'keypress', 'keyup'] as const
    for (const kind of kinds) window.addEventListener(kind, swallow, true)
    return () => {
      for (const kind of kinds) window.removeEventListener(kind, swallow, true)
    }
  }, [])
  const percent = total === 0 ? 100 : Math.round((done / total) * 100)
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-busy="true"
      aria-labelledby="session-delete-progress-title"
      data-testid="session-delete-progress"
      data-done={done}
      data-total={total}
      tabIndex={-1}
      ref={coverRef}
      onPointerDownCapture={event => event.stopPropagation()}
      onClickCapture={event => event.stopPropagation()}
    >
      <div className="w-full max-w-sm rounded-2xl border bg-background p-6 shadow-2xl">
        <h2
          id="session-delete-progress-title"
          className="text-base font-semibold text-foreground"
        >
          {t('sidebar.sessionDeleteProgressTitle')}
        </h2>
        <div
          className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label={t('sidebar.sessionDeleteProgress', { done, total })}
        >
          <div className="h-full bg-destructive transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          {t('sidebar.sessionDeleteProgress', { done, total })}
        </p>
      </div>
    </div>
  )
}
