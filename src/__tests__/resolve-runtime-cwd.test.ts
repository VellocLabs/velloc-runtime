import { describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { resolveRuntimeCwd } from '../utils/resolveRuntimeCwd'

function createFakeRuntimeConfig(): RuntimeConfig {
  return {
    getEnv: () => undefined,
    flagOn: () => false,
    now: () => 0,
    createUUID: () => 'test-uuid',
    createTimestamp: () => '1970-01-01T00:00:00Z',
    getMaxStructuredOutputRetries: () => 5,
  }
}

function createMockTransport(
  responder: (route: { capability: string; action: string }) => unknown,
): BrowserBridgeTransport {
  return {
    request: vi.fn(
      async (req: {
        route: { namespace: string; capability: string; action: string }
      }) => {
        return responder(req.route)
      },
    ),
  } as unknown as BrowserBridgeTransport
}

describe('resolveRuntimeCwd', () => {
  it('returns initialCwd unchanged when it is already absolute (POSIX)', async () => {
    const transport = createMockTransport(() => ({
      ok: true,
      result: '/should-not-be-called',
    }))
    const resolved = await resolveRuntimeCwd({
      initialCwd: '/home/peijun/projects/foo',
      bridgeTransport: transport,
      runtimeConfig: createFakeRuntimeConfig(),
    })
    expect(resolved).toBe('/home/peijun/projects/foo')
    // Trust-initialCwd path: no bridge call needed.
    expect(transport.request).not.toHaveBeenCalled()
  })

  it('returns initialCwd unchanged when it is already absolute (Windows)', async () => {
    const transport = createMockTransport(() => {
      throw new Error('should not be called')
    })
    const resolved = await resolveRuntimeCwd({
      initialCwd: 'D:\\project\\shift\\nexus_web',
      bridgeTransport: transport,
      runtimeConfig: createFakeRuntimeConfig(),
    })
    expect(resolved).toBe('D:\\project\\shift\\nexus_web')
  })

  it('fetches from host when initialCwd is "."', async () => {
    const transport = createMockTransport(route => {
      expect(route.capability).toBe('fs')
      expect(route.action).toBe('cwd')
      return { ok: true, result: '/home/peijun/projects/foo' }
    })
    const resolved = await resolveRuntimeCwd({
      initialCwd: '.',
      bridgeTransport: transport,
      runtimeConfig: createFakeRuntimeConfig(),
    })
    expect(resolved).toBe('/home/peijun/projects/foo')
  })

  it('fetches from host when initialCwd is undefined', async () => {
    const transport = createMockTransport(() => ({
      ok: true,
      result: 'C:\\Users\\peijun\\projects\\foo',
    }))
    const resolved = await resolveRuntimeCwd({
      initialCwd: undefined,
      bridgeTransport: transport,
      runtimeConfig: createFakeRuntimeConfig(),
    })
    expect(resolved).toBe('C:\\Users\\peijun\\projects\\foo')
  })

  it('throws when both initialCwd and host return non-absolute', async () => {
    const transport = createMockTransport(() => ({
      ok: true,
      result: '',
    }))
    await expect(
      resolveRuntimeCwd({
        initialCwd: '.',
        bridgeTransport: transport,
        runtimeConfig: createFakeRuntimeConfig(),
      }),
    ).rejects.toThrow(/runtime_cwd_unresolved/)
  })

  it('throws when the bridge request itself fails', async () => {
    const transport = createMockTransport(() => {
      throw new Error('bridge down')
    })
    await expect(
      resolveRuntimeCwd({
        initialCwd: '.',
        bridgeTransport: transport,
        runtimeConfig: createFakeRuntimeConfig(),
      }),
    ).rejects.toThrow(/runtime_cwd_unresolved/)
  })

  it('rejects a relative initialCwd even when the host also returns relative', async () => {
    // Defense-in-depth: if both layers misbehave we still throw rather
    // than silently propagating a non-absolute path downstream.
    const transport = createMockTransport(() => ({
      ok: true,
      result: 'some/relative/path',
    }))
    await expect(
      resolveRuntimeCwd({
        initialCwd: 'relative/initial',
        bridgeTransport: transport,
        runtimeConfig: createFakeRuntimeConfig(),
      }),
    ).rejects.toThrow(/runtime_cwd_unresolved/)
  })

  it('accepts UNC paths as absolute on Windows', async () => {
    const transport = createMockTransport(() => {
      throw new Error('should not be called')
    })
    const resolved = await resolveRuntimeCwd({
      initialCwd: '\\\\server\\share\\project',
      bridgeTransport: transport,
      runtimeConfig: createFakeRuntimeConfig(),
    })
    expect(resolved).toBe('\\\\server\\share\\project')
  })
})
