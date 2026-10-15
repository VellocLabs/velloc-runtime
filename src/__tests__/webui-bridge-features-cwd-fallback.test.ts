import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
} from '../browser/bridge/protocol/core'
import {
  __resetFeatureRegistryForTests,
  registerFeature,
} from '../skillLibrary/builtinSkills'
import { wipeSettingsMemos, NEXUS_SETTINGS_FILE_NAME } from '../settings/settingsStore'
import {
  __resetWebUiBridgeRegistryForTests,
  getWebUiBridgeHandler,
  type WebUiBridgeContext,
} from '../browser/worker/webUiBridge'
import {
  __resetBuiltinWebUiBridgeHandlersForTests,
  initBuiltinWebUiBridgeHandlers,
} from '../browser/worker/webUiBridge/initBuiltinHandlers'

/**
 * With `ctx.homeDir` empty, the features handler resolves the settings root via `fs.cwd` over the direct bridge
 * (`${cwd}/.velloc/settings.json`), cached across calls; with no direct bridge it falls back to '.'.
 */

function makeMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const fs: Partial<RuntimeFs> = {
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return content
    }),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    }),
    mkdir: vi.fn(async () => {}),
  }
  return { fs: fs as RuntimeFs, files }
}

/**
 * Build a stub direct bridge that intercepts `fs.userHome` and
 * `fs.cwd`, returning configurable absolute paths. The handler's
 * resolution chain consults userHome first, then cwd. `getCalls()`
 * returns the count for each so tests can assert caching + chain
 * traversal.
 */
function makeDirectBridge(opts: {
  userHome?: string
  cwd?: string
  userHomeError?: 'throw' | 'ok-false' | 'empty-result'
} = {}) {
  let userHomeCalls = 0
  let cwdCalls = 0
  const bridge: BrowserBridgeTransport = {
    async request(request) {
      const route = request.route as unknown as BrowserBridgeRoute
      if (route.capability === 'fs' && route.action === 'userHome') {
        userHomeCalls++
        if (opts.userHomeError === 'throw') {
          throw new Error('userHome route not implemented')
        }
        if (opts.userHomeError === 'ok-false') {
          return {
            id: request.id,
            route: request.route,
            ok: false,
            error: { code: 'unknown_action', message: 'older host' },
          } as never
        }
        return {
          id: request.id,
          route: request.route,
          ok: true,
          result: opts.userHomeError === 'empty-result' ? '' : (opts.userHome ?? ''),
        } as never
      }
      if (route.capability === 'fs' && route.action === 'cwd') {
        cwdCalls++
        return {
          id: request.id,
          route: request.route,
          ok: true,
          result: opts.cwd ?? '/fallback/cwd',
        } as never
      }
      throw new Error(`unexpected route ${route.capability}.${route.action}`)
    },
  }
  return {
    bridge,
    getUserHomeCalls: () => userHomeCalls,
    getCwdCalls: () => cwdCalls,
  }
}

function makeRequest(
  action: 'catalog' | 'snapshot' | 'setEnabled',
  payload: unknown = {},
  id = 'req-1',
): BrowserBridgeRequest {
  return {
    id,
    route: {
      namespace: 'nexus',
      capability: 'features',
      action,
    } as unknown as BrowserBridgeRoute,
    payload: payload as never,
  }
}

beforeEach(() => {
  __resetFeatureRegistryForTests()
  __resetWebUiBridgeRegistryForTests()
  __resetBuiltinWebUiBridgeHandlersForTests()
  wipeSettingsMemos()
})

afterEach(() => {
  __resetBuiltinWebUiBridgeHandlersForTests()
})

/**
 * Call the `features` handler the way the hub does.
 */
async function callFeaturesHandler(
  request: BrowserBridgeRequest,
  ctx: WebUiBridgeContext,
): Promise<BrowserBridgeResponse> {
  const handler = getWebUiBridgeHandler('features')
  if (!handler) {
    throw new Error('the features handler is not registered')
  }
  return handler(request, ctx)
}

