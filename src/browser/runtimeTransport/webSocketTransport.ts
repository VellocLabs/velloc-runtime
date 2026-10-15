/**
 * Contract: `FrameTransport` over an already-constructed WebSocket (F-24).
 * Frames are JSON text; a blob chunk is a binary message or, for the text-only
 * C++ listener, `'B' + base64(chunk)`. Both inbound forms are always accepted.
 * Sends queue while CONNECTING and flush in order on `open`. Every close code is
 * retryable except 4003 (`listener_disabled`, remote access turned off); the
 * reason carries the code (`'ws-4001'`).
 */
import type { BlobChunkHeader, Frame } from '../runtimeProtocol'
import { decodeBlobChunk, decodeFrame, encodeBlobChunk, encodeFrame } from '../runtimeProtocol'
import { base64Decode, base64Encode } from '../runtimeProtocol/blobText'
import {
  ListenerSet,
  type FrameTransport,
  type FrameTransportLimits,
  type Unsubscribe,
} from './FrameTransport'

/** Small chunks and a small window so bytes never starve the token stream. */
export const WEB_SOCKET_TRANSPORT_LIMITS: FrameTransportLimits = {
  chunkBytes: 64 * 1024,
  windowChunks: 8,
} as const

/** The slice of the DOM WebSocket the transport needs — a fake implements exactly this. */
export type SocketSurface = Pick<WebSocket,
  'readyState' | 'bufferedAmount' | 'binaryType' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'>

// WebSocket readyState constants (not on the type in some lib versions).
const CONNECTING = 0
const OPEN = 1

export type SocketLinkOptions = {
  /** Outbound blob encoding. Inbound always accepts both. Default 'text' (the C++ listener is text-only). */
  binaryEncoding?: 'native' | 'text'
}

export function createWebSocketTransport(
  socket: SocketSurface,
  options: SocketLinkOptions = {},
): FrameTransport {
  const binaryEncoding = options.binaryEncoding ?? 'text'
  const frames = new ListenerSet<[Frame]>()
  const chunks = new ListenerSet<[BlobChunkHeader, Uint8Array]>()
  const closed = new ListenerSet<[string, boolean]>()
  let isClosed = false
  // Bytes handed to send/sendBlobChunk before the socket opened, in order.
  const pending: Array<string | Uint8Array> = []
  let pendingBytes = 0

  socket.binaryType = 'arraybuffer'

  const finish = (code: number | null): void => {
    if (isClosed) return
    isClosed = true
    socket.removeEventListener('message', onMessage)
    socket.removeEventListener('close', onClose)
    socket.removeEventListener('error', onError)
    socket.removeEventListener('open', onOpen)
    const reason = code === null ? 'ws-closed' : `ws-${code}`
    // 4003 = listener_disabled is the only NON-retryable close.
    closed.emit(reason, code !== 4003)
    frames.clear()
    chunks.clear()
    closed.clear()
    pending.length = 0
    pendingBytes = 0
  }

  const byteSize = (data: string | Uint8Array): number =>
    typeof data === 'string' ? data.length : data.byteLength

  const flush = (): void => {
    while (pending.length > 0 && socket.readyState === OPEN) {
      const data = pending.shift()!
      pendingBytes -= byteSize(data)
      socket.send(data)
    }
  }

  const onOpen = (): void => flush()
  const onClose = (event: CloseEvent): void => finish(typeof event?.code === 'number' ? event.code : null)
  // A real socket ALWAYS fires 'close' after 'error' (spec: fail → error →
  // close), and that close carries the code — 1006 for a refused/dropped dial.
  // Finishing HERE would win the race against it and erase the code (finish is
  // idempotent), collapsing 'ws-1006' into an uninformative 'ws-closed'. So an
  // error only arms the finish; the close event that follows fires it. A peer
  // that errors without ever closing is finished by RuntimeConnection's own
  // handshake/heartbeat timeouts, which close the socket — and close() below
  // finishes synchronously — so nothing is left waiting on this path.
  const onError = (): void => {
    if (socket.readyState === /* CLOSED */ 3) finish(null)
  }

  const onMessage = (event: MessageEvent): void => {
    const data: unknown = event.data
    if (typeof data === 'string') {
      if (data.startsWith('B')) {
        const bytes = base64Decode(data.slice(1))
        if (bytes) {
          const decoded = decodeBlobChunk(bytes)
          if (decoded) chunks.emit(decoded.header, decoded.bytes)
        }
        return
      }
      const frame = decodeFrame(data)
      if (frame) frames.emit(frame)
      return
    }
    if (data instanceof ArrayBuffer) {
      const decoded = decodeBlobChunk(new Uint8Array(data))
      if (decoded) chunks.emit(decoded.header, decoded.bytes)
    }
  }

  socket.addEventListener('message', onMessage)
  socket.addEventListener('close', onClose)
  socket.addEventListener('error', onError)
  socket.addEventListener('open', onOpen)
  // A socket already open (a fake that starts OPEN) flushes immediately.
  flush()

  const push = (data: string | Uint8Array): void => {
    if (isClosed) return
    if (socket.readyState === OPEN && pending.length === 0) {
      socket.send(data)
      return
    }
    pending.push(data)
    pendingBytes += byteSize(data)
  }

  return {
    kind: 'websocket',
    limits: WEB_SOCKET_TRANSPORT_LIMITS,
    bufferedBytes: () => socket.bufferedAmount + pendingBytes,
    send(frame) {
      push(encodeFrame(frame))
    },
    sendBlobChunk(header, bytes) {
      const encoded = encodeBlobChunk(header, bytes)
      push(binaryEncoding === 'native' ? encoded : 'B' + base64Encode(encoded))
    },
    onFrame: (listener): Unsubscribe => frames.add(listener),
    onBlobChunk: (listener): Unsubscribe => chunks.add(listener),
    onClosed: (listener): Unsubscribe => closed.add(listener),
    close() {
      if (isClosed) return
      try {
        socket.close(1000)
      } catch {
        /* already closed */
      }
      // Some fakes/peers never fire 'close' after close(); finish so listeners
      // are not left waiting. Real sockets fire it first and finish() is idempotent.
      finish(1000)
    },
  }
}
