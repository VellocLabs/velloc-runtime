import { describe, expect, it, vi } from 'vitest'
import { resolveHomeDirViaBridgeBounded } from '../utils/resolveHomeDirViaBridge'

// A transport whose `fs.userHome` answers immediately with `home`.
function fastTransport(home: string) {
  return {
    request: async () => ({ ok: true as const, result: home }),
  } as unknown as Parameters<typeof resolveHomeDirViaBridgeBounded>[0]
}

// A transport that receives the request but NEVER answers (the web-deployment /
// un-rebuilt-host case the timeout exists for).
function hangingTransport() {
  return {
    request: () => new Promise(() => {}),
  } as unknown as Parameters<typeof resolveHomeDirViaBridgeBounded>[0]
}

describe('resolveHomeDirViaBridgeBounded', () => {
  it('resolves the host home dir and reports no timeout', async () => {
    const result = await resolveHomeDirViaBridgeBounded(
      fastTransport('/home/user'),
      5_000,
    )
    expect(result).toEqual({ home: '/home/user', timedOut: false })
  })

  it('reports timedOut when the host never answers', async () => {
    vi.useFakeTimers()
    try {
      const pending = resolveHomeDirViaBridgeBounded(hangingTransport(), 5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(pending).resolves.toEqual({ home: null, timedOut: true })
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression: the previous inline `Promise.race([probe, setTimeout(...)])` left
  // the timeout's `setTimeout` scheduled even after a fast host won the race, so
  // its callback fired ~8s after a SUCCESSFUL resolve and logged a spurious
  // "timed out … falling back" warning on every boot. The timer must be cleared.
  it('leaves no pending timer after a fast resolve (no spurious late timeout)', async () => {
    vi.useFakeTimers()
    try {
      const result = await resolveHomeDirViaBridgeBounded(
        fastTransport('/home/user'),
        5_000,
      )
      expect(result.timedOut).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('null transport → no home, not a timeout', async () => {
    const result = await resolveHomeDirViaBridgeBounded(undefined, 5_000)
    expect(result).toEqual({ home: null, timedOut: false })
  })
})
