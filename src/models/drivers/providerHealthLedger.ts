/**
 * Contract: the provider health ledger (F-27). The platform's record of what
 * the verdicts of an instance's requests said about it: cooling, exhausted or
 * disabled, and until when. Facts only; which provider to use is a router's
 * choice. Keyed by provider INSTANCE id, which is opaque here, and under it
 * by model for a verdict about one model. Reads are synchronous and from
 * memory; every change is written to the store, so a record survives a
 * restart. A record past its end is gone when read.
 *
 * A scope of `request` records nothing. A scope of `model`, and every
 * `model_unavailable`, is recorded under the model; `key`, `account` and
 * `provider` on the instance. A record is replaced only by one that lasts at
 * least as long; `disabled` is replaced by nothing.
 */
import type { PeerModelState, ProviderState } from '../../mods/provider/nouns/providerPeersTypes'
import type { ProviderConnectivityIssue } from '../../utils/providerConnectivity'

export const RATE_LIMIT_FIRST_MS = 60_000
export const RATE_LIMIT_MAX_MS = 15 * 60_000
/** A rate limit this soon after the last one's cooldown ended doubles the wait. */
export const RATE_LIMIT_REPEAT_MS = 10 * 60_000
export const QUOTA_UNKNOWN_MS = 60 * 60_000
/** Requests served in a UTC day from which a quota reads as a daily one. */
export const QUOTA_DAILY_SERVED = 10
export const BILLING_COOL_MS = 30 * 60_000
export const MODEL_UNAVAILABLE_MS = 60 * 60_000
export const TRANSIENT_COOL_MS = 30_000

const DAY_MS = 24 * 60 * 60_000

/** Where the ledger is kept between runs: one text, read once and replaced. */
export type ProviderHealthStore = {
  read(): Promise<string | undefined>
  write(text: string): Promise<void>
}

type HealthRecord = {
  status: 'cooling' | 'exhausted' | 'disabled'
  /** Absent: no end (`disabled`). */
  until?: number
  reason: ProviderConnectivityIssue['kind']
}

/** The last rate limit that carried no wait of its own, for the doubling. */
type RateSeries = { at: number; waitMs: number }

type Slot = { record?: HealthRecord; rate?: RateSeries }

type Instance = Slot & { models: Map<string, Slot> }

const instances = new Map<string, Instance>()
/** Requests served per instance in one UTC day. In memory only. */
const served = new Map<string, { day: number; count: number }>()
/** Each instance's config as last seen, to tell a change from a re-read. */
let seenConfigs: Map<string, string> | undefined
let store: ProviderHealthStore | undefined
/** The store's records are in memory: only then may it be written. */
let adopted = false
let writing: Promise<void> = Promise.resolve()
let loaded: Promise<void> = Promise.resolve()

function instanceOf(instanceId: string): Instance {
  let instance = instances.get(instanceId)
  if (!instance) instances.set(instanceId, (instance = { models: new Map() }))
  return instance
}

function slotOf(instance: Instance, model: string | undefined): Slot {
  if (model === undefined) return instance
  let slot = instance.models.get(model)
  if (!slot) instance.models.set(model, (slot = {}))
  return slot
}

/** The series still counts: its cooldown ended less than the repeat window ago. */
function repeats(rate: RateSeries | undefined, nowMs: number): rate is RateSeries {
  return rate !== undefined && nowMs - (rate.at + rate.waitMs) < RATE_LIMIT_REPEAT_MS
}

function live(record: HealthRecord | undefined, nowMs: number): HealthRecord | undefined {
  return record && (record.until === undefined || record.until > nowMs) ? record : undefined
}

function slotIsEmpty(slot: Slot, nowMs: number): boolean {
  return !live(slot.record, nowMs) && !repeats(slot.rate, nowMs)
}

/** Drop what has ended under `instanceId`; the instance too once nothing is left. */
function prune(instanceId: string, nowMs: number): void {
  const instance = instances.get(instanceId)
  if (!instance) return
  const sweep = (slot: Slot): void => {
    if (!live(slot.record, nowMs)) delete slot.record
    if (!repeats(slot.rate, nowMs)) delete slot.rate
  }
  sweep(instance)
  for (const [model, slot] of instance.models) {
    sweep(slot)
    if (slotIsEmpty(slot, nowMs)) instance.models.delete(model)
  }
  if (instance.models.size === 0 && slotIsEmpty(instance, nowMs)) instances.delete(instanceId)
}

/** When the provider itself said the condition lifts, if it said. */
function statedEnd(
  verdict: ProviderConnectivityIssue,
  nowMs: number,
  first: 'wait' | 'reset',
): number | undefined {
  const wait =
    typeof verdict.retryAfterMs === 'number' && Number.isFinite(verdict.retryAfterMs) && verdict.retryAfterMs > 0
      ? nowMs + verdict.retryAfterMs
      : undefined
  const reset =
    typeof verdict.resetsAt === 'number' && Number.isFinite(verdict.resetsAt) && verdict.resetsAt > nowMs
      ? verdict.resetsAt
      : undefined
  return first === 'wait' ? (wait ?? reset) : (reset ?? wait)
}

