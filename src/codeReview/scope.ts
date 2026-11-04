import { structuredPatch } from 'diff'
import type { Diagnostic, ReviewScope } from './contracts'
import { GitAdapterError, gitText, validateGitOid, validateGitRef, validateReviewPath, type GitQuery, type ReviewGitRunner } from './git-adapter'

export type ReviewAnchor = Diagnostic['anchor'] & { anchorKey: string }
export interface DiffFile {
  path: string
  beforePath?: string
  status: 'included' | 'binary' | 'large' | 'skipped' | 'unreadable'
  patch: string
  anchors: ReviewAnchor[]
  reason?: string
}
export interface ScopeManifest {
  scope: ReviewScope
  files: DiffFile[]
  anchors: ReviewAnchor[]
  status: 'empty' | 'reviewable' | 'partial'
  complete: boolean
  notices: string[]
  baseSource: string
  semantics: 'working-copy' | 'two-dot' | 'three-dot' | 'branch'
}
export type LocalReviewTarget = { kind: 'workspace' } | { kind: 'branch'; ref: string } | { kind: 'range'; expression: string } | { kind: 'paths'; paths: string[] }
export type WorkspaceRead = { kind: 'file'; bytes: Uint8Array; gitMode?: '100644' | '100755' } | { kind: 'missing' | 'directory' | 'symlink' | 'unreadable' | 'large' }
export interface ScopeResolverOptions {
  /** Host must authorize the canonical worktree AND gitDir/commonDir, including linked-worktree markers. */
  git: ReviewGitRunner
  workspaceKey: string
  projectKey: string
  /** Enforce canonical-root containment, refuse symlinks, and cap bytes before returning.
   * gitMode supplies filesystem executable bits when core.fileMode is enabled.
   * When disabled, effective tracked modes come from the index; missing required metadata means incomplete coverage. */
  readWorkspaceFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<WorkspaceRead>
  defaultBranch?: string
  maxFileBytes?: number
  maxDiffBytes?: number
  maxFiles?: number
  skipPath?: (path: string) => boolean
}
export class ScopeError extends Error {
  constructor(readonly code: 'invalid-diff' | 'invalid-range' | 'missing-ref' | 'ambiguous-base' | 'missing-path' | 'invalid-anchor' | 'snapshot-changed') { super(code) }
}
export async function reviewDigest(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}
function unquote(value: string): string {
  if (!value.startsWith('"')) return value.replace(/\t.*$/, '')
  if (!value.endsWith('"')) throw new ScopeError('invalid-diff')
  const bytes: number[] = []
  const inner = value.slice(1, -1)
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      const character = String.fromCodePoint(inner.codePointAt(i)!)
      bytes.push(...new TextEncoder().encode(character)); i += character.length - 1; continue
    }
    const octal = inner.slice(i + 1).match(/^[0-7]{1,3}/)?.[0]
    if (octal) { bytes.push(parseInt(octal, 8)); i += octal.length; continue }
    const escapes: Record<string, string> = { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07', '\\': '\\', '"': '"' }
    const next = escapes[inner[++i]]
    if (next === undefined) throw new ScopeError('invalid-diff')
    bytes.push(...new TextEncoder().encode(next))
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
}
function diffPath(value: string, prefix: 'a/' | 'b/'): string | undefined {
  const path = unquote(value)
  if (path === '/dev/null') return undefined
  if (!path.startsWith(prefix)) throw new ScopeError('invalid-diff')
  return validateReviewPath(path.slice(2))
}
export async function parseUnifiedDiff(patch: string, revisions: { base: string; head: string; workingCopy?: boolean }, limits: { maxFileBytes?: number; skipPath?: (path: string) => boolean } = {}): Promise<DiffFile[]> {
  if (!patch.trim()) return []
  if (!patch.startsWith('diff --git ')) throw new ScopeError('invalid-diff')
  const blocks = patch.split(/(?=^diff --git )/m).filter(Boolean)
  const files: DiffFile[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const header = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.+) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(lines[0])
    if (!header) throw new ScopeError('invalid-diff')
    let beforePath = diffPath(header[1], 'a/')
    let path = diffPath(header[2], 'b/')
    const firstHunk = lines.findIndex(l => l.startsWith('@@'))
    const metadata = lines.slice(1, firstHunk < 0 ? undefined : firstHunk)
    const beforeHeader = metadata.find(l => l.startsWith('--- '))
    const afterHeader = metadata.find(l => l.startsWith('+++ '))
    if (beforeHeader) beforePath = diffPath(beforeHeader.slice(4), 'a/')
    if (afterHeader) path = diffPath(afterHeader.slice(4), 'b/')
    path ??= beforePath
    if (!path) throw new ScopeError('invalid-diff')
    const status = limits.skipPath?.(path) ? 'skipped' : new TextEncoder().encode(block).length > (limits.maxFileBytes ?? 512 * 1024) ? 'large' : metadata.some(l => l.startsWith('Binary files ') || l === 'GIT binary patch') ? 'binary' : 'included'
    const file: DiffFile = { path, beforePath, status, patch: status === 'included' ? block : '', anchors: [] }
    if (status === 'included') {
      for (let index = Math.max(1, firstHunk); index < lines.length; index++) {
        if (!lines[index].startsWith('@@')) continue
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[index])
        if (!match || !beforeHeader || !afterHeader) throw new ScopeError('invalid-diff')
        const oldStart = Number(match[1]), oldCount = Number(match[2] ?? 1)
        const newStart = Number(match[3]), newCount = Number(match[4] ?? 1)
        if (![oldStart, oldCount, newStart, newCount, oldStart + oldCount, newStart + newCount].every(Number.isSafeInteger) || (oldCount && !oldStart) || (newCount && !newStart)) throw new ScopeError('invalid-diff')
        let oldSeen = 0, newSeen = 0, end = index + 1
        for (; end < lines.length && !lines[end].startsWith('@@'); end++) {
          const line = lines[end]
          if (line === '\\ No newline at end of file' || (end === lines.length - 1 && !line)) continue
          if (line.startsWith(' ')) { oldSeen++; newSeen++ }
          else if (line.startsWith('-')) oldSeen++
          else if (line.startsWith('+')) newSeen++
          else throw new ScopeError('invalid-diff')
        }
        if (oldSeen !== oldCount || newSeen !== newCount || (!beforePath && oldCount !== 0) || (afterHeader === '+++ /dev/null' && newCount !== 0)) throw new ScopeError('invalid-diff')
        const contextDigest = await reviewDigest(lines.slice(index, end).join('\n'))
        if (oldCount && beforePath) file.anchors.push({ anchorKey: crypto.randomUUID(), path: beforePath, revision: revisions.base, side: 'before', span: { start: oldStart, end: oldStart + oldCount - 1 }, contextDigest })
        if (newCount && afterHeader !== '+++ /dev/null') file.anchors.push({ anchorKey: crypto.randomUUID(), path, revision: revisions.head, side: revisions.workingCopy ? 'working-copy' : 'after', span: { start: newStart, end: newStart + newCount - 1 }, contextDigest })
        index = end - 1
      }
    }
    files.push(file)
  }
  return files
}
/** Each hunk of one file's patch as it reads on the before side and on the after side, without diff markers. */
export function hunkSides(patch: string): Array<{ before: string; after: string; beforeStart: number; afterStart: number }> {
  const hunks: Array<{ before: string[]; after: string[]; beforeStart: number; afterStart: number }> = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      hunks.push({ before: [], after: [], beforeStart: Math.max(1, Number(header?.[1] ?? 1)), afterStart: Math.max(1, Number(header?.[2] ?? 1)) })
      continue
    }
    const hunk = hunks.at(-1)
    if (!hunk || line.startsWith('\\')) continue
    if (line.startsWith('-')) hunk.before.push(line.slice(1))
    else if (line.startsWith('+')) hunk.after.push(line.slice(1))
    else { hunk.before.push(line.slice(1)); hunk.after.push(line.slice(1)) }
  }
  return hunks.map(hunk => ({ before: hunk.before.join('\n'), after: hunk.after.join('\n'), beforeStart: hunk.beforeStart, afterStart: hunk.afterStart }))
}
export function resolveReviewAnchor(anchors: readonly ReviewAnchor[], key: string, path: string, line?: number, endLine?: number): ReviewAnchor {
  const anchor = anchors.find(a => a.anchorKey === key)
  if (!anchor || anchor.path !== path || (endLine !== undefined && line === undefined)) throw new ScopeError('invalid-anchor')
  if (line === undefined) return { ...anchor, span: undefined }
  const end = endLine ?? line
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end) || !anchor.span || line < anchor.span.start || end > anchor.span.end || end < line) throw new ScopeError('invalid-anchor')
  return { ...anchor, span: { start: line, end } }
}
async function optional(git: ReviewGitRunner, query: GitQuery, signal?: AbortSignal): Promise<string | undefined> {
  const result = await git.query(query, signal)
  if (result.exitCode === 1 || (result.exitCode === 128 && query.kind === 'upstream')) return undefined
  if (result.exitCode !== 0) throw new GitAdapterError('query-failed')
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).trim() || undefined
}
function oneOid(value: string): string {
  const oid = value.trim()
  if (oid.includes('\n')) throw new ScopeError('ambiguous-base')
  return validateGitOid(oid)
}
async function baseFor(options: ScopeResolverOptions, ref: string, head: string, signal?: AbortSignal): Promise<{ base: string; source: string }> {
  const git = options.git
  const upstream = await optional(git, { kind: 'upstream', ref }, signal)
  if (upstream) {
    const base = await optional(git, { kind: 'merge-base', left: oneOid(upstream), right: head }, signal)
    if (base) return { base: oneOid(base), source: 'upstream' }
  }
  const parents = (await gitText(git, { kind: 'parents', oid: head }, signal)).trim().split(/\s+/)
  if (!parents[1]) return { base: oneOid(await gitText(git, { kind: 'empty-tree' }, signal)), source: 'initial-commit' }
  const defaultRef = options.defaultBranch ?? await optional(git, { kind: 'default-branch' }, signal)
  const candidates: Array<[string, string | undefined]> = []
  for (const name of [defaultRef, 'refs/heads/main', 'refs/heads/master']) {
    if (name) candidates.push([name, await optional(git, { kind: 'resolve', ref: name }, signal)])
  }
  for (const [source, oid] of candidates) {
    if (!oid) continue
    const base = await optional(git, { kind: 'merge-base', left: oneOid(oid), right: head }, signal)
    if (base) return { base: oneOid(base), source }
  }
  return { base: oneOid(parents[1]), source: 'parent' }
}
function matches(path: string, paths: string[]): boolean { return !paths.length || paths.some(p => p === path || path.startsWith(p + '/')) }
function utf8(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return undefined }
}
export async function resolveLocalReviewScope(options: ScopeResolverOptions, target: LocalReviewTarget = { kind: 'workspace' }, signal?: AbortSignal): Promise<ScopeManifest> {
  const { git } = options
  const paths = target.kind === 'paths' ? target.paths.map(p => validateReviewPath(p.replace(/^\.\//, ''))) : []
  if (target.kind === 'paths' && !paths.length) throw new ScopeError('missing-path')
  const workspace = target.kind === 'workspace' || target.kind === 'paths'
  let head: string, base: string, source: string
  let semantics: ScopeManifest['semantics'] = workspace ? 'working-copy' : 'branch'
  if (target.kind === 'range') {
    const match = /^(.+?)(\.{2,3})([^.].*)$/.exec(target.expression)
    if (!match) throw new ScopeError('invalid-range')
    const left = await optional(git, { kind: 'resolve', ref: validateGitRef(match[1]) }, signal)
    const right = await optional(git, { kind: 'resolve', ref: validateGitRef(match[3]) }, signal)
    if (!left || !right) throw new ScopeError('missing-ref')
    head = oneOid(right); base = oneOid(left); semantics = match[2] === '..' ? 'two-dot' : 'three-dot'; source = 'explicit'
    if (semantics === 'three-dot') base = oneOid(await gitText(git, { kind: 'merge-base', left: base, right: head }, signal))
  } else {
    const ref = target.kind === 'branch' ? validateGitRef(target.ref) : 'HEAD'
    const resolved = await optional(git, { kind: 'resolve', ref }, signal)
    if (!resolved) {
      if (!workspace) throw new ScopeError('missing-ref')
      head = base = oneOid(await gitText(git, { kind: 'empty-tree' }, signal)); source = 'unborn'
    } else { head = oneOid(resolved); const selected = await baseFor(options, ref, head, signal); base = selected.base; source = selected.source }
  }
  const scope: ReviewScope = { kind: target.kind, workspaceKey: options.workspaceKey, repository: { projectKey: options.projectKey }, revision: { base, head }, pathFilter: paths }
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024
  const maxDiffBytes = options.maxDiffBytes ?? 4 * 1024 * 1024
  const notices = workspace ? ['other-untracked-files-excluded'] : []
  if (source === 'initial-commit') notices.push('initial-commit-all-tracked-files')
  const files: DiffFile[] = []
  let totalBytes = 0
  if (!workspace) {
    try {
      const patch = await gitText(git, { kind: 'diff', base, head, paths }, signal)
      if (new TextEncoder().encode(patch).length > maxDiffBytes) notices.push('diff-output-limit')
      else files.push(...await parseUnifiedDiff(patch, { base, head }, { maxFileBytes, skipPath: options.skipPath }))
    } catch (error) {
      if (!(error instanceof GitAdapterError) || error.code !== 'output-limit') throw error
      notices.push('diff-output-limit')
    }
  } else {
    const tree = new Map<string, { mode: string; oid: string }>()
    if (source !== 'unborn' && source !== 'initial-commit') {
      for (const row of (await gitText(git, { kind: 'tree', oid: base }, signal)).split('\0').filter(Boolean)) {
        const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row)
        if (!match) throw new ScopeError('invalid-diff')
        tree.set(validateReviewPath(match[4]), { mode: match[1], oid: validateGitOid(match[3]) })
      }
    }
    const fileMode = await optional(git, { kind: 'file-mode' }, signal)
    if (fileMode !== undefined && fileMode !== 'true' && fileMode !== 'false') throw new ScopeError('invalid-diff')
    const indexModes = new Map<string, string>()
    const conflicted = new Set<string>()
    const tracked = new Set<string>()
    for (const row of (await gitText(git, { kind: 'index-entries' }, signal)).split('\0').filter(Boolean)) {
      const match = /^(100644|100755|120000|160000) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(row)
      if (!match) throw new ScopeError('invalid-diff')
      validateGitOid(match[2])
      const path = validateReviewPath(match[4])
      tracked.add(path)
      if (match[3] !== '0') conflicted.add(path)
      else {
        if (indexModes.has(path)) throw new ScopeError('invalid-diff')
        indexModes.set(path, match[1])
      }
    }
    const selected = new Set([...tree.keys(), ...tracked].filter(p => matches(p, paths)))
    for (const path of paths) {
      if (selected.has(path) || [...selected].some(p => p.startsWith(path + '/'))) continue
      const read = await options.readWorkspaceFile(path, maxFileBytes, signal)
      if (read.kind === 'missing') throw new ScopeError('missing-path')
      if (read.kind !== 'directory') selected.add(path)
    }
    const snapshotParts: string[] = []
    for (const path of [...selected].sort()) {
      if (signal?.aborted) throw new GitAdapterError('cancelled')
      const before = tree.get(path)
      let status: DiffFile['status'] | undefined
      if (files.length >= (options.maxFiles ?? 1000)) status = 'skipped'
      if (before?.mode === '120000' || before?.mode === '160000' || ['120000', '160000'].includes(indexModes.get(path) ?? '') || conflicted.has(path)) status = 'skipped'
      if (status) { files.push({ path, status, patch: '', anchors: [] }); continue }
      const current: WorkspaceRead = tracked.has(path) || paths.includes(path)
        ? await options.readWorkspaceFile(path, maxFileBytes, signal)
        : { kind: 'missing' }
      if (current.kind === 'large') status = 'large'
      else if (current.kind === 'unreadable') status = 'unreadable'
      else if (current.kind === 'symlink' || current.kind === 'directory') status = 'skipped'
      const afterBytes = current.kind === 'file' ? current.bytes : new Uint8Array()
      if (afterBytes.length > maxFileBytes) status = 'large'
      let beforeBytes = new Uint8Array()
      if (!status && before) {
        try {
          const result = await git.query({ kind: 'blob', oid: before.oid }, signal)
          if (result.exitCode !== 0) status = 'unreadable'
          else beforeBytes = new Uint8Array(result.stdout)
        } catch (error) {
          if (!(error instanceof GitAdapterError) || error.code !== 'output-limit') throw error
          status = 'large'
        }
      }
      if (beforeBytes.length > maxFileBytes) status = 'large'
      if (status) { files.push({ path, status, patch: '', anchors: [] }); continue }
      const beforeHash = await reviewDigest(beforeBytes), afterHash = await reviewDigest(afterBytes)
      const afterMode = current.kind === 'file'
        ? fileMode === 'false' ? indexModes.get(path) ?? '100644' : current.gitMode
        : undefined
      if (current.kind === 'file' && !afterMode) notices.push(`mode-unavailable:${path}`)
      if (afterMode && !['100644', '100755'].includes(afterMode)) throw new ScopeError('invalid-diff')
      const modeChanged = !!before && !!afterMode && before.mode !== afterMode
      snapshotParts.push(`${path}\0${current.kind}\0${afterHash}\0${afterMode ?? 'unknown'}`)
      if (beforeHash === afterHash && (!!before === (current.kind === 'file')) && !modeChanged) continue
      if (options.skipPath?.(path)) { files.push({ path, status: 'skipped', patch: '', anchors: [] }); continue }
      const beforeText = utf8(beforeBytes), afterText = utf8(afterBytes)
      if (beforeText === undefined || afterText === undefined) { files.push({ path, status: 'binary', patch: '', anchors: [] }); continue }
      const result = structuredPatch(path, path, beforeText, afterText, '', '', { context: 3 })
      const quote = (p: string) => JSON.stringify(p)
      const modeHeader = modeChanged ? `old mode ${before!.mode}\nnew mode ${afterMode}\n` : !before && afterMode ? `new file mode ${afterMode}\n` : current.kind === 'missing' && before ? `deleted file mode ${before.mode}\n` : ''
      const patch = `diff --git ${quote('a/' + path)} ${quote('b/' + path)}\n${modeHeader}--- ${before ? quote('a/' + path) : '/dev/null'}\n+++ ${current.kind === 'file' ? quote('b/' + path) : '/dev/null'}\n` + result.hunks.map(h => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}\n`).join('')
      totalBytes += new TextEncoder().encode(patch).length
      if (totalBytes > maxDiffBytes) { files.push({ path, status: 'large', patch: '', anchors: [], reason: 'diff-output-limit' }); continue }
      files.push(...await parseUnifiedDiff(patch, { base, head: `working-copy:${afterHash}`, workingCopy: true }, { maxFileBytes }))
    }
    scope.revision.workingCopyDigest = await reviewDigest(snapshotParts.join('\n'))
    const endHead = await optional(git, { kind: 'resolve', ref: 'HEAD' }, signal)
    if (source === 'unborn' ? !!endHead : endHead !== head) throw new ScopeError('snapshot-changed')
  }
  const complete = files.every(f => f.status === 'included') && !notices.some(n => n === 'diff-output-limit' || n.startsWith('mode-unavailable:'))
  return { scope, files, anchors: files.flatMap(f => f.anchors), status: !complete ? 'partial' : files.length ? 'reviewable' : 'empty', complete, notices, baseSource: source, semantics }
}
