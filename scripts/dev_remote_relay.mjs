#!/usr/bin/env node
/**
 * Contract: the development relay (F-24). Its paths, messages and close codes
 * are the ones the C++ listener (`net::HttpServer`) implements byte-for-byte.
 *
 *   node scripts/dev_remote_relay.mjs --port 8787 --token devtoken [--text-only]
 *
 * Three routes, all WebSocket upgrades:
 *
 *   /rt                         the remote CLIENT's entry. No control socket →
 *                               close 4001 (runtime_offline). Else mint a legId,
 *                               send {"open":legId} on the control socket, wait
 *                               ≤5 s for /host/leg/<legId> → close 4002
 *                               (leg_timeout) on expiry. Client messages that
 *                               arrive before the leg does are BUFFERED (cap
 *                               1 MiB, over → close 1009) and flushed in order.
 *   /host/control?token=<T>     the runtime's control socket. A wrong token →
 *                               HTTP 401. The LATEST control socket replaces the
 *                               previous one (closed 1001) — two Velloc windows
 *                               share one SharedWorker, and whichever booted
 *                               last owns the dial-out.
 *   /host/leg/<legId>?token=<T> the runtime's half of one client. Spliced to
 *                               the pending /rt socket: every message forwarded
 *                               verbatim (text and binary alike, unparsed), a
 *                               close on either side closes the other with the
 *                               same code. An unknown legId or wrong token →
 *                               404 (the route's existence is not leaked).
 *
 * Close codes (the table the CLIENT's retry/UI logic reads):
 *   1000/1001/1006  normal / abnormal disconnect          retryable
 *   4001            relay up, no runtime behind it        retryable (slow)
 *   4002            runtime did not claim the leg in 5 s  retryable
 *   4003            remote access turned off              FINAL (no retry)
 *   4004            too many concurrent clients           retryable (slow)
 *
 * `--text-only` mimics net::HttpServer (text frames only): a binary
 * message closes the connection it arrived on with 1003. e2e runs with it.
 *
 * Security: dev-only. It holds no user data and enforces nothing the runtime
 * does not re-check; the pair handshake (challenge/auth) runs end-to-end
 * between client and runtime over the spliced sockets.
 */

import { WebSocketServer } from 'ws'

import { isMainModule } from './lib/isMainModule.mjs'

const LEG_TIMEOUT_MS = 5_000
const MAX_BUFFER_BYTES = 1 * 1024 * 1024

function parseArgs(argv) {
  const args = { port: 8787, token: null, textOnly: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') args.port = Number(argv[++i])
    else if (arg === '--token') args.token = argv[++i]
    else if (arg === '--text-only') args.textOnly = true
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice(7))
    else if (arg.startsWith('--token=')) args.token = arg.slice(8)
    else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  if (!args.token) {
    console.error('missing --token (a development credential; see file header)')
    process.exit(2)
  }
  // 0 = the OS assigns a free port (e2e reads it off the log line).
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    console.error(`bad --port: ${args.port}`)
    process.exit(2)
  }
  return args
}

/** Random 16-byte hex legId — unpredictable enough that a client can't claim
 *  another client's pending leg by guessing. */
