import { describe, expect, it } from 'vitest'
import {
  archivedWorktreeLogLine,
  insideFolder,
  sameFolder,
  settleWorktreeOnArchive,
  settleWorktreeOnUnarchive,
  worktreeRecordOf,
  type ArchivedWorktreeDeps,
} from '../browser/worker/archivedWorktree'
import type { SessionWorktreeRecord } from '../sessions/sessionRecords'
import type { GitRunResult } from '../utils/agentWorktree'

// A person's archive removes a clean session worktree and keeps its branch;
// one with changes or ignored files, one git cannot read, or one another live
// session uses stays. Unarchive checks a removed one out again. (F-36)

const RECORD: SessionWorktreeRecord = {
  dir: 'D:/repo/.velloc/worktrees/parser',
  branch: 'session/parser',
  repoRoot: 'D:/repo',
}

type Answer = (command: string) => GitRunResult

function harness(opts: {
  record?: SessionWorktreeRecord
  answer?: Answer
  inUse?: boolean
} = {}) {
  let record = opts.record
  const commands: string[] = []
  const writes: SessionWorktreeRecord[] = []
  const answer: Answer = opts.answer ?? (() => ({ ok: true, stdout: '' }))
  const deps: ArchivedWorktreeDeps = {
    readWorktree: async () => record,
    writeWorktree: async (_id, next) => {
      writes.push(next)
      record = next
    },
    inUseElsewhere: async () => opts.inUse === true,
    run: (_id, cwd) => async command => {
      expect(cwd).toBe(RECORD.repoRoot)
      commands.push(command)
      return answer(command)
    },
    now: () => 1234,
  }
  return { deps, commands, writes, current: () => record }
}

