/**
 * DiagnosticsHub — trace subscriber registry and trace / worker-log fanout. Source subscriptions
 * install on the FIRST subscriber and tear down with the LAST, through every removal path.
 */

export type TraceSubscriberEntry = {
  port: MessagePort
  traceId?: string
}

/** The ring-buffer sources the hub subscribes to while it has listeners. */
export type DiagnosticsSources = {
  subscribeTrace(handler: (record: unknown) => void): () => void
  subscribeWorkerLog(handler: (entry: unknown) => void): () => void
}

export class DiagnosticsHub {
  private readonly traceSubscribers = new Map<MessagePort, string | undefined>()
  private sources: DiagnosticsSources | null = null
  private tracerUnsubscribe: (() => void) | null = null
  private workerLogUnsubscribe: (() => void) | null = null

  /** Wire the ring-buffer sources (once, at Manager construction). */
  attachSources(sources: DiagnosticsSources): void {
    this.sources = sources
  }

  subscribeTrace(port: MessagePort, traceId?: string): void {
    this.traceSubscribers.set(port, traceId)
    this.ensureSourcesInstalled()
  }

  unsubscribeTrace(port: MessagePort): void {
    this.traceSubscribers.delete(port)
    this.teardownSourcesIfIdle()
  }

  private ensureSourcesInstalled(): void {
    if (!this.sources) return
    if (!this.tracerUnsubscribe) {
      this.tracerUnsubscribe = this.sources.subscribeTrace(record =>
        this.fanoutTraceRecord(record),
      )
    }
    if (!this.workerLogUnsubscribe) {
      this.workerLogUnsubscribe = this.sources.subscribeWorkerLog(entry =>
        this.fanoutWorkerLog(entry),
      )
    }
  }

  private teardownSourcesIfIdle(): void {
    if (this.traceSubscribers.size > 0) return
    this.tracerUnsubscribe?.()
    this.tracerUnsubscribe = null
    this.workerLogUnsubscribe?.()
    this.workerLogUnsubscribe = null
  }

  fanoutTraceRecord(record: unknown): void {
    for (const [port, filterTraceId] of this.traceSubscribers) {
      // If the subscriber specified a traceId filter, only forward matching records.
      if (filterTraceId) {
        const recordTraceId = (record as { traceId?: string })?.traceId
        if (recordTraceId !== filterTraceId) continue
      }
      try {
        port.postMessage({ type: 'trace.record', payload: { record } })
      } catch {
        // Port closed; cleanup on disconnect.
      }
    }
  }

  fanoutWorkerLog(entry: unknown): void {
    for (const [port] of this.traceSubscribers) {
      try {
        port.postMessage({ type: 'worker.log', payload: { entry } })
      } catch {
        // Port closed.
      }
    }
  }

  removePort(port: MessagePort): void {
    this.traceSubscribers.delete(port)
    this.teardownSourcesIfIdle()
  }

  get subscriberCount(): number {
    return this.traceSubscribers.size
  }

  dispose(): void {
    this.tracerUnsubscribe?.()
    this.tracerUnsubscribe = null
    this.workerLogUnsubscribe?.()
    this.workerLogUnsubscribe = null
    this.traceSubscribers.clear()
  }
}
