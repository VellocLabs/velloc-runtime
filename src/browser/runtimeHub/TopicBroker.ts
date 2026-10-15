/**
 * Contract: TopicBroker — sequencing, replay and fan-out for `evt` frames. One monotonic `seq` per
 * topic and a replay ring capped by bytes and count. A `since` inside the ring gets the missed deltas;
 * otherwise a snapshot stamped with the seq at its start, then the deltas published meanwhile.
 * A subscriber over `lagBytes` un-drained skips deltas until drained, then gets a fresh snapshot.
 */
import type { EvtFrame, TopicId } from '../runtimeProtocol'
import type {
  ConnectionInfo,
  PublishOptions,
  SnapshotPage,
  TopicProvider,
} from './types'

export type TopicSubscriber = {
  readonly conn: ConnectionInfo
  send(evt: EvtFrame): void
  bufferedBytes(): number
}

export type TopicBrokerOptions = {
  /** Replay ring byte cap per topic. Default 512 KiB. */
  ringBytes?: number
  /** Replay ring entry cap per topic. Default 2000. */
  ringCount?: number
  /** Un-drained transport bytes past which a subscriber is lagging. Default 1 MiB. */
  lagBytes?: number
  /** Where a snapshot the broker started on its own (lag recovery) reports a provider failure. */
  log?(message: string): void
}

export type TopicAuthorization = 'ok' | 'not_found' | 'forbidden'

type RingEntry = { evt: EvtFrame; bytes: number }

type Subscription = {
  readonly sub: TopicSubscriber
  lagging: boolean
  /** Non-null while a snapshot is being produced; deltas published meanwhile wait here. */
  pending: EvtFrame[] | null
  /** The snapshot in flight, if any — a second one waits for it (they must not interleave). */
  inflight: Promise<void> | null
}

type TopicState = {
  seq: number
  ring: RingEntry[]
  ringBytes: number
  subscriptions: Map<string, Subscription>
}

const ENVELOPE_OVERHEAD_BYTES = 64
// Deep enough for a transcript: a tool-result image inside `worker.messages`
// sits at depth 8 ({payload:{messages:[{message:{content:[{result:[{image}]}]}}]}}),
// and a cap there charged its base64 16 bytes, so the ring's byte cap never
// evicted a screenshot-heavy transcript.
const ESTIMATE_MAX_DEPTH = 32

/**
 * Approximate wire size of a payload for the ring's byte cap — a walk that
 * sums string lengths and a fixed cost per primitive / key, without
 * serializing. `worker.stream` publishes hundreds of events a second; a
 * `JSON.stringify` per event would serialize the hottest payload in the
 * system twice (structured clone to each subscriber is the first).
 */
function estimateBytes(payload: unknown): number {
  return ENVELOPE_OVERHEAD_BYTES + estimateValue(payload, 0)
}

function estimateValue(value: unknown, depth: number): number {
  if (value === null || value === undefined) return 4
  switch (typeof value) {
    case 'string':
      return value.length + 2
    case 'number':
    case 'boolean':
    case 'bigint':
      return 8
    case 'object':
      break
    default:
      return 4
  }
  if (depth >= ESTIMATE_MAX_DEPTH) return 16
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value.byteLength
  if (Array.isArray(value)) {
    let sum = 2
    for (const item of value) sum += estimateValue(item, depth + 1) + 1
    return sum
  }
  let sum = 2
  for (const key in value as Record<string, unknown>) {
    sum += key.length + 4 + estimateValue((value as Record<string, unknown>)[key], depth + 1)
  }
  return sum
}

export class TopicBroker {
  private readonly providers: TopicProvider[] = []
  private readonly topics = new Map<TopicId, TopicState>()
  private readonly ringBytesCap: number
  private readonly ringCountCap: number
  private readonly lagBytes: number
  private readonly log: (message: string) => void

  constructor(options: TopicBrokerOptions = {}) {
    this.ringBytesCap = options.ringBytes ?? 512 * 1024
    this.ringCountCap = options.ringCount ?? 2000
    this.lagBytes = options.lagBytes ?? 1024 * 1024
    this.log = options.log ?? (() => {})
  }

  registerProvider(provider: TopicProvider): void {
    this.providers.push(provider)
  }

  /** First registered provider whose `matches` accepts the topic. */
  providerFor(topic: TopicId): TopicProvider | undefined {
    return this.providers.find(provider => provider.matches(topic))
  }

  authorize(topic: TopicId, conn: ConnectionInfo): TopicAuthorization {
    const provider = this.providerFor(topic)
    if (!provider) return 'not_found'
    return provider.authorize(topic, conn) ? 'ok' : 'forbidden'
  }

  seqOf(topic: TopicId): number {
    return this.topics.get(topic)?.seq ?? 0
  }

