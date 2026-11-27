/**
 * Contract: the provider health ledger (F-27). The platform's record of what
 * the verdicts of a model's requests said about it: cooling, exhausted or
 * disabled, and until when. Facts only; which provider to use is a router's
 * choice. Keyed by provider INSTANCE id, which is opaque here, and under it
 * by model. Reads are synchronous and from memory; every change is written
 * to the store, so a record survives a restart. A record past its end is
 * gone when read.
 *
 * A scope of `request` records nothing. Every other verdict is recorded
 * under the model the request named, whatever its scope: one model failing
 * says nothing about the instance's other models. A record is replaced only
 * by one that lasts at least as long; `disabled` is replaced by nothing.
 * Only a provider's own refusal (an HTTP status) disables a model; a
 * credentials verdict no server gave cools it for a while instead.
 */
import type { PeerModelState, PeerUntilFrom, ProviderState } from '../../mods/provider/nouns/providerPeersTypes'
import type { ProviderConnectivityIssue } from '../../utils/providerConnectivity'

export const RATE_LIMIT_FIRST_MS = 60_000
export const RATE_LIMIT_MAX_MS = 15 * 60_000
/** A rate limit this soon after the last one's cooldown ended doubles the wait. */
export const RATE_LIMIT_REPEAT_MS = 10 * 60_000
export const QUOTA_UNKNOWN_MS = 60 * 60_000
/** Requests served in a UTC day from which a quota reads as a daily one. */
export const QUOTA_DAILY_SERVED = 10
export const BILLING_COOL_MS = 30 * 60_000
/** How long a credentials verdict with no HTTP status holds a model. */
export const UNCONFIRMED_CREDENTIALS_MS = 10 * 60_000
export const MODEL_UNAVAILABLE_MS = 60 * 60_000
export const TRANSIENT_COOL_MS = 30_000
/** The longest a run of service or network failures holds a model. */
export const TRANSIENT_MAX_MS = 5 * 60_000
/** A service or network failure this soon after the last one's cooldown ended doubles the wait. */
export const TRANSIENT_REPEAT_MS = 2 * 60_000

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
  /** Who set `until`. Absent with no `until`, and on a record stored before it was kept. */
  untilFrom?: PeerUntilFrom
  reason: ProviderConnectivityIssue['kind']
}

/** The last rate limit that carried no wait of its own, for the doubling. */
type RateSeries = { at: number; waitMs: number }

/**
 * `trouble`: the last service or network failure, for its own doubling. Kept
 * in memory only: after a restart a failing model starts again at the
 * shortest wait.
 */
type Slot = { record?: HealthRecord; rate?: RateSeries; trouble?: RateSeries }

type Instance = { models: Map<string, Slot> }

const instances = new Map<string, Instance>()
/** Requests served per instance in one UTC day. In memory only. */
const served = new Map<string, { day: number; count: number }>()
/** Each instance's config as last seen, to tell a change from a re-read. */
let seenConfigs: Map<string, string> | undefined
/** The configs as the stored ledger saw them, until this run's first are known. */
let storedConfigs: Map<string, string> | undefined
/**
 * What was forgotten before the store's records were taken: those records
 * are not taken. No `model`: the instance and all its models; `reasons`: only
 * records of those reasons, and no rate-limit series.
 */
type Forgotten = { instanceId: string; model?: string; reasons?: readonly string[] }
const forgotten: Forgotten[] = []
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

function slotOf(instance: Instance, model: string): Slot {
  let slot = instance.models.get(model)
  if (!slot) instance.models.set(model, (slot = {}))
  return slot
}

/** The series still counts: its cooldown ended less than the repeat window ago. */
function repeats(rate: RateSeries | undefined, nowMs: number, windowMs: number = RATE_LIMIT_REPEAT_MS): rate is RateSeries {
  return rate !== undefined && nowMs - (rate.at + rate.waitMs) < windowMs
}

function live(record: HealthRecord | undefined, nowMs: number): HealthRecord | undefined {
  return record && (record.until === undefined || record.until > nowMs) ? record : undefined
}

function slotIsEmpty(slot: Slot, nowMs: number): boolean {
  return !live(slot.record, nowMs) && !repeats(slot.rate, nowMs) && !repeats(slot.trouble, nowMs, TRANSIENT_REPEAT_MS)
}

