/**
 * Contract: runs the jobs a provider declares (`providers.<key>.jobs`) by
 * raising `provider.job` in its module (F-27). The platform wakes the module
 * for a due job and holds nothing open between runs; the module's own idle
 * exit decides when its worker closes. A job runs
 * only for a registered provider that is set up. One run at a time per
 * provider, at most `PROVIDER_JOB_PARALLEL` providers at once, never two runs
 * of one job. Nothing is persisted: a run missed while the app was closed is
 * not made up. A failed run is reported and the job's next run is pushed
 * back; it never reaches a turn.
 */

import { effectiveJobTiming, type ProviderJobDecl } from './providerJobsManifest'

export type ProviderJobReason = 'schedule' | 'connect' | 'manual'

/** `e` of `provider.job`, besides `provider` and `locale`. */
export type ProviderJobEvent = {
  job: string
  reason: ProviderJobReason
  /** Epoch ms the run was due (schedule) or asked for (connect, manual). */
  scheduledAt: number
  /** Epoch ms the job's previous run started, in this app run. */
  lastRunAt?: number
}

/** `jobs` is a new list for each registration of the provider: a new one
 *  lifts the park on a module found without the hook. */
export type ProviderJobSource = { providerId: string; jobs: readonly ProviderJobDecl[] }

export type ProviderJobRefusal = 'unknown_job' | 'not_connected' | 'busy' | 'too_soon' | 'offline' | 'no_hook'

export type ProviderJobRunResult =
  | { status: 'ran' }
  | { status: 'failed'; message: string }
  | { status: 'refused'; reason: ProviderJobRefusal }

/** A manual run as the scheduler answered it: taken (`done` resolves when it
 *  ended, never rejects) or refused. */
export type ProviderJobRequest =
  | { status: 'accepted'; done: Promise<ProviderJobRunResult> }
  | { status: 'refused'; reason: ProviderJobRefusal }

export type ProviderJobState = {
  id: string
  /** Queued or running: a manual run is refused meanwhile. */
  busy: boolean
  lastRunAt?: number
  lastResult?: 'ran' | 'failed'
  /** Epoch ms of the next scheduled run; absent while none is planned. */
  nextRunAt?: number
  /** Epoch ms from which a manual run is accepted again. */
  manualFrom?: number
}

export type ProviderJobSchedulerDeps = {
  /** Every registered provider with its declared jobs. */
  providers: () => readonly ProviderJobSource[]
  /** The provider is set up (a key, a sign-in, or chosen keyless). */
  connected: (providerId: string) => boolean
  /** False until the set-up state can be trusted; nothing is planned before. */
  ready?: () => boolean
  /**
   * Raise `provider.job`. Resolves false when the module does not hook it;
   * rejects when the module could not serve or the hook did not finish.
   */
  run: (providerId: string, e: ProviderJobEvent, options: { budgetMs: number; signal: AbortSignal }) => Promise<boolean>
  report: (line: string) => void
  now?: () => number
  /** In [0, 1): spreads the periods. */
  random?: () => number
  online?: () => boolean
  /** Wall-clock bound of one run, the module's start included. */
  wallMs?: number
}

export const PROVIDER_JOB_PARALLEL = 2
export const PROVIDER_JOB_JITTER = 0.1
export const PROVIDER_JOB_MANUAL_GAP_MS = 10_000
export const PROVIDER_JOB_WALL_MS = 5 * 60_000
export const PROVIDER_JOB_MAX_BACKOFF_MS = 6 * 60 * 60_000
/** How often a due job that needs the network looks for it again. */
export const PROVIDER_JOB_OFFLINE_RETRY_MS = 60_000
const LONGEST_TIMER_MS = 60 * 60_000

type Entry = {
  readonly providerId: string
  decl: ProviderJobDecl
  shape: string
  everyMs: number
  budgetMs: number
  /** Infinity: no run planned (not set up, or the module has no hook). */
  dueAt: number
  /** When the run now waiting for the network was due. */
  offlineSince?: number
  lastRunAt?: number
  lastResult?: 'ran' | 'failed'
  lastManualAt?: number
  failures: number
  pending: boolean
  noHook: boolean
}

