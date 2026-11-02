import type { PublicationReceipt, PublicationReceiptStore } from './platform-adapter'

export interface PublicationReceiptStorage {
  read(): Promise<string | null>
  /** Atomically and durably replace the entire namespace before resolving. */
  writeAtomic(serialized: string): Promise<void>
}
export type DurablePublicationReceiptStore = Required<PublicationReceiptStore>
type Registry = { version: 1; receipts: PublicationReceipt[]; identities: Array<{ identityKey: string; key: string }> }
const owners = new WeakMap<object, ReceiptActor>()
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,300}$/.test(value)
const reasons = new Set(['head-changed', 'head-check-failed', 'publication-denied', 'write-outcome-unknown', 'recovered-remote-write', 'confirmed-absent', 'absence-not-authoritative', 'recovery-page-limit', 'recovery-inconclusive', 'recovery-store-unavailable', 'receipt-missing', 'retry-authorization-required', 'summary-update-authorization-required', 'publication-conflict'])
const fail = (): never => { throw new Error('invalid-publication-receipt') }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
const only = (value: Record<string, unknown>, keys: string[]) => { if (Object.keys(value).some(key => !keys.includes(key))) fail() }
function receipt(value: unknown): PublicationReceipt {
  const row = object(value)
  only(row, ['key', 'identityKey', 'contentDigest', 'state', 'diagnosticIds', 'externalId', 'reason', 'attempt', 'operation'])
  if (!digest(row.key) || (row.identityKey !== undefined && !digest(row.identityKey)) || (row.contentDigest !== undefined && !digest(row.contentDigest))) return fail()
  if (!['pending', 'succeeded', 'uncertain', 'failed', 'blocked'].includes(String(row.state))) return fail()
  if (!Array.isArray(row.diagnosticIds) || !row.diagnosticIds.every(id) || new Set(row.diagnosticIds).size !== row.diagnosticIds.length) return fail()
  if (row.externalId !== undefined && (typeof row.externalId !== 'string' || !/^[A-Za-z0-9_-]{1,300}$/.test(row.externalId))) return fail()
  if (row.reason !== undefined && (typeof row.reason !== 'string' || !reasons.has(row.reason))) return fail()
  if (row.attempt !== undefined && (!Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1)) return fail()
  if (row.operation !== undefined && row.operation !== 'create' && row.operation !== 'update') return fail()
  if (row.operation === 'update' && !row.externalId) return fail()
  if (row.state === 'succeeded' && !row.externalId) return fail()
  return {
    key: row.key,
    ...(row.identityKey !== undefined ? { identityKey: row.identityKey as string } : {}),
    ...(row.contentDigest !== undefined ? { contentDigest: row.contentDigest as string } : {}),
    state: row.state as PublicationReceipt['state'], diagnosticIds: [...row.diagnosticIds] as string[],
    ...(row.externalId !== undefined ? { externalId: row.externalId as string } : {}),
    ...(row.reason !== undefined ? { reason: row.reason as string } : {}),
    ...(row.attempt !== undefined ? { attempt: row.attempt as number } : {}),
    ...(row.operation !== undefined ? { operation: row.operation as PublicationReceipt['operation'] } : {}),
  }
}
const equal = (a: PublicationReceipt, b: PublicationReceipt) => JSON.stringify(receipt(a)) === JSON.stringify(receipt(b))
const sameOperation = (a: PublicationReceipt, b: PublicationReceipt) => a.key === b.key && a.identityKey === b.identityKey && a.contentDigest === b.contentDigest && a.operation === b.operation && JSON.stringify(a.diagnosticIds) === JSON.stringify(b.diagnosticIds)
function decode(serialized: string): Registry {
  const data = object(JSON.parse(serialized))
  only(data, ['version', 'receipts', 'identities'])
  if (data.version !== 1 || !Array.isArray(data.receipts) || !Array.isArray(data.identities)) return fail()
  const receipts = data.receipts.map(receipt)
  const byKey = new Map(receipts.map(row => [row.key, row]))
  if (byKey.size !== receipts.length) return fail()
  const identities = data.identities.map(value => {
    const entry = object(value)
    only(entry, ['identityKey', 'key'])
    if (!digest(entry.identityKey) || !digest(entry.key) || byKey.get(entry.key)?.identityKey !== entry.identityKey) return fail()
    return { identityKey: entry.identityKey, key: entry.key }
  })
  if (new Set(identities.map(entry => entry.identityKey)).size !== identities.length) return fail()
  const owned = new Set(identities.map(entry => entry.identityKey))
  if (receipts.some(row => row.identityKey && !owned.has(row.identityKey))) return fail()
  return { version: 1, receipts, identities }
}