/** Drop what has ended under `instanceId`; the instance too once nothing is left. */
function prune(instanceId: string, nowMs: number): void {
  const instance = instances.get(instanceId)
  if (!instance) return
  const sweep = (slot: Slot): void => {
    if (!live(slot.record, nowMs)) delete slot.record
    if (!repeats(slot.rate, nowMs)) delete slot.rate
    if (!repeats(slot.trouble, nowMs, TRANSIENT_REPEAT_MS)) delete slot.trouble
  }
  for (const [model, slot] of instance.models) {
    sweep(slot)
    if (slotIsEmpty(slot, nowMs)) instance.models.delete(model)
  }
  if (instance.models.size === 0) instances.delete(instanceId)
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
      const stated = statedEnd(verdict, nowMs, 'wait')
      let until = stated
      if (until === undefined) {
        const waitMs = repeats(slot.rate, nowMs) ? Math.min(slot.rate.waitMs * 2, RATE_LIMIT_MAX_MS) : RATE_LIMIT_FIRST_MS
        slot.rate = { at: nowMs, waitMs }
        until = nowMs + waitMs
      }
      return { status: 'cooling', until, untilFrom: stated === undefined ? 'platform' : 'provider', reason: 'rate_limit' }
    }
    case 'quota': {
      const stated = statedEnd(verdict, nowMs, 'reset')
      const until =
        stated ??
        (servedToday(instanceId, nowMs) >= QUOTA_DAILY_SERVED
          ? (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS
          : nowMs + QUOTA_UNKNOWN_MS)
      return { status: 'exhausted', until, untilFrom: stated === undefined ? 'platform' : 'provider', reason: 'quota' }
    }
    case 'billing':
      return { status: 'cooling', until: nowMs + BILLING_COOL_MS, untilFrom: 'platform', reason: 'billing' }
    case 'credentials':
      if (verdict.status === undefined) {
        return { status: 'cooling', until: nowMs + UNCONFIRMED_CREDENTIALS_MS, untilFrom: 'platform', reason: 'credentials' }
      }
      return { status: 'disabled', reason: 'credentials' }
    case 'model_unavailable':
      return { status: 'cooling', until: nowMs + MODEL_UNAVAILABLE_MS, untilFrom: 'platform', reason: 'model_unavailable' }
    case 'service':
    case 'network': {
      // A model that keeps failing is tried less often: 30 s, doubling to 5 min.
      const waitMs = repeats(slot.trouble, nowMs, TRANSIENT_REPEAT_MS)
        ? Math.min(slot.trouble.waitMs * 2, TRANSIENT_MAX_MS)
        : TRANSIENT_COOL_MS
      slot.trouble = { at: nowMs, waitMs }
      return { status: 'cooling', until: nowMs + waitMs, untilFrom: 'platform', reason: verdict.kind }
    }
    default:
      return undefined
  }
}

/**
 * Record what a failed request's verdict says about the model that served
 * it: `model` of `instanceId`, the one the request named.
 */
export function recordProviderVerdict(
  instanceId: string,
  model: string,
  verdict: ProviderConnectivityIssue,
  nowMs: number,
): void {
  if (!instanceId || !model || verdict.scope === 'request') return
  prune(instanceId, nowMs)
  const slot = slotOf(instanceOf(instanceId), model)
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
    ...(record.until !== undefined && record.untilFrom ? { untilFrom: record.untilFrom } : {}),
    reason: record.reason,
  }
}

/** What is recorded about the models of `instanceId` now. A copy; no model when nothing holds. */
export function providerStateOf(instanceId: string, nowMs: number): ProviderState {
  prune(instanceId, nowMs)
  const models: Record<string, PeerModelState> = {}
  for (const [model, slot] of instances.get(instanceId)?.models ?? []) {
    if (slot.record) models[model] = stateOfRecord(slot.record)
  }
  return { models }
}

/** Forget what is recorded about `model` of `instanceId`, or about all its models when none is named. */
export function clearProviderState(instanceId: string, model?: string): void {
  const pending = store !== undefined && !adopted
  if (pending) forgotten.push({ instanceId, ...(model !== undefined ? { model } : {}) })
  const instance = instances.get(instanceId)
  let changed = false
  if (instance && model === undefined) {
    instances.delete(instanceId)
    changed = true
  } else if (instance && instance.models.delete(model!)) {
    if (instance.models.size === 0) instances.delete(instanceId)
    changed = true
  }
  if (changed || pending) persist()
}

