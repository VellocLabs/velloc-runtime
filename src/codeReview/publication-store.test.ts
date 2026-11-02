import { bindChangeRequestTarget, createReviewPlatformPublisher, type ChangeRequestSnapshot, type PublicationWrite, type ReviewHttpRequest } from './platform-adapter'
import { describe, expect, it, vi } from 'vitest'
import { createPublicationReceiptStore, type PublicationReceiptStorage } from './publication-store'
import type { PublicationReceipt } from './platform-adapter'
const hash = (char: string) => char.repeat(64)
function pending(key = hash('a'), identityKey = hash('b')): PublicationReceipt {
  return { key, identityKey, contentDigest: hash('c'), state: 'pending', diagnosticIds: ['diagnostic-1'], attempt: 1, operation: 'create' }
}
function storage() {
  let data: string | null = null
  const io: PublicationReceiptStorage = { read: vi.fn(async () => data), writeAtomic: vi.fn(async value => { data = value }) }
  return { io, bytes: () => data, seed: (value: string) => { data = value } }
}
describe('durable publication receipt registry', () => {
  it('persists pending and both claims before granting permission to send', async () => {
    const disk = storage()
    let finish!: () => void
    const write = disk.io.writeAtomic
    disk.io.writeAtomic = vi.fn(async value => { await new Promise<void>(resolve => { finish = resolve }); await write(value) })
    const store = createPublicationReceiptStore(disk.io)
    let acquired = false
    const reserved = store.reserve(pending()).then(value => { acquired = value.acquired; return value })
    await vi.waitFor(() => expect(disk.io.writeAtomic).toHaveBeenCalledOnce())
    expect(acquired).toBe(false)
    finish()
    expect((await reserved).acquired).toBe(true)
    expect(JSON.parse(disk.bytes()!).identities).toEqual([{ identityKey: hash('b'), key: hash('a') }])
  })
  it('serializes separate facades with the same namespace owner and deduplicates across reports', async () => {
    const disk = storage(), owner = {}
    const first = createPublicationReceiptStore(disk.io, owner)
    const second = createPublicationReceiptStore({ ...disk.io }, owner)
    const results = await Promise.all([first.reserve(pending()), second.reserve({ ...pending(hash('d')), diagnosticIds: ['another-report-diagnostic'] })])
    expect(results.map(value => value.acquired)).toEqual([true, false])
    expect(results[1].receipt.key).toBe(hash('a'))
    expect(await second.get(hash('d'))).toBeUndefined()
    expect(disk.io.read).toHaveBeenCalledOnce()
    expect((await first.get(hash('a')))?.state).toBe('pending')
  })
  it('recovers pending as durable uncertain on restart and never reacquires it', async () => {
    const disk = storage()
    const first = createPublicationReceiptStore(disk.io, {})
    await first.reserve(pending())
    const restarted = createPublicationReceiptStore(disk.io, {})
    const restored = await restarted.get(hash('a'))
    expect(restored).toMatchObject({ state: 'uncertain', reason: 'write-outcome-unknown' })
    expect(JSON.parse(disk.bytes()!).receipts[0].state).toBe('uncertain')
    expect((await restarted.reserve(pending())).acquired).toBe(false)
    expect((await restarted.reserve(pending(hash('d')))).receipt.key).toBe(hash('a'))
    await expect(restarted.save({ ...pending(), state: 'succeeded', externalId: '123' })).rejects.toThrow()
    expect(await restarted.compareAndSwap(restored!, { ...restored!, state: 'succeeded', reason: 'recovered-remote-write', externalId: '123' })).toBe(true)
  })
  it('requires exact CAS and authoritative absence before retrying with a new attempt', async () => {
    const disk = storage(), store = createPublicationReceiptStore(disk.io)
    const original = pending()
    await store.reserve(original)
    const uncertain: PublicationReceipt = { ...original, state: 'uncertain', reason: 'write-outcome-unknown' }
    await store.save(uncertain)
    expect(await store.compareAndSwap(original, { ...original, state: 'succeeded', externalId: '123' })).toBe(false)
    await expect(store.compareAndSwap(uncertain, { ...original, attempt: 2 })).rejects.toThrow()
    const absent: PublicationReceipt = { ...uncertain, state: 'failed', reason: 'confirmed-absent' }
    expect(await store.compareAndSwap(uncertain, absent)).toBe(true)
    const retry = { ...original, attempt: 2 }
    expect(await store.compareAndSwap(absent, retry)).toBe(true)
    await expect(store.save({ ...original, state: 'succeeded', externalId: 'old-request' })).rejects.toThrow()
    await store.save({ ...retry, state: 'succeeded', externalId: 'new-request' })
    expect((await store.get(original.key))?.externalId).toBe('new-request')
  })
  it('atomically transfers summary identity while preserving prior receipts and rejecting racing revisions', async () => {
    const disk = storage(), store = createPublicationReceiptStore(disk.io)
    const original = pending()
    await store.reserve(original)
    const success: PublicationReceipt = { ...original, state: 'succeeded', externalId: '42' }
    await store.save(success)
    const update: PublicationReceipt = { ...pending(hash('d')), contentDigest: hash('e'), operation: 'update', externalId: '42' }
    const other = { ...update, key: hash('f') }
    expect(await Promise.all([store.reserveRevision(success, update), store.reserveRevision(success, other)])).toEqual([true, false])
    expect(await store.get(original.key)).toEqual(success)
    expect((await store.reserve(pending(hash('f')))).receipt).toEqual(update)
    const restarted = createPublicationReceiptStore(disk.io, {})
    expect(await restarted.get(original.key)).toEqual(success)
    const uncertain = await restarted.get(update.key)
    expect(uncertain).toMatchObject({ state: 'uncertain', operation: 'update', externalId: '42' })
    await expect(restarted.compareAndSwap(uncertain!, { ...uncertain!, state: 'failed', reason: 'confirmed-absent' })).rejects.toThrow()
  })
  it('does not publish in-memory claims after a failed atomic save', async () => {
    const disk = storage(), store = createPublicationReceiptStore(disk.io)
    const write = disk.io.writeAtomic
    disk.io.writeAtomic = vi.fn(async () => { throw new Error('disk-full') })
    await expect(store.reserve(pending())).rejects.toThrow('disk-full')
    expect(await store.get(hash('a'))).toBeUndefined()
    expect(disk.bytes()).toBeNull()
    disk.io.writeAtomic = write
    expect((await store.reserve(pending())).acquired).toBe(true)
    const success: PublicationReceipt = { ...pending(), state: 'succeeded', externalId: '42' }
    disk.io.writeAtomic = async () => { throw new Error('disk-full') }
    await expect(store.save(success)).rejects.toThrow('disk-full')
    await expect(store.get(hash('a'))).rejects.toThrow('disk-full')
    disk.io.writeAtomic = write
    const recovered = await store.get(hash('a'))
    expect(recovered?.state).toBe('uncertain')
    expect(await store.compareAndSwap(recovered!, success)).toBe(true)
    expect(await store.get(hash('a'))).toEqual(success)
  })
  it('returns detached records and rejects bodies, credentials and arbitrary reason text', async () => {
    const disk = storage(), store = createPublicationReceiptStore(disk.io)
    await expect(store.reserve({ ...pending(), body: 'raw report secret' } as PublicationReceipt)).rejects.toThrow()
    await expect(store.reserve({ ...pending(), token: 'secret-token' } as PublicationReceipt)).rejects.toThrow()
    await expect(store.reserve({ ...pending(), key: 'https://secret.invalid/token' })).rejects.toThrow()
    const value = pending()
    await store.reserve(value)
    value.diagnosticIds.push('caller-mutation')
    const found = await store.get(value.key)
    found!.diagnosticIds.push('reader-mutation')
    await expect(store.save({ ...pending(), state: 'uncertain', reason: 'Authorization: secret' })).rejects.toThrow()
    expect((await store.get(value.key))?.diagnosticIds).toEqual(['diagnostic-1'])
    expect(disk.bytes()).not.toMatch(/raw report|token|mutation|Authorization/)
  })
  it('fails closed on corrupt storage or missing identity mappings', async () => {
    const disk = storage()
    disk.seed(JSON.stringify({ version: 1, receipts: [pending()], identities: [] }))
    const store = createPublicationReceiptStore(disk.io)
    await expect(store.reserve(pending())).rejects.toThrow()
    expect(disk.io.writeAtomic).not.toHaveBeenCalled()
    disk.seed('{broken')
    await expect(store.get(hash('a'))).rejects.toThrow()
    expect(disk.io.writeAtomic).not.toHaveBeenCalled()
  })
})

