/**
 * BlobSendLoop: the protocol's one blob send loop, for the hub pushing a
 * handler's bytes after its `res` and a client pushing `sys.putBlob` bytes.
 * Cut, send, wait for credit, sized by the transport's `limits`; transfer vs copy
 * stays the transport's `sendBlobChunk` decision.
 */
import type { AckFrame } from '../runtimeProtocol'
import type { FrameTransport } from './FrameTransport'

type Outgoing = {
  id: string
  bytes: Uint8Array
  chunkCount: number
  nextIndex: number
  ackedUpTo: number
  resolve: () => void
  reject: (error: unknown) => void
}

export class BlobSendLoop {
  private readonly outgoing = new Map<string, Outgoing>()

  constructor(private readonly transport: FrameTransport) {}

  /**
   * Push `bytes` as blob `id`. Resolves once every chunk is on the wire and —
   * on a windowed transport — acknowledged; rejects if the loop is cleared
   * (the connection went away) first.
   */
  send(id: string, bytes: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const blob: Outgoing = {
        id,
        bytes,
        chunkCount: Math.max(1, Math.ceil(bytes.byteLength / this.transport.limits.chunkBytes)),
        nextIndex: 0,
        ackedUpTo: -1,
        resolve,
        reject,
      }
      this.outgoing.set(id, blob)
      this.pump(blob)
    })
  }

  onAck(ack: AckFrame): void {
    const blob = this.outgoing.get(ack.id)
    if (!blob) return
    // An ack can only cover chunks that exist. One past the last index would
    // step `ackedUpTo` over the `chunkCount - 1` that `pump` waits for, and
    // the send would never settle — the bytes pinned until the connection
    // died. Clamped rather than dropped: the peer plainly has everything.
    blob.ackedUpTo = Math.max(blob.ackedUpTo, Math.min(ack.upTo, blob.chunkCount - 1))
    this.pump(blob)
  }

  /** Stop every send in progress (the connection is gone). */
  clear(error: unknown): void {
    const pending = Array.from(this.outgoing.values())
    this.outgoing.clear()
    for (const blob of pending) blob.reject(error)
  }

  private pump(blob: Outgoing): void {
    const { chunkBytes, windowChunks } = this.transport.limits
    while (blob.nextIndex < blob.chunkCount && blob.nextIndex - (blob.ackedUpTo + 1) < windowChunks) {
      const index = blob.nextIndex
      const start = index * chunkBytes
      const chunk = blob.bytes.subarray(start, Math.min(start + chunkBytes, blob.bytes.byteLength))
      this.transport.sendBlobChunk({ id: blob.id, index, last: index === blob.chunkCount - 1 }, chunk)
      blob.nextIndex += 1
    }
    const allSent = blob.nextIndex === blob.chunkCount
    if (allSent && (windowChunks === Number.POSITIVE_INFINITY || blob.ackedUpTo === blob.chunkCount - 1)) {
      this.outgoing.delete(blob.id)
      blob.resolve()
    }
  }
}
