import { describe, expect, it, vi } from 'vitest'
import { parseUnifiedDiff, resolveLocalReviewScope, resolveReviewAnchor, type ScopeResolverOptions, type WorkspaceRead } from './scope'
import { GitAdapterError, createGitArgvRunner, type GitStreamSpawner, type GitQuery, type ReviewGitRunner } from './git-adapter'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
const base = 'a'.repeat(40), head = 'b'.repeat(40), other = 'c'.repeat(40), blob = 'd'.repeat(40), empty = 'e'.repeat(40)
const encode = (text: string) => new TextEncoder().encode(text)
const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n'
function fixture(settings: { fileMode?: string; indexEntries?: string; upstream?: string; refs?: Record<string, string>; parent?: string; initial?: boolean; unborn?: boolean; tree?: string; tracked?: string; before?: string; files?: Record<string, WorkspaceRead>; patch?: string } = {}) {
  const queries: GitQuery[] = []
  const git: ReviewGitRunner = { root: '/repo', async query(q) {
    queries.push(q)
    let text: string | undefined
    switch (q.kind) {
      case 'resolve': text = q.ref === 'HEAD' ? settings.unborn ? undefined : head : settings.refs?.[q.ref]; break
      case 'upstream': text = settings.upstream; break
      case 'default-branch': break
      case 'merge-base': text = q.left; break
      case 'parents': text = head + (settings.initial ? '' : ' ' + (settings.parent ?? base)); break
      case 'empty-tree': text = empty; break
      case 'tree': text = settings.tree ?? `100644 blob ${blob}\ta.ts\0`; break
      case 'tracked': text = settings.tracked ?? 'a.ts\0'; break
      case 'file-mode': text = settings.fileMode ?? 'true'; break
      case 'index-entries': text = settings.indexEntries ?? (settings.tracked ?? 'a.ts\0').split('\0').filter(Boolean).map(path => `100644 ${blob} 0\t${path}\0`).join(''); break
      case 'blob': text = settings.before ?? 'same\nold\n'; break
      case 'diff': text = settings.patch ?? patch; break
    }
    return { exitCode: text === undefined ? 1 : 0, stdout: encode(text ?? '') }
  } }
  const readWorkspaceFile = vi.fn(async (path: string): Promise<WorkspaceRead> => settings.files?.[path] ?? (path === 'a.ts' ? { kind: 'file', bytes: encode('same\nnew\n'), gitMode: '100644' } : { kind: 'missing' }))
  const options: ScopeResolverOptions = { git, workspaceKey: 'workspace', projectKey: 'project', readWorkspaceFile }
  return { options, queries, readWorkspaceFile }
}
describe('local scope', () => {
  it('combines committed/index/worktree state into one base-to-current snapshot', async () => {
    const f = fixture({ upstream: base })
    const result = await resolveLocalReviewScope(f.options)
    expect(result.baseSource).toBe('upstream'); expect(result.files).toHaveLength(1)
    expect(result.anchors.map(a => a.side)).toEqual(['before', 'working-copy'])
    expect(result.anchors[0].revision).toBe(base)
    expect(result.scope.revision.workingCopyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(f.queries.some(q => q.kind === 'diff')).toBe(false)
    expect(result.notices).toContain('other-untracked-files-excluded')
  })
  it.each([
    [{ refs: { 'refs/heads/main': other } }, 'refs/heads/main', other],
    [{ refs: { 'refs/heads/master': other } }, 'refs/heads/master', other],
    [{}, 'parent', base], [{ initial: true }, 'initial-commit', empty],
  ] as const)('selects fallback base %#', async (settings, source, expected) => {
    const result = await resolveLocalReviewScope(fixture(settings).options)
    expect(result.baseSource).toBe(source); expect(result.scope.revision.base).toBe(expected)
  })
  it('prefers the configured local default branch over main', async () => {
    const f = fixture({ refs: { 'refs/remotes/origin/develop': other, 'refs/heads/main': base } })
    const result = await resolveLocalReviewScope({ ...f.options, defaultBranch: 'refs/remotes/origin/develop' })
    expect(result.scope.revision.base).toBe(other)
  })
  it('does not read a newly untracked file left behind by a staged deletion', async () => {
    const f = fixture({ tracked: '' })
    const result = await resolveLocalReviewScope(f.options)
    expect(f.readWorkspaceFile).not.toHaveBeenCalled()
    expect(result.anchors.map(a => a.side)).toEqual(['before'])
  })
  it('covers both a committed file and a staged addition at current working-copy contents', async () => {
    const f = fixture({ tracked: 'a.ts\0added.ts\0', files: { 'added.ts': { kind: 'file', bytes: encode('unstaged latest\n') } } })
    const result = await resolveLocalReviewScope(f.options)
    expect(result.files.map(f => f.path)).toEqual(['a.ts', 'added.ts'])
    expect(result.files[1].patch).toContain('+unstaged latest')
    expect(result.files[1].anchors.map(a => a.side)).toEqual(['working-copy'])
  })
  it('uses the empty tree for a root commit even when main points to HEAD', async () => {
    const result = await resolveLocalReviewScope(fixture({ initial: true, refs: { 'refs/heads/main': head } }).options)
    expect(result.baseSource).toBe('initial-commit'); expect(result.files).toHaveLength(1)
    expect(result.notices).toContain('initial-commit-all-tracked-files')
  })
  it('does not change normal main-to-HEAD comparison semantics', async () => {
    const result = await resolveLocalReviewScope(fixture({ refs: { 'refs/heads/main': head }, before: 'same\nnew\n' }).options)
    expect(result.baseSource).toBe('refs/heads/main'); expect(result.status).toBe('empty')
  })
  it('retains mode-only changes without inventing line anchors', async () => {
    const result = await resolveLocalReviewScope(fixture({ before: 'same\nnew\n', files: { 'a.ts': { kind: 'file', bytes: encode('same\nnew\n'), gitMode: '100755' } } }).options)
    expect(result.status).toBe('reviewable'); expect(result.files).toHaveLength(1)
    expect(result.files[0].patch).toContain('old mode 100644\nnew mode 100755')
    expect(result.anchors).toEqual([])
  })
  it('keeps an unchanged Windows workspace complete when the reader omits gitMode', async () => {
    const f = fixture({ fileMode: 'false', before: 'unchanged', files: { 'a.ts': { kind: 'file', bytes: encode('unchanged') } } })
    const result = await resolveLocalReviewScope(f.options)
    expect(result.status).toBe('empty'); expect(result.complete).toBe(true)
    expect(result.notices).not.toContain('mode-unavailable:a.ts')
    expect(f.queries).toContainEqual({ kind: 'index-entries' })
    expect(f.queries).not.toContainEqual({ kind: 'tracked' })
  })
  it('uses the staged mode on Windows rather than absent or irrelevant filesystem bits', async () => {
    for (const gitMode of [undefined, '100644'] as const) {
      const f = fixture({ fileMode: 'false', before: 'unchanged', indexEntries: `100755 ${blob} 0\ta.ts\0`, files: { 'a.ts': { kind: 'file', bytes: encode('unchanged'), gitMode } } })
      const result = await resolveLocalReviewScope(f.options)
      expect(result.status).toBe('reviewable'); expect(result.complete).toBe(true)
      expect(result.files[0].patch).toContain('old mode 100644\nnew mode 100755')
    }
  })
  it('does not invent executable-bit differences when Windows ignores filesystem mode', async () => {
    const result = await resolveLocalReviewScope(fixture({ fileMode: 'false', before: 'unchanged', files: { 'a.ts': { kind: 'file', bytes: encode('unchanged'), gitMode: '100755' } } }).options)
    expect(result.status).toBe('empty'); expect(result.complete).toBe(true)
  })
  it('marks unmerged index entries partial instead of choosing a conflict stage mode', async () => {
    const result = await resolveLocalReviewScope(fixture({ fileMode: 'false', indexEntries: `100644 ${blob} 1\ta.ts\0` }).options)
    expect(result.status).toBe('partial'); expect(result.files[0].status).toBe('skipped')
  })
  it('prefers a comparable explicit upstream even for a root commit', async () => {
    const result = await resolveLocalReviewScope(fixture({ initial: true, upstream: head, before: 'same\nnew\n' }).options)
    expect(result.baseSource).toBe('upstream'); expect(result.status).toBe('empty')
  })
  it('reports missing mode information rather than a false complete empty scope', async () => {
    const result = await resolveLocalReviewScope(fixture({ before: 'unchanged', files: { 'a.ts': { kind: 'file', bytes: encode('unchanged') } } }).options)
    expect(result.status).toBe('partial'); expect(result.notices).toContain('mode-unavailable:a.ts')
  })
  it('handles an unborn empty repository without claiming read failure as clean', async () => {
    const result = await resolveLocalReviewScope(fixture({ unborn: true, tracked: '' }).options)
    expect(result.baseSource).toBe('unborn'); expect(result.status).toBe('empty')
  })
  it('rejects an empty explicit path selection before querying Git', async () => {
    const f = fixture()
    await expect(resolveLocalReviewScope(f.options, { kind: 'paths', paths: [] })).rejects.toThrow('missing-path')
    expect(f.queries).toEqual([])
  })
  it('keeps unchanged path empty rather than auditing the full file', async () => {
    const f = fixture({ before: 'same\nnew\n' })
    const result = await resolveLocalReviewScope(f.options, { kind: 'paths', paths: ['./a.ts'] })
    expect(result.status).toBe('empty'); expect(result.files).toEqual([])
  })
  it('does not turn unchanged excluded paths into a partial review', async () => {
    const f = fixture({ before: 'same\nnew\n' })
    const result = await resolveLocalReviewScope({ ...f.options, skipPath: () => true }, { kind: 'paths', paths: ['a.ts'] })
    expect(result.status).toBe('empty')
    expect(result.files).toEqual([])
  })
  it('keeps changed excluded files visible as skipped coverage', async () => {
    const result = await resolveLocalReviewScope({ ...fixture().options, skipPath: () => true })
    expect(result.status).toBe('partial')
    expect(result.files).toEqual([{ path: 'a.ts', status: 'skipped', patch: '', anchors: [] }])
  })
  it('allows an explicit new file but does not enumerate unrelated untracked files', async () => {
    const f = fixture({ tracked: '', tree: '', files: { 'new.ts': { kind: 'file', bytes: encode('new\n') }, 'secret.env': { kind: 'file', bytes: encode('secret') } } })
    const result = await resolveLocalReviewScope(f.options, { kind: 'paths', paths: ['new.ts'] })
    expect(result.files[0].path).toBe('new.ts'); expect(result.anchors.map(a => a.side)).toEqual(['working-copy'])
    expect(f.readWorkspaceFile.mock.calls.every(c => c[0] === 'new.ts')).toBe(true)
  })
  it.each(['..', '...'])('pins both revisions for %s without touching the working tree', async operator => {
    const f = fixture({ refs: { main: base, feature: head } })
    const result = await resolveLocalReviewScope(f.options, { kind: 'range', expression: `main${operator}feature` })
    expect(result.semantics).toBe(operator === '..' ? 'two-dot' : 'three-dot')
    expect(f.queries).toContainEqual({ kind: 'diff', base, head, paths: [] })
    expect(f.readWorkspaceFile).not.toHaveBeenCalled(); expect(result.anchors[1].side).toBe('after')
  })
  it('reviews a branch without checkout or worktree modifications', async () => {
    const f = fixture({ refs: { feature: other }, upstream: base })
    const result = await resolveLocalReviewScope(f.options, { kind: 'branch', ref: 'feature' })
    expect(result.scope.revision.head).toBe(other); expect(f.readWorkspaceFile).not.toHaveBeenCalled()
  })
  it.each(['binary', 'large', 'unreadable', 'symlink'] as const)('records %s as partial rather than false empty', async kind => {
    const f = fixture({ files: { 'a.ts': kind === 'binary' ? { kind: 'file', bytes: new Uint8Array([0, 1]) } : { kind } } })
    const result = await resolveLocalReviewScope(f.options)
    expect(result.status).toBe('partial'); expect(result.complete).toBe(false); expect(result.files).toHaveLength(1)
  })
  it('preserves a coverage failure on truncated native diff output', async () => {
    const f = fixture({ refs: { feature: other } })
    const original = f.options.git.query
    f.options.git.query = async (q, signal) => { if (q.kind === 'diff') throw new GitAdapterError('output-limit'); return original(q, signal) }
    const result = await resolveLocalReviewScope(f.options, { kind: 'branch', ref: 'feature' })
    expect(result.status).toBe('partial'); expect(result.notices).toContain('diff-output-limit')
  })
})
describe('diff anchors', () => {
  it('assigns unique random keys and enforces exact side, revision and legal range', async () => {
    const files = await parseUnifiedDiff(patch, { base, head })
    const anchors = files.flatMap(f => f.anchors)
    const again = await parseUnifiedDiff(patch, { base, head })
    expect(anchors[0].anchorKey).not.toBe(again[0].anchors[0].anchorKey)
    expect(anchors[0]).toMatchObject({ revision: base, side: 'before', span: { start: 1, end: 2 } })
    expect(anchors[1]).toMatchObject({ revision: head, side: 'after' })
    expect(resolveReviewAnchor(anchors, anchors[0].anchorKey, 'a.ts', 2).span).toEqual({ start: 2, end: 2 })
    for (const line of [0, 3, -1, 1.5, NaN]) expect(() => resolveReviewAnchor(anchors, anchors[0].anchorKey, 'a.ts', line)).toThrow('invalid-anchor')
    expect(() => resolveReviewAnchor(anchors, anchors[0].anchorKey, 'else.ts', 1)).toThrow()
    expect(() => resolveReviewAnchor(anchors, 'invented', 'a.ts', 1)).toThrow()
  })
  it('maps deletions only to before and handles quoted UTF-8 paths', async () => {
    const files = await parseUnifiedDiff('diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"\n--- "a/\\303\\251.ts"\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n', { base, head })
    expect(files[0].path).toBe('é.ts'); expect(files[0].anchors).toHaveLength(1); expect(files[0].anchors[0].side).toBe('before')
  })
  it('rejects malformed or truncated hunks instead of inventing line ranges', async () => {
    await expect(parseUnifiedDiff(patch.replace('-1,2', '-1,3'), { base, head })).rejects.toThrow('invalid-diff')
    await expect(parseUnifiedDiff(patch.replace('a/a.ts', 'a/../secret'), { base, head })).rejects.toThrow()
    await expect(parseUnifiedDiff(patch.replace('-1,2', '-0,2'), { base, head })).rejects.toThrow('invalid-diff')
  })
  it('retains binary, oversized, skipped and mode-only changes in the manifest', async () => {
    expect((await parseUnifiedDiff('diff --git a/a.bin b/a.bin\nBinary files a/a.bin and b/a.bin differ\n', { base, head }))[0].status).toBe('binary')
    expect((await parseUnifiedDiff(patch, { base, head }, { maxFileBytes: 1 }))[0].status).toBe('large')
    expect((await parseUnifiedDiff(patch, { base, head }, { skipPath: () => true }))[0].status).toBe('skipped')
    const mode = await parseUnifiedDiff('diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n', { base, head })
    expect(mode).toHaveLength(1); expect(mode[0].anchors).toEqual([])
  })
})

describe.skipIf(!process.env.VELLOC_REVIEW_TEST_SCRATCH)('isolated real Git scope', () => {
  it('includes initial main tracked files and never executes hostile filters or shell-like refs', async () => {
    const root = await mkdtemp(join(process.env.VELLOC_REVIEW_TEST_SCRATCH!, 'review-git-'))
    const run = (args: string[], input?: string) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
    try {
      run(['init', '-b', 'main'])
      run(['config', 'core.filemode', 'false'])
      const oddPath = 'odd;$(echo-owned).ts'
      await writeFile(join(root, oddPath), 'literal name\n')
      await writeFile(join(root, 'a.ts'), 'tracked\n')
      await writeFile(join(root, '.gitattributes'), '*.ts filter=hostile diff=hostile\n')
      run(['add', '--', 'a.ts', '.gitattributes', oddPath])
      const tree = run(['write-tree'])
      const revision = run(['commit-tree', tree], 'fixture\n')
      run(['update-ref', 'refs/heads/main', revision])
      const bad = 'echo filter-executed >> sentinel; exit 77'
      for (const key of ['filter.hostile.clean', 'filter.hostile.smudge', 'filter.hostile.process', 'diff.hostile.command', 'diff.hostile.textconv', 'core.fsmonitor']) run(['config', key, bad])
      run(['config', 'filter.hostile.required', 'true'])
      const ref = 'feature/$(echo-owned);name'
      run(['update-ref', 'refs/heads/' + ref, revision])
      const spawner: GitStreamSpawner = async (spec, events) => {
        const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: false, stdio: 'pipe' })
        child.stdout.on('data', data => events.onOutput?.('stdout', new Uint8Array(data)))
        child.stderr.on('data', data => events.onOutput?.('stderr', new Uint8Array(data)))
        child.on('close', code => events.onExit?.({ exitCode: code ?? -1, killed: false, timedOut: false, durationMs: 1 }))
        child.on('error', () => events.onExit?.({ exitCode: -1, killed: false, timedOut: false, durationMs: 1 }))
        return { streamId: 'fixture', async write(data) { child.stdin.write(data); return true }, async closeStdin() { child.stdin.end(); return true }, async kill() { return child.kill() }, detach() { child.stdout.removeAllListeners(); child.stderr.removeAllListeners() } }
      }
      const git = await createGitArgvRunner(spawner, { authorizeRoot: async () => ({ root, gitDir: join(root, '.git'), commonDir: join(root, '.git') }) })
      const options: ScopeResolverOptions = { git, workspaceKey: root, projectKey: 'fixture', async readWorkspaceFile(path) { return { kind: 'file', bytes: new Uint8Array(await readFile(join(root, path))) } } }
      const initial = await resolveLocalReviewScope(options)
      expect(initial.baseSource).toBe('initial-commit')
      expect(initial.files.map(file => file.path)).toEqual(['.gitattributes', 'a.ts', oddPath])
      await writeFile(join(root, 'a.ts'), 'changed\n')
      const working = await resolveLocalReviewScope(options)
      expect(working.files.find(f => f.path === 'a.ts')?.patch).toContain('+changed')
      const branch = await resolveLocalReviewScope(options, { kind: 'branch', ref })
      expect(branch.scope.revision.head).toBe(revision)
      expect((await resolveLocalReviewScope(options, { kind: 'range', expression: `main...${ref}` })).status).toBe('empty')
      // A second commit makes main a normal self-base; a staged mode is still reviewable.
      const next = run(['commit-tree', tree, '-p', revision], 'second fixture\n')
      run(['update-ref', 'refs/heads/main', next])
      await writeFile(join(root, 'a.ts'), 'tracked\n')
      const unchanged = await resolveLocalReviewScope(options)
      expect(unchanged.status).toBe('empty'); expect(unchanged.complete).toBe(true)
      const blobOid = run(['rev-parse', `${revision}:a.ts`])
      run(['-c', 'core.fsmonitor=false', '-c', 'filter.hostile.process=', '-c', 'filter.hostile.clean=', '-c', 'filter.hostile.smudge=', '-c', 'filter.hostile.required=false', 'update-index', '--cacheinfo', `100755,${blobOid},a.ts`])
      const modes = await resolveLocalReviewScope(options)
      expect(modes.complete).toBe(true)
      expect(modes.baseSource).toBe('refs/heads/main')
      expect(modes.files).toHaveLength(1)
      expect(modes.files[0].patch).toContain('old mode 100644\nnew mode 100755')
      await expect(stat(join(root, 'sentinel'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
