/**
 * Contract: the one seam between the UI ⇄ Runtime protocol and a wire (P-3),
 * symmetric so one implementation serves both ends. Moves protocol frames and
 * blob chunks only; whether bytes are transferred or copied is decided in a
 * transport's `sendBlobChunk` alone, and every layer above sees `Uint8Array`.
 * `limits` drive the blob send loop: chunks of `chunkBytes`, at most
 * `windowChunks` un-acked (MessagePort: large chunk, infinite window; WebSocket:
 * small chunks and window so bytes never starve the token stream).
 */
import type { BlobChunkHeader, Frame } from '../runtimeProtocol'

export type Unsubscribe = () => void

export type FrameTransportKind = 'message-port' | 'websocket'

export type FrameTransportLimits = {
  readonly chunkBytes: number
  readonly windowChunks: number
}

export interface FrameTransport {
  readonly kind: FrameTransportKind
  readonly limits: FrameTransportLimits
  /**
   * Bytes accepted by `send` / `sendBlobChunk` that the wire has not yet
   * drained (`WebSocket.bufferedAmount`). The broker reads it to detect a
   * lagging subscriber. A transport with no such signal — a
   * MessagePort — returns 0, and so never lags.
   */
  bufferedBytes(): number
  send(frame: Frame): void
  sendBlobChunk(header: BlobChunkHeader, bytes: Uint8Array): void
  onFrame(listener: (frame: Frame) => void): Unsubscribe
  onBlobChunk(listener: (header: BlobChunkHeader, bytes: Uint8Array) => void): Unsubscribe
  /** Fires once, when the wire is gone for good (peer closed it or `close()` was called). */
  onClosed(listener: (reason: string, retryable: boolean) => void): Unsubscribe
  close(): void
}

/** Shared by every transport: a listener set that survives listeners removing themselves mid-fire. */
export class ListenerSet<A extends unknown[]> {
  private readonly listeners = new Set<(...args: A) => void>()

  add(listener: (...args: A) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(...args: A): void {
    for (const listener of Array.from(this.listeners)) {
      listener(...args)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
