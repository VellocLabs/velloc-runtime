import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserBridgeRequest,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
} from '../browser/bridge/protocol/core'
import {
  combineTracerSignals,
  loadAgentTracerFlags,
  resolveTracerFlagsWithinBudget,
  type AgentTracerFlags,
} from '../browser/boot/loadAgentTracerFlags'
import { wipeSettingsMemos } from '../settings/settingsStore'

beforeEach(() => {
  // The settings module's cache survives across calls within a process.
  // Reset between tests so a previous test's parsed settings.json
  // doesn't leak into the next.
  wipeSettingsMemos()
})

/**
 * Page-thread tracer flags: `agent.log` / `agent.trace` are read from settings.json over the bridge (stub
 * transport); URL params win on an explicit dev opt-in; a missing file, a bridge error or a missing `agent` section
 * yields `{ log: false, trace: false }`.
 */

function makeStubBridge(opts: {
  userHome?: string
  cwd?: string
  /** Map of (path → settings.json body) — readFile returns the body
   *  on hit, throws ENOENT on miss. Mirrors the in-memory fs other
   *  tests use, but routed through the bridge interface so we can
   *  call `loadAgentTracerFlags(transport)` directly. */
  files?: Record<string, string>
  /** When set, every userHome request fails this way. */
  userHomeMode?: 'throw' | 'ok-false' | 'empty'
} = {}) {
  const files = opts.files ?? {}
  const calls = {
    userHome: 0,
    cwd: 0,
    readFile: [] as string[],
  }
  const transport: BrowserBridgeTransport = {
    async request(request) {
      const route = request.route as unknown as BrowserBridgeRoute
      if (route.capability === 'fs' && route.action === 'userHome') {
        calls.userHome++
        if (opts.userHomeMode === 'throw') {
          throw new Error('userHome transport error')
        }
        if (opts.userHomeMode === 'ok-false') {
          return {
            id: request.id, route: request.route,
            ok: false,
            error: { code: 'unknown_action', message: '' },
          } as never
        }
        return {
          id: request.id, route: request.route,
          ok: true,
          result: opts.userHomeMode === 'empty' ? '' : (opts.userHome ?? ''),
        } as never
      }
      if (route.capability === 'fs' && route.action === 'cwd') {
        calls.cwd++
        return {
          id: request.id, route: request.route,
          ok: true,
          result: opts.cwd ?? '',
        } as never
      }
      if (route.capability === 'fs' && route.action === 'readFile') {
        const path = (request.payload as { path: string }).path
        calls.readFile.push(path)
        const body = files[path]
        if (body === undefined) {
          return {
            id: request.id, route: request.route,
            ok: false,
            error: { code: 'ENOENT', message: `not found: ${path}` },
          } as never
        }
        // The fs.readFile bridge route returns binary bytes (the
        // `BrowserFsOperations` adapter wraps the result in a
        // TextDecoder). Match that contract here so the
        // production path through the helper exercises decode.
        return {
          id: request.id, route: request.route,
          ok: true,
          result: new TextEncoder().encode(body),
        } as never
      }
      throw new Error(`unexpected route ${route.capability}.${route.action}`)
    },
  }
  return { transport, calls }
}

describe('loadAgentTracerFlags', () => {
  it('reads agent.log + agent.trace from settings.json via the bridge', async () => {
    const { transport } = makeStubBridge({
      userHome: '/home/alice',
      files: {
        '/home/alice/.velloc/settings.json': JSON.stringify({
          version: 1,
          agent: { log: true, trace: false },
        }),
      },
    })
    const flags = await loadAgentTracerFlags(transport)
    expect(flags).toEqual({ log: true, trace: false })
  })

  it('returns false flags when the settings file is missing', async () => {
    const { transport } = makeStubBridge({
      userHome: '/home/alice',
      files: {},
    })
    const flags = await loadAgentTracerFlags(transport)
    expect(flags).toEqual({ log: false, trace: false })
  })

  it('returns false flags when the agent section is absent', async () => {
    const { transport } = makeStubBridge({
      userHome: '/home/alice',
      files: {
        '/home/alice/.velloc/settings.json': JSON.stringify({
          version: 1,
          features: { 'some.feature': true },
        }),
      },
    })
    const flags = await loadAgentTracerFlags(transport)
    expect(flags).toEqual({ log: false, trace: false })
  })

  it('does not read settings under fs.cwd when fs.userHome returns empty', async () => {
    const { transport, calls } = makeStubBridge({
      userHomeMode: 'empty',
      cwd: '/var/work',
      files: {
        '/var/work/.velloc/settings.json': JSON.stringify({
          version: 1,
          agent: { log: true },
        }),
      },
    })
    const flags = await loadAgentTracerFlags(transport)
    expect(flags).toEqual({ log: false, trace: false })
    expect(calls.readFile).toEqual([])
  })

  it('does not read settings under fs.cwd when fs.userHome throws', async () => {
    const { transport, calls } = makeStubBridge({
      userHomeMode: 'throw',
      cwd: '/var/work',
      files: {
        '/var/work/.velloc/settings.json': JSON.stringify({
          version: 1,
          agent: { trace: true },
        }),
      },
    })
    const flags = await loadAgentTracerFlags(transport)
    expect(flags).toEqual({ log: false, trace: false })
    expect(calls.userHome).toBe(2)
    expect(calls.readFile).toEqual([])
  })

  it('returns false flags when neither home resolution path works', async () => {
    const { transport } = makeStubBridge({
      userHomeMode: 'throw',
      cwd: '',
      // No files — even if cwd had resolved, no settings.json exists.
    })
    const flags = await loadAgentTracerFlags(transport)
    expect(flags).toEqual({ log: false, trace: false })
  })

  it('returns false flags on malformed settings.json', async () => {
    const { transport } = makeStubBridge({
      userHome: '/home/alice',
      files: {
        '/home/alice/.velloc/settings.json': 'not json {{{',
      },
    })
    const flags = await loadAgentTracerFlags(transport)
    expect(flags).toEqual({ log: false, trace: false })
  })

  it('never throws — bridge transport errors are absorbed', async () => {
    // Worst-case stub: every request throws.
    const transport: BrowserBridgeTransport = {
      async request() {
        throw new Error('all routes broken')
      },
    }
    const flags = await loadAgentTracerFlags(transport)
    expect(flags).toEqual({ log: false, trace: false })
  })
})

