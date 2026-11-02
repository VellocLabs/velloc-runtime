import type { BrowserNetworkOperations } from '../utils/BrowserNetworkOperations'
import type { ReviewScope } from './contracts'
import { validateGitOid, validateReviewPath } from './git-adapter'
import { parseUnifiedDiff, resolveReviewAnchor, reviewDigest, type DiffFile, type ReviewAnchor, type ScopeManifest } from './scope'

export type ReviewHttpRequest = NonNullable<BrowserNetworkOperations['httpRequest']>
export interface ReviewRemote { platform: 'github' | 'gitlab'; origin: string; projectKey: string }
export interface ChangeRequestTarget extends ReviewRemote { number: number }
export interface PlatformSecret { origin: string; name: string }
export class PlatformAdapterError extends Error {
  constructor(readonly code: 'invalid-target' | 'ambiguous-target' | 'target-mismatch' | 'invalid-response' | 'http-failed' | 'response-limit' | 'redirect-refused' | 'secret-origin' | 'head-changed' | 'publication-denied' | 'invalid-publication' | 'binary-context') { super(code) }
}
function project(path: string, platform: ReviewRemote['platform']): string {
  const parts = path.replace(/^\//, '').replace(/\.git$/, '').split('/')
  if (parts.length < 2 || (platform === 'github' && parts.length !== 2) || parts.some(p => !/^[A-Za-z0-9_.-]+$/.test(p) || p === '.' || p === '..')) throw new PlatformAdapterError('invalid-target')
  return parts.join('/')
}
export function parseReviewRemote(remote: string): ReviewRemote {
  const scp = /^git@(github\.com|gitlab\.com):(.+)$/.exec(remote)
  let url: URL
  try { url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote) } catch { throw new PlatformAdapterError('invalid-target') }
  if (!['https:', 'ssh:'].includes(url.protocol) || url.password || (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) || url.port || url.search || url.hash || !['github.com', 'gitlab.com'].includes(url.hostname)) throw new PlatformAdapterError('invalid-target')
  const platform = url.hostname === 'github.com' ? 'github' : 'gitlab'
  return { platform, origin: `https://${url.hostname}`, projectKey: project(url.pathname, platform) }
}
function sameProject(a: ReviewRemote, b: ReviewRemote): boolean {
  return a.platform === b.platform && a.origin === b.origin && (a.platform === 'github' ? a.projectKey.toLowerCase() === b.projectKey.toLowerCase() : a.projectKey === b.projectKey)
}
export function bindChangeRequestTarget(remotes: readonly string[], input: number | string | ChangeRequestTarget): ChangeRequestTarget {
  const repositories = remotes.map(parseReviewRemote).filter((r, i, all) => all.findIndex(other => sameProject(r, other)) === i)
  let candidate: ChangeRequestTarget
  if (typeof input === 'number' || (typeof input === 'string' && /^[0-9]+$/.test(input))) {
    if (repositories.length !== 1) throw new PlatformAdapterError('ambiguous-target')
    candidate = { ...repositories[0], number: Number(input) }
  } else if (typeof input === 'string') {
    let url: URL
    try { url = new URL(input) } catch { throw new PlatformAdapterError('invalid-target') }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new PlatformAdapterError('invalid-target')
    const match = url.hostname === 'github.com' ? /^\/(.+)\/pull\/(\d+)$/.exec(url.pathname) : url.hostname === 'gitlab.com' ? /^\/(.+)\/-\/merge_requests\/(\d+)$/.exec(url.pathname) : null
    if (!match) throw new PlatformAdapterError('invalid-target')
    candidate = { ...parseReviewRemote(`https://${url.hostname}/${match[1]}`), number: Number(match[2]) }
  } else {
    const remote = parseReviewRemote(`${input.origin}/${input.projectKey}`)
    if (remote.platform !== input.platform) throw new PlatformAdapterError('invalid-target')
    candidate = { ...remote, number: input.number }
  }
  if (!Number.isSafeInteger(candidate.number) || candidate.number < 1) throw new PlatformAdapterError('invalid-target')
  if (!repositories.some(r => sameProject(r, candidate))) throw new PlatformAdapterError('target-mismatch')
  return Object.freeze(candidate)
}
export interface PlatformReadOptions {
  httpRequest: ReviewHttpRequest
  target: ChangeRequestTarget
  workspaceKey: string
  secret?: PlatformSecret
  maxResponseBytes?: number
  maxContextBytes?: number
  timeoutMs?: number
}
export interface ChangeRequestSnapshot {
  target: ChangeRequestTarget
  base: string
  head: string
  start?: string
  manifest: ScopeManifest
}
export interface ReviewPlatformReader {
  read(signal?: AbortSignal): Promise<ChangeRequestSnapshot>
  checkHead(snapshot: ChangeRequestSnapshot, signal?: AbortSignal): Promise<void>
  /** Caller authorizes the repository path. Any file in the bound revision may provide context, including unchanged callers. */
  readContext(snapshot: ChangeRequestSnapshot, path: string, side?: 'before' | 'after', signal?: AbortSignal): Promise<string>
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformAdapterError('invalid-response')
  return value as Record<string, unknown>
}
function string(value: unknown): string { if (typeof value !== 'string') throw new PlatformAdapterError('invalid-response'); return value }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new PlatformAdapterError('invalid-response'); return Number(value) }
function apiFor(target: ChangeRequestTarget): { origin: string; endpoint: string } {
  const checked = bindChangeRequestTarget([`${target.origin}/${target.projectKey}`], target)
  if (checked.platform === 'github') return { origin: 'https://api.github.com', endpoint: `/repos/${checked.projectKey}/pulls/${checked.number}` }
  return { origin: 'https://gitlab.com', endpoint: `/api/v4/projects/${encodeURIComponent(checked.projectKey)}/merge_requests/${checked.number}` }
}
function transport(options: PlatformReadOptions) {
  const { origin, endpoint } = apiFor(options.target)
  if (options.secret && (options.secret.origin !== origin || !/^(?:mcp|plugin|provider):[A-Za-z0-9_.:/-]{1,240}$/.test(options.secret.name))) throw new PlatformAdapterError('secret-origin')
  const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024
  return {
    endpoint,
    async request(path: string, method: 'GET' | 'POST' | 'PUT', body: unknown, signal?: AbortSignal, accept = 'application/json', byteLimit = maxResponseBytes, contextText = false) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      const headers: Record<string, string> = { Accept: accept }
      if (options.secret) headers[options.target.platform === 'github' ? 'Authorization' : 'PRIVATE-TOKEN'] = `${options.target.platform === 'github' ? 'Bearer ' : ''}{{secret:${options.secret.name}}}`
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const response = await options.httpRequest({ url: origin + path, method, headers, ...(body !== undefined ? { body: new TextEncoder().encode(JSON.stringify(body)) } : {}), maxResponseBytes: byteLimit, timeoutMs: options.timeoutMs ?? 30_000, followRedirects: false, maxRedirects: 0, allowPrivateNetwork: false }, { signal })
      if (response.finalUrl && response.finalUrl !== origin + path) throw new PlatformAdapterError('redirect-refused')
      if (response.status >= 300 && response.status < 400) throw new PlatformAdapterError('redirect-refused')
      if (response.status < 200 || response.status >= 300) throw new PlatformAdapterError('http-failed')
      if (response.body.length > byteLimit) throw new PlatformAdapterError('response-limit')
      if (contextText && response.body.some(byte => byte === 0 || byte < 9 || byte > 13 && byte < 32)) throw new PlatformAdapterError('binary-context')
      try { return new TextDecoder('utf-8', { fatal: true }).decode(response.body) }
      catch { throw new PlatformAdapterError(contextText ? 'binary-context' : 'invalid-response') }
    },
  }
}
function json(text: string): Record<string, unknown> {
  try { return record(JSON.parse(text)) } catch { throw new PlatformAdapterError('invalid-response') }
}
async function metadata(options: PlatformReadOptions, signal?: AbortSignal) {
  const io = transport(options)
  const data = json(await io.request(io.endpoint, 'GET', undefined, signal))
  const target = options.target
  if (target.platform === 'github') {
    if (integer(data.number) !== target.number) throw new PlatformAdapterError('target-mismatch')
    const base = record(data.base), head = record(data.head)
    if (!sameProject(target, parseReviewRemote(string(record(base.repo).html_url)))) throw new PlatformAdapterError('target-mismatch')
    const baseTip = validateGitOid(string(base.sha)), headTip = validateGitOid(string(head.sha))
    const comparison = json(await io.request(`/repos/${target.projectKey}/compare/${baseTip}...${headTip}`, 'GET', undefined, signal))
    return { base: validateGitOid(string(record(comparison.merge_base_commit).sha)), head: headTip, changedFiles: integer(data.changed_files), start: baseTip }
  }
  if (integer(data.iid) !== target.number) throw new PlatformAdapterError('target-mismatch')
  const bound = bindChangeRequestTarget([`${target.origin}/${target.projectKey}`], string(data.web_url))
  if (bound.number !== target.number) throw new PlatformAdapterError('target-mismatch')
  const refs = record(data.diff_refs)
  return { base: validateGitOid(string(refs.base_sha)), head: validateGitOid(string(refs.head_sha)), start: validateGitOid(string(refs.start_sha)), changedFiles: undefined }
}
export function createReviewPlatformReader(options: PlatformReadOptions): ReviewPlatformReader {
  const target = Object.freeze({ ...options.target })
  options = { ...options, target, secret: options.secret ? { ...options.secret } : undefined }
  const io = transport(options)
  const approvedRevisions = new Set<string>()
  const revisionKey = (snapshot: ChangeRequestSnapshot) => JSON.stringify([snapshot.base, snapshot.head, snapshot.start])
  const contextLimit = Math.min(options.maxContextBytes ?? 512 * 1024, options.maxResponseBytes ?? 8 * 1024 * 1024)
  if (!Number.isSafeInteger(contextLimit) || contextLimit < 1) throw new PlatformAdapterError('response-limit')
  const checkHead = async (snapshot: ChangeRequestSnapshot, signal?: AbortSignal) => {
    if (!sameProject(target, snapshot.target) || target.number !== snapshot.target.number) throw new PlatformAdapterError('target-mismatch')
    const current = await metadata(options, signal)
    if (current.head !== snapshot.head || current.base !== snapshot.base || current.start !== snapshot.start) throw new PlatformAdapterError('head-changed')
  }
  return {
    checkHead,
    async readContext(snapshot, path, side = 'after', signal) {
      snapshot = structuredClone(snapshot)
      if (!sameProject(target, snapshot.target) || target.number !== snapshot.target.number) throw new PlatformAdapterError('target-mismatch')
      if (side !== 'before' && side !== 'after') throw new PlatformAdapterError('invalid-target')
      validateReviewPath(path)
      validateGitOid(snapshot.base); validateGitOid(snapshot.head)
      if (!approvedRevisions.has(revisionKey(snapshot))) {
        await checkHead(snapshot, signal)
        approvedRevisions.add(revisionKey(snapshot))
      }
      const revision = side === 'before' ? snapshot.base : snapshot.head
      const endpoint = target.platform === 'github'
        ? `/repos/${target.projectKey}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${revision}`
        : `/api/v4/projects/${encodeURIComponent(target.projectKey)}/repository/files/${encodeURIComponent(path)}/raw?ref=${revision}`
      return io.request(endpoint, 'GET', undefined, signal, target.platform === 'github' ? 'application/vnd.github.raw' : 'text/plain', contextLimit, true)
    },
    async read(signal) {
      const refs = await metadata(options, signal)
      let files: DiffFile[] = []
      const notices: string[] = []
      if (target.platform === 'github') {
        const patch = await io.request(io.endpoint, 'GET', undefined, signal, 'application/vnd.github.diff')
        files = await parseUnifiedDiff(patch, refs)
        if (files.length !== refs.changedFiles) notices.push('remote-diff-incomplete')
      } else {
        const data = json(await io.request(io.endpoint + '/changes', 'GET', undefined, signal))
        if (data.overflow !== false) notices.push('remote-diff-incomplete')
        if (!Array.isArray(data.changes)) throw new PlatformAdapterError('invalid-response')
        for (const value of data.changes) {
          const file = record(value)
          const before = validateReviewPath(string(file.old_path)), after = validateReviewPath(string(file.new_path))
          const diff = string(file.diff)
          if (file.too_large === true || file.collapsed === true || !diff.startsWith('@@')) {
            files.push({ path: after, beforePath: before, status: file.too_large ? 'large' : 'skipped', patch: '', anchors: [], reason: 'remote-patch-unavailable' }); continue
          }
          const patch = `diff --git ${JSON.stringify('a/' + before)} ${JSON.stringify('b/' + after)}\n--- ${file.new_file === true ? '/dev/null' : JSON.stringify('a/' + before)}\n+++ ${file.deleted_file === true ? '/dev/null' : JSON.stringify('b/' + after)}\n${diff}${diff.endsWith('\n') ? '' : '\n'}`
          files.push(...await parseUnifiedDiff(patch, refs))
        }
      }
      const scope: ReviewScope = { kind: 'change-request', workspaceKey: options.workspaceKey, repository: { platform: target.platform, projectKey: target.projectKey }, revision: { base: refs.base, head: refs.head }, pathFilter: [], request: { number: target.number, headRevision: refs.head } }
      const complete = !notices.length && files.every(f => f.status === 'included')
      const manifest: ScopeManifest = { scope, files, anchors: files.flatMap(f => f.anchors), complete, status: complete ? files.length ? 'reviewable' : 'empty' : 'partial', notices, baseSource: 'change-request', semantics: 'three-dot' }
      const snapshot: ChangeRequestSnapshot = { target, base: refs.base, head: refs.head, start: refs.start, manifest }
      await checkHead(snapshot, signal)
      approvedRevisions.add(revisionKey(snapshot))
      return snapshot
    },
  }
}
export interface PublicationWrite {
  kind: 'inline' | 'summary' | 'discussion'
  body: string
  diagnosticIds: string[]
  reportRevision: number
  rootCauseFingerprint?: string
  location?: { anchorKey: string; path: string; line: number; endLine?: number }
  suggestion?: { replacement: string; original: string }
}