function mintLegId(randomBytes) {
  let out = ''
  for (const b of randomBytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function createRelay({ token, textOnly = false, randomBytes } = {}) {
  const random =
    randomBytes ??
    (async () => {
      const { randomBytes: rb } = await import('node:crypto')
      return rb(16)
    })

  /** The runtime's one control socket; null while the desktop panel is closed. */
  let control = null
  /** legId → { client, buffered, bufferBytes, timer, leg } */
  const pendingLegs = new Map()

  const wss = new WebSocketServer({ noServer: true })

  const close = (ws, code) => {
    try {
      ws.close(code)
    } catch {
      /* already gone */
    }
  }

  /** Splice two sockets: verbatim forwarding both ways, paired close. */
  const splice = (a, b) => {
    const forward = (from, to) => {
      from.on('message', (data, isBinary) => {
        if (textOnly && isBinary) {
          // net::HttpServer speaks text only: a binary frame is a
          // protocol error, closed 1003 — e2e asserts this shape.
          close(from, 1003)
          return
        }
        try {
          to.send(data, { binary: isBinary })
        } catch {
          /* peer gone; its own close tears the pair down */
        }
      })
      from.on('close', (code) => close(to, code === 1006 ? 1000 : code))
      from.on('error', () => close(to, 1011))
    }
    forward(a, b)
    forward(b, a)
  }

  const handleRt = async (ws) => {
    if (!control || control.readyState !== control.OPEN) {
      close(ws, 4001)
      return
    }
    const legId = mintLegId(await random())
    const entry = {
      client: ws,
      buffered: /** @type {Array<{data: Buffer, isBinary: boolean}>} */ ([]),
      bufferBytes: 0,
      leg: null,
      timer: setTimeout(() => {
        // The runtime never claimed its leg — likely a control socket that
        // died between the client's connect and the open message.
        pendingLegs.delete(legId)
        close(ws, 4002)
      }, LEG_TIMEOUT_MS),
    }
    pendingLegs.set(legId, entry)

    ws.on('message', (data, isBinary) => {
      if (entry.leg) return // spliced; the splice's own listener handles it
      if (entry.bufferBytes + data.length > MAX_BUFFER_BYTES) {
        pendingLegs.delete(legId)
        clearTimeout(entry.timer)
        close(ws, 1009)
        return
      }
      entry.buffered.push({ data, isBinary })
      entry.bufferBytes += data.length
    })
    ws.on('close', () => {
      if (!entry.leg) {
        pendingLegs.delete(legId)
        clearTimeout(entry.timer)
      }
    })

    try {
      control.send(JSON.stringify({ open: legId }))
    } catch {
      pendingLegs.delete(legId)
      clearTimeout(entry.timer)
      close(ws, 4001)
    }
  }

  const handleControl = (ws) => {
    if (control && control.readyState === control.OPEN) {
      // Latest wins: a second window's SharedWorker replaced the first's.
      close(control, 1001)
    }
    control = ws
    ws.on('close', () => {
      if (control === ws) control = null
      // Every client whose leg never arrived has no runtime behind it now.
      for (const [, entry] of pendingLegs) {
        clearTimeout(entry.timer)
        close(entry.client, 4001)
      }
      pendingLegs.clear()
    })
  }

  const handleLeg = (ws, legId) => {
    const entry = pendingLegs.get(legId)
    if (!entry) {
      close(ws, 1000)
      return
    }
    pendingLegs.delete(legId)
    clearTimeout(entry.timer)
    entry.leg = ws
    // Flush what the client said before its runtime leg arrived, in order.
    for (const msg of entry.buffered) {
      try {
        ws.send(msg.data, { binary: msg.isBinary })
      } catch {
        break
      }
    }
    entry.buffered = []
    splice(entry.client, ws)
    ws.on('close', () => {
      // Informational — the control socket may already be gone.
      try {
        if (control && control.readyState === control.OPEN) {
          control.send(JSON.stringify({ closed: legId }))
        }
      } catch {
        /* gone */
      }
    })
  }

  /** Route an upgrade request. Returns false when it was NOT claimed (the
   *  caller destroys the socket) — ws's `noServer` mode makes us answer the
   *  HTTP side ourselves for the rejections. */
  const route = (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const givenToken = url.searchParams.get('token')

    if (path === '/rt') {
      wss.handleUpgrade(req, socket, head, (ws) => void handleRt(ws))
      return true
    }
    if (path === '/host/control') {
      if (givenToken !== token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return true
      }
      wss.handleUpgrade(req, socket, head, handleControl)
      return true
    }
    const legMatch = path.match(/^\/host\/leg\/([0-9a-f]{32})$/)
    if (legMatch) {
      if (givenToken !== token) {
        // 404, not 401: the route's existence is not for unauthenticated
        // callers to learn (the listener's rule, mirrored here).
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return true
      }
      wss.handleUpgrade(req, socket, head, (ws) => handleLeg(ws, legMatch[1]))
      return true
    }
    return false
  }

  return { wss, route }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { createServer } = await import('node:http')
  const relay = createRelay({ token: args.token, textOnly: args.textOnly })
  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found\n')
  })
  server.on('upgrade', (req, socket, head) => {
    if (!relay.route(req, socket, head)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
    }
  })
  server.listen(args.port, () => {
    // With --port 0 the OS assigned the port — report the BOUND one, which is
    // the only one a caller can dial.
    const bound = server.address()
    const port = typeof bound === 'object' && bound ? bound.port : args.port
    console.log(
      `[dev-relay] ws://127.0.0.1:${port}  (text-only: ${args.textOnly})`,
    )
  })
}

// Run as a script, not when imported by a test.
if (isMainModule(import.meta.url)) {
  void main()
}
