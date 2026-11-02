import { describe, expect, it, vi } from 'vitest'
import { readStoredReviewSnapshot, projectStoredReview } from './stored-snapshot'
import { ReviewReportStore } from './report-store'
import { unconfiguredFs, type RuntimeFs } from '../utils/fs/runtimeFs'

async function fixture() {
  const records = new Map<string, string>()
  const store = new ReviewReportStore({ listRunIds: async () => [...records.keys()], load: async id => records.get(id) ?? null, save: async (id, text) => { records.set(id, text) } }, { id: () => 'r1', sanitizeExcerpt: value => value })
  await store.createRun({ conversationKey: 's1', scope: { kind: 'workspace', workspaceKey: '/repo', repository: { projectKey: 'repo' }, revision: { base: 'a', head: 'b' }, pathFilter: [] }, policy: { level: 'low', recipe: 'quick-hunks', recipeRevision: 1, execution: 'isolated', presentation: 'terminal', reportLimit: 4 } })
  await store.start('r1')
  const raw = JSON.parse(records.get('r1')!)
  raw.grants = [{ token: 'MUST-NOT-LEAK' }]
  raw.actions = [{ id: 'p1', kind: 'publication', state: 'running', diagnosticIds: [], secret: 'MUST-NOT-LEAK' }]
  raw.publications = [{ receiptId: 'p1', state: 'pending', credential: 'MUST-NOT-LEAK' }]
  raw.run.extra = 'MUST-NOT-LEAK'
  const file = '/sessions/s1/code-review/r1.json'
  const files = new Map([[file, JSON.stringify(raw)], ['/sessions/s1/code-review/presentation/r1.json', JSON.stringify({ emptyScope: true, target: './a.ts', credentials: 'MUST-NOT-LEAK' })]])
  const dirs = new Set(['/', '/sessions', '/sessions/s1', '/sessions/s1/code-review', '/sessions/s1/code-review/presentation'])
  const missing = () => Object.assign(new Error('ENOENT: missing'), { code: 'ENOENT' })
  const fs: RuntimeFs = { ...unconfiguredFs,
    realpath: vi.fn(async path => path),
    stat: vi.fn(async path => {
      if (!files.has(path) && !dirs.has(path)) throw missing()
      return { size: new TextEncoder().encode(files.get(path) ?? '').length, isFile: () => files.has(path), isDirectory: () => dirs.has(path), isSymbolicLink: () => false } as Awaited<ReturnType<RuntimeFs['stat']>>
    }),
    readdir: vi.fn(async () => [{ name: 'r1.json', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }]),
    readFileBytes: vi.fn(async path => { if (!files.has(path)) throw missing(); return new TextEncoder().encode(files.get(path)!) }),
    writeFile: vi.fn(), mkdir: vi.fn(),
  }
  return { fs, raw, files, file }
}
describe('stored review cold projection', () => {
  it('reads before engine boot, recovers interrupted status in memory, and strips internal data recursively', async () => {
    const { fs, files, file } = await fixture()
    const before = files.get(file)
    const result = await readStoredReviewSnapshot({ fs, sessionBase: '/sessions', sessionId: 's1' })
    expect(result.reports[0]).toMatchObject({ run: { progress: { status: 'partial' } }, coverage: { complete: false, limitations: ['interrupted-run'] }, actions: [{ state: 'uncertain' }], emptyScope: true, targetLabel: './a.ts' })
    expect(Object.values(result.reports[0]!.permissions!)).toEqual(expect.arrayContaining([false]))
    expect(Object.values(result.reports[0]!.permissions!).every(value => value === false)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('MUST-NOT-LEAK')
    expect(fs.writeFile).not.toHaveBeenCalled(); expect(fs.mkdir).not.toHaveBeenCalled(); expect(files.get(file)).toBe(before)
  })
  it('rejects cross-session records, unknown versions and malformed nested schema', async () => {
    const { raw } = await fixture()
    expect(() => projectStoredReview(JSON.stringify(raw), 's2', 'r1')).toThrow('review-session-mismatch')
    expect(() => projectStoredReview(JSON.stringify({ ...raw, version: 2 }), 's1', 'r1')).toThrow()
    raw.run.progress.spawnedTasks = '8'
    expect(() => projectStoredReview(JSON.stringify(raw), 's1', 'r1')).toThrow()
  })
  it('rejects junctioned session directories before reading report contents', async () => {
    const { fs } = await fixture()
    fs.realpath = vi.fn(async path => path === '/sessions/s1' ? '/outside' : path)
    await expect(readStoredReviewSnapshot({ fs, sessionBase: '/sessions', sessionId: 's1' })).rejects.toThrow('review-storage-not-authorized')
    expect(fs.readFileBytes).not.toHaveBeenCalled()
  })
  it('returns an empty view for a missing review directory without creating it', async () => {
    const { fs } = await fixture()
    fs.stat = vi.fn(async () => { throw Object.assign(new Error('ENOENT: missing'), { code: 'ENOENT' }) })
    expect(await readStoredReviewSnapshot({ fs, sessionBase: '/sessions', sessionId: 's1' })).toEqual({ sessionId: 's1', sequence: 0, reports: [] })
    expect(fs.mkdir).not.toHaveBeenCalled()
  })
})