describe('features handler settings-root resolution', () => {
  it('resolves user home via fs.userHome when ctx.homeDir is empty', async () => {
    registerFeature({ id: 'a', title: 'A', description: '', default: true })
    initBuiltinWebUiBridgeHandlers()

    const { fs, files } = makeMemoryFs()
    const { bridge, getUserHomeCalls, getCwdCalls } = makeDirectBridge({
      userHome: '/home/alice',
      cwd: '/var/work/proj',
    })

    const ctx: WebUiBridgeContext = {
      homeDir: '',
      fs,
      broadcastEvent: vi.fn(),
      directBridge: bridge,
    }

    // setEnabled on a feature writes the file. The path proves which
    // root the handler used.
    const response = await callFeaturesHandler(
      makeRequest('setEnabled', { patch: { a: false } }),
      ctx,
    )
    expect(response.ok).toBe(true)
    expect(getUserHomeCalls(), 'fs.userHome called once').toBe(1)
    expect(getCwdCalls(),
        'fs.cwd NOT called — userHome already gave a value').toBe(0)
    // File at the resolved HOME's `.velloc/` — the production
    // user-scope path. NOT under `/var/work/proj` (cwd).
    expect(
      JSON.parse(files.get(`/home/alice/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!),
    ).toMatchObject({ version: 1, features: { a: false } })
    expect(
      files.get(`/var/work/proj/.velloc/${NEXUS_SETTINGS_FILE_NAME}`),
    ).toBeUndefined()
  })

  it('falls back to fs.cwd when fs.userHome returns empty (no DIR_HOME)', async () => {
    registerFeature({ id: 'b', title: 'B', description: '', default: true })
    initBuiltinWebUiBridgeHandlers()

    const { fs, files } = makeMemoryFs()
    const { bridge, getUserHomeCalls, getCwdCalls } = makeDirectBridge({
      userHomeError: 'empty-result',
      cwd: '/var/work/proj',
    })

    const ctx: WebUiBridgeContext = {
      homeDir: '',
      fs,
      broadcastEvent: vi.fn(),
      directBridge: bridge,
    }
    await callFeaturesHandler(
      makeRequest('setEnabled', { patch: { b: false } }),
      ctx,
    )
    expect(getUserHomeCalls()).toBe(1)
    expect(getCwdCalls(),
        'fs.cwd called after empty userHome — fallback chain').toBe(1)
    // Settings file lands at the cwd fallback.
    expect(
      files.get(`/var/work/proj/.velloc/${NEXUS_SETTINGS_FILE_NAME}`),
    ).toBeDefined()
  })

  it('falls back to fs.cwd when fs.userHome returns ok:false (older host)', async () => {
    registerFeature({ id: 'c', title: 'C', description: '', default: true })
    initBuiltinWebUiBridgeHandlers()

    const { fs, files } = makeMemoryFs()
    const { bridge, getCwdCalls } = makeDirectBridge({
      userHomeError: 'ok-false',
      cwd: '/var/work/proj',
    })

    const ctx: WebUiBridgeContext = {
      homeDir: '',
      fs,
      broadcastEvent: vi.fn(),
      directBridge: bridge,
    }
    await callFeaturesHandler(
      makeRequest('setEnabled', { patch: { c: false } }),
      ctx,
    )
    expect(getCwdCalls()).toBe(1)
    expect(
      files.get(`/var/work/proj/.velloc/${NEXUS_SETTINGS_FILE_NAME}`),
    ).toBeDefined()
  })

  it('falls back to fs.cwd when fs.userHome throws (transport error)', async () => {
    registerFeature({ id: 'd', title: 'D', description: '', default: true })
    initBuiltinWebUiBridgeHandlers()

    const { fs, files } = makeMemoryFs()
    const { bridge, getCwdCalls } = makeDirectBridge({
      userHomeError: 'throw',
      cwd: '/var/work/proj',
    })

    const ctx: WebUiBridgeContext = {
      homeDir: '',
      fs,
      broadcastEvent: vi.fn(),
      directBridge: bridge,
    }
    await callFeaturesHandler(
      makeRequest('setEnabled', { patch: { d: false } }),
      ctx,
    )
    expect(getCwdCalls()).toBe(1)
    expect(
      files.get(`/var/work/proj/.velloc/${NEXUS_SETTINGS_FILE_NAME}`),
    ).toBeDefined()
  })

  it('caches the settings root across multiple features requests', async () => {
    registerFeature({ id: 'e', title: 'E', description: '', default: true })
    initBuiltinWebUiBridgeHandlers()

    const { fs } = makeMemoryFs()
    const { bridge, getUserHomeCalls } = makeDirectBridge({
      userHome: '/home/alice',
    })

    const ctx: WebUiBridgeContext = {
      homeDir: '',
      fs,
      broadcastEvent: vi.fn(),
      directBridge: bridge,
    }

    // Three round-trips, one fs.userHome lookup. The module-level
    // cache means subsequent features calls skip the bridge for the
    // settings root.
    await callFeaturesHandler(makeRequest('catalog'), ctx)
    await callFeaturesHandler(makeRequest('snapshot'), ctx)
    await callFeaturesHandler(makeRequest('catalog'), ctx)
    expect(getUserHomeCalls()).toBe(1)
  })

  it('prefers ctx.homeDir over the fs.userHome / fs.cwd chain when set', async () => {
    registerFeature({ id: 'f', title: 'F', description: '', default: true })
    initBuiltinWebUiBridgeHandlers()

    const { fs, files } = makeMemoryFs()
    const { bridge, getUserHomeCalls, getCwdCalls } = makeDirectBridge({
      userHome: '/home/from-bridge',
      cwd: '/var/work/proj',
    })

    const ctx: WebUiBridgeContext = {
      homeDir: '/home/from-env',
      fs,
      broadcastEvent: vi.fn(),
      directBridge: bridge,
    }

    await callFeaturesHandler(
      makeRequest('setEnabled', { patch: { f: false } }),
      ctx,
    )
    // ctx.homeDir won — neither bridge route was called.
    expect(getUserHomeCalls()).toBe(0)
    expect(getCwdCalls()).toBe(0)
    expect(
      files.get(`/home/from-env/.velloc/${NEXUS_SETTINGS_FILE_NAME}`),
    ).toBeDefined()
  })

  it('falls back to "." when ctx.homeDir is empty AND no direct bridge', async () => {
    registerFeature({ id: 'g', title: 'G', description: '', default: true })
    initBuiltinWebUiBridgeHandlers()

    const { fs, files } = makeMemoryFs()
    const ctx: WebUiBridgeContext = {
      homeDir: '',
      fs,
      broadcastEvent: vi.fn(),
      directBridge: null,
    }

    const response = await callFeaturesHandler(
      makeRequest('setEnabled', { patch: { g: false } }),
      ctx,
    )
    expect(response.ok).toBe(true)
    // File anchored at the relative '.' sentinel — the worker's fs
    // resolves it against whatever it considers root.
    expect(files.get(`./.velloc/${NEXUS_SETTINGS_FILE_NAME}`)).toBeDefined()
  })
})

/**
 * `resolveSettingsRoot` wraps each bridge call (fs.userHome → fs.cwd) in a 2s timeout, so it completes in ≤4s
 * when C++ never answers.
 */

/** Build a direct bridge whose `fs.userHome` / `fs.cwd` requests NEVER
 *  resolve. Used to simulate the C++-hangs failure mode. */
function makeNeverRespondingBridge(): BrowserBridgeTransport {
  return {
    async request(_request) {
      // A Promise that never resolves — the request is sent into the
      // void. The CALLER must apply its own timeout or wait forever.
      return new Promise(() => { /* never resolves */ })
    },
  }
}

describe('resolveSettingsRoot — short-timeout regression', () => {
  it(
    'completes in well under 60 seconds when fs.userHome and fs.cwd both hang',
    async () => {
      // The bug: the WebUI gives the worker handler 60s before
      // declaring a timeout. If resolveSettingsRoot takes the full 60s
      // (two 30s sequential transport timeouts), the WebUI shows the
      // page stuck on "Loading…". Fix: short-circuit each bridge call
      // at 2s so total is ≤4s even when C++ is completely silent.
      registerFeature({ id: 'a', title: 'A', description: '', default: true })
      initBuiltinWebUiBridgeHandlers()

      // Suppress the expected console.warn from the timeout path so
      // test output stays clean — the warn is the diagnostic that
      // tells a real user what happened, but here we EXPECT it.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const { fs } = makeMemoryFs()
      const ctx: WebUiBridgeContext = {
        homeDir: '',
        fs,
        broadcastEvent: vi.fn(),
        directBridge: makeNeverRespondingBridge(),
      }

      const t0 = Date.now()
      const response = await callFeaturesHandler(
        makeRequest('catalog'),
        ctx,
      )
      const elapsed = Date.now() - t0

      // The catalog request still succeeds — fallback path is `.` for
      // the settings root. The handler doesn't need disk for catalog
      // anyway (it's an in-memory registry).
      expect(response.ok).toBe(true)
      // Critical: completed in WELL under 60s. With the fix this is
      // ~4s (two 2s timeouts); without the fix it was ~60s. We assert
      // <15s to leave headroom for slow CI without losing the signal.
      expect(elapsed).toBeLessThan(15_000)
      // And both fallback warns fired (userHome + cwd timeouts).
      expect(warnSpy).toHaveBeenCalled()

      warnSpy.mockRestore()
    },
    20_000, // test timeout — generous, real run is ~4s.
  )

  it(
    'a hanging userHome but a fast cwd resolves quickly via cwd fallback',
    async () => {
      registerFeature({ id: 'b', title: 'B', description: '', default: true })
      initBuiltinWebUiBridgeHandlers()

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // userHome hangs; cwd answers immediately.
      const bridge: BrowserBridgeTransport = {
        async request(request) {
          const route = request.route as unknown as BrowserBridgeRoute
          if (route.capability === 'fs' && route.action === 'userHome') {
            return new Promise(() => { /* hang */ })
          }
          if (route.capability === 'fs' && route.action === 'cwd') {
            return {
              id: request.id,
              route: request.route,
              ok: true,
              result: '/var/work/proj',
            } as never
          }
          throw new Error(`unexpected route ${route.capability}.${route.action}`)
        },
      }

      const { fs, files } = makeMemoryFs()
      const ctx: WebUiBridgeContext = {
        homeDir: '',
        fs,
        broadcastEvent: vi.fn(),
        directBridge: bridge,
      }

      const t0 = Date.now()
      const response = await callFeaturesHandler(
        makeRequest('setEnabled', { patch: { b: false } }),
        ctx,
      )
      const elapsed = Date.now() - t0
      expect(response.ok).toBe(true)
      // Total wait: ~2s for the userHome timeout, then near-instant cwd.
      expect(elapsed).toBeLessThan(5_000)
      // Settings file landed at the resolved cwd, not the '.' fallback.
      expect(
        files.get(`/var/work/proj/.velloc/${NEXUS_SETTINGS_FILE_NAME}`),
      ).toBeDefined()
      warnSpy.mockRestore()
    },
    10_000,
  )

  it('coalesces concurrent first-time callers into one resolution', async () => {
    registerFeature({ id: 'c', title: 'C', description: '', default: true })
    initBuiltinWebUiBridgeHandlers()

    let userHomeCalls = 0
    let resolveUserHome: ((value: unknown) => void) | undefined
    const userHomePromise = new Promise<unknown>(resolve => {
      resolveUserHome = resolve
    })
    const bridge: BrowserBridgeTransport = {
      async request(request) {
        const route = request.route as unknown as BrowserBridgeRoute
        if (route.capability === 'fs' && route.action === 'userHome') {
          userHomeCalls++
          // Park until the test releases.
          await userHomePromise
          return {
            id: request.id,
            route: request.route,
            ok: true,
            result: '/home/alice',
          } as never
        }
        throw new Error(`unexpected route ${route.capability}.${route.action}`)
      },
    }
    const { fs } = makeMemoryFs()
    const makeCtx = (): WebUiBridgeContext => ({
      homeDir: '',
      fs,
      broadcastEvent: vi.fn(),
      directBridge: bridge,
    })

    // Fire 4 concurrent requests — the production WebUI page opens
    // features + plugins + agent + mcpSettings together on first
    // mount. The fix's `inFlightResolution` latch should collapse
    // them into a single userHome bridge call.
    const responses = Promise.all([
      callFeaturesHandler(makeRequest('catalog'), makeCtx()),
      callFeaturesHandler(makeRequest('catalog', {}, 'r2'), makeCtx()),
      callFeaturesHandler(makeRequest('catalog', {}, 'r3'), makeCtx()),
      callFeaturesHandler(makeRequest('catalog', {}, 'r4'), makeCtx()),
    ])
    // Let the microtask queue drain — by now all 4 should be parked
    // on the same `inFlightResolution` promise.
    await new Promise(r => setTimeout(r, 50))
    expect(userHomeCalls).toBe(1)

    // Release; all 4 complete.
    resolveUserHome!({})
    const results = await responses
    expect(results.every(r => r.ok)).toBe(true)
    // Still just 1 bridge call total.
    expect(userHomeCalls).toBe(1)
  })
})
