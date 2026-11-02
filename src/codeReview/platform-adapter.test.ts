import { describe, expect, it, vi } from 'vitest'
import { bindChangeRequestTarget, createReviewPlatformPublisher, createReviewPlatformReader, parseReviewRemote, reviewSuggestionOriginal, type PublicationReceipt, type PublicationReceiptStore, type PublicationWrite, type ReviewHttpRequest } from './platform-adapter'
const base = 'a'.repeat(40), head = 'b'.repeat(40), start = 'c'.repeat(40)
const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
const target = bindChangeRequestTarget(['git@github.com:owner/repo.git'], 12)
function harness(platform: 'github' | 'gitlab' = 'github') {
  let currentHead = head
  let failWrite = false
  const selected = platform === 'github' ? target : bindChangeRequestTarget(['https://gitlab.com/group/repo.git'], 12)
  const httpRequest = vi.fn<ReviewHttpRequest>(async request => {
    let body: unknown
    if (request.method === 'POST' || request.method === 'PUT') {
      if (failWrite) throw new Error('timeout')
      body = { id: platform === 'github' ? 123 : 'note123' }
    } else if (request.url.includes('/compare/')) body = { merge_base_commit: { sha: base } }
    else if (request.url.includes('?per_page=')) body = []
    else if (request.headers?.Accept === 'application/vnd.github.raw') body = 'new\n'
    else if (request.headers?.Accept === 'application/vnd.github.diff') body = patch
    else if (request.url.endsWith('/changes')) body = { overflow: false, changes: [{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }] }
    else body = platform === 'github' ? { number: 12, changed_files: 1, base: { sha: base, repo: { html_url: 'https://github.com/owner/repo' } }, head: { sha: currentHead } } : { iid: 12, web_url: 'https://gitlab.com/group/repo/-/merge_requests/12', diff_refs: { base_sha: base, head_sha: currentHead, start_sha: start } }
    return { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)) }
  })
  const saved = new Map<string, PublicationReceipt>()
  const receipts: PublicationReceiptStore = {
    async reserve(receipt) { const existing = saved.get(receipt.key) ?? [...saved.values()].reverse().find(r => r.identityKey === receipt.identityKey); if (existing) return { acquired: false, receipt: existing }; saved.set(receipt.key, receipt); return { acquired: true, receipt } },
    async save(receipt) { saved.set(receipt.key, receipt) },
    async get(key) { return saved.get(key) },
    async compareAndSwap(previous, next) { if (JSON.stringify(saved.get(previous.key)) !== JSON.stringify(previous)) return false; saved.set(next.key, next); return true },
    async reserveRevision(previous, next) { if (JSON.stringify(saved.get(previous.key)) !== JSON.stringify(previous) || saved.has(next.key)) return false; saved.set(next.key, next); return true },
  }
  const options = { httpRequest, target: selected, workspaceKey: 'workspace' }
  return { options, httpRequest, receipts, saved, setHead: (value: string) => { currentHead = value }, failWrite: () => { failWrite = true } }
}
function inline(anchorKey: string): PublicationWrite { return { kind: 'inline', body: 'A concrete issue.', diagnosticIds: ['d1'], reportRevision: 1, rootCauseFingerprint: 'cause', location: { anchorKey, path: 'a.ts', line: 1 } } }
describe('platform target binding', () => {
  it('binds repository and request number for supported SSH and HTTPS remotes', () => {
    expect(target).toMatchObject({ platform: 'github', projectKey: 'owner/repo', number: 12 })
    expect(parseReviewRemote('ssh://git@gitlab.com/group/sub/repo.git').projectKey).toBe('group/sub/repo')
    expect(bindChangeRequestTarget(['https://github.com/owner/repo.git'], 'https://github.com/owner/repo/pull/12')).toEqual(target)
  })
  it('fails closed on ambiguity, foreign projects, unsafe origins and invalid IDs', () => {
    expect(() => bindChangeRequestTarget(['https://github.com/a/repo', 'https://github.com/b/repo'], 12)).toThrow('ambiguous-target')
    expect(() => bindChangeRequestTarget(['https://github.com/owner/repo'], 'https://github.com/other/repo/pull/12')).toThrow('target-mismatch')
    for (const remote of ['https://evil.test/owner/repo', 'https://github.com:999/owner/repo', 'https://user:pass@github.com/owner/repo', 'file:///repo', 'https://github.com/owner/repo?token=x']) expect(() => parseReviewRemote(remote)).toThrow()
    for (const id of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => bindChangeRequestTarget(['https://github.com/owner/repo'], id)).toThrow()
  })
})
describe('platform reads', () => {
  it.each(['github', 'gitlab'] as const)('reads %s base/head/diff with no local state or writes', async platform => {
    const h = harness(platform); const snapshot = await createReviewPlatformReader(h.options).read()
    expect(snapshot).toMatchObject({ base, head }); expect(snapshot.manifest.scope.kind).toBe('change-request')
    expect(snapshot.manifest.anchors.map(a => a.side)).toEqual(['before', 'after'])
    for (const [request] of h.httpRequest.mock.calls) expect(request).toMatchObject({ method: 'GET', followRedirects: false, maxRedirects: 0, allowPrivateNetwork: false })
    expect(h.httpRequest.mock.calls).toHaveLength(platform === 'github' ? 5 : 3)
  })
  it('accepts only origin-bound secret references and refuses redirects', async () => {
    const h = harness()
    expect(() => createReviewPlatformReader({ ...h.options, secret: { origin: 'https://github.com', name: 'mcp:github' } })).toThrow('secret-origin')
    await createReviewPlatformReader({ ...h.options, secret: { origin: 'https://api.github.com', name: 'mcp:github' } }).read()
    expect(h.httpRequest.mock.calls[0][0].headers?.Authorization).toBe('Bearer {{secret:mcp:github}}')
    h.httpRequest.mockImplementationOnce(async request => ({ status: 302, statusText: 'Found', finalUrl: request.url, body: new Uint8Array(), headers: { location: 'https://evil.test' } }))
    await expect(createReviewPlatformReader(h.options).read()).rejects.toThrow('redirect-refused')
  })
  it('does not call an incomplete diff empty', async () => {
    const h = harness()
    const original = h.httpRequest.getMockImplementation()!
    h.httpRequest.mockImplementation(async (request, options) => request.headers?.Accept === 'application/vnd.github.diff' ? { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new Uint8Array() } : original(request, options))
    const snapshot = await createReviewPlatformReader(h.options).read()
    expect(snapshot.manifest.status).toBe('partial'); expect(snapshot.manifest.notices).toContain('remote-diff-incomplete')
  })
  it('rejects a remote head changed during diff retrieval', async () => {
    const h = harness(); const original = h.httpRequest.getMockImplementation()!
    h.httpRequest.mockImplementation(async (request, options) => { const result = await original(request, options); if (request.headers?.Accept === 'application/vnd.github.diff') h.setHead(start); return result })
    await expect(createReviewPlatformReader(h.options).read()).rejects.toThrow('head-changed')
  })
})
describe('runtime-only publication', () => {
  it('cannot write without current host authorization', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => false })
    await expect(publisher.publish(snapshot, inline(snapshot.manifest.anchors[1].anchorKey))).rejects.toThrow('publication-denied')
    expect(h.httpRequest.mock.calls.every(c => c[0].method === 'GET')).toBe(true); expect(h.saved.size).toBe(0)
  })
  it('posts a pinned GitHub inline comment once with a durable operation receipt', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    const write = inline(snapshot.manifest.anchors[1].anchorKey)
    const result = await publisher.publish(snapshot, write)
    expect(result).toMatchObject({ state: 'succeeded', externalId: '123' })
    expect(await publisher.publish(snapshot, write)).toEqual(result)
    const posts = h.httpRequest.mock.calls.filter(c => c[0].method === 'POST'); expect(posts).toHaveLength(1)
    expect(JSON.parse(new TextDecoder().decode(posts[0][0].body))).toMatchObject({ commit_id: head, path: 'a.ts', side: 'RIGHT', line: 1 })
    expect(posts[0][0].url).toBe('https://api.github.com/repos/owner/repo/pulls/12/comments')
  })
  it('blocks stale head and refuses forged anchors', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    await expect(publisher.publish(snapshot, inline('fake'))).rejects.toThrow('invalid-anchor')
    h.setHead(start)
    expect(await publisher.publish(snapshot, inline(snapshot.manifest.anchors[1].anchorKey))).toMatchObject({ state: 'blocked', reason: 'head-changed' })
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(0)
  })
  it('keeps timeout outcome uncertain and does not blindly retry', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read(); h.failWrite()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    const write = inline(snapshot.manifest.anchors[0].anchorKey)
    expect(await publisher.publish(snapshot, write)).toMatchObject({ state: 'uncertain' })
    expect(await publisher.publish(snapshot, write)).toMatchObject({ state: 'uncertain' })
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(1)
  })
  it('recovers a timed-out accepted comment and persists its remote ID without another POST', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read(); h.failWrite()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    const write = inline(snapshot.manifest.anchors[1].anchorKey)
    const first = await publisher.publish(snapshot, write)
    const sent = h.httpRequest.mock.calls.find(c => c[0].method === 'POST')![0]
    const content = JSON.parse(new TextDecoder().decode(sent.body))
    const original = h.httpRequest.getMockImplementation()!
    h.httpRequest.mockImplementation(async (request, options) => request.url.includes('?per_page=') ? { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify([{ ...content, id: 456 }])) } : original(request, options))
    const recovered = await publisher.recover(snapshot, write)
    expect(recovered).toMatchObject({ key: first.key, state: 'succeeded', externalId: '456' })
    expect(h.saved.get(first.key)?.externalId).toBe('456')
    expect(await publisher.publish(snapshot, write)).toEqual(recovered)
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(1)
  })
  it('requires authoritative absence and a fresh retry grant after bounded remote lookup', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read(); h.failWrite()
    let permitRetry = false
    const authorize = vi.fn(async (_write, _snapshot, action) => action?.action !== 'retry' || permitRetry)
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize, confirmAbsent: async () => true })
    const write = inline(snapshot.manifest.anchors[1].anchorKey)
    await publisher.publish(snapshot, write)
    expect(await publisher.recover(snapshot, write)).toMatchObject({ state: 'failed', reason: 'confirmed-absent' })
    expect(await publisher.publish(snapshot, write)).toMatchObject({ state: 'blocked', reason: 'retry-authorization-required' })
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(1)
    permitRetry = true
    await publisher.publish(snapshot, write)
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(2)
    expect(authorize.mock.calls.some(c => c[2]?.action === 'retry')).toBe(true)
  })
  it('does not equate an empty eventually consistent list with definitive absence', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read(); h.failWrite()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    const write = inline(snapshot.manifest.anchors[0].anchorKey)
    await publisher.publish(snapshot, write)
    expect(await publisher.recover(snapshot, write)).toMatchObject({ state: 'uncertain', reason: 'absence-not-authoritative' })
    await publisher.publish(snapshot, write)
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(1)
  })
  it('bounds pagination and cannot retry after an incomplete search', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read(); h.failWrite()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true, recoveryMaxPages: 2, confirmAbsent: async () => true })
    const write = inline(snapshot.manifest.anchors[0].anchorKey)
    await publisher.publish(snapshot, write)
    const original = h.httpRequest.getMockImplementation()!
    h.httpRequest.mockImplementation(async (request, options) => request.url.includes('?per_page=') ? { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'unrelated' })))) } : original(request, options))
    expect(await publisher.recover(snapshot, write)).toMatchObject({ state: 'uncertain', reason: 'recovery-page-limit' })
    expect(h.httpRequest.mock.calls.filter(c => c[0].url.includes('?per_page='))).toHaveLength(2)
    await publisher.publish(snapshot, write)
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(1)
  })
  it('deduplicates an unchanged root mechanism across revised reports and wording', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    const write = inline(snapshot.manifest.anchors[0].anchorKey)
    const first = await publisher.publish(snapshot, write)
    const second = await publisher.publish(snapshot, { ...write, body: 'Same mechanism described differently.', diagnosticIds: ['new-id'], reportRevision: 2 })
    expect(second.externalId).toBe(first.externalId)
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(1)
  })
  it('blocks GitLab summary replacement without update authorization, then updates the original note', async () => {
    const h = harness('gitlab'); const snapshot = await createReviewPlatformReader(h.options).read()
    const initial = { kind: 'summary' as const, body: 'First report.', diagnosticIds: ['d1'], reportRevision: 1 }
    const firstPublisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    const first = await firstPublisher.publish(snapshot, initial)
    const revised = { ...initial, body: 'Revised report.', reportRevision: 2 }
    expect(await firstPublisher.publish(snapshot, revised)).toMatchObject({ state: 'blocked', reason: 'summary-update-authorization-required' })
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true, authorizeUpdate: async () => true })
    const updated = await publisher.publish(snapshot, revised)
    expect(updated).toMatchObject({ state: 'succeeded', externalId: first.externalId, operation: 'update' })
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(1)
    const puts = h.httpRequest.mock.calls.filter(c => c[0].method === 'PUT')
    expect(puts).toHaveLength(1); expect(puts[0][0].url).toMatch(/\/notes\/note123$/)
  })
  it('recovers a GitLab summary through bounded notes reads', async () => {
    const h = harness('gitlab'); const snapshot = await createReviewPlatformReader(h.options).read(); h.failWrite()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    const write = { kind: 'summary' as const, body: 'Partial report.', diagnosticIds: [], reportRevision: 1 }
    await publisher.publish(snapshot, write)
    const sent = h.httpRequest.mock.calls.find(c => c[0].method === 'POST')![0]
    const body = JSON.parse(new TextDecoder().decode(sent.body)).body
    const original = h.httpRequest.getMockImplementation()!
    h.httpRequest.mockImplementation(async (request, options) => request.url.includes('?per_page=') ? { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify([{ id: 99, body }])) } : original(request, options))
    expect(await publisher.recover(snapshot, write)).toMatchObject({ state: 'succeeded', externalId: '99' })
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(1)
  })
  it('serializes concurrent retry requests through receipt compare-and-swap', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read(); h.failWrite()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true, confirmAbsent: async () => true })
    const write = inline(snapshot.manifest.anchors[1].anchorKey)
    await publisher.publish(snapshot, write); await publisher.recover(snapshot, write)
    await Promise.all([publisher.publish(snapshot, write), publisher.publish(snapshot, write)])
    expect(h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')).toHaveLength(2)
  })
  it('does not accept a matching marker with different content or inline revision', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read(); h.failWrite()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    const write = inline(snapshot.manifest.anchors[1].anchorKey)
    await publisher.publish(snapshot, write)
    const sent = h.httpRequest.mock.calls.find(c => c[0].method === 'POST')![0]
    const content = JSON.parse(new TextDecoder().decode(sent.body))
    const original = h.httpRequest.getMockImplementation()!
    h.httpRequest.mockImplementation(async (request, options) => request.url.includes('?per_page=') ? { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify([{ ...content, id: 99, commit_id: start }, { ...content, id: 100, body: 'modified' + content.body }])) } : original(request, options))
    expect(await publisher.recover(snapshot, write)).toMatchObject({ state: 'uncertain' })
  })
  it('does not append an unchanged GitLab summary for a new report revision', async () => {
    const h = harness('gitlab'); const snapshot = await createReviewPlatformReader(h.options).read()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    const write = { kind: 'summary' as const, body: 'Unchanged report.', diagnosticIds: ['d1'], reportRevision: 1 }
    const first = await publisher.publish(snapshot, write)
    expect(await publisher.publish(snapshot, { ...write, reportRevision: 2, diagnosticIds: ['replacement-id'] })).toEqual(first)
    expect(h.httpRequest.mock.calls.filter(c => c[0].method !== 'GET')).toHaveLength(1)
  })
  it('uses one GitLab summary note and only an explicit discussion request for inline', async () => {
    const h = harness('gitlab'); const snapshot = await createReviewPlatformReader(h.options).read()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    await publisher.publish(snapshot, { kind: 'summary', body: 'Report, including locally repaired but not pushed state.', diagnosticIds: ['d1', 'd2'], reportRevision: 1 })
    await publisher.publish(snapshot, { ...inline(snapshot.manifest.anchors[0].anchorKey), kind: 'discussion' })
    const posts = h.httpRequest.mock.calls.filter(c => c[0].method === 'POST')
    expect(posts[0][0].url).toMatch(/\/notes$/); expect(posts[1][0].url).toMatch(/\/discussions$/)
    expect(JSON.parse(new TextDecoder().decode(posts[1][0].body)).position).toMatchObject({ base_sha: base, head_sha: head, start_sha: start, old_line: 1, new_path: 'a.ts', old_path: 'a.ts' })
  })
})