  /** Assigns the next seq, records the event in the ring, fans it out. Returns the seq. */
  publish(topic: TopicId, payload: unknown, opts: PublishOptions = {}): number {
    const state = this.stateOf(topic)
    state.seq += 1
    const evt: EvtFrame = {
      kind: 'evt',
      topic,
      seq: state.seq,
      ...(opts.type !== undefined ? { type: opts.type } : {}),
      payload,
      form: opts.form ?? 'delta',
    }
    this.record(state, evt)
    for (const subscription of Array.from(state.subscriptions.values())) {
      this.deliver(topic, state, subscription, evt)
    }
    return state.seq
  }

  /**
   * Publish several deltas of one topic as ONE event (`form: 'deltas'`) under a single `seq`; a
   * receiver unfolds it. An empty batch is not published.
   */
  publishBatch(topic: TopicId, payloads: readonly unknown[], opts: PublishOptions = {}): number {
    if (payloads.length === 0) return this.seqOf(topic)
    return this.publish(topic, [...payloads], { ...opts, form: 'deltas' })
  }

  /**
   * Add `sub` to `topic` and bring it up to date. The caller has already run
   * `authorize`. Resolves when the snapshot or replay has been handed to the
   * transport; live deltas flow from the moment of the call.
   */
  async subscribe(sub: TopicSubscriber, topic: TopicId, since?: number): Promise<void> {
    const state = this.stateOf(topic)
    const existing = state.subscriptions.get(sub.conn.connectionId)
    const subscription: Subscription = existing ?? { sub, lagging: false, pending: null, inflight: null }
    state.subscriptions.set(sub.conn.connectionId, subscription)
    if (!existing) {
      this.providerFor(topic)?.onSubscribe?.(topic, sub.conn, state.subscriptions.size === 1)
    }

    if (since !== undefined && this.canReplay(state, since)) {
      for (const entry of state.ring) {
        if (entry.evt.seq > since) sub.send(this.narrow(topic, sub.conn, entry.evt))
      }
      return
    }
    await this.sendSnapshot(topic, state, subscription, since)
  }

  /**
   * An explicit unsubscribe. When it removes the LAST subscriber the replay
   * ring is released too (the `seq` line is kept, so a later subscriber never
   * sees seq go backwards): nobody asked to come back to this topic, and a
   * ring kept here lived for the life of the SharedWorker — up to four per
   * session ever opened.
   */
  unsubscribe(connectionId: string, topic: TopicId): void {
    this.detach(connectionId, topic, true)
  }

  private detach(connectionId: string, topic: TopicId, releaseRing: boolean): void {
    const state = this.topics.get(topic)
    if (!state) return
    const subscription = state.subscriptions.get(connectionId)
    if (!subscription) return
    state.subscriptions.delete(connectionId)
    this.providerFor(topic)?.onUnsubscribe?.(topic, subscription.sub.conn, state.subscriptions.size === 0)
    if (state.subscriptions.size > 0) return
    if (releaseRing) this.releaseRing(topic)
    else if (state.ring.length === 0 && state.seq === 0) this.topics.delete(topic)
  }

  /**
   * Drop every subscription of a connection; returns the topics it held. The
   * rings are KEPT — the connection may come back with `hello.resume` — and
   * the hub hands them back through `releaseRing` when that chance has
   * passed (the retained entry expires, or the connection was not
   * resumable to begin with). Without that hand-back a ring outlived every
   * connection that ever dropped, for the life of the runtime.
   */
  removeConnection(connectionId: string): TopicId[] {
    const held: TopicId[] = []
    for (const [topic, state] of this.topics) {
      if (state.subscriptions.has(connectionId)) {
        held.push(topic)
        this.detach(connectionId, topic, false)
      }
    }
    return held
  }

  /**
   * Release a topic's replay ring — a no-op while anyone is subscribed (the
   * ring is theirs). The `seq` line is kept so a later subscriber never sees
   * seq go backwards; a topic that never published is forgotten entirely.
   */
  releaseRing(topic: TopicId): void {
    const state = this.topics.get(topic)
    if (!state || state.subscriptions.size > 0) return
    state.ring = []
    state.ringBytes = 0
    if (state.seq === 0) this.topics.delete(topic)
  }

  /** Forget a topic entirely (its ring and subscribers) — e.g. when the session it names is deleted. */
  dropTopic(topic: TopicId): void {
    const state = this.topics.get(topic)
    if (!state) return
    for (const connectionId of Array.from(state.subscriptions.keys())) this.unsubscribe(connectionId, topic)
    this.topics.delete(topic)
  }

  subscribersOf(topic: TopicId): readonly string[] {
    return Array.from(this.topics.get(topic)?.subscriptions.keys() ?? [])
  }

  // ---- internals -----------------------------------------------------------

  private stateOf(topic: TopicId): TopicState {
    let state = this.topics.get(topic)
    if (!state) {
      state = { seq: 0, ring: [], ringBytes: 0, subscriptions: new Map() }
      this.topics.set(topic, state)
    }
    return state
  }

