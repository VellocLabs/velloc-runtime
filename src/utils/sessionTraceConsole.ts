/**
 * UI-realm console helper for the session tracer: installs
 * `globalThis.__nexusTrace` with `dumpAll()` (UI + manager ring buffers, merged)
 * and `subscribe({ traceId? })`. Needs the SharedWorker port, passed once via
 * `installSessionTraceConsole({ port })`.
 */

import {
  formatTraceTable,
  getSessionTracer,
  type TraceRecord,
} from './sessionTrace'

declare global {
  // eslint-disable-next-line no-var
  var __nexusTrace: NexusTraceConsole | undefined
}

export type NexusTraceConsole = {
  dumpAll(): Promise<TraceRecord[]>
  subscribe(opts?: {
    traceId?: string
    listener?: (record: TraceRecord) => void
  }): () => void
  /**
   * Snapshot of the local UI tracer only. Synchronous. Useful when the
   * SharedWorker port isn't installed yet (e.g. before `nexusBoot`).
   */
  dumpLocal(): TraceRecord[]
}

export type InstallSessionTraceConsoleOptions = {
  port: MessagePort
  /**
   * Optional default listener for `subscribe()` calls that omit one.
   * Defaults to a colored console.debug per record.
   */
  defaultListener?: (record: TraceRecord) => void
}

const REQUEST_ID_PREFIX = 'trace-flush-'
let requestCounter = 0

function nextRequestId(): string {
  requestCounter += 1
  return `${REQUEST_ID_PREFIX}${requestCounter}-${Date.now().toString(36)}`
}

function defaultLog(record: TraceRecord): void {
  // Keep this dependency-free — no React, no devtools UI. Just a single
  // console.debug per record so the user's existing devtools filter can
  // gate it. The label is grep-friendly.
  console.debug(
    `[NexusTrace] ${record.context} ${record.name}` +
      (record.durationMs !== undefined
        ? ` ${record.durationMs.toFixed(2)}ms`
        : ''),
    record.attrs ?? '',
  )
}

export function installSessionTraceConsole(
  opts: InstallSessionTraceConsoleOptions,
): NexusTraceConsole {
  const { port } = opts
  const defaultListener = opts.defaultListener ?? defaultLog

  // Streaming subscribers maintained on the UI side (one per call to
  // `subscribe()`). Each entry has the listener fn + an optional
  // traceId filter (mirrors the server-side filter so we re-filter
  // locally too — the manager filters as a courtesy but UI is the
  // ultimate arbiter).
  type LocalSub = {
    listener: (record: TraceRecord) => void
    traceId?: string
  }
  const localSubs = new Set<LocalSub>()
  let portListenerInstalled = false
  let localTracerUnsubscribe: (() => void) | null = null

  function installPortListenerIfNeeded(): void {
    if (portListenerInstalled) return
    portListenerInstalled = true
    port.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (data?.type === 'trace.record') {
        const record = (data.payload as { record: TraceRecord }).record
        for (const sub of localSubs) {
          if (sub.traceId && sub.traceId !== record.traceId) continue
          sub.listener(record)
        }
      }
    })
    port.start()
  }

  function installLocalTracerListenerIfNeeded(): void {
    if (localTracerUnsubscribe) return
    localTracerUnsubscribe = getSessionTracer().subscribe(record => {
      for (const sub of localSubs) {
        if (sub.traceId && sub.traceId !== record.traceId) continue
        sub.listener(record)
      }
    })
  }

  const console_: NexusTraceConsole = {
    dumpLocal(): TraceRecord[] {
      return getSessionTracer().drain()
    },

    async dumpAll(): Promise<TraceRecord[]> {
      const local = getSessionTracer().drain()
      const remote = await fetchRemoteSnapshot(port)
      const merged = [...local, ...remote].sort(
        (a, b) => a.startMs - b.startMs,
      )
      // Convenience: render once for the caller. They still get the
      // raw array as the return value.
      // eslint-disable-next-line no-console
      console.table(formatTraceTable(merged))
      return merged
    },

    subscribe(subOpts): () => void {
      installPortListenerIfNeeded()
      installLocalTracerListenerIfNeeded()
      const sub: LocalSub = {
        listener: subOpts?.listener ?? defaultListener,
        traceId: subOpts?.traceId,
      }
      localSubs.add(sub)
      // Tell the manager we want pushes too (fan-out is filtered in
      // both places to be defensive).
      port.postMessage({
        type: 'trace.subscribe',
        ...(sub.traceId ? { traceId: sub.traceId } : {}),
      })
      return () => {
        localSubs.delete(sub)
        if (localSubs.size === 0) {
          port.postMessage({ type: 'trace.unsubscribe' })
          localTracerUnsubscribe?.()
          localTracerUnsubscribe = null
        }
      }
    },
  }

  globalThis.__nexusTrace = console_
  return console_
}

function fetchRemoteSnapshot(port: MessagePort): Promise<TraceRecord[]> {
  return new Promise(resolve => {
    const requestId = nextRequestId()
    let settled = false
    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      port.removeEventListener('message', handler as EventListener)
      resolve([])
    }, 2_000)

    const handler = (event: MessageEvent): void => {
      const data = event.data as Record<string, unknown> | null
      if (
        data?.type === 'trace.snapshot' &&
        (data.requestId as string | undefined) === requestId
      ) {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        port.removeEventListener('message', handler as EventListener)
        const payload = data.payload as { records?: TraceRecord[] } | undefined
        resolve(payload?.records ?? [])
      }
    }
    port.addEventListener('message', handler as EventListener)
    port.start()
    port.postMessage({ type: 'trace.flush', requestId })
  })
}