it('uses a host-namespaced secret reference and rejects template injection', async () => {
  const h = harness()
  await createReviewPlatformReader({ ...h.options, secret: { origin: 'https://api.github.com', name: 'mcp:github' } }).read()
  expect(h.httpRequest.mock.calls[0][0].headers?.Authorization).toBe('Bearer {{secret:mcp:github}}')
  for (const name of ['TOKEN', 'mcp:github}}x', 'mcp:github\nX-Key: value']) expect(() => createReviewPlatformReader({ ...h.options, secret: { origin: 'https://api.github.com', name } })).toThrow('secret-origin')
})

describe('remote revision context', () => {
  it.each(['github', 'gitlab'] as const)('reads unchanged %s files with encoded paths and pinned before/after revisions', async platform => {
    const h = harness(platform)
    const reader = createReviewPlatformReader({ ...h.options, secret: { origin: platform === 'github' ? 'https://api.github.com' : 'https://gitlab.com', name: 'provider:review-token' } })
    const snapshot = await reader.read()
    const original = h.httpRequest.getMockImplementation()!
    h.httpRequest.mockImplementation(async (request, options) => request.url.includes('/contents/') || request.url.includes('/repository/files/')
      ? { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode('export const unchanged = true\n') } : original(request, options))
    const path = 'src/caller #?%é.ts'
    expect(await reader.readContext(snapshot, path)).toBe('export const unchanged = true\n')
    expect(await reader.readContext(snapshot, path, 'before')).toBe('export const unchanged = true\n')
    const requests = h.httpRequest.mock.calls.slice(-2).map(c => c[0])
    const prefix = platform === 'github' ? 'https://api.github.com/repos/owner/repo/contents/src/caller%20%23%3F%25%C3%A9.ts' : 'https://gitlab.com/api/v4/projects/group%2Frepo/repository/files/src%2Fcaller%20%23%3F%25%C3%A9.ts/raw'
    expect(requests.map(r => r.url)).toEqual([`${prefix}?ref=${head}`, `${prefix}?ref=${base}`])
    for (const request of requests) {
      expect(request).toMatchObject({ method: 'GET', maxResponseBytes: 512 * 1024, followRedirects: false, maxRedirects: 0, allowPrivateNetwork: false })
      expect(request.headers?.[platform === 'github' ? 'Authorization' : 'PRIVATE-TOKEN']).toContain('{{secret:provider:review-token}}')
    }
    h.setHead(start)
    await reader.readContext(snapshot, path)
    expect(h.httpRequest.mock.calls.at(-1)?.[0].url).toBe(`${prefix}?ref=${head}`)
  })
  it('refuses foreign targets, forged revisions and unsafe paths before reading content', async () => {
    const h = harness(); const reader = createReviewPlatformReader(h.options); const snapshot = await reader.read()
    const count = h.httpRequest.mock.calls.length
    await expect(reader.readContext({ ...snapshot, target: { ...snapshot.target, number: 999 } }, 'src/a.ts')).rejects.toThrow('target-mismatch')
    for (const path of ['../secret', 'src/../secret', '.git/config', '/etc/passwd', 'C:/secret', 'https://evil.test/x', 'src\\secret']) await expect(reader.readContext(snapshot, path)).rejects.toThrow()
    expect(h.httpRequest.mock.calls).toHaveLength(count)
    await expect(reader.readContext({ ...snapshot, head: start }, 'src/a.ts')).rejects.toThrow('head-changed')
    expect(h.httpRequest.mock.calls.some(c => c[0].url.includes('/contents/'))).toBe(false)
  })
  it.each([new Uint8Array([0, 1, 2]), new Uint8Array([0xff, 0xfe])])('declines binary and invalid UTF-8 context', async bytes => {
    const h = harness(); const reader = createReviewPlatformReader(h.options); const snapshot = await reader.read()
    h.httpRequest.mockImplementationOnce(async request => ({ status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: bytes }))
    await expect(reader.readContext(snapshot, 'image.bin')).rejects.toThrow('binary-context')
  })
  it('enforces the configured context byte cap independently from diff reads', async () => {
    const h = harness(); const reader = createReviewPlatformReader({ ...h.options, maxContextBytes: 4 }); const snapshot = await reader.read()
    h.httpRequest.mockImplementationOnce(async request => ({ status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode('12345') }))
    await expect(reader.readContext(snapshot, 'large.txt')).rejects.toThrow('response-limit')
    expect(h.httpRequest.mock.calls.at(-1)?.[0].maxResponseBytes).toBe(4)
  })
  it('rejects redirects and cancellation without changing the requested revision', async () => {
    const h = harness(); const reader = createReviewPlatformReader(h.options); const snapshot = await reader.read()
    h.httpRequest.mockImplementationOnce(async () => ({ status: 200, statusText: 'OK', finalUrl: 'https://evil.test/file', headers: {}, body: new Uint8Array() }))
    await expect(reader.readContext(snapshot, 'a.ts')).rejects.toThrow('redirect-refused')
    const count = h.httpRequest.mock.calls.length
    const abort = new AbortController(); abort.abort()
    await expect(reader.readContext(snapshot, 'a.ts', 'after', abort.signal)).rejects.toThrow()
    expect(h.httpRequest.mock.calls).toHaveLength(count)
  })
})