describe('archive', () => {
  it('removes a clean worktree without --force and keeps its branch', async () => {
    const h = harness({ record: RECORD })
    expect(await settleWorktreeOnArchive(h.deps, 's1')).toEqual({ action: 'removed', dir: RECORD.dir })
    expect(h.commands).toEqual([
      'git -C "D:/repo/.velloc/worktrees/parser" status --porcelain --untracked-files=normal',
      'git -C "D:/repo/.velloc/worktrees/parser" status --porcelain --untracked-files=normal --ignored',
      'git -C "D:/repo" worktree remove "D:/repo/.velloc/worktrees/parser"',
    ])
    expect(h.commands.some(c => c.includes('--force') || c.includes('branch -D'))).toBe(false)
    expect(h.writes).toEqual([{ ...RECORD, removedAt: 1234 }])
  })

  it('keeps a worktree with changes and counts them', async () => {
    const h = harness({
      record: RECORD,
      answer: c => (c.includes('status') ? { ok: true, stdout: ' M a.ts\n?? b.ts\n' } : { ok: true, stdout: '' }),
    })
    expect(await settleWorktreeOnArchive(h.deps, 's1')).toEqual({
      action: 'kept', dir: RECORD.dir, reason: 'changes', changes: 2,
    })
    expect(h.commands).toHaveLength(1)
    expect(h.writes).toEqual([])
  })

  it('keeps a worktree holding only ignored files, which a removal would delete', async () => {
    const h = harness({
      record: RECORD,
      answer: c => (c.endsWith('--ignored') ? { ok: true, stdout: '!! .env\n!! node_modules/\n' } : { ok: true, stdout: '' }),
    })
    expect(await settleWorktreeOnArchive(h.deps, 's1')).toEqual({ action: 'kept', dir: RECORD.dir, reason: 'ignored_files' })
    expect(h.commands.some(c => c.includes('worktree remove'))).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('keeps a worktree when git cannot list its ignored files', async () => {
    const h = harness({
      record: RECORD,
      answer: c => (c.endsWith('--ignored') ? { ok: false, stdout: 'fatal' } : { ok: true, stdout: '' }),
    })
    expect(await settleWorktreeOnArchive(h.deps, 's1')).toMatchObject({ action: 'kept', reason: 'unreadable' })
    expect(h.commands.some(c => c.includes('worktree remove'))).toBe(false)
  })

  it('keeps a worktree git cannot read', async () => {
    const h = harness({ record: RECORD, answer: () => ({ ok: false, stdout: 'fatal: not a git repository' }) })
    expect(await settleWorktreeOnArchive(h.deps, 's1')).toMatchObject({ action: 'kept', reason: 'unreadable' })
    expect(h.writes).toEqual([])
  })

  it('keeps a worktree another live session works in, without asking git', async () => {
    const h = harness({ record: RECORD, inUse: true })
    expect(await settleWorktreeOnArchive(h.deps, 's1')).toMatchObject({ action: 'kept', reason: 'in_use' })
    expect(h.commands).toEqual([])
  })

  it('keeps it when git refuses the removal', async () => {
    const h = harness({
      record: RECORD,
      answer: c => (c.includes('worktree remove') ? { ok: false, stdout: 'contains modified files' } : { ok: true, stdout: '' }),
    })
    expect(await settleWorktreeOnArchive(h.deps, 's1')).toMatchObject({ action: 'kept', reason: 'remove_failed' })
    expect(h.writes).toEqual([])
  })

  it('does nothing for a session with no worktree, or one already removed', async () => {
    expect(await settleWorktreeOnArchive(harness().deps, 's1')).toEqual({ action: 'none' })
    const removed = harness({ record: { ...RECORD, removedAt: 1 } })
    expect(await settleWorktreeOnArchive(removed.deps, 's1')).toEqual({ action: 'none' })
    expect(removed.commands).toEqual([])
  })
})

describe('unarchive', () => {
  it('checks a removed worktree out again from its branch and clears the mark', async () => {
    const h = harness({ record: { ...RECORD, removedAt: 1 } })
    expect(await settleWorktreeOnUnarchive(h.deps, 's1')).toEqual({ action: 'restored', dir: RECORD.dir })
    expect(h.commands).toEqual([
      `git -C "D:/repo" worktree add "D:/repo/.velloc/worktrees/parser" 'session/parser'`,
    ])
    expect(h.current()).toEqual(RECORD)
  })

  it('reports a failed checkout and keeps the mark', async () => {
    const h = harness({ record: { ...RECORD, removedAt: 1 }, answer: () => ({ ok: false, stdout: 'already exists' }) })
    expect(await settleWorktreeOnUnarchive(h.deps, 's1')).toEqual({
      action: 'restore_failed', dir: RECORD.dir, reason: 'already exists',
    })
    expect(h.current()?.removedAt).toBe(1)
  })

  it('leaves a kept worktree alone', async () => {
    const h = harness({ record: RECORD })
    expect(await settleWorktreeOnUnarchive(h.deps, 's1')).toEqual({ action: 'none' })
    expect(h.commands).toEqual([])
  })
})

describe('helpers', () => {
  it('reads only a whole record', () => {
    expect(worktreeRecordOf(RECORD)).toEqual(RECORD)
    expect(worktreeRecordOf({ ...RECORD, removedAt: 5 })).toEqual({ ...RECORD, removedAt: 5 })
    expect(worktreeRecordOf({ dir: 'x', branch: '' , repoRoot: 'y' })).toBeUndefined()
    expect(worktreeRecordOf('x')).toBeUndefined()
    expect(worktreeRecordOf(undefined)).toBeUndefined()
  })

  it('a folder below the checkout is inside it; a sibling with the same prefix is not', () => {
    expect(insideFolder('D:\\repo\\wt\\src', 'd:/repo/wt')).toBe(true)
    expect(insideFolder('D:/repo/wt/', 'D:/repo/wt')).toBe(true)
    expect(insideFolder('D:/repo/wt2', 'D:/repo/wt')).toBe(false)
    expect(insideFolder('D:/repo', 'D:/repo/wt')).toBe(false)
  })

  it('compares folders across slashes, a trailing slash and drive-letter case', () => {
    expect(sameFolder('D:\\repo\\wt\\', 'd:/repo/wt')).toBe(true)
    expect(sameFolder('/home/a/wt', '/home/a/WT')).toBe(false)
    expect(sameFolder('D:/repo/wt', 'D:/repo/wt2')).toBe(false)
  })

  it('logs the kept case with its count and nothing for none', () => {
    expect(archivedWorktreeLogLine('s1', { action: 'none' })).toBeNull()
    expect(
      archivedWorktreeLogLine('s1', { action: 'kept', dir: 'D:/wt', reason: 'changes', changes: 3 }),
    ).toContain('3 changed path(s)')
    expect(
      archivedWorktreeLogLine('s1', { action: 'kept', dir: 'D:/wt', reason: 'ignored_files' }),
    ).toContain('has ignored files')
  })
})
