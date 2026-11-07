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
  HOST_PLACEHOLDER,
  MaskingResidualError,
  MaskingUnavailableError,
  type EgressRequest,
} from './egressGuard'
import { formatLogLine, MaskingLogWriter, type MaskingLogSink } from './maskingLog'
import {
  compileMasking,
  validateMaskingRules,
  type CompiledMasking,
  type MaskingRuleProblem,
} from './maskingRules'
import { maskPayload, PayloadMasker } from './maskPayload'
import { createRestoreFilter, type RestoreFilter } from './restoreStream'
import type { ReplacementEntry } from './replacementTrace'

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
  /** Why an enabled table is not in use. */
  problem?: MaskingRuleProblem
  /** The last failure to read the settings or write the log. */
  lastError?: MaskingError
}

/** A failure, by reason; `detail` is the system's own message, if any. */
export type MaskingError = {
  reason: 'settingsUnreadable' | 'hostDisconnected' | 'other'
  detail?: string
}

/** Thrown by a log sink for a failure the user is told about by reason. */
export class MaskingHostError extends Error {
  constructor(readonly reason: 'hostDisconnected') {
    super(reason)
    this.name = 'MaskingHostError'
  }
}

function maskingErrorOf(error: unknown): MaskingError {
  if (error instanceof MaskingHostError) return { reason: error.reason }
  return { reason: 'other', detail: error instanceof Error ? error.message : String(error) }
}

/** Delay before a failed settings read is tried again. */
export const MASKING_READ_RETRY_MS = 5_000

/** Longest a stream waits for the state to become known before it is refused
 *  as `unknown`; well inside a stream's idle budget. */
export const MASKING_KNOWN_WAIT_MS = 20_000

/** Longest a stream waits for the settings to be read again before it goes
 *  on with the state it has. */
export const MASKING_REFRESH_WAIT_MS = 2_000

type MaskingSettingsRead = () => Promise<NexusModelMaskingSettings | undefined | 'unreadable'>

/** The preset User-Agent the host would fill in for a provider, if any. */
export type PresetUserAgentOf = (providerId: string) => string | undefined

/** `value` masked outside its host-side placeholders. */
function maskOutsidePlaceholders(value: string, masking: CompiledMasking): string {
  let out = ''
  let last = 0
  for (const placeholder of value.matchAll(HOST_PLACEHOLDER)) {
    out += masking.maskText(value.slice(last, placeholder.index), undefined, false).text + placeholder[0]
    last = placeholder.index + placeholder[0].length
  }
  return out + masking.maskText(value.slice(last), undefined, false).text
}

function maskValues(values: Record<string, string>, masking: CompiledMasking): Record<string, string> | undefined {
  let changed = false
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    out[name] = maskOutsidePlaceholders(value, masking)
    if (out[name] !== value) changed = true
  }
  return changed ? out : undefined
}