type Queued = {
  entry: Entry
  reason: ProviderJobReason
  scheduledAt: number
  done: (result: ProviderJobRunResult) => void
}

export type ProviderJobScheduler = {
  /** Bring the plan to the registered providers and their set-up state. */
  sync: () => void
  /** Run a declared job now (`reason: 'manual'`). Resolves when the run
   *  ended, or at once with why it was refused. Never rejects. */
  runNow: (providerId: string, jobId: string) => Promise<ProviderJobRunResult>
  /** `runNow`, answered as soon as the run was taken or refused. */
  requestRun: (providerId: string, jobId: string) => ProviderJobRequest
  states: (providerId: string) => ProviderJobState[]
  dispose: () => void
}

const keyOf = (providerId: string, jobId: string): string => `${providerId}\n${jobId}`

export function createProviderJobScheduler(deps: ProviderJobSchedulerDeps): ProviderJobScheduler {
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const online = deps.online ?? (() => (globalThis.navigator as { onLine?: boolean } | undefined)?.onLine !== false)
  const wallMs = deps.wallMs ?? PROVIDER_JOB_WALL_MS

  const entries = new Map<string, Entry>()
  /** Whether each provider with jobs was set up at the last sync. */
  const seen = new Map<string, boolean>()
  const queue: Queued[] = []
  const active = new Set<string>()
  const running = new Set<AbortController>()
  /** Each provider's `jobs` list at the last sync. */
  const sourceOf = new Map<string, readonly ProviderJobDecl[]>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const nextDue = (entry: Entry, from: number): number => from + Math.round(entry.everyMs * (1 + PROVIDER_JOB_JITTER * random()))
  const label = (entry: Entry): string => `${entry.providerId}: job "${entry.decl.id}"`
  const isLive = (entry: Entry): boolean => entries.get(keyOf(entry.providerId, entry.decl.id)) === entry
  const needsNetwork = (entry: Entry): boolean => entry.decl.requires?.includes('online') === true

  function waitForNetwork(entry: Entry, dueAt: number, at: number): void {
    entry.offlineSince ??= dueAt
    if (entry.dueAt !== Infinity) entry.dueAt = Math.min(entry.dueAt, at + PROVIDER_JOB_OFFLINE_RETRY_MS)
  }

  function arm(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (disposed) return
    let soonest = Infinity
    for (const entry of entries.values()) soonest = Math.min(soonest, entry.dueAt)
    if (soonest === Infinity) return
    timer = setTimeout(tick, Math.min(Math.max(soonest - now(), 0), LONGEST_TIMER_MS))
  }

  function enqueue(entry: Entry, reason: ProviderJobReason, scheduledAt: number): Promise<ProviderJobRunResult> {
    entry.pending = true
    return new Promise(resolve => {
      queue.push({ entry, reason, scheduledAt, done: resolve })
    })
  }

  function tick(): void {
    timer = undefined
    const at = now()
    for (const entry of entries.values()) {
      if (entry.dueAt > at) continue
      const dueAt = entry.dueAt
      entry.dueAt = nextDue(entry, at)
      if (entry.pending) {
        deps.report(`${label(entry)} is still running; this run is skipped`)
        continue
      }
      if (!deps.connected(entry.providerId)) {
        entry.dueAt = Infinity
        continue
      }
      if (needsNetwork(entry) && !online()) {
        waitForNetwork(entry, dueAt, at)
        continue
      }
      const scheduledAt = entry.offlineSince ?? dueAt
      entry.offlineSince = undefined
      void enqueue(entry, 'schedule', scheduledAt)
    }
    pump()
    arm()
  }

  function settle(item: Queued, result: ProviderJobRunResult): void {
    item.entry.pending = false
    item.done(result)
  }

  function pump(): void {
    let index = 0
    while (index < queue.length && active.size < PROVIDER_JOB_PARALLEL) {
      const item = queue[index]!
      const { entry } = item
      if (active.has(entry.providerId)) {
        index += 1
        continue
      }
      queue.splice(index, 1)
      if (disposed || !isLive(entry)) settle(item, { status: 'refused', reason: 'unknown_job' })
      else if (!deps.connected(entry.providerId)) settle(item, { status: 'refused', reason: 'not_connected' })
      else if (entry.noHook) settle(item, { status: 'refused', reason: 'no_hook' })
      else if (needsNetwork(entry) && !online()) {
        if (item.reason === 'schedule') waitForNetwork(entry, item.scheduledAt, now())
        settle(item, { status: 'refused', reason: 'offline' })
      } else void execute(item)
    }
  }

  async function execute(item: Queued): Promise<void> {
    const { entry } = item
    active.add(entry.providerId)
    const e: ProviderJobEvent = {
      job: entry.decl.id,
      reason: item.reason,
      scheduledAt: item.scheduledAt,
      ...(entry.lastRunAt !== undefined ? { lastRunAt: entry.lastRunAt } : {}),
    }
    entry.lastRunAt = now()
    const controller = new AbortController()
    running.add(controller)
    let wall: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      wall = setTimeout(() => {
        controller.abort()
        reject(new Error(`not finished within ${wallMs} ms`))
      }, wallMs)
    })
    let result: ProviderJobRunResult
    try {
      const raised = await Promise.race([deps.run(entry.providerId, e, { budgetMs: entry.budgetMs, signal: controller.signal }), expired])
      if (raised) {
        entry.failures = 0
        entry.lastResult = 'ran'
        result = { status: 'ran' }
      } else {
        // Nothing to wake the module for until it is registered again.
        for (const other of entries.values()) {
          if (other.providerId !== entry.providerId) continue
          other.noHook = true
          other.dueAt = Infinity
        }
        deps.report(`${entry.providerId}: jobs are declared but the module does not hook provider.job; none will run`)
        result = { status: 'refused', reason: 'no_hook' }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      entry.failures += 1
      entry.lastResult = 'failed'
      const wait = Math.min(entry.everyMs * 2 ** Math.min(entry.failures, 10), Math.max(entry.everyMs, PROVIDER_JOB_MAX_BACKOFF_MS))
      if (entry.dueAt !== Infinity) entry.dueAt = Math.max(entry.dueAt, now() + wait)
      deps.report(`${label(entry)} failed (${entry.failures} in a row): ${message}`)
      result = { status: 'failed', message }
    } finally {
      if (wall !== undefined) clearTimeout(wall)
      controller.abort()
      running.delete(controller)
      active.delete(entry.providerId)
    }
    settle(item, result)
    pump()
    arm()
  }

  function sync(): void {
    if (disposed || deps.ready?.() === false) return
    const at = now()
    const live = new Set<string>()
    const providers = new Set<string>()
    for (const source of deps.providers()) {
      if (source.jobs.length === 0) continue
      providers.add(source.providerId)
      const connected = deps.connected(source.providerId)
      const registeredAgain = sourceOf.has(source.providerId) && sourceOf.get(source.providerId) !== source.jobs
      sourceOf.set(source.providerId, source.jobs)
      // Set up since the last look; a provider first seen set up waits for its period.
      const justConnected = seen.get(source.providerId) === false && connected
      seen.set(source.providerId, connected)
      for (const decl of source.jobs) {
        const key = keyOf(source.providerId, decl.id)
        live.add(key)
        const shape = JSON.stringify(decl)
        let entry = entries.get(key)
        if (!entry || entry.shape !== shape) {
          const timing = effectiveJobTiming(decl)
          if (timing.clamped) {
            deps.report(`${source.providerId}: job "${decl.id}" runs every ${timing.everyMs} ms with a budget of ${timing.budgetMs} ms (the declared figures are outside the platform's range)`)
          }
          if (entry) {
            // Changed in place: a run still going keeps the job busy.
            Object.assign(entry, { decl, shape, everyMs: timing.everyMs, budgetMs: timing.budgetMs, dueAt: Infinity, failures: 0 })
          } else {
            entry = {
              providerId: source.providerId,
              decl,
              shape,
              everyMs: timing.everyMs,
              budgetMs: timing.budgetMs,
              dueAt: Infinity,
              failures: 0,
              pending: false,
              noHook: false,
            }
            entries.set(key, entry)
          }
        }
        if (registeredAgain) entry.noHook = false
        if (!connected) entry.dueAt = Infinity
        else if (entry.dueAt === Infinity && !entry.noHook) entry.dueAt = nextDue(entry, at)
        if (justConnected && !entry.pending && !entry.noHook && decl.runOn?.includes('connect')) void enqueue(entry, 'connect', at)
      }
    }
    for (const key of [...entries.keys()]) if (!live.has(key)) entries.delete(key)
    for (const id of [...seen.keys()]) if (!providers.has(id)) seen.delete(id)
    for (const id of [...sourceOf.keys()]) if (!providers.has(id)) sourceOf.delete(id)
    pump()
    arm()
  }

  function requestRun(providerId: string, jobId: string): ProviderJobRequest {
    const refused = (reason: ProviderJobRefusal): ProviderJobRequest => ({ status: 'refused', reason })
    if (disposed) return refused('unknown_job')
    if (!entries.has(keyOf(providerId, jobId))) sync()
    const entry = entries.get(keyOf(providerId, jobId))
    if (!entry) return refused('unknown_job')
    if (!deps.connected(providerId)) return refused('not_connected')
    if (entry.noHook) return refused('no_hook')
    if (entry.pending) return refused('busy')
    const at = now()
    if (entry.lastManualAt !== undefined && at - entry.lastManualAt < PROVIDER_JOB_MANUAL_GAP_MS) return refused('too_soon')
    if (entry.decl.requires?.includes('online') && !online()) return refused('offline')
    entry.lastManualAt = at
    const done = enqueue(entry, 'manual', at)
    pump()
    arm()
    return { status: 'accepted', done }
  }

  async function runNow(providerId: string, jobId: string): Promise<ProviderJobRunResult> {
    const request = requestRun(providerId, jobId)
    return request.status === 'accepted' ? request.done : request
  }

  function states(providerId: string): ProviderJobState[] {
    const out: ProviderJobState[] = []
    for (const entry of entries.values()) {
      if (entry.providerId !== providerId) continue
      out.push({
        id: entry.decl.id,
        busy: entry.pending,
        ...(entry.lastRunAt !== undefined ? { lastRunAt: entry.lastRunAt } : {}),
        ...(entry.lastResult !== undefined ? { lastResult: entry.lastResult } : {}),
        ...(entry.dueAt !== Infinity ? { nextRunAt: entry.dueAt } : {}),
        ...(entry.lastManualAt !== undefined ? { manualFrom: entry.lastManualAt + PROVIDER_JOB_MANUAL_GAP_MS } : {}),
      })
    }
    return out
  }

  function dispose(): void {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    entries.clear()
    seen.clear()
    sourceOf.clear()
    for (const controller of running) controller.abort()
    for (const item of queue.splice(0)) settle(item, { status: 'refused', reason: 'unknown_job' })
  }

  return { sync, runNow, requestRun, states, dispose }
}

// ── the realm's scheduler ──

let installed: ProviderJobScheduler | undefined

/** Install (or, with undefined, remove) the scheduler; the one before is disposed. */
export function setProviderJobScheduler(next: ProviderJobScheduler | undefined): void {
  installed?.dispose()
  installed = next
}

/**
 * Run a provider's declared job now. `providerId` is the registered id
 * (`mod.<plugin>.<key>`). Security: only a job the provider's manifest
 * declares can be named; an unknown one is refused, and nothing else of the
 * module can be reached through this.
 */
export function runProviderJobNow(providerId: string, jobId: string): Promise<ProviderJobRunResult> {
  return installed ? installed.runNow(providerId, jobId) : Promise.resolve({ status: 'refused', reason: 'unknown_job' })
}

/** The declared jobs of a provider as the scheduler holds them now. */
export function providerJobStates(providerId: string): ProviderJobState[] {
  return installed ? installed.states(providerId) : []
}