  private record(state: TopicState, evt: EvtFrame): void {
    const bytes = estimateBytes(evt.payload)
    state.ring.push({ evt, bytes })
    state.ringBytes += bytes
    while (
      state.ring.length > 1 &&
      (state.ringBytes > this.ringBytesCap || state.ring.length > this.ringCountCap)
    ) {
      const evicted = state.ring.shift()!
      state.ringBytes -= evicted.bytes
    }
  }

  /** The ring holds every seq after `since` — or there is nothing after it. */
  private canReplay(state: TopicState, since: number): boolean {
    if (since > state.seq) return false
    if (since === state.seq) return true
    const first = state.ring[0]
    return first !== undefined && first.evt.seq <= since + 1
  }

  private deliver(
    topic: TopicId,
    state: TopicState,
    subscription: Subscription,
    evt: EvtFrame,
  ): void {
    if (subscription.pending) {
      subscription.pending.push(evt)
      return
    }
    const buffered = subscription.sub.bufferedBytes()
    if (subscription.lagging) {
      if (buffered > this.lagBytes) return
      subscription.lagging = false
      // Nobody awaits this snapshot, so a provider that throws would surface
      // as an unhandled rejection. The subscriber stays: the deltas it
      // skipped while lagging left a hole in its seq line, and the client's
      // hole detection re-subscribes (a fresh snapshot) on the next delta.
      this.sendSnapshot(topic, state, subscription, undefined).catch(error => {
        this.log(`[runtimeHub] lag-recovery snapshot for '${topic}' failed: ${String(error)}`)
      })
      return
    }
    if (buffered > this.lagBytes) {
      subscription.lagging = true
      return
    }
    subscription.sub.send(this.narrow(topic, subscription.sub.conn, evt))
  }

  /**
   * The delta as `conn` may see it (`TopicProvider.project`): as published
   * when the provider does not narrow, else the narrowed payload under the
   * same seq — or, when withheld, a typeless `null` delta holding the seq.
   * A batch is narrowed item by item and withheld only when nothing is left.
   */
  private narrow(topic: TopicId, conn: ConnectionInfo, evt: EvtFrame): EvtFrame {
    const project = this.providerFor(topic)?.project
    if (!project) return evt
    const withheld = (): EvtFrame => ({ kind: 'evt', topic, seq: evt.seq, payload: null, form: 'delta' })
    if (evt.form === 'deltas' && Array.isArray(evt.payload)) {
      const kept = evt.payload
        .map(payload => project(topic, conn, { ...(evt.type !== undefined ? { type: evt.type } : {}), payload }))
        .filter(payload => payload !== undefined)
      return kept.length === 0 ? withheld() : { ...evt, payload: kept }
    }
    const payload = project(topic, conn, { ...(evt.type !== undefined ? { type: evt.type } : {}), payload: evt.payload })
    if (payload === undefined) return withheld()
    return payload === evt.payload ? evt : { ...evt, payload }
  }

  /**
   * Snapshots for one subscription never overlap: a second request waits for
   * the first to finish (each run owns `pending`; two runs sharing it would
   * flush the other's held deltas ahead of its pages).
   */
  private sendSnapshot(
    topic: TopicId,
    state: TopicState,
    subscription: Subscription,
    since: number | undefined,
  ): Promise<void> {
    const previous = subscription.inflight ?? Promise.resolve()
    const run = previous.then(() => this.runSnapshot(topic, state, subscription, since))
    const tracked = run.finally(() => {
      if (subscription.inflight === tracked) subscription.inflight = null
    })
    subscription.inflight = tracked
    return tracked
  }

  private async runSnapshot(
    topic: TopicId,
    state: TopicState,
    subscription: Subscription,
    since: number | undefined,
  ): Promise<void> {
    const provider = this.providerFor(topic)
    const seq = state.seq
    subscription.pending = []
    const { sub } = subscription
    const stillCurrent = (): boolean =>
      state.subscriptions.get(sub.conn.connectionId) === subscription

    const page = (p: SnapshotPage, more: boolean): EvtFrame => ({
      kind: 'evt',
      topic,
      seq,
      ...(p.type !== undefined ? { type: p.type } : {}),
      payload: p.payload,
      form: 'snapshot',
      ...(more ? { more: true } : {}),
    })

    try {
      let held: SnapshotPage | null = null
      let sent = 0
      if (provider) {
        for await (const next of provider.snapshot(topic, sub.conn, since)) {
          if (!stillCurrent()) return
          if (held) {
            sub.send(page(held, true))
            sent += 1
          }
          held = next
        }
      }
      if (!stillCurrent()) return
      if (held) {
        sub.send(page(held, false))
        sent += 1
      }
      // A delta-only topic yields nothing; the client still needs the seq baseline.
      if (sent === 0) sub.send(page({ payload: null }, false))
    } finally {
      const pending = subscription.pending
      subscription.pending = null
      if (pending && stillCurrent()) {
        for (const evt of pending) this.deliver(topic, state, subscription, evt)
      }
    }
  }
}
