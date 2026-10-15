/**
 * (F-24): createWebSocketTransport. A blob
 * chunk is either a native binary message or — because the C++ listener speaks
 * text only — 'B' + base64(chunk). Both forms are always accepted inbound, so
 * two ends configured differently interoperate. Sends queue while CONNECTING
 * and flush on open. The fake socket pair below mirrors the message-port
 * transport test's shape.
 */
import { describe, expect, it } from 'vitest'
import type { BlobChunkHeader, Frame } from '../browser/runtimeProtocol'
import { decodeBlobChunk, decodeFrame, encodeBlobChunk } from '../browser/runtimeProtocol'
import { base64Encode } from '../browser/runtimeProtocol/blobText'
import { createWebSocketTransport, WEB_SOCKET_TRANSPORT_LIMITS } from '../browser/runtimeTransport'

type Wire = string | ArrayBuffer

/** A minimal WebSocket stand-in: one end of an in-memory pair. */
class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  readyState = FakeSocket.CONNECTING
  bufferedAmount = 0
  binaryType: BinaryType = 'blob'
  peer: FakeSocket | null = null
  private listeners = new Map<string, Array<(e: { data?: unknown; code?: number }) => void>>()

  addEventListener(type: string, l: EventListenerOrEventListenerObject): void {
    const fn = l as (e: { data?: unknown; code?: number }) => void
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type)!.push(fn)
  }
  removeEventListener(type: string, l: EventListenerOrEventListenerObject): void {
    const fn = l as (e: { data?: unknown; code?: number }) => void
    const arr = this.listeners.get(type) ?? []
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
  emit(type: string, e: { data?: unknown; code?: number } = {}): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(e)
  }
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.emit('open')
  }
  send(data: unknown): void {
    const wire: Wire = typeof data === 'string' ? data : (data as Uint8Array).slice().buffer
    queueMicrotask(() => this.peer?.emit('message', { data: wire }))
  }
  close(code = 1000): void {
    this.readyState = 3
    this.emit('close', { code })
    queueMicrotask(() => this.peer?.emit('close', { code }))
  }
}

function socketPair(): { a: FakeSocket; b: FakeSocket } {
  const a = new FakeSocket()
  const b = new FakeSocket()
  a.peer = b
  b.peer = a
  return { a, b }
}

function collect<T>(count: number, subscribe: (push: (item: T) => void) => void): Promise<T[]> {
  return new Promise(resolve => {
    const items: T[] = []
    subscribe(item => {
      items.push(item)
      if (items.length === count) resolve(items)
    })
  })
}

const flush = () => new Promise<void>(r => setTimeout(r, 0))

