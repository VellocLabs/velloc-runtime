import { describe, expect, it } from 'vitest'
import {
  installSessionTracer,
  formatTraceTable,
} from '../utils/sessionTrace'

// `installSessionTracer` is module-scoped — once installed, subsequent calls
// return the same instance. To get a clean tracer per test, we reset the
// module via `vi.resetModules()` and re-import. Vitest's worker process is
// shared across tests in this file, but each `it` block gets its own
// imports here.

describe('SessionTracer', () => {
  // Collection is OPT-IN: the tracer ships disabled and each realm's debug
  // gate turns it on (page: installModelUploadTracer; worker:
  // applyDiagnosticGates). A user who never enables debugging must retain
  // nothing in memory.
  it('collects NOTHING by default — span/event are no-ops until enabled', async () => {
    const { installSessionTracer: install } = await freshTracerModule()
    const tracer = install({ context: 'ui' })
    const span = tracer.span('ignored.span')
    span.end()
    tracer.event('ignored.event')
    expect(tracer.isEnabled()).toBe(false)
    expect(tracer.drain()).toEqual([])
  })

  it('setEnabled(false) drops already-collected records (releases memory)', async () => {
    const { installSessionTracer: install } = await freshTracerModule()
    const tracer = install({ context: 'ui' })
    tracer.setEnabled(true)
    tracer.event('collected-while-on')
    expect(tracer.drain()).toHaveLength(1)
    tracer.setEnabled(false)
    expect(tracer.drain()).toEqual([])
  })

  it('records a span with start + duration', async () => {
    const { installSessionTracer: install } = await freshTracerModule()
    const tracer = install({ context: 'ui' })
    tracer.setEnabled(true)
    const span = tracer.span('test.span', { attrs: { x: 1 } })
    await tinyDelay()
    span.end({ y: 2 })

    const records = tracer.drain()
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.name).toBe('test.span')
    expect(record.context).toBe('ui')
    expect(record.durationMs).toBeGreaterThan(0)
    expect(record.attrs).toEqual({ x: 1, y: 2 })
  })

  it('records an instantaneous event without a duration', async () => {
    const { installSessionTracer: install } = await freshTracerModule()
    const tracer = install({ context: 'worker' })
    tracer.setEnabled(true)
    tracer.event('test.event', { attrs: { ok: true } })

    const records = tracer.drain()
    expect(records).toHaveLength(1)
    expect(records[0]!.name).toBe('test.event')
    expect(records[0]!.durationMs).toBeUndefined()
    expect(records[0]!.attrs).toEqual({ ok: true })
  })

  it('propagates traceId across nested spans when caller threads it', async () => {
    const { installSessionTracer: install } = await freshTracerModule()
    const tracer = install({ context: 'ui' })
    tracer.setEnabled(true)
    const root = tracer.span('root')
    const child = tracer.span('child', {
      traceId: root.traceId,
      parentSpanId: root.spanId,
    })
    child.end()
    root.end()

    const records = tracer.drain()
    expect(new Set(records.map(r => r.traceId)).size).toBe(1)
    const childRec = records.find(r => r.name === 'child')!
    expect(childRec.parentSpanId).toBe(root.spanId)
  })

  it('streams new records to subscribers', async () => {
    const { installSessionTracer: install } = await freshTracerModule()
    const tracer = install({ context: 'ui' })
    tracer.setEnabled(true)
    const seen: string[] = []
    const unsub = tracer.subscribe(r => seen.push(r.name))

    tracer.event('a')
    const span = tracer.span('b')
    span.end()
    unsub()
    tracer.event('c-not-streamed')

    expect(seen).toEqual(['a', 'b'])
  })

  it('evicts the oldest record when the ring fills', async () => {
    const { installSessionTracer: install } = await freshTracerModule()
    const tracer = install({ context: 'worker', bufferSize: 3 })
    tracer.setEnabled(true)
    tracer.event('one')
    tracer.event('two')
    tracer.event('three')
    tracer.event('four')

    const names = tracer.drain().map(r => r.name)
    // 'one' should have been evicted — buffer holds 3 newest.
    expect(names).toEqual(['two', 'three', 'four'])
  })

  it('formatTraceTable renders empty input as []', () => {
    expect(formatTraceTable([])).toEqual([])
  })

  it('formatTraceTable computes offsets relative to the earliest span', async () => {
    const { installSessionTracer: install } = await freshTracerModule()
    const tracer = install({ context: 'ui' })
    tracer.setEnabled(true)
    tracer.event('first')
    await tinyDelay()
    tracer.event('second')

    const formatted = formatTraceTable(tracer.drain())
    expect(formatted).toHaveLength(2)
    expect(formatted[0]!['offset (ms)']).toBe('0.00')
    expect(parseFloat(formatted[1]!['offset (ms)'])).toBeGreaterThan(0)
  })
})

describe('trace overlay model uploads', () => {
  it('filters the Model-JSON list to the current session', async () => {
    const { filterModelUploadsForSession } = await import('../utils/traceOverlay')
    const uploads = [
      makeModelUpload(1, 'session-a'),
      makeModelUpload(2, 'session-b'),
      makeModelUpload(3, 'session-a'),
    ]

    expect(filterModelUploadsForSession(uploads, 'session-a').map(u => u.index))
      .toEqual([1, 3])
    expect(filterModelUploadsForSession(uploads, null).map(u => u.index))
      .toEqual([1, 2, 3])
  })

  it('keeps a manually selected upload while new current-session uploads arrive', async () => {
    const { resolveModelUploadSelection } = await import('../utils/traceOverlay')
    const uploads = [
      makeModelUpload(1, 'session-a'),
      makeModelUpload(2, 'session-a'),
    ]

    expect(resolveModelUploadSelection(uploads, 1, 'session-a', true)).toBe(1)
    uploads.push(makeModelUpload(3, 'session-a'))
    expect(resolveModelUploadSelection(uploads, 1, 'session-a', true)).toBe(1)
    expect(resolveModelUploadSelection(uploads, 1, 'session-a', false)).toBe(3)
  })

  it('resolves selection against the newly active session', async () => {
    const { resolveModelUploadSelection } = await import('../utils/traceOverlay')
    const uploads = [
      makeModelUpload(1, 'session-a'),
      makeModelUpload(2, 'session-b'),
    ]

    expect(resolveModelUploadSelection(uploads, 1, 'session-b', true)).toBe(2)
  })
})

async function freshTracerModule() {
  // Force the module to re-evaluate so `activeTracer` resets to null and the
  // test gets its own SessionTracer instance.
  const { vi } = await import('vitest')
  vi.resetModules()
  return import('../utils/sessionTrace')
}

function tinyDelay(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 1))
}

function makeModelUpload(index: number, sessionId: string) {
  return {
    trace: 'NexusTrace' as const,
    scope: 'ModelUpload' as const,
    event: 'request' as const,
    index,
    timestamp: `2026-06-28T00:00:0${index}.000Z`,
    sessionId,
    querySource: 'sdk',
    messageCount: 1,
    toolCount: 0,
    payloadLength: 2,
    payload: {},
  }
}

// Force `installSessionTracer` to be referenced from the static import too,
// so eslint and the type-checker keep the import alive even though every
// test re-imports via `freshTracerModule()`.
void installSessionTracer
