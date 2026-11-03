/**
 * Contract: The realm's model egress masking state (F-39): the rule table from
 * settings.json, compiled, the log, and the per-stream sessions the driver
 * stream host opens. Masking is the user's, not a session's: one holder per
 * realm. `configure` takes effect for the next stream; a stream keeps the
 * table it opened with. A table that fails validation is never used, in part
 * or whole: masking stays off and `status().problem` says why.
 */
import type { BridgeModelRequestPayload } from '../../browser/bridge/browserBridgeProtocol'
import { setRawProviderEgressCheck } from '../../browser/bridge/rawProviderStream'
import type { DriverStreamEvent } from '../drivers/driverTypes'
import type { NexusModelMaskingSettings } from '../../settings/settingsTypes'
import { findEgressResidual, MaskingResidualError } from './egressGuard'
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

export type MaskingStatus = {
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
  lastError?: string
}

export type MaskingStreamMeta = { streamId: string; provider: string; model: string }

/** One stream's masking: its payload copy, its restore filter, its log lines. */
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
  private compiled: CompiledMasking | undefined
  private problem: MaskingRuleProblem | undefined
  private lastError: string | undefined
  private writer: MaskingLogWriter | undefined
  private pending: Promise<void> | undefined
  private readonly listeners = new Set<(status: MaskingStatus) => void>()

  /** Applies the `modelMasking` section. Returns the table's problem, if any. */
  configure(settings: NexusModelMaskingSettings | undefined): MaskingRuleProblem | undefined {
    const next = settings ?? {}
    const wasActive = this.compiled !== undefined
    const rulesChanged = JSON.stringify(next.rules ?? []) !== JSON.stringify(this.settings.rules ?? [])
    this.settings = next
    this.lastError = undefined
    const validated = validateMaskingRules(next.rules ?? [])
    this.problem = validated.ok ? undefined : validated.problem
    const usable = validated.ok && validated.rules.length > 0
    this.compiled = next.enabled === true && usable ? compileMasking(validated.ok ? validated.rules : []) : undefined
    setRawProviderEgressCheck(this.compiled ? request => this.checkEgress(request) : undefined)
    // Logged whenever requests start using a table: turned on, or replaced.
    if (this.compiled && (rulesChanged || !wasActive)) {
      this.log([{ ts_ms: Date.now(), event: 'rules_set', count: this.compiled.rules.length }])
    }
    this.notify()
    return this.problem
  }

  /** Reads the settings once, asynchronously; streams opened meanwhile wait. */
  load(read: () => Promise<NexusModelMaskingSettings | undefined>): Promise<void> {
    const pending = read().then(
      settings => {
        this.configure(settings)
      },
      error => {
        this.setError(error instanceof Error ? error.message : String(error))
      },
    ).finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
    this.pending = pending
    return pending
  }

  /** Pending first read, if any. */
  whenLoaded(): Promise<void> | undefined {
    return this.pending
  }

  setLogSink(sink: MaskingLogSink | undefined): void {
    this.writer = sink ? new MaskingLogWriter(sink, message => this.setError(message)) : undefined
  }

  status(): MaskingStatus {
    const rules = this.settings.rules ?? []
    return {
      enabled: this.settings.enabled === true,
      active: this.compiled !== undefined,
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

  openStream(meta: MaskingStreamMeta): MaskingStream | undefined {
    if (!this.compiled) return undefined
    return new MaskingStream(this, this.compiled, meta, this.settings.logDetail ?? 'counts')
  }

  /** Appends lines to the log, when a path and a sink are set. */
  log(lines: readonly LogFields[]): void {
    const path = this.settings.logPath
    if (!path || !this.writer || lines.length === 0) return
    void this.writer.append(path, lines.map(formatLogLine).join(''))
  }

  private checkEgress(request: Parameters<typeof findEgressResidual>[1]): void {
    const compiled = this.compiled
    if (!compiled) return
    const residual = findEgressResidual(compiled, request)
    if (!residual) return
    this.log([{ ts_ms: Date.now(), event: 'refused', where: residual.where, rule: residual.rule + 1 }])
    throw new MaskingResidualError(residual)
  }

  private setError(message: string): void {
    this.lastError = message
    this.notify()
  }

  private notify(): void {
    const status = this.status()
    for (const listener of [...this.listeners]) listener(status)
  }
}

/** The realm's one holder. */
export const modelMasking = new ModelMaskingHolder()
