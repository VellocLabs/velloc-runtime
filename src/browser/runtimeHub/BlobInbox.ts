/**
 * Security: bytes a client pushes to the runtime. Chunks are accepted only for an id the hub handed
 * out for `sys.putBlob`; each blob reserves its declared size against a per-connection budget until
 * received or expired; a size mismatch fails it (`bad_payload`). The chunk table is bounded too: an
 * index past `ceil(declared / chunkBytes)` (plus one) fails the blob, so empty chunks cannot grow it.
 */
import { wireError, type BlobChunkHeader } from '../runtimeProtocol'

export type BlobInboxLimits = {
  /** Declared bytes of blobs announced but not yet received, per connection. */
  maxBytes: number
  /** An announced blob nobody `receive`s within this long is dropped. */
  ttlMs: number
}

export const DEFAULT_BLOB_INBOX_LIMITS: BlobInboxLimits = {
  maxBytes: 64 * 1024 * 1024,
  ttlMs: 2 * 60_000,
}

type Waiter = { resolve: (bytes: Uint8Array) => void; reject: (error: unknown) => void }

type Inbound = {
  declared: number
  /** `ceil(declared / chunkBytes) + 1`: the most chunk indexes the blob may have. */
  maxChunks: number
  expiresAt: number
  chunks: Map<number, Uint8Array>
  received: number
  total: number | null
  complete: Uint8Array | null
  waiters: Waiter[]
}

export class BlobInbox {
  private readonly inbound = new Map<string, Inbound>()

  /**
   * `chunkBytes` is the transport's chunk size — the hub passes
   * `transport.limits.chunkBytes`. The default, 1, is the loosest bound that
   * still holds (a non-empty chunk carries at least one byte): `declared`
   * chunks, plus the slack.
   */
  constructor(
    private readonly limits: BlobInboxLimits = DEFAULT_BLOB_INBOX_LIMITS,
    private readonly now: () => number = () => Date.now(),
    private readonly chunkBytes: number = 1,
  ) {}

  /** Reserve room for an announced blob. Throws `conflict` when the budget is spent. */
  expect(id: string, bytes: number): void {
    this.sweep()
    let reserved = 0
    for (const blob of this.inbound.values()) reserved += blob.declared
    if (reserved + bytes > this.limits.maxBytes) {
      throw wireError('conflict', `upload of ${bytes} bytes exceeds this connection's pending-upload budget`, {
        maxBytes: this.limits.maxBytes,
        pendingBytes: reserved,
      })
    }
    this.inbound.set(id, {
      declared: bytes,
      // One of slack over the sender's exact count: the bound is against a
      // flood, not a sender whose last cut lands a byte off.
      maxChunks: Math.ceil(bytes / Math.max(1, this.chunkBytes)) + 1,
      expiresAt: this.now() + this.limits.ttlMs,
      chunks: new Map(),
      received: 0,
      total: null,
      complete: null,
      waiters: [],
    })
  }

  /** A chunk arrived. `false` when it belongs to no announced blob (the caller does not ack it). */
  accept(header: BlobChunkHeader, bytes: Uint8Array): boolean {
    // An expired blob is gone before its chunks are looked at — `sweep` used
    // to run only from `expect` / `receive`, so a client that never announced
    // another blob could keep feeding an expired one.
    this.sweep()
    const blob = this.inbound.get(header.id)
    if (!blob || blob.complete) return false
    if (header.index >= blob.maxChunks) {
      this.fail(header.id, blob, `blob '${header.id}' has a chunk past the ${blob.maxChunks} its ${blob.declared} bytes allow`)
      return true
    }
    if (!blob.chunks.has(header.index)) {
      blob.chunks.set(header.index, bytes)
      blob.received += bytes.byteLength
    }
    if (header.last) blob.total = header.index + 1
    if (blob.received > blob.declared) {
      this.fail(header.id, blob, `blob '${header.id}' carried more than the ${blob.declared} bytes announced`)
      return true
    }
    const total = blob.total
    if (total === null) return true
    for (const index of blob.chunks.keys()) {
      if (index >= total) {
        this.fail(header.id, blob, `blob '${header.id}' has a chunk past its last one`)
        return true
      }
    }
    if (blob.chunks.size === total) this.complete(header.id, blob)
    return true
  }

  /** The bytes of an announced blob, once all of them are in. Consumes the blob. */
  receive(id: string, signal?: AbortSignal): Promise<Uint8Array> {
    this.sweep()
    const blob = this.inbound.get(id)
    if (!blob) return Promise.reject(wireError('not_found', `no pending upload '${id}'`))
    if (blob.complete) {
      this.inbound.delete(id)
      return Promise.resolve(blob.complete)
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject }
      blob.waiters.push(waiter)
      signal?.addEventListener(
        'abort',
        () => {
          const index = blob.waiters.indexOf(waiter)
          if (index >= 0) blob.waiters.splice(index, 1)
          reject(wireError('cancelled', 'request cancelled'))
        },
        { once: true },
      )
    })
  }

  clear(error: unknown): void {
    const pending = Array.from(this.inbound.values())
    this.inbound.clear()
    for (const blob of pending) for (const waiter of blob.waiters) waiter.reject(error)
  }

  private complete(id: string, blob: Inbound): void {
    if (blob.received !== blob.declared) {
      this.fail(id, blob, `blob '${id}' carried ${blob.received} bytes, ${blob.declared} were announced`)
      return
    }
    const out = new Uint8Array(blob.received)
    let offset = 0
    for (let index = 0; index < blob.total!; index += 1) {
      const chunk = blob.chunks.get(index)!
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    blob.chunks.clear()
    if (blob.waiters.length > 0) {
      this.inbound.delete(id)
      for (const waiter of blob.waiters) waiter.resolve(out)
      return
    }
    blob.complete = out
  }

  private fail(id: string, blob: Inbound, message: string): void {
    this.inbound.delete(id)
    const error = wireError('bad_payload', message)
    for (const waiter of blob.waiters) waiter.reject(error)
  }

  /** Drop expired blobs nobody is waiting for. */
  private sweep(): void {
    const now = this.now()
    for (const [id, blob] of this.inbound) {
      if (blob.expiresAt <= now && blob.waiters.length === 0) this.inbound.delete(id)
    }
  }
}