describe('createWebSocketTransport', () => {
  it('declares the websocket kind and limits, sets arraybuffer binaryType', () => {
    const { a } = socketPair()
    const t = createWebSocketTransport(a)
    expect(t.kind).toBe('websocket')
    expect(t.limits).toEqual(WEB_SOCKET_TRANSPORT_LIMITS)
    expect(a.binaryType).toBe('arraybuffer')
  })

  it('queues sends while CONNECTING and flushes them in order on open', async () => {
    const { a, b } = socketPair()
    const ta = createWebSocketTransport(a)
    const received = collect<Frame>(2, push => createWebSocketTransport(b).onFrame(push))
    // Socket is still CONNECTING: handshake sends hello immediately (the real
    // RuntimeConnection does exactly this).
    ta.send({ kind: 'cancel', id: 'r1' })
    ta.send({ kind: 'cancel', id: 'r2' })
    await flush()
    a.open()
    expect(await received).toEqual([
      { kind: 'cancel', id: 'r1' },
      { kind: 'cancel', id: 'r2' },
    ])
  })

  it('counts queued bytes in bufferedBytes() alongside socket.bufferedAmount', () => {
    const { a } = socketPair()
    a.bufferedAmount = 100
    const t = createWebSocketTransport(a)
    t.send({ kind: 'cancel', id: 'queued' })   // queued (CONNECTING)
    const queued = t.bufferedBytes()
    expect(queued).toBeGreaterThan(100)
    a.open()
    return flush().then(() => {
      expect(t.bufferedBytes()).toBe(100)      // flushed; only the socket's own bytes remain
    })
  })

  it('sends a blob chunk as text (default) and as native binary; both decode identically', async () => {
    const header: BlobChunkHeader = { id: 'blob-1', index: 0, last: true }
    const bytes = new Uint8Array([0, 255, 16, 128])
    for (const encoding of ['text', 'native'] as const) {
      const { a, b } = socketPair()
      a.open(); b.open()
      const ta = createWebSocketTransport(a, { binaryEncoding: encoding })
      const got = collect<[BlobChunkHeader, Uint8Array]>(1, push =>
        createWebSocketTransport(b).onBlobChunk((h, by) => push([h, by])))
      ta.sendBlobChunk(header, bytes)
      const [h, by] = (await got)[0]
      expect(h).toEqual(header)
      expect(Array.from(by)).toEqual(Array.from(bytes))
    }
  })

  it("emits 'B'+base64 on the wire in text mode, matching the Python vector form", async () => {
    const { a, b } = socketPair()
    a.open(); b.open()
    const ta = createWebSocketTransport(a, { binaryEncoding: 'text' })
    const wireSeen = collect<string>(1, push => b.addEventListener('message', e => push((e as { data?: unknown }).data as string)))
    const header: BlobChunkHeader = { id: 'x', index: 0, last: true }
    const bytes = new Uint8Array([1, 2, 3])
    ta.sendBlobChunk(header, bytes)
    const wire = (await wireSeen)[0]
    expect(wire).toBe('B' + base64Encode(encodeBlobChunk(header, bytes)))
  })

  it('a text-mode sender and a native-mode receiver interoperate (inbound accepts both)', async () => {
    const { a, b } = socketPair()
    a.open(); b.open()
    const header: BlobChunkHeader = { id: 'mix', index: 0, last: true }
    const bytes = new Uint8Array([9, 8, 7])
    const got = collect<[BlobChunkHeader, Uint8Array]>(2, push => {
      const tb = createWebSocketTransport(b)
      tb.onBlobChunk((h, by) => push([h, by]))
    })
    createWebSocketTransport(a, { binaryEncoding: 'text' }).sendBlobChunk(header, bytes)
    createWebSocketTransport(a, { binaryEncoding: 'native' }).sendBlobChunk(header, bytes)
    const both = await got
    for (const [h, by] of both) {
      expect(h).toEqual(header)
      expect(Array.from(by)).toEqual(Array.from(bytes))
    }
  })

  it('drops malformed inbound (bad JSON text, bad base64, bad binary) without throwing', async () => {
    const { a, b } = socketPair()
    a.open(); b.open()
    const tb = createWebSocketTransport(b)
    const frames: Frame[] = []
    tb.onFrame(f => frames.push(f))
    // Drive the peer's message listener directly with garbage.
    b.emit('message', { data: 'not json' })
    b.emit('message', { data: 'B!!!not-base64' })
    b.emit('message', { data: new Uint8Array([1, 2]).buffer })  // too short to be a chunk
    await flush()
    expect(frames).toEqual([])   // nothing crashed, nothing bogus emitted
  })

  it('reports bufferedAmount + queued bytes via bufferedBytes()', () => {
    const { a } = socketPair()
    a.open()
    a.bufferedAmount = 42
    const t = createWebSocketTransport(a)
    expect(t.bufferedBytes()).toBe(42)
  })

  it('onClosed fires once (close or error, whichever first); 4003 is non-retryable', async () => {
    const { a } = socketPair()
    const t = createWebSocketTransport(a)
    const events: Array<[string, boolean]> = []
    t.onClosed((reason, retryable) => events.push([reason, retryable]))
    a.emit('close', { code: 4003 })   // listener_disabled — final
    a.emit('close', { code: 1000 })   // a second close must NOT re-fire
    a.emit('error')
    await flush()
    expect(events).toEqual([['ws-4003', false]])
  })

  it('a normal close is retryable and reason carries the code', async () => {
    const { a } = socketPair()
    const t = createWebSocketTransport(a)
    const events: Array<[string, boolean]> = []
    t.onClosed((reason, retryable) => events.push([reason, retryable]))
    a.emit('close', { code: 4001 })   // runtime_offline — retryable
    await flush()
    expect(events).toEqual([['ws-4001', true]])
  })

  it('an error defers to the close event that follows, keeping its code', async () => {
    // A real socket fires 'error' THEN 'close' on a failed dial (code 1006 for
    // a refused/dropped connection). Finishing on the error would erase the
    // code — 'ws-closed' instead of 'ws-1006' — and with it any chance the UI
    // discriminates why the wire died.
    const { a } = socketPair()
    const t = createWebSocketTransport(a)
    const events: Array<[string, boolean]> = []
    t.onClosed((reason, retryable) => events.push([reason, retryable]))
    a.emit('error')
    a.emit('close', { code: 1006 })
    await flush()
    expect(events).toEqual([['ws-1006', true]])
  })

  it('an error on an already-CLOSED socket finishes without a close event', async () => {
    // The no-close-event escape hatch: some fakes/peers never fire 'close'
    // after 'error', and a socket already CLOSED will not fire one either.
    const { a } = socketPair()
    a.readyState = 3
    const t = createWebSocketTransport(a)
    const events: Array<[string, boolean]> = []
    t.onClosed((reason, retryable) => events.push([reason, retryable]))
    a.emit('error')
    await flush()
    expect(events).toEqual([['ws-closed', true]])
  })

  it('close() closes the socket with 1000 and is idempotent', async () => {
    const { a } = socketPair()
    const t = createWebSocketTransport(a)
    const events: Array<[string, boolean]> = []
    t.onClosed((reason, retryable) => events.push([reason, retryable]))
    t.close()
    t.close()
    await flush()
    expect(events).toEqual([['ws-1000', true]])
  })
})
