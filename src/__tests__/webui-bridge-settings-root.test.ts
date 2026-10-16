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
 * The WebUI settings root: `ctx.homeDir`, else the host's `fs.userHome`. With no home the request is
 * refused (`host_unavailable`), nothing is written, and the next request asks again. The host's `fs.cwd`
 * is never asked.
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

type UserHomeAnswer = string | 'throw' | 'ok-false' | 'hang'

/**
 * A direct bridge answering `fs.userHome` with `answers[n]` on the n-th ask (the last answer repeats),
 * and `fs.cwd` with `/var/work/proj`. Counts both.
 */
function makeDirectBridge(...answers: UserHomeAnswer[]) {
  let userHomeCalls = 0
  let cwdCalls = 0
  const bridge: BrowserBridgeTransport = {
    async request(request) {
      const route = request.route as unknown as BrowserBridgeRoute
      if (route.capability === 'fs' && route.action === 'userHome') {
        const answer = answers[Math.min(userHomeCalls, answers.length - 1)]
        userHomeCalls++
        if (answer === 'hang') return new Promise(() => {})
        if (answer === 'throw') throw new Error('transport closed')
        if (answer === 'ok-false') {
          return {
            id: request.id,
            route: request.route,
            ok: false,
            error: { code: 'FS_ERROR', message: 'no home' },
          } as never
        }
        return { id: request.id, route: request.route, ok: true, result: answer } as never
      }
      if (route.capability === 'fs' && route.action === 'cwd') {
        cwdCalls++
        return { id: request.id, route: request.route, ok: true, result: '/var/work/proj' } as never
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

function makeCtx(fs: RuntimeFs, directBridge: BrowserBridgeTransport | null, homeDir = ''): WebUiBridgeContext {
  return { homeDir, fs, broadcastEvent: vi.fn(), directBridge }
}

beforeEach(() => {
  __resetFeatureRegistryForTests()
  __resetWebUiBridgeRegistryForTests()
  __resetBuiltinWebUiBridgeHandlersForTests()
  wipeSettingsMemos()
  registerFeature({ id: 'a', title: 'A', description: '', default: true })
  initBuiltinWebUiBridgeHandlers()
})

afterEach(() => {
  __resetBuiltinWebUiBridgeHandlersForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Call the `features` handler the way the hub does. */
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

const settingsAt = (root: string) => `${root}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

describe('WebUI settings root', () => {
  it('resolves the user home via fs.userHome when ctx.homeDir is empty', async () => {
    const { fs, files } = makeMemoryFs()
    const { bridge, getUserHomeCalls, getCwdCalls } = makeDirectBridge('/home/alice')

    const response = await callFeaturesHandler(
      makeRequest('setEnabled', { patch: { a: false } }),
      makeCtx(fs, bridge),
    )
    expect(response.ok).toBe(true)
    expect(getUserHomeCalls()).toBe(1)
    expect(getCwdCalls()).toBe(0)
    expect(JSON.parse(files.get(settingsAt('/home/alice'))!)).toMatchObject({
      version: 1,
      features: { a: false },
    })
  })

  it.each<[string, UserHomeAnswer]>([
    ['an empty answer', ''],
    ['an error answer', 'ok-false'],
    ['a transport error', 'throw'],
  ])('refuses on %s, writes nothing, and never asks fs.cwd', async (_label, answer) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fs, files } = makeMemoryFs()
    const { bridge, getCwdCalls } = makeDirectBridge(answer)

    await expect(
      callFeaturesHandler(makeRequest('setEnabled', { patch: { a: false } }), makeCtx(fs, bridge)),
    ).rejects.toMatchObject({ code: 'host_unavailable', retryable: true })
    expect(getCwdCalls()).toBe(0)
    expect(files.size).toBe(0)
  })

  it('does not cache a failed lookup: the next request asks again and finds the home', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fs, files } = makeMemoryFs()
    // First lookup: both asks fail. Second lookup: the host names the home.
    const { bridge, getUserHomeCalls } = makeDirectBridge('ok-false', 'ok-false', '/home/alice')
    const ctx = makeCtx(fs, bridge)

    await expect(callFeaturesHandler(makeRequest('catalog'), ctx)).rejects.toMatchObject({
      code: 'host_unavailable',
    })
    const response = await callFeaturesHandler(
      makeRequest('setEnabled', { patch: { a: false } }, 'req-2'),
      ctx,
    )
    expect(response.ok).toBe(true)
    expect(getUserHomeCalls()).toBe(3)
    expect(files.get(settingsAt('/home/alice'))).toBeDefined()
    expect(files.get(settingsAt('/var/work/proj'))).toBeUndefined()
  })

  it('a host that never answers is refused within the bound, not after the transport timeout', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fs } = makeMemoryFs()
    const { bridge, getCwdCalls } = makeDirectBridge('hang')

    const pending = callFeaturesHandler(makeRequest('catalog'), makeCtx(fs, bridge))
    const outcome = expect(pending).rejects.toMatchObject({ code: 'host_unavailable' })
    await vi.advanceTimersByTimeAsync(5_000)
    await outcome
    expect(getCwdCalls()).toBe(0)
  })

  it('caches a found home across requests', async () => {
    const { fs } = makeMemoryFs()
    const { bridge, getUserHomeCalls } = makeDirectBridge('/home/alice')
    const ctx = makeCtx(fs, bridge)

    await callFeaturesHandler(makeRequest('catalog'), ctx)
    await callFeaturesHandler(makeRequest('snapshot'), ctx)
    await callFeaturesHandler(makeRequest('catalog'), ctx)
    expect(getUserHomeCalls()).toBe(1)
  })

  it('prefers ctx.homeDir and asks the host nothing', async () => {
    const { fs, files } = makeMemoryFs()
    const { bridge, getUserHomeCalls, getCwdCalls } = makeDirectBridge('/home/from-bridge')

    await callFeaturesHandler(
      makeRequest('setEnabled', { patch: { a: false } }),
      makeCtx(fs, bridge, '/home/from-env'),
    )
    expect(getUserHomeCalls()).toBe(0)
    expect(getCwdCalls()).toBe(0)
    expect(files.get(settingsAt('/home/from-env'))).toBeDefined()
  })

  it('refuses with no home and no direct bridge, and writes nothing', async () => {
    const { fs, files } = makeMemoryFs()

    await expect(
      callFeaturesHandler(makeRequest('setEnabled', { patch: { a: false } }), makeCtx(fs, null)),
    ).rejects.toMatchObject({ code: 'host_unavailable' })
    expect(files.size).toBe(0)
  })

  it('coalesces concurrent first-time callers into one lookup', async () => {
    let userHomeCalls = 0
    let release: (() => void) | undefined
    const parked = new Promise<void>(resolve => {
      release = resolve
    })
    const bridge: BrowserBridgeTransport = {
      async request(request) {
        const route = request.route as unknown as BrowserBridgeRoute
        if (route.capability === 'fs' && route.action === 'userHome') {
          userHomeCalls++
          await parked
          return { id: request.id, route: request.route, ok: true, result: '/home/alice' } as never
        }
        throw new Error(`unexpected route ${route.capability}.${route.action}`)
      },
    }
    const { fs } = makeMemoryFs()

    const responses = Promise.all(
      ['r1', 'r2', 'r3', 'r4'].map(id => callFeaturesHandler(makeRequest('catalog', {}, id), makeCtx(fs, bridge))),
    )
    await new Promise(r => setTimeout(r, 50))
    expect(userHomeCalls).toBe(1)

    release!()
    const results = await responses
    expect(results.every(r => r.ok)).toBe(true)
    expect(userHomeCalls).toBe(1)
  })
})