/** `request` with every header value and query value masked; names are kept. */
export function withMaskedValues<T extends { headers?: Record<string, string>; queryParams?: Record<string, string> }>(
  request: T,
  masking: CompiledMasking,
): T {
  const maskedHeaders = request.headers ? maskValues(request.headers, masking) : undefined
  const maskedQuery = request.queryParams ? maskValues(request.queryParams, masking) : undefined
  if (!maskedHeaders && !maskedQuery) return request
  return {
    ...request,
    ...(maskedHeaders ? { headers: maskedHeaders } : {}),
    ...(maskedQuery ? { queryParams: maskedQuery } : {}),
  }
}

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
  /** The replacements made in the payload, until the request passes the egress check. */
  private readonly pending: ReplacementEntry[] = []
  readonly restore: RestoreFilter
  private closed = false

  constructor(
    private readonly holder: ModelMaskingHolder,
    readonly masking: CompiledMasking,
  ) {
    this.restore = createRestoreFilter(masking)
  }

  /** Masks `payload`; the replacements are logged once the request passes `checkEgress`. */
  maskPayload(payload: BridgeModelRequestPayload): BridgeModelRequestPayload {
    return maskPayload(payload, new PayloadMasker(this.masking, this.pending))
  }

  /** A header or other single value, masked. */
  maskValue(value: string): string {
    return this.masking.maskText(value).text
  }

  /** Throws `MaskingResidualError` when `request` still holds a match of
   *  this stream's table; otherwise logs the replacements made for it. */
  checkEgress(request: EgressRequest): void {
    this.holder.refuseResidual(this.masking, request)
    this.holder.logOut(this.pending.splice(0))
  }

  restoreEvents(events: DriverStreamEvent[]): DriverStreamEvent[] {
    return this.restore.apply(events)
  }

  /** Writes what came back, once. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.holder.log(this.restore.entries())
  }
}

export class ModelMaskingHolder {
  private settings: NexusModelMaskingSettings = {}
  private state: MaskingState = 'unknown'
  private compiled: CompiledMasking | undefined
  private problem: MaskingRuleProblem | undefined
  private lastError: MaskingError | undefined
  private writer: MaskingLogWriter | undefined
  private lastOut = new Set<string>()
  private pending: Promise<void> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  /** Bumped by every `configure` and reset: a read that started before it is stale. */
  private generation = 0
  private readonly listeners = new Set<(status: MaskingStatus) => void>()
  private readonly waiters = new Set<() => void>()
  private presetUserAgentOf: PresetUserAgentOf = () => undefined
  private reader: MaskingSettingsRead | undefined
  /** The settings re-read in flight; streams that start meanwhile share it. */
  private refreshing: Promise<void> | undefined

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
    this.settings = next
    this.generation += 1
    this.lastOut = new Set()
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
    this.settle()
    return this.problem
  }

  /**
   * Reads the settings; streams opened meanwhile wait. `read` resolving to
   * `'unreadable'` or rejecting leaves the state `unknown` and tries again
   * after `MASKING_READ_RETRY_MS`; `undefined` means the file holds no section.
   * A read that lands after a `configure` (a `/masking` change) is dropped.
   */
  load(read: MaskingSettingsRead): Promise<void> {
    this.reader = read
    this.cancelRetry()
    const generation = this.generation
    const pending = read().then(
      settings => {
        if (generation !== this.generation) return
        if (settings === 'unreadable') this.readFailed(read, { reason: 'settingsUnreadable' })
        else this.configure(settings)
      },
      error => {
        if (generation === this.generation) this.readFailed(read, maskingErrorOf(error))
      },
    ).finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
    this.pending = pending
    return pending
  }

  /**
   * Reads the settings again, so an edit of settings.json (the section
   * removed, turned off or changed) applies to the next stream. The table is
   * recompiled only when the section differs. One read at a time: a call made
   * while one is in flight waits for that read. Resolves when the read is
   * applied, when `signal` aborts, or after `timeoutMs`; a read still running
   * then is applied when it lands, unless a `configure` came first. A read
   * that fails leaves the state as it is.
   */
  async refresh(signal?: AbortSignal, timeoutMs: number = MASKING_REFRESH_WAIT_MS): Promise<void> {
    const read = this.reader
    if (!read || this.state === 'unknown' || signal?.aborted) return
    if (!this.refreshing) {
      const generation = this.generation
      const reading: Promise<void> = read().then(
        settings => {
          if (settings === 'unreadable' || generation !== this.generation) return
          if (JSON.stringify(settings ?? {}) === JSON.stringify(this.settings)) return
          this.configure(settings)
        },
        () => undefined,
      ).finally(() => {
        if (this.refreshing === reading) this.refreshing = undefined
      })
      this.refreshing = reading
    }
    const reading = this.refreshing
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    await Promise.race([
      reading,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs)
        onAbort = () => resolve()
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }

  /** Resolves once the state is known (anything but `unknown`), when
   *  `signal` aborts, or after `timeoutMs`; the caller then reads the state. */
  whenKnown(signal?: AbortSignal, timeoutMs: number = MASKING_KNOWN_WAIT_MS): Promise<void> {
    if (this.state !== 'unknown' || signal?.aborted) return Promise.resolve()
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => done(), timeoutMs)
      const done = () => {
        clearTimeout(timer)
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
    const rules = this.settings.rules
    return {
      state: this.state,
      enabled: this.settings.enabled === true,
      active: this.state === 'active',
      ruleCount: Array.isArray(rules) ? rules.length : 0,
      ...(this.settings.logPath ? { logPath: this.settings.logPath } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  /** The rules settings.json holds, as written (any JSON), whether in use or not. */
  savedRules(): unknown {
    return structuredClone(this.settings.rules ?? [])
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
  openStream(): MaskingStream | undefined {
    if (this.state === 'off') return undefined
    if (this.state === 'active' && this.compiled) return new MaskingStream(this, this.compiled)
    throw this.unavailable()
  }

  /** Appends the entries to the log, when a path and a sink are set. */
  log(entries: readonly ReplacementEntry[]): void {
    const path = this.settings.logPath
    if (!path || !this.writer || entries.length === 0) return
    void this.writer.append(path, entries.map(formatLogLine))
  }

  /** Logs the replacements of a request that is about to be sent, except those
   *  the previous request already had (the history is masked again each turn). */
  logOut(entries: readonly ReplacementEntry[]): void {
    if (entries.length === 0) return
    const keys = entries.map(entry => JSON.stringify([entry.where, entry.original, entry.replaced]))
    const previous = this.lastOut
    this.lastOut = new Set(keys)
    this.log(entries.filter((_, i) => !previous.has(keys[i]!)))
  }

  /** Throws `MaskingResidualError` when `request` still holds a match of
   *  `masking`. */
  refuseResidual(masking: CompiledMasking, request: EgressRequest): void {
    const residual = findEgressResidual(masking, request)
    if (!residual) return
    throw new MaskingResidualError(residual)
  }

  /** Test hook: back to the state before any read. */
  resetForTest(): void {
    this.cancelRetry()
    this.generation += 1
    this.settings = {}
    this.state = 'unknown'
    this.compiled = undefined
    this.problem = undefined
    this.lastError = undefined
    this.pending = undefined
    this.writer = undefined
    this.reader = undefined
    this.refreshing = undefined
    this.lastOut = new Set()
  }

  private unavailable(): MaskingUnavailableError {
    return new MaskingUnavailableError(this.state === 'broken' ? 'broken' : 'unknown')
  }

  /** The check every raw provider request passes, set once: requests other
   *  than a driver stream's (documents, mod fetches) see the current table,
   *  with their header and query values masked. */
  private installEgressCheck(): void {
    setRawProviderEgressCheck((request): RawProviderStreamRequest | void => {
      if (request.masking === 'stream') return
      if (this.state === 'off') return
      if (this.state === 'active' && this.compiled) {
        const sent = withMaskedUserAgent(
          withMaskedValues(request, this.compiled),
          this.compiled,
          this.presetUserAgent(request.providerId),
        )
        this.refuseResidual(this.compiled, sent)
        return sent
      }
      throw this.unavailable()
    })
  }

  private readFailed(
    read: MaskingSettingsRead,
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