// nexusBoot races the settings read against a 1s boot budget; resolveTracerFlagsWithinBudget keeps the budget but
// fires the late callback when a slow read lands, so the page still installs the tracer.
describe('resolveTracerFlagsWithinBudget', () => {
  it('returns the read result when it beats the budget; no late callback', async () => {
    const onLate = vi.fn()
    const flags = await resolveTracerFlagsWithinBudget(
      Promise.resolve({ log: false, trace: true }),
      1_000,
      onLate,
    )
    expect(flags).toEqual({ log: false, trace: true })
    // Let any (buggy) continuation microtasks flush before asserting.
    await Promise.resolve()
    await Promise.resolve()
    expect(onLate).not.toHaveBeenCalled()
  })

  it('degrades to false flags on timeout, then fires the late callback when the slow read resolves', async () => {
    vi.useFakeTimers()
    try {
      let resolveRead!: (flags: AgentTracerFlags) => void
      const read = new Promise<AgentTracerFlags>(resolve => {
        resolveRead = resolve
      })
      const onLate = vi.fn()
      const racing = resolveTracerFlagsWithinBudget(read, 1_000, onLate)
      await vi.advanceTimersByTimeAsync(1_000)
      // Boot proceeds with the fallback…
      expect(await racing).toEqual({ log: false, trace: false })
      expect(onLate).not.toHaveBeenCalled()
      // …and the late result still applies instead of being dropped.
      resolveRead({ log: false, trace: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(onLate).toHaveBeenCalledTimes(1)
      expect(onLate).toHaveBeenCalledWith({ log: false, trace: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays quiet when the late result has nothing enabled', async () => {
    vi.useFakeTimers()
    try {
      let resolveRead!: (flags: AgentTracerFlags) => void
      const read = new Promise<AgentTracerFlags>(resolve => {
        resolveRead = resolve
      })
      const onLate = vi.fn()
      const racing = resolveTracerFlagsWithinBudget(read, 1_000, onLate)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await racing).toEqual({ log: false, trace: false })
      resolveRead({ log: false, trace: false })
      await vi.advanceTimersByTimeAsync(0)
      // A late all-off result changes nothing — no callback churn.
      expect(onLate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('combineTracerSignals', () => {
  it('URL params alone turn on the bus', () => {
    expect(combineTracerSignals(
      { log: true, trace: false, traceModelRequests: false },
      { log: false, trace: false },
    )).toEqual({ enableBus: true, enableOverlay: false })

    expect(combineTracerSignals(
      { log: false, trace: false, traceModelRequests: true },
      { log: false, trace: false },
    )).toEqual({ enableBus: true, enableOverlay: false })
  })

  it("URL `trace=1` turns on BOTH bus and overlay", () => {
    expect(combineTracerSignals(
      { log: false, trace: true, traceModelRequests: false },
      { log: false, trace: false },
    )).toEqual({ enableBus: true, enableOverlay: true })
  })

  it('settings.json `log` alone turns on the bus (not the overlay)', () => {
    expect(combineTracerSignals(
      { log: false, trace: false, traceModelRequests: false },
      { log: true, trace: false },
    )).toEqual({ enableBus: true, enableOverlay: false })
  })

  it('settings.json `trace` turns on BOTH bus and overlay', () => {
    expect(combineTracerSignals(
      { log: false, trace: false, traceModelRequests: false },
      { log: false, trace: true },
    )).toEqual({ enableBus: true, enableOverlay: true })
  })

  it('both signals additive — URL log + settings trace = both on', () => {
    expect(combineTracerSignals(
      { log: true, trace: false, traceModelRequests: false },
      { log: false, trace: true },
    )).toEqual({ enableBus: true, enableOverlay: true })
  })

  it('neither signal set → both off', () => {
    expect(combineTracerSignals(
      { log: false, trace: false, traceModelRequests: false },
      { log: false, trace: false },
    )).toEqual({ enableBus: false, enableOverlay: false })
  })
})