describe('GitHub complete-fix suggestion publication', () => {
  it('appends one fenced suggestion before the stable retry marker and digest', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read(); h.failWrite()
    const authorize = vi.fn(async (_write: PublicationWrite) => true)
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize, confirmAbsent: async () => true })
    const write = { ...inline(snapshot.manifest.anchors[1].anchorKey), suggestion: { original: 'new', replacement: 'fixed' } }
    const first = await publisher.publish(snapshot, write)
    expect(first.state).toBe('uncertain')
    expect(await publisher.recover(snapshot, write)).toMatchObject({ key: first.key, state: 'failed' })
    const retry = await publisher.publish(snapshot, { ...write, body: '  A concrete issue.\r\n' })
    expect(retry).toMatchObject({ key: first.key, contentDigest: first.contentDigest, attempt: 2 })
    const posts = h.httpRequest.mock.calls.filter(call => call[0].method === 'POST')
    expect(posts).toHaveLength(2)
    const bodies = posts.map(call => JSON.parse(new TextDecoder().decode(call[0].body)))
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0].body).toBe(`A concrete issue.\n\n\`\`\`suggestion\nfixed\n\`\`\`\n\n<!-- velloc-review:${first.key} -->`)
    expect(h.httpRequest.mock.calls.filter(call => call[0].headers?.Accept === 'application/vnd.github.raw')).toHaveLength(2)
    expect(authorize.mock.calls[0][0]).toMatchObject({ suggestion: write.suggestion, body: 'A concrete issue.' })
    const other = harness(); const otherSnapshot = await createReviewPlatformReader(other.options).read()
    const otherPublisher = createReviewPlatformPublisher({ ...other.options, receipts: other.receipts, authorize: async () => true })
    const plain = await otherPublisher.publish(otherSnapshot, inline(otherSnapshot.manifest.anchors[1].anchorKey))
    expect(first.contentDigest).not.toBe(plain.contentDigest)
  })
  it('supports ten-line after-side spans and emits the exact start/end range', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read()
    snapshot.manifest.anchors[1].span = { start: 1, end: 10 }
    const source = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n')
    const original = h.httpRequest.getMockImplementation()!
    h.httpRequest.mockImplementation(async (request, options) => request.headers?.Accept === 'application/vnd.github.raw'
      ? { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode(source + '\n') } : original(request, options))
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    const write = inline(snapshot.manifest.anchors[1].anchorKey)
    write.location!.endLine = 10; write.suggestion = { original: source, replacement: '' }
    expect(await publisher.publish(snapshot, write)).toMatchObject({ state: 'succeeded' })
    const post = h.httpRequest.mock.calls.find(call => call[0].method === 'POST')![0]
    expect(JSON.parse(new TextDecoder().decode(post.body))).toMatchObject({ start_line: 1, line: 10, start_side: 'RIGHT', side: 'RIGHT' })
    expect(h.httpRequest.mock.calls.find(call => call[0].headers?.Accept === 'application/vnd.github.raw')![0].url).toBe(`https://api.github.com/repos/owner/repo/contents/a.ts?ref=${head}`)
  })
  it.each(['before', 'summary', 'gitlab', 'oversize', 'fence', 'backtick', 'body-fence', 'too-many-lines', 'unchanged', 'binary'] as const)('rejects %s suggestions before network writes', async kind => {
    const h = harness(kind === 'gitlab' ? 'gitlab' : 'github'); const snapshot = await createReviewPlatformReader(h.options).read()
    const write = { ...inline(snapshot.manifest.anchors[kind === 'before' ? 0 : 1].anchorKey), suggestion: { original: 'new', replacement: 'fixed' } }
    if (kind === 'summary') write.kind = 'summary'
    if (kind === 'gitlab') write.kind = 'discussion'
    if (kind === 'oversize') write.suggestion.replacement = 'é'.repeat(2049)
    if (kind === 'fence') write.suggestion.replacement = '```suggestion\nescape\n```'
    if (kind === 'backtick') write.suggestion.replacement = '`template`'
    if (kind === 'body-fence') write.body += '\n```open'
    if (kind === 'too-many-lines') write.suggestion.replacement = 'x\n'.repeat(10)
    if (kind === 'unchanged') write.suggestion.replacement = 'new'
    if (kind === 'binary') write.suggestion.replacement = 'a\u0000'
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    await expect(publisher.publish(snapshot, write)).rejects.toThrow('invalid-publication')
    expect(h.httpRequest.mock.calls.every(call => call[0].method === 'GET')).toBe(true)
  })
  it('rejects eleven-line anchors even with a short replacement', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read()
    snapshot.manifest.anchors[1].span = { start: 1, end: 11 }
    const write = inline(snapshot.manifest.anchors[1].anchorKey); write.location!.endLine = 11
    write.suggestion = { original: Array.from({ length: 11 }, () => 'new').join('\n'), replacement: 'fixed' }
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    await expect(publisher.publish(snapshot, write)).rejects.toThrow('invalid-publication')
    expect(h.httpRequest.mock.calls.every(call => call[0].method === 'GET')).toBe(true)
  })
  it.each(['mismatch', 'stale', 'binary', 'cancelled', 'changed-during-read'] as const)('blocks %s before publication', async kind => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read()
    const write = { ...inline(snapshot.manifest.anchors[1].anchorKey), suggestion: { original: kind === 'mismatch' ? 'invented' : 'new', replacement: 'fixed' } }
    const controller = new AbortController()
    if (kind === 'stale') h.setHead(start)
    if (kind === 'cancelled') controller.abort()
    const original = h.httpRequest.getMockImplementation()!
    h.httpRequest.mockImplementation(async (request, options) => {
      const response = await original(request, options)
      if (request.headers?.Accept === 'application/vnd.github.raw') {
        if (kind === 'binary') response.body = new Uint8Array([0])
        if (kind === 'changed-during-read') h.setHead(start)
      }
      return response
    })
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => true })
    expect(await publisher.publish(snapshot, write, controller.signal)).toMatchObject({ state: 'blocked' })
    expect(h.httpRequest.mock.calls.every(call => call[0].method === 'GET')).toBe(true)
  })
  it('does not fetch suggestion source or post without authorization', async () => {
    const h = harness(); const snapshot = await createReviewPlatformReader(h.options).read()
    const publisher = createReviewPlatformPublisher({ ...h.options, receipts: h.receipts, authorize: async () => false })
    await expect(publisher.publish(snapshot, { ...inline(snapshot.manifest.anchors[1].anchorKey), suggestion: { original: 'new', replacement: 'fixed' } })).rejects.toThrow('publication-denied')
    expect(h.httpRequest.mock.calls.some(call => call[0].headers?.Accept === 'application/vnd.github.raw' || call[0].method === 'POST')).toBe(false)
  })
})


it('extracts exact remote span text without normalizing internal line endings', () => {
  expect(reviewSuggestionOriginal('one\r\ntwo\r\nthree\r\n', 1, 2)).toBe('one\r\ntwo')
  expect(reviewSuggestionOriginal('one\ntwo', 2, 2)).toBe('two')
  expect(reviewSuggestionOriginal('one\n\n', 2, 2)).toBe('')
  for (const [start, end] of [[0, 1], [1, 11], [2, 1], [1.5, 2], [2, 2]]) expect(() => reviewSuggestionOriginal('one\n', start, end)).toThrow('invalid-publication')
  expect(() => reviewSuggestionOriginal('one\u0000', 1, 1)).toThrow('invalid-publication')
})
