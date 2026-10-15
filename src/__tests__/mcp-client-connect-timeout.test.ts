import { afterEach, describe, expect, it, vi } from 'vitest'

// connectMCPServer (the browser-transport path: http / sse / websocket) must
// bound its connect. The runtime build awaits every configured server, so one
// that never answers would otherwise hold session boot indefinitely.
const hung = { closed: 0 }
vi.mock('../mcp/transport', () => ({
  createTransport: async () => ({
    // start() never settles: the server accepts the socket and says nothing.
    start: () => new Promise<void>(() => {}),
    send: async () => {},
    close: async () => {
      hung.closed++
    },
  }),
}))

import { connectMCPServer } from '../mcp/client'

describe('connectMCPServer connect timeout', () => {
  afterEach(() => {
    hung.closed = 0
    vi.useRealTimers()
  })

  it('marks a server that never answers failed, and closes its transport', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = connectMCPServer({
      cwd: '/p',
      name: 'slow',
      config: { type: 'http', url: 'http://localhost:1/mcp' },
      connectTimeoutMs: 5_000,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    const server = await pending
    expect(server.status).toBe('failed')
    expect(server.error).toMatch(/"slow" connection timed out after 5000ms/)
    expect(hung.closed).toBe(1)
  })
})
