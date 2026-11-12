/**
 * Contract: what a person's archive and unarchive do to the git worktree the
 * runtime made for a session (F-36). On archive a clean checkout is removed
 * and its branch kept; one with changes, one holding gitignored files, one git
 * cannot read, or one another live session works in is kept. On unarchive a removed checkout is checked
 * out again from its branch. Never throws; the outcome says what happened.
 * Security: the record's paths and branch come from the runtime's own
 * session record; git runs with each as one quoted word, in the repository
 * root.
 */
import type { SessionWorktreeRecord } from '../../sessions/sessionRecords'
import {
  checkoutHasIgnoredFiles,
  readCheckoutState,
  removeCheckoutKeepBranch,
  restoreCheckout,
  type HostCommandRunner,
} from '../../utils/agentWorktree'

export type ArchivedWorktreeDeps = {
  readWorktree(sessionId: string): Promise<SessionWorktreeRecord | undefined>
  writeWorktree(sessionId: string, record: SessionWorktreeRecord): Promise<void>
  /** Another live, unarchived session works in `dir` or below it, or an
   *  unarchived session listed under this one, with no worktree of its own
   *  and not a teammate, may (its folder is not on record). */
  inUseElsewhere(sessionId: string, dir: string): Promise<boolean>
  /** Git for `sessionId`, run in `cwd`. */
  run(sessionId: string, cwd: string): HostCommandRunner
  now(): number
}

export type ArchivedWorktreeOutcome =
  | { action: 'none' }
  | { action: 'removed'; dir: string }
  | { action: 'kept'; dir: string; reason: 'changes' | 'ignored_files' | 'unreadable' | 'in_use' | 'remove_failed'; changes?: number }
  | { action: 'restored'; dir: string }
  | { action: 'restore_failed'; dir: string; reason: string }

export async function settleWorktreeOnArchive(
  deps: ArchivedWorktreeDeps,
  sessionId: string,
): Promise<ArchivedWorktreeOutcome> {
  const record = await deps.readWorktree(sessionId).catch(() => undefined)
  if (!record || record.removedAt !== undefined) return { action: 'none' }
  const dir = record.dir
  if (await deps.inUseElsewhere(sessionId, dir).catch(() => true)) return { action: 'kept', dir, reason: 'in_use' }
  const run = deps.run(sessionId, record.repoRoot)
  const state = await readCheckoutState(run, dir)
  if (state.state === 'unknown') return { action: 'kept', dir, reason: 'unreadable' }
  if (state.state === 'dirty') return { action: 'kept', dir, reason: 'changes', changes: state.changes }
  const ignored = await checkoutHasIgnoredFiles(run, dir)
  if (ignored === undefined) return { action: 'kept', dir, reason: 'unreadable' }
  if (ignored) return { action: 'kept', dir, reason: 'ignored_files' }
  if (!(await removeCheckoutKeepBranch(run, record.repoRoot, dir))) {
    return { action: 'kept', dir, reason: 'remove_failed' }
  }
  await deps.writeWorktree(sessionId, { ...record, removedAt: deps.now() }).catch(() => {})
  return { action: 'removed', dir }
}

export async function settleWorktreeOnUnarchive(
  deps: ArchivedWorktreeDeps,
  sessionId: string,
): Promise<ArchivedWorktreeOutcome> {
  const record = await deps.readWorktree(sessionId).catch(() => undefined)
  if (!record || record.removedAt === undefined) return { action: 'none' }
  const restored = await restoreCheckout(deps.run(sessionId, record.repoRoot), record.repoRoot, record.dir, record.branch)
  if (!restored.ok) return { action: 'restore_failed', dir: record.dir, reason: restored.reason }
  const { removedAt: _removedAt, ...kept } = record
  await deps.writeWorktree(sessionId, kept).catch(() => {})
  return { action: 'restored', dir: record.dir }
}

/** The one-line account of an outcome for the runtime's log; null for none. */
export function archivedWorktreeLogLine(sessionId: string, outcome: ArchivedWorktreeOutcome): string | null {
  switch (outcome.action) {
    case 'none':
      return null
    case 'removed':
      return `archive of ${sessionId}: removed the clean worktree ${outcome.dir}; its branch stays`
    case 'kept':
      if (outcome.reason === 'changes') {
        return `archive of ${sessionId}: kept the worktree ${outcome.dir}, ${outcome.changes} changed path(s); unarchive to work in it again, or remove it by hand`
      }
      if (outcome.reason === 'ignored_files') {
        return `archive of ${sessionId}: kept the worktree ${outcome.dir}, it has ignored files; remove it by hand if they are not needed`
      }
      return `archive of ${sessionId}: kept the worktree ${outcome.dir} (${outcome.reason})`
    case 'restored':
      return `unarchive of ${sessionId}: checked the worktree ${outcome.dir} out again`
    case 'restore_failed':
      return `unarchive of ${sessionId}: could not check the worktree ${outcome.dir} out again: ${outcome.reason}`
  }
}

function folderKey(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s
}

/** Two paths name the same folder: slashes, a trailing slash and (on a drive path) case aside. */
export function sameFolder(a: string, b: string): boolean {
  return folderKey(a) === folderKey(b)
}

/** `path` is `dir` or a folder below it, compared as `sameFolder` does. */
export function insideFolder(path: string, dir: string): boolean {
  const p = folderKey(path)
  const d = folderKey(dir)
  return p === d || p.startsWith(`${d}/`)
}

/** A stored worktree record, or undefined when the value is not one. */
export function worktreeRecordOf(value: unknown): SessionWorktreeRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.dir !== 'string' || typeof v.branch !== 'string' || typeof v.repoRoot !== 'string') return undefined
  if (!v.dir || !v.branch || !v.repoRoot) return undefined
  return {
    dir: v.dir,
    branch: v.branch,
    repoRoot: v.repoRoot,
    ...(typeof v.removedAt === 'number' ? { removedAt: v.removedAt } : {}),
  }
}