/** Security: a config's fingerprint, so no config (sealed secrets included) is written to the cache. */
function fingerprint(config: unknown): string {
  const text = JSON.stringify(config) ?? ''
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`
}

const LIFTED_BY_CONFIG: readonly string[] = ['billing', 'credentials', 'model_unavailable']

/** Lift what a config change may have fixed for `instanceId`. True when something was lifted. */
function liftForConfigChange(instanceId: string): boolean {
  if (store !== undefined && !adopted) forgotten.push({ instanceId, reasons: LIFTED_BY_CONFIG })
  const instance = instances.get(instanceId)
  if (!instance) return false
  let changed = false
  for (const slot of instance.models.values()) {
    if (slot.record && LIFTED_BY_CONFIG.includes(slot.record.reason)) {
      delete slot.record
      changed = true
    }
  }
  return changed
}

/** Instances whose config differs between two sightings. */
function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(id => before.get(id) !== after.get(id))
}

/**
 * The provider configs as they are now. An instance whose config differs
 * from the one last seen loses its models' `billing`, `credentials` and
 * `model_unavailable` records: the person may have paid, replaced the key, or
 * pointed it at another endpoint or API version. The configs last seen are kept
 * with the ledger, so a change made while no run was watching counts too.
 */
export function noteProviderConfigs(configs: Readonly<Record<string, unknown>>): void {
  const next = new Map<string, string>()
  for (const [instanceId, config] of Object.entries(configs)) next.set(instanceId, fingerprint(config))
  const before = seenConfigs ?? storedConfigs
  seenConfigs = next
  storedConfigs = undefined
  const differ = before ? changedBetween(before, next) : [...next.keys()]
  let changed = false
  if (before) {
    for (const instanceId of differ) {
      if (liftForConfigChange(instanceId)) changed = true
    }
  }
  // The configs are kept with the ledger, so a change made between runs is seen.
  if (changed || (adopted && differ.length > 0)) persist()
}

// ── kept between runs ───────────────────────────────────────────────────────

type StoredSlot = { record?: HealthRecord; rate?: RateSeries }
type StoredLedger = {
  version: 1
  instances: Record<string, { models?: Record<string, StoredSlot> }>
  /** Each instance's config fingerprint when the ledger was written. */
  configs?: Record<string, string>
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
      ...(record.until !== undefined && (record.untilFrom === 'provider' || record.untilFrom === 'platform')
        ? { untilFrom: record.untilFrom }
        : {}),
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
    out.instances[instanceId] = { models }
  }
  const configs = seenConfigs ?? storedConfigs
  if (configs) out.configs = Object.fromEntries(configs)
  return JSON.stringify(out)
}

/**
 * Take what the store held. What was recorded since the start stays. Only
 * records under a model are taken.
 */
function adopt(text: string | undefined): void {
  if (!text) return
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.instances)) return
  const stored = new Map<string, string>()
  if (isRecord(parsed.configs)) {
    for (const [instanceId, print] of Object.entries(parsed.configs)) {
      if (typeof print === 'string') stored.set(instanceId, print)
    }
  }
  // Configs that changed while no run was watching lift what they may have fixed.
  const changedSince = new Set(seenConfigs && isRecord(parsed.configs) ? changedBetween(stored, seenConfigs) : [])
  const isForgotten = (instanceId: string, model: string, reason: string | undefined): boolean =>
    (reason !== undefined && changedSince.has(instanceId) && LIFTED_BY_CONFIG.includes(reason)) ||
    forgotten.some(
      f =>
        f.instanceId === instanceId &&
        (f.model === undefined || f.model === model) &&
        (f.reasons === undefined || (reason !== undefined && f.reasons.includes(reason))),
    )
  const fill = (instanceId: string, model: string, slot: Slot, from: Slot): void => {
    if (!slot.record && from.record && !isForgotten(instanceId, model, from.record.reason)) slot.record = from.record
    if (!slot.rate && from.rate && !isForgotten(instanceId, model, undefined)) slot.rate = from.rate
  }
  for (const [instanceId, value] of Object.entries(parsed.instances)) {
    if (!isRecord(value)) continue
    const instance = instanceOf(instanceId)
    if (isRecord(value.models)) {
      for (const [model, from] of Object.entries(value.models)) fill(instanceId, model, slotOf(instance, model), readSlot(from))
    }
    for (const [model, slot] of instance.models) {
      if (!slot.record && !slot.rate) instance.models.delete(model)
    }
    if (instance.models.size === 0) instances.delete(instanceId)
  }
  if (!seenConfigs && stored.size > 0) storedConfigs = stored
}

/** Take what `target` holds, once. A read that failed is tried again later. */
async function load(target: ProviderHealthStore): Promise<void> {
  if (adopted || store !== target) return
  try {
    const text = await target.read()
    if (store !== target || adopted) return
    adopt(text)
    adopted = true
    forgotten.length = 0
    if (seenConfigs) persist()
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
  forgotten.length = 0
  loaded = next ? load(next) : Promise.resolve()
  return loaded
}

/**
 * The store may be reachable now (a home or a host bridge arrived): take
 * what it holds if that has not happened yet. Never rejects.
 */
export function retryProviderHealthLedgerLoad(): Promise<void> {
  const target = store
  if (!target || adopted) return loaded
  loaded = loaded.then(() => load(target))
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
  storedConfigs = undefined
  forgotten.length = 0
  store = undefined
  adopted = false
  writing = Promise.resolve()
  loaded = Promise.resolve()
}
