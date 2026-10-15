/**
 * Contract: `FrameTransport` over a `MessagePort` (structured clone, never JSON).
 * A frame is posted as itself (accepted iff `readFrame`); a blob chunk as
 * `{ $chunk: BlobChunkHeader, bytes: Uint8Array }`; anything else is dropped.
 * Holds the protocol's only transfer branch: a chunk spanning its whole buffer
 * is transferred (the sender's buffer detaches), a window onto a larger buffer
 * is sliced first. The port's `close` event ends the transport, as do a
 * `messageerror` and the `error` of `options.worker`, each with its own reason,
 * so a connection without a handshake deadline still fails.
 */
import type { BlobChunkHeader, Frame } from '../runtimeProtocol'
import { isBlobChunkHeader, readFrame } from '../runtimeProtocol'
import {
  ListenerSet,
  type FrameTransport,
  type FrameTransportLimits,
  type Unsubscribe,
} from './FrameTransport'

export const MESSAGE_PORT_TRANSPORT_LIMITS: FrameTransportLimits = {
  chunkBytes: 16 * 1024 * 1024,
  windowChunks: Number.POSITIVE_INFINITY,
}

type ChunkMessage = { $chunk: BlobChunkHeader; bytes: Uint8Array }

function isChunkMessage(value: unknown): value is ChunkMessage {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return isBlobChunkHeader(record.$chunk) && record.bytes instanceof Uint8Array
}

/** The worker a port leads to — just enough of `AbstractWorker` to hear its `error`. */
export type WorkerErrorSource = {
  addEventListener(type: 'error', listener: (event: Event) => void): void
  removeEventListener(type: 'error', listener: (event: Event) => void): void
}

export type MessagePortTransportOptions = {
  /** The worker behind `port`; its `error` event ends the transport (`worker-error`). */
  worker?: WorkerErrorSource
}

export function createMessagePortTransport(
  port: MessagePort,
  limits: FrameTransportLimits = MESSAGE_PORT_TRANSPORT_LIMITS,
  options: MessagePortTransportOptions = {},
): FrameTransport {
  const frames = new ListenerSet<[Frame]>()
  const chunks = new ListenerSet<[BlobChunkHeader, Uint8Array]>()
  const closed = new ListenerSet<[string, boolean]>()
  let isClosed = false

  const finish = (reason: string): void => {
    if (isClosed) return
    isClosed = true
    port.removeEventListener('message', onMessage)
    port.removeEventListener('messageerror', onMessageError)
    port.removeEventListener('close', onClose)
    options.worker?.removeEventListener('error', onWorkerError)
    closed.emit(reason, false)
    frames.clear()
    chunks.clear()
    closed.clear()
  }

  const onMessage = (event: MessageEvent): void => {
    const data: unknown = event.data
    const frame = readFrame(data)
    if (frame) {
      frames.emit(frame)
      return
    }
    if (isChunkMessage(data)) {
      chunks.emit(data.$chunk, data.bytes)
    }
  }

  const onClose = (): void => {
    finish('port-closed')
  }
  const onMessageError = (): void => {
    finish('messageerror')
  }
  const onWorkerError = (): void => {
    finish('worker-error')
  }

  port.addEventListener('message', onMessage)
  port.addEventListener('messageerror', onMessageError)
  port.addEventListener('close', onClose)
  options.worker?.addEventListener('error', onWorkerError)
  port.start()

  return {
    kind: 'message-port',
    limits,
    bufferedBytes: () => 0,
    send(frame) {
      if (isClosed) return
      port.postMessage(frame)
    },
    sendBlobChunk(header, bytes) {
      if (isClosed) return
      // The single transfer/copy branch. A view over its whole buffer moves;
      // a view over part of one is copied out so the remainder stays put. An
      // empty chunk is posted without a transfer list: its buffer may be one
      // that an earlier transfer already detached, and transferring a detached
      // buffer throws.
      if (bytes.byteLength === 0) {
        const message: ChunkMessage = { $chunk: header, bytes: new Uint8Array(0) }
        port.postMessage(message)
        return
      }
      const spansBuffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      const payload = spansBuffer ? bytes : bytes.slice()
      const message: ChunkMessage = { $chunk: header, bytes: payload }
      port.postMessage(message, [payload.buffer as ArrayBuffer])
    },
    onFrame: (listener): Unsubscribe => frames.add(listener),
    onBlobChunk: (listener): Unsubscribe => chunks.add(listener),
    onClosed: (listener): Unsubscribe => {
      if (isClosed) {
        listener('port-closed', false)
        return () => {}
      }
      return closed.add(listener)
    },
    close() {
      if (isClosed) return
      finish('closed')
      try {
        port.close()
      } catch {
        /* already closed */
      }
    },
  }
}
