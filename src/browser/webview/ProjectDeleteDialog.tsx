/**
 * Confirmation for deleting a project from the sidebar, and the run that
 * deletes its sessions one at a time behind the session delete's progress
 * cover. (F-17)
 */
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { useUnsavedEditsGate } from '@/glic/unsavedEditsGate'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { useT } from './i18n'
import { projectDisplayName } from './projectsStorage'
import { normalizeProjectPath } from './projectTree'
import {
  sessionToShowBeforeDelete,
  useSessionDeletionRun,
  type ShowableSession,
} from './SessionDeleteDialog'

/** The project awaiting delete confirmation. */
export type ProjectDeleteTarget = { path: string }

/** What the plan reads of a stored session. */
type ProjectSession = { sessionId: string; projectRoot?: string; spawnerSessionId?: string }

/** What a confirmed delete of one project does. */
export type ProjectDeletionPlan = {
  /** The sessions to delete, one at a time, in this order. */
  order: string[]
  /** Every session the run removes: `order` plus the teammates that go with a lead in it. */
  gone: string[]
  /** The session whose delete takes the shown one: its lead when a teammate is shown. */
  anchor: string
}

/**
 * What deleting the project at `path` removes. `order` is every session filed
 * under the folder, except a teammate whose lead is also going (the runtime
 * removes it with the lead), with `anchor` last when it is in the order,
 * since deleting it re-points the shell.
 */
export function projectDeletionPlan(
  sessions: readonly ProjectSession[],
  path: string,
  activeSessionId: string,
): ProjectDeletionPlan {
  const normalized = normalizeProjectPath(path)
  const filed = sessions.filter(
    session => session.projectRoot && normalizeProjectPath(session.projectRoot) === normalized,
  )
  const filedIds = new Set(filed.map(session => session.sessionId))
  const ids = filed
    .filter(session => !session.spawnerSessionId || !filedIds.has(session.spawnerSessionId))
    .map(session => session.sessionId)
  const going = new Set(ids)
  const active = sessions.find(session => session.sessionId === activeSessionId)
  const anchor =
    active?.spawnerSessionId && going.has(active.spawnerSessionId) ? active.spawnerSessionId : activeSessionId
  return {
    order: [...ids.filter(id => id !== anchor), ...ids.filter(id => id === anchor)],
    gone: [
      ...ids,
      ...sessions
        .filter(session => session.spawnerSessionId && going.has(session.spawnerSessionId) && !going.has(session.sessionId))
        .map(session => session.sessionId),
    ],
    anchor,
  }
}

/**
 * The shell's project delete confirmation for `target` (`null` = none shown).
 * `sessions` is every stored session; `listed` is the sidebar's rows (where
 * the screen may move). The dialog names how many sessions the run deletes.
 * Confirm moves the screen off any session in the plan's `gone`
 * ({@link sessionToShowBeforeDelete}), runs the plan's order through
 * {@link useSessionDeletionRun}, then calls `onDeleted` with the path.
 */
export function ProjectDeleteConfirm<T extends ShowableSession>({
  target,
  sessions,
  listed,
  activeSessionId,
  onShow,
  onDelete,
  onDeleted,
  onCancel,
}: {
  target: ProjectDeleteTarget | null
  sessions: readonly ProjectSession[]
  listed: readonly T[]
  activeSessionId: string
  /** Shows a session; called once, before the first delete, when the one on screen is about to go. */
  onShow: (sessionId: string) => void
  /** Settles once the runtime has removed the session: `true`, or `false` when it gave up waiting. */
  onDelete: (sessionId: string) => Promise<boolean | void> | boolean | void
  /** The run is over: drop the project from the list. */
  onDeleted: (path: string) => void
  onCancel: () => void
}) {
  const run = useSessionDeletionRun()
  const plan = useMemo(
    () => (target ? projectDeletionPlan(sessions, target.path, activeSessionId) : null),
    [sessions, target, activeSessionId],
  )
  if (run.cover) return run.cover
  if (!target || !plan) return null
  return (
    <ProjectDeleteDialog
      path={target.path}
      sessionCount={plan.order.length}
      onCancel={onCancel}
      onConfirm={() => {
        const show = sessionToShowBeforeDelete(listed, plan.gone, plan.anchor, activeSessionId)
        if (show !== undefined) onShow(show)
        run.start(plan.order, onDelete, () => onDeleted(target.path))
      }}
    />
  )
}

/**
 * Confirmation for deleting a project: it removes the conversation history Nexus stores
 * (`~/.velloc/projects/<sanitized>/`), never the user's source folder, and names both
 * paths. A project with no sessions is only un-listed. Backdrop click cancels.
 */
export function ProjectDeleteDialog({
  path,
  sessionCount,
  onCancel,
  onConfirm,
}: {
  path: string
  sessionCount: number
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useT()
  const name = projectDisplayName(path)
  // Hand-rolled modal, not the shared Dialog primitive (which holds the gate
  // itself): hold the background updater's reload while it is up
  // (glic/unsavedEditsGate.ts). Mounted only while shown.
  useUnsavedEditsGate(true)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-delete-dialog-title"
      data-testid="project-delete-dialog"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border bg-background p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <h2
          id="project-delete-dialog-title"
          className="text-lg font-semibold text-foreground"
        >
          {t('sidebar.projectDeleteTitle')}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {sessionCount === 0
            ? t('sidebar.projectDeleteEmptyBody', { name })
            : t('sidebar.projectDeleteBody', {
                count: sessionCount,
                name,
                store: `${RUNTIME_DIR_NAME}/projects`,
                path,
              })}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="outline"
            data-testid="project-delete-cancel"
            onClick={onCancel}
          >
            {t('sidebar.projectDeleteCancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="project-delete-confirm"
            onClick={onConfirm}
          >
            {t('sidebar.projectDeleteConfirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
