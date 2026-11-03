/**
 * Contract: The realm's model egress masking state (F-39): the rule table from
 * settings.json, compiled, the log, and the per-stream sessions the driver
 * stream host opens. Masking is the user's, not a session's: one holder per
 * realm. `configure` takes effect for the next stream; a stream keeps the
 * table it opened with, and its egress check uses that table.
 *
 * Security: masking fails closed. Until the first settings read completes the
 * state is `unknown`; a read that fails is retried and the state stays
 * `unknown`. While the state is `unknown`, or masking is turned on with a
 * table that is empty or fails validation, every model request is refused
 * (`MaskingUnavailableError`) and nothing is sent. Only `off` and `active`
 * let requests through.
 */
import type { BridgeModelRequestPayload } from '../../browser/bridge/browserBridgeProtocol'
import { setRawProviderEgressCheck, type RawProviderStreamRequest } from '../../browser/bridge/rawProviderStream'
import type { DriverStreamEvent } from '../drivers/driverTypes'
import type { NexusModelMaskingSettings } from '../../settings/settingsTypes'
import {
  findEgressResidual,
  MaskingResidualError,
  MaskingUnavailableError,
  type EgressRequest,
} from './egressGuard'
import { formatLogLine, MaskingLogWriter, type LogFields, type MaskingLogSink } from './maskingLog'
import {
  compileMasking,
  validateMaskingRules,
  type CompiledMasking,
  type MaskingRule,
  type MaskingRuleProblem,
} from './maskingRules'
import { maskPayload, MaskingTally, PayloadMasker } from './maskPayload'
import { createRestoreFilter, type RestoreFilter } from './restoreStream'

export type MaskingLogDetail = 'counts' | 'context'

/**
 * `unknown`: the settings have not been read (yet). `off`: masking is turned
 * off. `active`: requests are masked. `broken`: masking is turned on but its
 * table is empty or invalid.
 */
export type MaskingState = 'unknown' | 'off' | 'active' | 'broken'

export type MaskingStatus = {
  state: MaskingState
  /** What settings.json asks for. */
  enabled: boolean
  /** Whether requests are being masked now. */
  active: boolean
  ruleCount: number
  logPath?: string
  logDetail: MaskingLogDetail
  /** Why an enabled table is not in use. */
  problem?: MaskingRuleProblem
  /** The last failure to read the settings or write the log. */
  lastError?: MaskingError
}

/** A failure, by reason; `detail` is the system's own message, if any. */
export type MaskingError = {
  reason: 'settingsUnreadable' | 'hostDisconnected' | 'cannotRename' | 'other'
  detail?: string
}

/** Thrown by a log sink for a failure the user is told about by reason. */
export class MaskingHostError extends Error {
  constructor(readonly reason: 'hostDisconnected' | 'cannotRename') {
    super(reason)
    this.name = 'MaskingHostError'
  }
}

function maskingErrorOf(error: unknown): MaskingError {
  if (error instanceof MaskingHostError) return { reason: error.reason }
  return { reason: 'other', detail: error instanceof Error ? error.message : String(error) }
}

export type MaskingStreamMeta = { streamId: string; provider: string; model: string }

/** Delay before a failed settings read is tried again. */
export const MASKING_READ_RETRY_MS = 5_000

/** The preset User-Agent the host would fill in for a provider, if any. */
export type PresetUserAgentOf = (providerId: string) => string | undefined

/**
 * `request` with its User-Agent masked. The host fills a provider's preset
 * User-Agent only when the request has none, out of the guard's sight, so
 * with masking on the request always carries one explicitly.
 */
export function withMaskedUserAgent<T extends { headers?: Record<string, string> }>(
  request: T,
  masking: CompiledMasking,
  preset: string | undefined,
): T {
  const headers = request.headers ?? {}
  const name = Object.keys(headers).find(header => header.toLowerCase() === 'user-agent')
  const current = name !== undefined ? headers[name]! : preset
  if (!current) return request
  const masked = masking.maskText(current).text
  if (name !== undefined && masked === current) return request
  return { ...request, headers: { ...headers, [name ?? 'user-agent']: masked } }
}

/** One stream's masking: its payload copy, its restore filter, its guard, its log lines. */
export class MaskingStream {
  private readonly outTally: MaskingTally
  private readonly inHits = new Map<string, Map<number, number>>()
  readonly restore: RestoreFilter
  private closed = false