function servedToday(instanceId: string, nowMs: number): number {
  const count = served.get(instanceId)
  return count && count.day === Math.floor(nowMs / DAY_MS) ? count.count : 0
}

/** The record a verdict leaves in `slot`, or undefined when it leaves none. */
function recordFor(
  instanceId: string,
  slot: Slot,
  verdict: ProviderConnectivityIssue,
  nowMs: number,
): HealthRecord | undefined {
  switch (verdict.kind) {
    case 'rate_limit': {
      let until = statedEnd(verdict, nowMs, 'wait')
      if (until === undefined) {
        const waitMs = repeats(slot.rate, nowMs) ? Math.min(slot.rate.waitMs * 2, RATE_LIMIT_MAX_MS) : RATE_LIMIT_FIRST_MS
        slot.rate = { at: nowMs, waitMs }
        until = nowMs + waitMs
      }
      return { status: 'cooling', until, reason: 'rate_limit' }
    }
    case 'quota': {
      const stated = statedEnd(verdict, nowMs, 'reset')
      const until =
        stated ??
        (servedToday(instanceId, nowMs) >= QUOTA_DAILY_SERVED
          ? (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS
          : nowMs + QUOTA_UNKNOWN_MS)
      return { status: 'exhausted', until, reason: 'quota' }
    }
    case 'billing':
      return { status: 'cooling', until: nowMs + BILLING_COOL_MS, reason: 'billing' }
    case 'credentials':
      return { status: 'disabled', reason: 'credentials' }
    case 'model_unavailable':
      return { status: 'cooling', until: nowMs + MODEL_UNAVAILABLE_MS, reason: 'model_unavailable' }
    case 'service':
    case 'network':
      return { status: 'cooling', until: nowMs + TRANSIENT_COOL_MS, reason: verdict.kind }
    default:
      return undefined
  }
}

/**
 * Record what a failed request's verdict says about the instance that
 * served it. `model` is the model the request named.
 */
export function recordProviderVerdict(
  instanceId: string,
  model: string,
  verdict: ProviderConnectivityIssue,
  nowMs: number,
): void {
  if (!instanceId || verdict.scope === 'request') return
  const underModel = verdict.scope === 'model' || verdict.kind === 'model_unavailable'
  if (underModel && !model) return
  prune(instanceId, nowMs)
  const slot = slotOf(instanceOf(instanceId), underModel ? model : undefined)
  const next = recordFor(instanceId, slot, verdict, nowMs)
  const held = live(slot.record, nowMs)
  const replaces =
    next !== undefined &&
    (!held || next.status === 'disabled' || (held.until !== undefined && (next.until ?? Infinity) >= held.until))
  if (replaces) slot.record = next
  prune(instanceId, nowMs)
  if (next !== undefined) persist()
}

/** Count one request `instanceId` served: what tells a daily quota from an unknown one. */
export function recordProviderServed(instanceId: string, nowMs: number): void {
  const day = Math.floor(nowMs / DAY_MS)
  const count = served.get(instanceId)
  if (count && count.day === day) count.count += 1
  else served.set(instanceId, { day, count: 1 })
}

function stateOfRecord(record: HealthRecord): PeerModelState {
  return {
    status: record.status,
    ...(record.until !== undefined ? { until: record.until } : {}),
    reason: record.reason,
  }
}

/** What is recorded about `instanceId` now. A copy; `ok` when nothing holds. */
export function providerStateOf(instanceId: string, nowMs: number): ProviderState {
  prune(instanceId, nowMs)
  const instance = instances.get(instanceId)
  if (!instance) return { status: 'ok' }
  const models: Record<string, PeerModelState> = {}
  for (const [model, slot] of instance.models) {
    if (slot.record) models[model] = stateOfRecord(slot.record)
  }
  return {
    ...(instance.record ? stateOfRecord(instance.record) : { status: 'ok' as const }),
    ...(Object.keys(models).length > 0 ? { models } : {}),
  }
}

/** Forget what is recorded about `instanceId`, or about `model` of it alone. */
export function clearProviderState(instanceId: string, model?: string): void {
  const instance = instances.get(instanceId)
  if (!instance) return
  if (model === undefined) instances.delete(instanceId)
  else {
    if (!instance.models.delete(model)) return
    if (instance.models.size === 0 && !instance.record && !instance.rate) instances.delete(instanceId)
  }
  persist()
}

/**
 * The provider configs as they are now. An instance whose config differs
 * from the one last seen loses its `billing` and `credentials` records: the
 * person may have paid or replaced the key. The first call only takes note.
 */
export function noteProviderConfigs(configs: Readonly<Record<string, unknown>>): void {
  const next = new Map<string, string>()
  for (const [instanceId, config] of Object.entries(configs)) next.set(instanceId, JSON.stringify(config) ?? '')
  const before = seenConfigs
  seenConfigs = next
  if (!before) return
  let changed = false
  for (const instanceId of new Set([...before.keys(), ...next.keys()])) {
    if (before.get(instanceId) === next.get(instanceId)) continue
    const instance = instances.get(instanceId)
    if (!instance) continue
    for (const slot of [instance, ...instance.models.values()]) {
      if (slot.record?.reason === 'billing' || slot.record?.reason === 'credentials') {
        delete slot.record
        changed = true
      }
    }
  }
  if (changed) persist()
}

// ── kept between runs ───────────────────────────────────────────────────────

type StoredSlot = { record?: HealthRecord; rate?: RateSeries }
type StoredLedger = {
  version: 1
  instances: Record<string, StoredSlot & { models?: Record<string, StoredSlot> }>
}

const STATUSES: readonly string[] = ['cooling', 'exhausted', 'disabled']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSlot(value: unknown): Slot {
  const slot: Slot = {}
  if (!isRecord(value)) return slot
  const record = value.record
  if (
    isRecord(record) &&
    typeof record.status === 'string' &&
    STATUSES.includes(record.status) &&
    typeof record.reason === 'string' &&
    (record.until === undefined || (typeof record.until === 'number' && Number.isFinite(record.until))) &&
    // Only `disabled` has no end: anything else without one would never lift.
    (record.until !== undefined || record.status === 'disabled')
  ) {
    slot.record = {
      status: record.status as HealthRecord['status'],
      ...(record.until !== undefined ? { until: record.until as number } : {}),
      reason: record.reason as HealthRecord['reason'],
    }
  }
  const rate = value.rate
  if (
    isRecord(rate) &&
    typeof rate.at === 'number' &&
    Number.isFinite(rate.at) &&
    typeof rate.waitMs === 'number' &&
    rate.waitMs > 0
  ) {
    slot.rate = { at: rate.at, waitMs: Math.min(rate.waitMs, RATE_LIMIT_MAX_MS) }
  }
  return slot
}

function writeSlot(slot: Slot): StoredSlot {
  return { ...(slot.record ? { record: slot.record } : {}), ...(slot.rate ? { rate: slot.rate } : {}) }
}

function serialize(): string {
  const out: StoredLedger = { version: 1, instances: {} }
  for (const [instanceId, instance] of instances) {
    const models: Record<string, StoredSlot> = {}
    for (const [model, slot] of instance.models) models[model] = writeSlot(slot)
    out.instances[instanceId] = { ...writeSlot(instance), ...(instance.models.size > 0 ? { models } : {}) }
  }
  return JSON.stringify(out)
}

/** Take what the store held. What was recorded since the start stays. */
function adopt(text: string | undefined): void {
  if (!text) return
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.instances)) return
  const fill = (slot: Slot, stored: Slot): void => {
    if (!slot.record && stored.record) slot.record = stored.record
    if (!slot.rate && stored.rate) slot.rate = stored.rate
  }
  for (const [instanceId, value] of Object.entries(parsed.instances)) {
    if (!isRecord(value)) continue
    const instance = instanceOf(instanceId)
    fill(instance, readSlot(value))
    if (isRecord(value.models)) {
      for (const [model, stored] of Object.entries(value.models)) fill(slotOf(instance, model), readSlot(stored))
    }
  }
}