/** Exact span text, excluding only the final line terminator. */
export function reviewSuggestionOriginal(content: string, start: number, end: number): string {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 10 || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(content)) throw new PlatformAdapterError('invalid-publication')
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  if (end > lines.length) throw new PlatformAdapterError('invalid-publication')
  const selected = lines.slice(start - 1, end).join('\n')
  return selected.endsWith('\r') ? selected.slice(0, -1) : selected
}
export function validateReviewSuggestion(suggestion: NonNullable<PublicationWrite['suggestion']>): void {
  if (!suggestion || typeof suggestion.original !== 'string' || typeof suggestion.replacement !== 'string' || suggestion.original === suggestion.replacement || suggestion.replacement.includes('\r')) throw new PlatformAdapterError('invalid-publication')
  for (const text of [suggestion.original, suggestion.replacement]) {
    if (new TextEncoder().encode(text).length > 4096 || text.split('\n').length > 10 || /[`\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]|~~~/.test(text)) throw new PlatformAdapterError('invalid-publication')
  }
}
export interface PublicationReceipt {
  key: string
  /** Stable across report revisions for the same unchanged mechanism or summary target. */
  identityKey?: string
  contentDigest?: string
  state: 'pending' | 'succeeded' | 'uncertain' | 'failed' | 'blocked'
  diagnosticIds: string[]
  externalId?: string
  reason?: string
  attempt?: number
  operation?: 'create' | 'update'
}
export interface PublicationReceiptStore {
  /** Atomically persist pending and claim BOTH key and identityKey. Return the existing identity owner on conflict. */
  reserve(receipt: PublicationReceipt): Promise<{ acquired: boolean; receipt: PublicationReceipt }>
  save(receipt: PublicationReceipt): Promise<void>
  /** Durable lookup and exact-record CAS are required for recovery and summary updates. */
  get?(key: string): Promise<PublicationReceipt | undefined>
  compareAndSwap?(previous: PublicationReceipt, next: PublicationReceipt): Promise<boolean>
  /** Atomically claim a new operation and transfer its identity from previous, preserving previous's receipt. */
  reserveRevision?(previous: PublicationReceipt, next: PublicationReceipt): Promise<boolean>
}
export interface PublicationAuthorization {
  action: 'create' | 'retry' | 'update'
  externalId?: string
  receiptKey: string
}
export interface PlatformPublisherOptions extends PlatformReadOptions {
  receipts: PublicationReceiptStore
  /** Host approval binds this exact action, target, head and content. A retry requires fresh authorization. */
  authorize(write: PublicationWrite, snapshot: ChangeRequestSnapshot, action?: PublicationAuthorization): Promise<boolean>
  /** Separate capability: absence blocks modifying an existing GitLab summary. */
  authorizeUpdate?(write: PublicationWrite, snapshot: ChangeRequestSnapshot, externalId: string): Promise<boolean>
  recoveryMaxPages?: number
  /** Confirm the old request is quiescent and absence is authoritative despite server consistency delays. */
  confirmAbsent?(receipt: PublicationReceipt): Promise<boolean>
}
export interface ReviewPlatformPublisher {
  publish(snapshot: ChangeRequestSnapshot, write: PublicationWrite, signal?: AbortSignal): Promise<PublicationReceipt>
  /** Query remote comments first; never send a write. A confirmed-absent result may subsequently be retried via publish. */
  recover(snapshot: ChangeRequestSnapshot, write: PublicationWrite, signal?: AbortSignal): Promise<PublicationReceipt>
}
interface PreparedPublication {
  snapshot: ChangeRequestSnapshot
  write: PublicationWrite
  path: string
  body: Record<string, unknown>
  pending: PublicationReceipt
}
function remoteId(value: unknown): string {
  if ((typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) throw new PlatformAdapterError('invalid-response')
  return String(value)
}
function canonicalTarget(target: ChangeRequestTarget) {
  return [target.platform, target.origin, target.platform === 'github' ? target.projectKey.toLowerCase() : target.projectKey, target.number]
}
/** Runtime-only capability; do not register publication as a model-callable tool. */
export function createReviewPlatformPublisher(options: PlatformPublisherOptions): ReviewPlatformPublisher {
  options = { ...options, target: { ...options.target }, secret: options.secret ? { ...options.secret } : undefined }
  const reader = createReviewPlatformReader(options), io = transport(options)
  const maxPages = options.recoveryMaxPages ?? 10
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new PlatformAdapterError('invalid-publication')
  async function prepare(snapshot: ChangeRequestSnapshot, write: PublicationWrite): Promise<PreparedPublication> {
    snapshot = structuredClone(snapshot); write = structuredClone(write)
    if (!sameProject(options.target, snapshot.target) || options.target.number !== snapshot.target.number) throw new PlatformAdapterError('target-mismatch')
    if (!write.body.trim() || write.body.length > 60_000 || !Number.isSafeInteger(write.reportRevision) || write.reportRevision < 1) throw new PlatformAdapterError('invalid-publication')
    write.body = write.body.replace(/\r\n/g, '\n').trim()
    let anchor: ReviewAnchor | undefined
    if (write.kind !== 'summary') {
      if (!write.location || !write.rootCauseFingerprint) throw new PlatformAdapterError('invalid-publication')
      anchor = resolveReviewAnchor(snapshot.manifest.anchors, write.location.anchorKey, write.location.path, write.location.line, write.location.endLine)
      if (anchor.side === 'working-copy' || anchor.revision !== (anchor.side === 'before' ? snapshot.base : snapshot.head)) throw new PlatformAdapterError('invalid-publication')
    }
    let humanBody = write.body
    if (write.suggestion !== undefined) {
      if (options.target.platform !== 'github' || write.kind !== 'inline' || anchor?.side !== 'after' || !anchor.span || anchor.span.end - anchor.span.start >= 10 || /```|~~~/.test(humanBody)) throw new PlatformAdapterError('invalid-publication')
      validateReviewSuggestion(write.suggestion)
      if (write.suggestion.original.split('\n').length !== anchor.span.end - anchor.span.start + 1) throw new PlatformAdapterError('invalid-publication')
      humanBody += `\n\n\`\`\`suggestion\n${write.suggestion.replacement}\n\`\`\``
      if (humanBody.length > 60_000) throw new PlatformAdapterError('invalid-publication')
    }
    let path: string
    const body: Record<string, unknown> = { body: humanBody }
    if (options.target.platform === 'github') {
      if (write.kind === 'discussion') throw new PlatformAdapterError('invalid-publication')
      path = write.kind === 'summary' ? `/repos/${options.target.projectKey}/issues/${options.target.number}/comments` : io.endpoint + '/comments'
      if (anchor?.span) {
        const file = snapshot.manifest.files.find(f => f.anchors.some(a => a.anchorKey === anchor?.anchorKey))
        if (!file) throw new PlatformAdapterError('invalid-publication')
        Object.assign(body, { commit_id: snapshot.head, path: file.path, side: anchor.side === 'before' ? 'LEFT' : 'RIGHT', line: anchor.span.end })
        if (anchor.span.start !== anchor.span.end) Object.assign(body, { start_line: anchor.span.start, start_side: body.side })
      }
    } else {
      if (write.kind === 'inline') throw new PlatformAdapterError('invalid-publication')
      path = io.endpoint + (write.kind === 'discussion' ? '/discussions' : '/notes')
      if (anchor?.span) {
        if (!snapshot.start || anchor.span.start !== anchor.span.end) throw new PlatformAdapterError('invalid-publication')
        const file = snapshot.manifest.files.find(f => f.anchors.some(a => a.anchorKey === anchor?.anchorKey))
        if (!file) throw new PlatformAdapterError('invalid-publication')
        body.position = { position_type: 'text', base_sha: snapshot.base, head_sha: snapshot.head, start_sha: snapshot.start, old_path: file.beforePath ?? file.path, new_path: file.path, [anchor.side === 'before' ? 'old_line' : 'new_line']: anchor.span.start }
      }
    }
    const contentDigest = await reviewDigest(JSON.stringify(body))
    const target = canonicalTarget(options.target)
    const key = await reviewDigest(JSON.stringify([target, snapshot.head, write.kind, contentDigest, write.kind === 'summary' ? [...write.diagnosticIds].sort() : write.rootCauseFingerprint, write.kind === 'summary' ? write.reportRevision : null, write.kind === 'summary' ? snapshot.manifest.complete : null]))
    const identityKey = await reviewDigest(JSON.stringify(write.kind === 'summary'
      ? [target, write.kind, options.target.platform === 'gitlab' ? null : snapshot.head]
      : [target, snapshot.head, write.kind, write.rootCauseFingerprint, anchor?.path, anchor?.side, ...(write.rootCauseFingerprint?.startsWith('mechanism:') ? [] : [anchor?.span, anchor?.contextDigest])]))
    // The opaque marker binds recovery to an operation, without exposing diagnostic text or credentials.
    body.body = `${humanBody}\n\n<!-- velloc-review:${key} -->`
    return { snapshot, write, path, body, pending: { key, identityKey, contentDigest, state: 'pending', diagnosticIds: [...write.diagnosticIds], attempt: 1, operation: 'create' } }
  }
  async function authorized(p: PreparedPublication, action: PublicationAuthorization['action'], receipt = p.pending): Promise<boolean> {
    return options.authorize(structuredClone(p.write), structuredClone(p.snapshot), { action, externalId: receipt.externalId, receiptKey: receipt.key })
  }
  async function send(p: PreparedPublication, receipt: PublicationReceipt, action: PublicationAuthorization['action'], signal?: AbortSignal): Promise<PublicationReceipt> {
    try {
      await reader.checkHead(p.snapshot, signal)
      if (!await authorized(p, action, receipt)) throw new PlatformAdapterError('publication-denied')
      if (receipt.operation === 'update' && (!receipt.externalId || !await options.authorizeUpdate?.(structuredClone(p.write), structuredClone(p.snapshot), receipt.externalId))) throw new PlatformAdapterError('publication-denied')
      if (p.write.suggestion && p.write.location) {
        const location = p.write.location
        const content = await reader.readContext(p.snapshot, location.path, 'after', signal)
        if (reviewSuggestionOriginal(content, location.line, location.endLine ?? location.line) !== p.write.suggestion.original) throw new PlatformAdapterError('invalid-publication')
        await reader.checkHead(p.snapshot, signal)
      }
    } catch (error) {
      const blocked: PublicationReceipt = { ...receipt, state: 'blocked', reason: error instanceof PlatformAdapterError ? error.code : 'head-check-failed' }
      await options.receipts.save(blocked); return blocked
    }
    let result: PublicationReceipt
    try {
      const update = receipt.operation === 'update'
      const response = json(await io.request(update ? `${p.path}/${remoteId(receipt.externalId)}` : p.path, update ? 'PUT' : 'POST', p.body, signal))
      result = { ...receipt, state: 'succeeded', reason: undefined, externalId: remoteId(response.id) }
    } catch {
      result = { ...receipt, state: 'uncertain', reason: 'write-outcome-unknown' }
    }
    await options.receipts.save(result)
    return result
  }
  async function recover(snapshot: ChangeRequestSnapshot, write: PublicationWrite, signal?: AbortSignal): Promise<PublicationReceipt> {
    const p = await prepare(snapshot, write)
    const store = options.receipts
    if (!store.get || !store.compareAndSwap) return { ...p.pending, state: 'blocked', reason: 'recovery-store-unavailable' }
    const previous = await store.get(p.pending.key)
    if (!previous) return { ...p.pending, state: 'blocked', reason: 'receipt-missing' }
    if (previous.state !== 'pending' && previous.state !== 'uncertain') return previous
    const marker = `<!-- velloc-review:${previous.key} -->`
    const matches: string[] = []
    let exhausted = false
    try {
      for (let page = 1; page <= maxPages; page++) {
        const text = await io.request(`${p.path}?per_page=100&page=${page}`, 'GET', undefined, signal)
        const values: unknown = JSON.parse(text)
        if (!Array.isArray(values) || values.length > 100) throw new PlatformAdapterError('invalid-response')
        for (const value of values) {
          const item = record(value)
          const candidates = p.write.kind === 'discussion' ? record(value).notes : [item]
          if (!Array.isArray(candidates)) throw new PlatformAdapterError('invalid-response')
          for (const entry of candidates) {
            const comment = record(entry)
            if (typeof comment.body !== 'string' || !comment.body.includes(marker)) continue
            if (comment.body.replace(/\r\n/g, '\n').trim() !== p.body.body) continue
            if (options.target.platform === 'github' && p.write.kind === 'inline') {
              if (comment.commit_id !== p.body.commit_id || comment.path !== p.body.path || comment.side !== p.body.side || (comment.line ?? comment.original_line) !== p.body.line || (comment.start_line ?? undefined) !== p.body.start_line) continue
            }
            if (p.write.kind === 'discussion') {
              const position = record(comment.position), expected = record(p.body.position)
              if (Object.keys(expected).some(key => position[key] !== expected[key])) continue
            }
            matches.push(remoteId(p.write.kind === 'discussion' ? item.id : comment.id))
          }
        }
        if (values.length < 100) { exhausted = true; break }
      }
      if (matches.length > 1) throw new PlatformAdapterError('invalid-response')
      let next: PublicationReceipt
      if (matches.length === 1) next = { ...previous, state: 'succeeded', externalId: matches[0], reason: 'recovered-remote-write' }
      else if (exhausted && previous.operation !== 'update' && await options.confirmAbsent?.(structuredClone(previous))) next = { ...previous, state: 'failed', reason: 'confirmed-absent' }
      else next = { ...previous, state: 'uncertain', reason: exhausted ? 'absence-not-authoritative' : 'recovery-page-limit' }
      if (await store.compareAndSwap(previous, next)) return next
      return await store.get(previous.key) ?? previous
    } catch {
      const next: PublicationReceipt = { ...previous, state: 'uncertain', reason: 'recovery-inconclusive' }
      if (await store.compareAndSwap(previous, next)) return next
      return await store.get(previous.key) ?? previous
    }
  }
  return {
    recover,
    async publish(snapshot, write, signal) {
      const p = await prepare(snapshot, write)
      if (!await authorized(p, 'create')) throw new PlatformAdapterError('publication-denied')
      const reserved = await options.receipts.reserve(p.pending)
      if (reserved.acquired) return send(p, p.pending, 'create', signal)
      const existing = reserved.receipt
      if (existing.key === p.pending.key && existing.state === 'failed' && existing.reason === 'confirmed-absent') {
        if (!options.receipts.compareAndSwap || !await authorized(p, 'retry', existing)) return { ...existing, state: 'blocked', reason: 'retry-authorization-required' }
        const retry: PublicationReceipt = { ...existing, state: 'pending', reason: undefined, attempt: (existing.attempt ?? 1) + 1 }
        if (!await options.receipts.compareAndSwap(existing, retry)) return await options.receipts.get?.(existing.key) ?? existing
        return send(p, retry, 'retry', signal)
      }
      if (existing.key === p.pending.key || existing.state !== 'succeeded') return existing
      if (p.write.kind !== 'summary' || existing.contentDigest === p.pending.contentDigest) return existing
      if (options.target.platform !== 'gitlab' || !existing.externalId || !options.receipts.reserveRevision || !await options.authorizeUpdate?.(structuredClone(p.write), structuredClone(p.snapshot), existing.externalId)) {
        return { ...p.pending, state: 'blocked', reason: 'summary-update-authorization-required', externalId: existing.externalId }
      }
      const update: PublicationReceipt = { ...p.pending, operation: 'update', externalId: existing.externalId }
      if (!await options.receipts.reserveRevision(existing, update)) return { ...update, state: 'blocked', reason: 'publication-conflict' }
      return send(p, update, 'update', signal)
    },
  }
}