it('supports publisher recovery and GitLab revisions without duplicate POSTs across restarts', async () => {
  const disk = storage()
  const target = bindChangeRequestTarget(['https://gitlab.com/group/repo'], 12)
  const base = 'a'.repeat(40), head = 'b'.repeat(40), start = 'c'.repeat(40)
  const snapshot: ChangeRequestSnapshot = { target, base, head, start, manifest: { scope: { kind: 'change-request', workspaceKey: 'w', repository: { projectKey: target.projectKey, platform: 'gitlab' }, revision: { base, head }, pathFilter: [], request: { number: 12, headRevision: head } }, files: [], anchors: [], status: 'empty', complete: true, notices: [], baseSource: 'change-request', semantics: 'three-dot' } }
  let comment = '', timeout = true
  const httpRequest = vi.fn<ReviewHttpRequest>(async request => {
    let body: unknown
    if (request.method === 'POST' || request.method === 'PUT') {
      const saved = JSON.parse(disk.bytes()!)
      expect(saved.receipts.at(-1).state).toBe('pending')
      comment = JSON.parse(new TextDecoder().decode(request.body)).body
      if (timeout) throw new Error('timeout')
      body = { id: 123 }
    } else if (request.url.includes('?per_page=')) body = [{ id: 123, body: comment }]
    else body = { iid: 12, web_url: 'https://gitlab.com/group/repo/-/merge_requests/12', diff_refs: { base_sha: base, head_sha: head, start_sha: start } }
    return { status: 200, statusText: 'OK', finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) }
  })
  const write: PublicationWrite = { kind: 'summary', body: 'Private report body', diagnosticIds: [], reportRevision: 1 }
  const make = () => createReviewPlatformPublisher({ httpRequest, target, workspaceKey: 'w', receipts: createPublicationReceiptStore(disk.io, {}), authorize: async () => true, authorizeUpdate: async () => true })
  expect(await make().publish(snapshot, write)).toMatchObject({ state: 'uncertain' })
  const restarted = make()
  expect(await restarted.publish(snapshot, write)).toMatchObject({ state: 'uncertain' })
  expect(httpRequest.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1)
  expect(await restarted.recover(snapshot, write)).toMatchObject({ state: 'succeeded', externalId: '123' })
  timeout = false
  const revised = { ...write, body: 'Revised private report body', reportRevision: 2 }
  expect(await restarted.publish(snapshot, revised)).toMatchObject({ state: 'succeeded', operation: 'update', externalId: '123' })
  expect(httpRequest.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1)
  expect(httpRequest.mock.calls.filter(([request]) => request.method === 'PUT')).toHaveLength(1)
  expect(disk.bytes()).not.toContain('report body')
  expect(await make().publish(snapshot, revised)).toMatchObject({ state: 'succeeded', operation: 'update' })
  expect(httpRequest.mock.calls.filter(([request]) => request.method === 'PUT')).toHaveLength(1)
})

it('does not reacquire a reservation when storage committed but its acknowledgment failed', async () => {
  const disk = storage(), store = createPublicationReceiptStore(disk.io)
  const write = disk.io.writeAtomic
  disk.io.writeAtomic = async value => { await write(value); throw new Error('ack-lost') }
  await expect(store.reserve(pending())).rejects.toThrow('ack-lost')
  disk.io.writeAtomic = write
  const result = await store.reserve(pending())
  expect(result.acquired).toBe(false)
  expect(result.receipt.state).toBe('uncertain')
})