class ReceiptActor {
  private queue: Promise<unknown> = Promise.resolve()
  private state: Registry | undefined
  constructor(private readonly storage: PublicationReceiptStorage) {}
  private async load(): Promise<Registry> {
    if (this.state) return this.state
    const serialized = await this.storage.read()
    const state: Registry = serialized === null ? { version: 1, receipts: [], identities: [] } : decode(serialized)
    let recovered = false
    for (const row of state.receipts) if (row.state === 'pending') {
      row.state = 'uncertain'
      row.reason = 'write-outcome-unknown'
      recovered = true
    }
    if (recovered) await this.storage.writeAtomic(JSON.stringify(state))
    this.state = state
    return state
  }
  transact<T>(operation: (state: Registry) => { result: T; changed?: boolean }): Promise<T> {
    const task = this.queue.then(async () => {
      const next = structuredClone(await this.load())
      const { result, changed } = operation(next)
      if (changed) {
        try { await this.storage.writeAtomic(JSON.stringify(next)) }
        catch (error) { this.state = undefined; throw error }
        this.state = next
      }
      return structuredClone(result)
    })
    this.queue = task.catch(() => {})
    return task
  }
}

/**
 * Contract: one owner object per durable namespace and runtime lifetime. All facades sharing that
 * object use its first storage adapter and one actor. Reuse it across reports and sessions. A fresh
 * owner denotes a restart only after the old runtime is quiescent. Cross-process writers need an
 * external lock; atomic replacement alone is not a cross-process compare-and-swap.
 * Security: only digests, identifiers and allowlisted outcome codes are persisted, never write bodies.
 */
export function createPublicationReceiptStore(storage: PublicationReceiptStorage, owner: object = storage): DurablePublicationReceiptStore {
  let actor = owners.get(owner)
  if (!actor) { actor = new ReceiptActor(storage); owners.set(owner, actor) }
  const run = actor.transact.bind(actor)
  return {
    get(key) {
      if (!digest(key)) return Promise.reject(new Error('invalid-publication-receipt'))
      return run(state => ({ result: state.receipts.find(row => row.key === key) }))
    },
    async reserve(input) {
      const next = receipt(input)
      if (next.state !== 'pending' || next.operation === 'update' || (next.attempt ?? 1) !== 1 || next.reason || next.externalId) return fail()
      return run<{ acquired: boolean; receipt: PublicationReceipt }>(state => {
        const ownerKey = next.identityKey ? state.identities.find(entry => entry.identityKey === next.identityKey)?.key : undefined
        const existing = state.receipts.find(row => row.key === next.key) ?? state.receipts.find(row => row.key === ownerKey)
        if (existing) return { result: { acquired: false, receipt: existing } }
        state.receipts.push(next)
        if (next.identityKey) state.identities.push({ identityKey: next.identityKey, key: next.key })
        return { changed: true, result: { acquired: true, receipt: next } }
      })
    },
    async save(input) {
      const next = receipt(input)
      await run(state => {
        const index = state.receipts.findIndex(row => row.key === next.key)
        const previous = state.receipts[index]
        if (!previous || !sameOperation(previous, next) || previous.attempt !== next.attempt) return fail()
        if (equal(previous, next)) return { result: undefined }
        if (previous.state !== 'pending' || !['succeeded', 'uncertain', 'blocked'].includes(next.state)) return fail()
        if (previous.externalId && previous.externalId !== next.externalId) return fail()
        state.receipts[index] = next
        return { changed: true, result: undefined }
      })
    },
    async compareAndSwap(oldInput, newInput) {
      const previous = receipt(oldInput), next = receipt(newInput)
      if (!sameOperation(previous, next)) return fail()
      const retry = previous.state === 'failed' && previous.reason === 'confirmed-absent' && next.state === 'pending' && next.attempt === (previous.attempt ?? 1) + 1 && !next.reason
      const recover = ['pending', 'uncertain'].includes(previous.state) && ['succeeded', 'uncertain', 'failed'].includes(next.state) && previous.attempt === next.attempt && (next.state !== 'failed' || (next.reason === 'confirmed-absent' && previous.operation !== 'update'))
      if (!retry && !recover && !equal(previous, next)) return fail()
      if (previous.externalId && previous.externalId !== next.externalId) return fail()
      return run(state => {
        const index = state.receipts.findIndex(row => row.key === previous.key)
        if (index < 0 || !equal(state.receipts[index], previous)) return { result: false }
        state.receipts[index] = next
        return { changed: !equal(previous, next), result: true }
      })
    },
    async reserveRevision(oldInput, newInput) {
      const previous = receipt(oldInput), next = receipt(newInput)
      if (!previous.identityKey || previous.state !== 'succeeded' || !previous.externalId || next.key === previous.key || next.identityKey !== previous.identityKey || next.state !== 'pending' || next.operation !== 'update' || next.externalId !== previous.externalId || (next.attempt ?? 1) !== 1 || next.reason) return fail()
      return run(state => {
        const current = state.receipts.find(row => row.key === previous.key)
        const identity = state.identities.find(entry => entry.identityKey === previous.identityKey)
        if (!current || !equal(current, previous) || identity?.key !== previous.key || state.receipts.some(row => row.key === next.key)) return { result: false }
        state.receipts.push(next)
        identity.key = next.key
        return { changed: true, result: true }
      })
    },
  }
}
