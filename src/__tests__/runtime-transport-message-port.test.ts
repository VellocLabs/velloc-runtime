import { describe, expect, it } from 'vitest'
import type { BlobChunkHeader, Frame } from '../browser/runtimeProtocol'
import { createMessagePortTransport } from '../browser/runtimeTransport'

/** MessageChannel delivery is asynchronous; wait for `count` items to land. */
function collect<T>(count: number, subscribe: (push: (item: T) => void) => void): Promise<T[]> {
  return new Promise(resolve => {
    const items: T[] = []
    subscribe(item => {
      items.push(item)
      if (items.length === count) resolve(items)
    })
  })
}

function pair() {
  const channel = new MessageChannel()
  return {
    a: createMessagePortTransport(channel.port1),
    b: createMessagePortTransport(channel.port2),
    channel,
  }
}

describe('createMessagePortTransport', () => {
  it('declares the message-port limits and no buffered bytes', () => {
    const { a } = pair()
    expect(a.kind).toBe('message-port')
    expect(a.limits.windowChunks).toBe(Number.POSITIVE_INFINITY)
    expect(a.limits.chunkBytes).toBeGreaterThan(1024 * 1024)
    expect(a.bufferedBytes()).toBe(0)
    a.close()
  })

  it('delivers frames to the peer and drops non-frame messages', async () => {
    const { a, b, channel } = pair()
    const received = collect<Frame>(2, push => b.onFrame(push))
    channel.port1.postMessage({ not: 'a frame' })
    channel.port1.postMessage(42)
    a.send({ kind: 'cancel', id: 'r1' })
    a.send({ kind: 'ack', id: 'blob', upTo: 3 })
    expect(await received).toEqual([
      { kind: 'cancel', id: 'r1' },
      { kind: 'ack', id: 'blob', upTo: 3 },
    ])
    a.close()
  })

  it('moves a whole-buffer chunk (sender detached) and copies a partial view (sender intact)', async () => {
    const { a, b } = pair()
    const received = collect<[BlobChunkHeader, Uint8Array]>(2, push =>
      b.onBlobChunk((header, bytes) => push([header, bytes])),
    )

    const whole = new Uint8Array([1, 2, 3, 4])
    a.sendBlobChunk({ id: 'w', index: 0, last: false }, whole)
    // Transferred: the sender's buffer is detached.
    expect(whole.buffer.byteLength).toBe(0)

    const backing = new Uint8Array([9, 9, 5, 6, 7, 9, 9])
    const view = backing.subarray(2, 5)
    a.sendBlobChunk({ id: 'p', index: 1, last: true }, view)
    // Copied: the backing buffer is still usable.
    expect(backing.buffer.byteLength).toBe(7)
    expect(Array.from(backing)).toEqual([9, 9, 5, 6, 7, 9, 9])

    const [[hw, bw], [hp, bp]] = await received
    expect(hw).toEqual({ id: 'w', index: 0, last: false })
    expect(Array.from(bw)).toEqual([1, 2, 3, 4])
    expect(hp).toEqual({ id: 'p', index: 1, last: true })
    expect(Array.from(bp)).toEqual([5, 6, 7])
    a.close()
  })

  it('closing one end fires onClosed on the peer and silences sends', async () => {
    const { a, b } = pair()
    const closed = new Promise<string>(resolve => b.onClosed(reason => resolve(reason)))
    a.close()
    expect(await closed).toBe('port-closed')
    // Sends after close are no-ops, not throws.
    expect(() => b.send({ kind: 'cancel', id: 'x' })).not.toThrow()
    expect(() => a.send({ kind: 'cancel', id: 'x' })).not.toThrow()
  })

  it('onClosed after the fact fires immediately, once', () => {
    const { a, b } = pair()
    a.close()
    let calls = 0
    a.onClosed(() => {
      calls += 1
    })
    expect(calls).toBe(1)
    b.close()
  })
})
