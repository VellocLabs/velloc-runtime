import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserBridgeTransport } from '../../browser/bridge/protocol/core'
import { APP_UPDATE_PRIMITIVES, createBridgeAppUpdateHost } from '../../appUpdate/bridgeAppUpdateHost'
import { installRuntimeAppUpdate } from '../../appUpdate/runtimeAppUpdate'
import { configureAppUpdateService, currentAppUpdateService } from '../../appUpdate/appUpdateHolder'

type Req = { route: { capability: string; action: string }; payload: Record<string, unknown> }

/** A host port that serves only the routes the update host uses. */
function hostPort(opts: { status?: number; chunks?: Uint8Array[]; streamError?: string; osName?: string } = {}) {
  const log: string[] = []
  const appended: Array<{ path: string; bytes: number[] }> = []
  let chunks = [...(opts.chunks ?? [new Uint8Array([1, 2]), new Uint8Array([3])])]
  const persistent = [{ id: 'p1', command: 'x', logPath: 'l', startedMs: 0, running: false, exitCode: 0 }]
  const answer = (result: unknown) => ({ ok: true, result })
  const transport = {
    request: async (req: Req) => {
      const route = `${req.route.capability}.${req.route.action}`
      log.push(route)
      switch (route) {
        case 'network.streamOpen':
          return answer({ streamId: 's1', status: opts.status ?? 200, statusText: '', finalUrl: '', headers: {} })
        case 'network.streamRead': {
          const chunk = chunks.shift() ?? new Uint8Array(0)
          const done = chunks.length === 0
          return answer({ chunk, done, ...(done && opts.streamError ? { errorCode: opts.streamError } : {}) })
        }
        case 'network.streamCancel':
          return answer({ ok: true })
        case 'fs.appendFile':
          appended.push({ path: req.payload.path as string, bytes: [...(req.payload.data as Uint8Array)] })
          return answer({ ok: true })
        case 'fs.rm':
          return answer({ ok: true })
        case 'fs.paths':
          return answer({ home: 'C:\\Users\\u', temp: '', appData: '', cache: 'C:\\Users\\u\\AppData\\Local' })
        case 'shell.spawn':
          return answer({ persistentId: 'p1' })
        case 'shell.persistentList':
          return answer({ shells: persistent })
        case 'appInfo.getVersionInfo':
          return answer({ appVersion: '1.149.2.4', chromiumVersion: '149.0.0.0', osName: opts.osName ?? 'Windows NT 10.0.26200' })
        case 'appInfo.relaunch':
          return answer({ ok: true })
        default:
          return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: route } }
      }
    },
  } as unknown as BrowserBridgeTransport
  const set = (next: Uint8Array[]) => {
    chunks = next
  }
  return { transport, log, appended, persistent, set }
}

const fullManifest = { capabilities: [], primitives: [...APP_UPDATE_PRIMITIVES, 'shell.spawn.argv'] }
let n = 0
const deps = (transport: BrowserBridgeTransport) => ({
  transport: () => transport,
  manifest: () => fullManifest,
  createRequestId: () => `r${(n += 1)}`,
})

afterEach(() => {
  currentAppUpdateService()?.dispose()
  configureAppUpdateService(null)
})

describe('bridge update host', () => {
  it('streams the package into the file chunk by chunk, after clearing it', async () => {
    const port = hostPort({ chunks: [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4])] })
    const host = createBridgeAppUpdateHost(deps(port.transport))
    await host.download('https://example.com/p.exe', 'C:\\u\\p.exe.part')
    expect(port.log.filter(route => route !== 'fs.cwd')[0]).toBe('fs.rm')
    expect(port.appended).toEqual([
      { path: 'C:\\u\\p.exe.part', bytes: [1, 2] },
      { path: 'C:\\u\\p.exe.part', bytes: [3] },
      { path: 'C:\\u\\p.exe.part', bytes: [4] },
    ])
  })

  it('a non-200 package answer and a stream error both reject', async () => {
    await expect(
      createBridgeAppUpdateHost(deps(hostPort({ status: 404 }).transport)).download('https://e/p', 'C:\\p'),
    ).rejects.toThrow('package request answered 404')
    const broken = hostPort({ streamError: 'net::ERR_CONNECTION_RESET' })
    await expect(createBridgeAppUpdateHost(deps(broken.transport)).download('https://e/p', 'C:\\p')).rejects.toThrow(
      'download failed: net::ERR_CONNECTION_RESET',
    )
    expect(broken.log).toContain('network.streamCancel')
  })

  it('reads the manifest text and its status', async () => {
    const port = hostPort({ chunks: [new TextEncoder().encode('{"version":'), new TextEncoder().encode('"1"}')] })
    await expect(createBridgeAppUpdateHost(deps(port.transport)).fetchText('https://e/m.json', 1024)).resolves.toEqual({
      status: 200,
      text: '{"version":"1"}',
    })
  })

  it('places updates under the local cache and reports an install as finished once the host lists it ended', async () => {
    const port = hostPort()
    const host = createBridgeAppUpdateHost(deps(port.transport))
    await expect(host.updateRoot()).resolves.toBe('C:\\Users\\u\\AppData\\Local\\Velloc\\Update')
    await expect(host.startInstall('script', 'C:\\log')).resolves.toBe('p1')
    await expect(host.installRunning('p1')).resolves.toBe(false)
    port.persistent[0].running = true
    await expect(host.installRunning('p1')).resolves.toBe(true)
    await expect(host.installRunning('other')).resolves.toBeNull()
    await host.relaunch()
    expect(port.log.at(-1)).toBe('appInfo.relaunch')
  })
})

describe('installRuntimeAppUpdate', () => {
  it('starts only on an official channel', async () => {
    const port = hostPort()
    await expect(installRuntimeAppUpdate({ ...deps(port.transport), channel: () => null })).resolves.toBe(
      'not served from an official channel',
    )
    expect(currentAppUpdateService()).toBeNull()
  })

  it('needs every primitive it uses', async () => {
    const port = hostPort()
    const reason = await installRuntimeAppUpdate({
      ...deps(port.transport),
      manifest: () => ({ capabilities: [], primitives: ['fs.paths'] }),
      channel: () => 'stable',
    })
    expect(reason).toBe('host lacks network.streamOpen, shell.spawn.persist, shell.persistentList')
  })

  it('needs a Windows host', async () => {
    const port = hostPort({ osName: 'Mac OS X 15.0' })
    await expect(installRuntimeAppUpdate({ ...deps(port.transport), channel: () => 'stable' })).resolves.toBe(
      'not a Windows host',
    )
  })

  it('concurrent starts share one round trip and one service', async () => {
    const port = hostPort()
    const [a, b] = await Promise.all([
      installRuntimeAppUpdate({ ...deps(port.transport), channel: () => 'stable' }),
      installRuntimeAppUpdate({ ...deps(port.transport), channel: () => 'stable' }),
    ])
    expect([a, b]).toEqual([null, null])
    expect(port.log.filter(route => route === 'appInfo.getVersionInfo')).toHaveLength(1)
    expect(currentAppUpdateService()).not.toBeNull()
  })

  it('starts once on a qualifying host', async () => {
    const port = hostPort()
    await expect(installRuntimeAppUpdate({ ...deps(port.transport), channel: () => 'beta' })).resolves.toBeNull()
    const first = currentAppUpdateService()
    expect(first?.getState()).toEqual({ available: true, phase: 'idle' })
    await installRuntimeAppUpdate({ ...deps(port.transport), channel: () => 'beta' })
    expect(currentAppUpdateService()).toBe(first)
  })
})