  constructor(
    private readonly holder: ModelMaskingHolder,
    readonly masking: CompiledMasking,
    private readonly meta: MaskingStreamMeta,
    logDetail: MaskingLogDetail,
  ) {
    this.outTally = new MaskingTally(logDetail === 'context')
    this.restore = createRestoreFilter(masking, (where, rule) => {
      const byRule = this.inHits.get(where) ?? new Map<number, number>()
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1)
      this.inHits.set(where, byRule)
    })
  }

  maskPayload(payload: BridgeModelRequestPayload): BridgeModelRequestPayload {
    return maskPayload(payload, new PayloadMasker(this.masking, this.outTally))
  }

  /** A header or other single value, masked. */
  maskValue(value: string): string {
    return this.masking.maskText(value).text
  }

  /** Throws `MaskingResidualError` when `request` still holds a match of
   *  this stream's table. */
  checkEgress(request: EgressRequest): void {
    this.holder.refuseResidual(this.masking, request)
  }

  restoreEvents(events: DriverStreamEvent[]): DriverStreamEvent[] {
    return this.restore.apply(events)
  }

  /** Writes this stream's lines once. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const now = Date.now()
    const base = { ts_ms: now, stream: this.meta.streamId, provider: this.meta.provider, model: this.meta.model }
    const lines: LogFields[] = []
    for (const [where, byRule] of this.outTally.hits) {
      for (const [rule, n] of byRule) lines.push({ ...base, dir: 'out', rule: rule + 1, n, where })
    }
    for (const where of this.outTally.collisions) {
      lines.push({ ts_ms: now, stream: this.meta.streamId, event: 'collision', where })
    }
    for (const entry of this.outTally.contexts ?? []) {
      lines.push({ ts_ms: now, stream: this.meta.streamId, dir: 'out', rule: entry.rule + 1, where: entry.where, ctx: entry.context })
    }
    for (const [where, byRule] of this.inHits) {
      for (const [rule, n] of byRule) lines.push({ ...base, dir: 'in', rule: rule + 1, n, where })
    }
    this.holder.log(lines)
  }
}

export class ModelMaskingHolder {
  private settings: NexusModelMaskingSettings = {}
  private state: MaskingState = 'unknown'
  private compiled: CompiledMasking | undefined
  private problem: MaskingRuleProblem | undefined
  private lastError: MaskingError | undefined
  private writer: MaskingLogWriter | undefined
  private pending: Promise<void> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<(status: MaskingStatus) => void>()
  private readonly waiters = new Set<() => void>()
  private presetUserAgentOf: PresetUserAgentOf = () => undefined

  constructor() {
    this.installEgressCheck()
  }

  /** How to find the preset User-Agent the host would add for a provider. */
  setPresetUserAgentResolver(resolve: PresetUserAgentOf): void {
    this.presetUserAgentOf = resolve
  }

  /** The preset User-Agent for `providerId`, as the host would send it. */
  presetUserAgent(providerId: string): string | undefined {
    return this.presetUserAgentOf(providerId)
  }

  /** Applies the `modelMasking` section. Returns the table's problem, if any. */
  configure(settings: NexusModelMaskingSettings | undefined): MaskingRuleProblem | undefined {
    const next = settings ?? {}
    const wasActive = this.state === 'active'
    const rulesChanged = JSON.stringify(next.rules ?? []) !== JSON.stringify(this.settings.rules ?? [])
    this.settings = next
    this.lastError = undefined
    this.cancelRetry()
    const validated = validateMaskingRules(next.rules ?? [])
    this.problem = validated.ok ? undefined : validated.problem
    if (next.enabled !== true) {
      this.state = 'off'
      this.compiled = undefined
    } else if (validated.ok && validated.rules.length > 0) {
      this.state = 'active'
      this.compiled = compileMasking(validated.rules)
    } else {
      this.state = 'broken'
      this.compiled = undefined
    }
    // Logged whenever requests start using a table: turned on, or replaced.
    if (this.compiled && (rulesChanged || !wasActive)) {
      this.log([{ ts_ms: Date.now(), event: 'rules_set', count: this.compiled.rules.length }])
    }
    this.settle()
    return this.problem
  }

  /**
   * Reads the settings; streams opened meanwhile wait. `read` resolving to
   * `'unreadable'` or rejecting leaves the state `unknown` and tries again
   * after `MASKING_READ_RETRY_MS`; `undefined` means the file holds no section.
   */
  load(read: () => Promise<NexusModelMaskingSettings | undefined | 'unreadable'>): Promise<void> {
    this.cancelRetry()
    const pending = read().then(
      settings => {
        if (settings === 'unreadable') this.readFailed(read, { reason: 'settingsUnreadable' })
        else this.configure(settings)
      },
      error => this.readFailed(read, maskingErrorOf(error)),
    ).finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
    this.pending = pending
    return pending
  }

  /** Resolves once the state is known (anything but `unknown`), or when
   *  `signal` aborts. */
  whenKnown(signal?: AbortSignal): Promise<void> {
    if (this.state !== 'unknown' || signal?.aborted) return Promise.resolve()
    return new Promise<void>(resolve => {
      const done = () => {
        this.waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  setLogSink(sink: MaskingLogSink | undefined): void {
    this.writer = sink ? new MaskingLogWriter(sink, error => this.setError(maskingErrorOf(error))) : undefined
  }

  status(): MaskingStatus {
    const rules = this.settings.rules ?? []
    return {
      state: this.state,
      enabled: this.settings.enabled === true,
      active: this.state === 'active',
      ruleCount: rules.length,
      ...(this.settings.logPath ? { logPath: this.settings.logPath } : {}),
      logDetail: this.settings.logDetail ?? 'counts',
      ...(this.problem ? { problem: this.problem } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  /** The rules settings.json holds, whether in use or not. */
  savedRules(): MaskingRule[] {
    return [...(this.settings.rules ?? [])]
  }

  /** The table requests use now, if masking is active. */
  current(): CompiledMasking | undefined {
    return this.compiled
  }

  onChange(listener: (status: MaskingStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * The masking a new stream uses: a session when active, `undefined` when
   * off. Throws `MaskingUnavailableError` while the state is `unknown` or
   * `broken`, so the stream sends nothing.
   */
  openStream(meta: MaskingStreamMeta): MaskingStream | undefined {
    if (this.state === 'off') return undefined
    if (this.state === 'active' && this.compiled) {
      return new MaskingStream(this, this.compiled, meta, this.settings.logDetail ?? 'counts')
    }
    throw this.unavailable()
  }

  /** Appends lines to the log, when a path and a sink are set. */
  log(lines: readonly LogFields[]): void {
    const path = this.settings.logPath
    if (!path || !this.writer || lines.length === 0) return
    void this.writer.append(path, lines.map(formatLogLine).join(''))
  }

  /** Throws `MaskingResidualError` (and logs it) when `request` still holds
   *  a match of `masking`. */
  refuseResidual(masking: CompiledMasking, request: EgressRequest): void {
    const residual = findEgressResidual(masking, request)
    if (!residual) return
    this.log([{ ts_ms: Date.now(), event: 'refused', where: residual.where, rule: residual.rule + 1 }])
    throw new MaskingResidualError(residual)
  }

  /** Test hook: back to the state before any read. */
  resetForTest(): void {
    this.cancelRetry()
    this.settings = {}
    this.state = 'unknown'
    this.compiled = undefined
    this.problem = undefined
    this.lastError = undefined
    this.pending = undefined
    this.writer = undefined
  }

  private unavailable(): MaskingUnavailableError {
    return new MaskingUnavailableError(this.state === 'broken' ? 'broken' : 'unknown')
  }

  /** The check every raw provider request passes, set once: requests other
   *  than a driver stream's (documents, mod fetches) see the current table,
   *  and carry an explicit masked User-Agent. */
  private installEgressCheck(): void {
    setRawProviderEgressCheck((request): RawProviderStreamRequest | void => {
      if (request.masking === 'stream') return
      if (this.state === 'off') return
      if (this.state === 'active' && this.compiled) {
        const sent = withMaskedUserAgent(request, this.compiled, this.presetUserAgent(request.providerId))
        this.refuseResidual(this.compiled, sent)
        return sent
      }
      throw this.unavailable()
    })
  }

  private readFailed(
    read: () => Promise<NexusModelMaskingSettings | undefined | 'unreadable'>,
    error: MaskingError,
  ): void {
    if (this.state === 'unknown') {
      this.cancelRetry()
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        if (this.state === 'unknown') void this.load(read)
      }, MASKING_READ_RETRY_MS)
    }
    this.setError(error)
  }

  private cancelRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private settle(): void {
    if (this.state !== 'unknown') for (const waiter of [...this.waiters]) waiter()
    this.notify()
  }

  private setError(error: MaskingError): void {
    this.lastError = error
    this.notify()
  }

  private notify(): void {
    const status = this.status()
    for (const listener of [...this.listeners]) listener(status)
  }
}

/** The realm's one holder. */
export const modelMasking = new ModelMaskingHolder()