/** Take what `target` holds, once. A read that failed is tried again later. */
async function load(target: ProviderHealthStore): Promise<void> {
  if (adopted || store !== target) return
  try {
    const text = await target.read()
    if (store !== target || adopted) return
    adopt(text)
    adopted = true
  } catch {
    // Not readable now: the ledger works in memory until it is.
  }
}

function persist(): void {
  const target = store
  if (!target) return
  // One write at a time, each carrying the ledger as it is when it starts.
  // Never before the store was read: a write would replace records the
  // ledger has not taken yet.
  writing = Promise.all([loaded, writing]).then(async () => {
    await load(target)
    if (store !== target || !adopted) return
    try {
      await target.write(serialize())
    } catch {
      // The record still holds in memory; the next change writes again.
    }
  })
}

/**
 * Keep the ledger in `store` from now on, and take what it holds. `read`
 * rejects when the store cannot be reached and answers undefined when it
 * holds nothing. Resolves once the first read is over; never rejects.
 */
export function configureProviderHealthLedger(next: ProviderHealthStore | undefined): Promise<void> {
  store = next
  adopted = false
  loaded = next ? load(next) : Promise.resolve()
  return loaded
}

/** Resolves once every change made so far is in the store. */
export async function providerHealthLedgerSettled(): Promise<void> {
  await loaded
  await writing
}

/** Test hook. */
export function resetProviderHealthLedger(): void {
  instances.clear()
  served.clear()
  seenConfigs = undefined
  store = undefined
  adopted = false
  writing = Promise.resolve()
  loaded = Promise.resolve()
}
