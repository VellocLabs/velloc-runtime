/**
 * The typed wrappers over the additive native primitives (`browser/bridge/nativePrimitives.ts`, P-3) degrade on an
 * older host: an unlisted primitive is never called; NOT_IMPLEMENTED reads as unsupported; the ignore-if-absent
 * variants need a positive manifest listing. Plus each wrapper's wire shape and event filtering.
 */
import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  createNativePrimitives,
  isNativePrimitiveUnsupported,
  isPreconditionFailed,
  NativePrimitiveError,
} from '../browser/bridge/nativePrimitives'
import { __test_only_directPortRoutePolicy } from '../browser/bridge/DirectPortBridgeTransport'
import { normalizeBrowserHostManifest } from '../browser/bridge/protocol/manifest'
import type {
  BridgeEventEnvelope,
  BridgeEventHandler,
  BrowserBridgeRequest,
  BrowserBridgeTransport,
} from '../browser/bridge/browserBridgeProtocol'

type Reply =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }

/** A transport that records requests, answers from `answer`, and lets a test
 *  push host events. */
function fakeTransport(answer: (request: BrowserBridgeRequest) => Reply) {
  const requests: BrowserBridgeRequest[] = []
  const handlers = new Set<BridgeEventHandler>()
  const transport: BrowserBridgeTransport = {
    async request(request) {
      requests.push(request as BrowserBridgeRequest)
      const reply = answer(request as BrowserBridgeRequest)
      return { id: request.id, route: request.route, ...reply } as never
    },
    subscribeEvents(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
  const emit = (capability: string, action: string, payload: unknown) => {
    const event = {
      route: { namespace: 'nexus', capability, action },
      payload,
    } as BridgeEventEnvelope
    for (const handler of Array.from(handlers)) handler(event)
  }
  return { transport, requests, emit, handlerCount: () => handlers.size }
}

const ALL_PRIMITIVES = [
  'fs.watch',
  'fs.copyFile',
  'fs.symlink',
  'fs.readlink',
  'fs.chmod',
  'fs.writeFile.ifMatch',
  'fs.paths',
  'shell.spawn.argv',
  'shell.spawn.pty',
  'shell.spawn.persist',
  'shell.persistentList',
  'shell.persistentKill',
  'shell.env',
  'shell.spawn.secretEnv',
  'network.streamOpen',
  'network.secretTemplates',
  'network.wsOpen',
  'network.oauthTemplates',
  'model.rawStreamOpen.oauth',
  'appInfo.purgeRenderCaches',
]

function make(
  answer: (request: BrowserBridgeRequest) => Reply,
  // `null` = no manifest at all (an `undefined` argument would take the
  // default).
  manifest: { capabilities: string[]; primitives?: string[] } | null = {
    capabilities: ['fs', 'shell', 'network', 'secrets', 'alarms'],
    primitives: ALL_PRIMITIVES,
  },
) {
  const fake = fakeTransport(answer)
  let n = 0
  const primitives = createNativePrimitives({
    transport: fake.transport,
    createRequestId: () => `req-${++n}`,
    manifest: manifest ?? undefined,
  })
  return { ...fake, primitives }
}

const ok = (result: unknown): Reply => ({ ok: true, result })
const routeOf = (request: BrowserBridgeRequest) =>
  `${request.route.capability}.${String(request.route.action)}`

describe('the manifest gate', () => {
  it('never calls a primitive the manifest does not list', async () => {
    const { primitives, requests } = make(() => ok({ ok: true }), {
      capabilities: ['fs'],
      primitives: [],
    })
    await expect(primitives.fs.copyFile('a', 'b')).rejects.toSatisfy(
      isNativePrimitiveUnsupported,
    )
    expect(requests).toHaveLength(0)
  })

  it('reads NOT_IMPLEMENTED (an older host) as unsupported', async () => {
    const { primitives } = make(
      () => ({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Unsupported action' } }),
      null, // no manifest: the call goes out
    )
    await expect(primitives.fs.readlink('/x')).rejects.toSatisfy(isNativePrimitiveUnsupported)
  })

  it('refuses the ignore-if-absent variants without a positive listing', async () => {
    const { primitives, requests } = make(() => ok({ ok: true }), null)
    await expect(
      primitives.fs.writeFileIfMatch('/f', new Uint8Array([1]), { mtimeMs: 1, size: 1 }),
    ).rejects.toSatisfy(isNativePrimitiveUnsupported)
    await expect(
      primitives.shell.spawnPersistent({ file: 'node', logPath: '/l.log' }),
    ).rejects.toSatisfy(isNativePrimitiveUnsupported)
    await expect(
      primitives.network.streamOpen({
        url: 'https://a.example',
        body: new Uint8Array(),
        headers: { Authorization: 'Bearer {{secret:provider:a}}' },
      }),
    ).rejects.toSatisfy(isNativePrimitiveUnsupported)
    expect(requests).toHaveLength(0)
  })

  it('gates secrets and alarms on the advertised capability', async () => {
    const { primitives, requests } = make(() => ok({}), {
      capabilities: ['fs'],
      primitives: ALL_PRIMITIVES,
    })
    await expect(primitives.secrets.has('mcp:x')).rejects.toSatisfy(isNativePrimitiveUnsupported)
    await expect(primitives.alarms.list()).rejects.toSatisfy(isNativePrimitiveUnsupported)
    expect(requests).toHaveLength(0)
  })

  it('surfaces any other host error with its code', async () => {
    const { primitives } = make(() => ({
      ok: false,
      error: { code: 'FS_ERROR', message: 'EEXIST: the destination already exists' },
    }))
    const error = await primitives.fs.copyFile('a', 'b').catch(e => e)
    expect(error).toBeInstanceOf(NativePrimitiveError)
    expect((error as NativePrimitiveError).code).toBe('FS_ERROR')
  })
})

describe('fs', () => {
  it('watch delivers only its own bursts, including one that beat the reply', async () => {
    let emitEarly: (() => void) | null = null
    const fake = make(request => {
      if (routeOf(request) === 'fs.watch') {
        emitEarly?.()
        return ok({ watchId: 'w7', mode: 'native' })
      }
      return ok({ found: true })
    })
    emitEarly = () =>
      fake.emit('fs', 'onChange', { watchId: 'w7', paths: ['/p/early'], kind: 'created' })
    const seen: string[][] = []
    const handle = await fake.primitives.fs.watch('/p', { recursive: true }, change =>
      seen.push(change.paths),
    )
    expect(handle).toMatchObject({ watchId: 'w7', mode: 'native' })
    expect(fake.requests[0]!.payload).toEqual({ path: '/p', recursive: true })

    fake.emit('fs', 'onChange', { watchId: 'w7', paths: ['/p/a'], kind: 'modified' })
    fake.emit('fs', 'onChange', { watchId: 'w8', paths: ['/other'], kind: 'modified' })
    expect(seen).toEqual([['/p/early'], ['/p/a']])

    await handle.close()
    await handle.close() // idempotent
    expect(fake.requests.filter(r => routeOf(r) === 'fs.unwatch')).toHaveLength(1)
    fake.emit('fs', 'onChange', { watchId: 'w7', paths: ['/p/late'], kind: 'modified' })
    expect(seen).toHaveLength(2)
    expect(fake.handlerCount()).toBe(0)
  })

  it('a failed watch leaves no listener behind', async () => {
    const fake = make(() => ({
      ok: false,
      error: { code: 'TOO_MANY_WATCHES', message: 'at most 64' },
    }))
    await expect(fake.primitives.fs.watch('/p', {}, () => {})).rejects.toBeInstanceOf(
      NativePrimitiveError,
    )
    expect(fake.handlerCount()).toBe(0)
  })

  it('writeFileIfMatch sends the precondition and returns the next one', async () => {
    const fake = make(() => ok({ ok: true, mtimeMs: 20, size: 3 }))
    const next = await fake.primitives.fs.writeFileIfMatch(
      '/f',
      new Uint8Array([1, 2, 3]),
      { mtimeMs: 10, size: 1 },
    )
    expect(next).toEqual({ mtimeMs: 20, size: 3 })
    expect(fake.requests[0]!.payload).toMatchObject({ path: '/f', ifMatch: { mtimeMs: 10, size: 1 } })
  })

  it('a lost compare-and-swap is PRECONDITION_FAILED', async () => {
    const fake = make(() => ({
      ok: false,
      error: { code: 'PRECONDITION_FAILED', message: 'The file changed since it was read.' },
    }))
    const error = await fake.primitives.fs
      .writeFileIfMatch('/f', new Uint8Array(), { mtimeMs: 1, size: 0 })
      .catch(e => e)
    expect(isPreconditionFailed(error)).toBe(true)
  })

  it('copyFile / symlink / readlink / chmod / paths speak their wire shapes', async () => {
    const fake = make(request => {
      switch (routeOf(request)) {
        case 'fs.readlink':
          return ok({ target: '/real' })
        case 'fs.chmod':
          return ok({ applied: false })
        case 'fs.paths':
          return ok({ home: '/h', temp: '/t', appData: '/a', cache: '/c' })
        default:
          return ok({ ok: true })
      }
    })
    await fake.primitives.fs.copyFile('/a', '/b', { overwrite: true })
    await fake.primitives.fs.symlink('/real', '/link')
    expect(await fake.primitives.fs.readlink('/link')).toBe('/real')
    expect(await fake.primitives.fs.chmod('/x', 0o755)).toBe(false)
    expect(await fake.primitives.fs.paths()).toEqual({
      home: '/h',
      temp: '/t',
      appData: '/a',
      cache: '/c',
    })
    expect(fake.requests.map(r => [routeOf(r), r.payload])).toEqual([
      ['fs.copyFile', { src: '/a', dst: '/b', overwrite: true }],
      ['fs.symlink', { target: '/real', path: '/link' }],
      ['fs.readlink', { path: '/link' }],
      ['fs.chmod', { path: '/x', mode: 0o755 }],
      ['fs.paths', {}],
    ])
  })
})

describe('shell', () => {
  it('spawnArgv sends the argv form and spawnPersistent the persist field', async () => {
    const fake = make(request =>
      (request.payload as { persist?: unknown }).persist
        ? ok({ persistentId: 'persist-1' })
        : ok({ streamId: 'stream-1' }),
    )
    expect(
      await fake.primitives.shell.spawnArgv({ file: 'node', args: ['-v'] }),
    ).toEqual({ streamId: 'stream-1' })
    expect(
      await fake.primitives.shell.spawnPersistent({
        file: 'node',
        args: ['server.js'],
        logPath: '/logs/server.log',
      }),
    ).toEqual({ persistentId: 'persist-1' })
    expect(fake.requests[0]!.payload).toEqual({ file: 'node', args: ['-v'] })
    expect(fake.requests[1]!.payload).toEqual({
      file: 'node',
      args: ['server.js'],
      persist: { logPath: '/logs/server.log' },
    })
  })

  it('an env {{secret:NAME}} needs shell.spawn.secretEnv listed, on every spawn form', async () => {
    const answer = (request: BrowserBridgeRequest) =>
      (request.payload as { persist?: unknown }).persist ? ok({ persistentId: 'p' }) : ok({ streamId: 's' })
    const env = { API_KEY: '{{secret:mcp.foo.env.API_KEY}}' }
    const without = make(answer, {
      capabilities: ['fs', 'shell', 'network', 'secrets', 'alarms'],
      primitives: ALL_PRIMITIVES.filter(p => p !== 'shell.spawn.secretEnv'),
    })
    await expect(without.primitives.shell.spawnArgv({ file: 'srv', env })).rejects.toSatisfy(isNativePrimitiveUnsupported)
    await expect(
      without.primitives.shell.spawnPersistent({ shell: 'bash', command: 'srv', logPath: '/l', env }),
    ).rejects.toSatisfy(isNativePrimitiveUnsupported)
    await expect(without.primitives.shell.spawnArgvStream({ file: 'srv', env }, {})).rejects.toSatisfy(isNativePrimitiveUnsupported)
    await expect(
      without.primitives.shell.spawnShellStream({ shell: 'bash', command: 'srv', env }, {}),
    ).rejects.toSatisfy(isNativePrimitiveUnsupported)
    expect(without.requests).toHaveLength(0)
    // A plain env needs nothing; a listed host gets the placeholder.
    expect(await without.primitives.shell.spawnArgv({ file: 'srv', env: { A: 'b' } })).toEqual({ streamId: 's' })
    const listed = make(answer)
    expect(await listed.primitives.shell.spawnArgv({ file: 'srv', env })).toEqual({ streamId: 's' })
  })

  it('a host that ignored persist (no persistentId) is unsupported, not success', async () => {
    const fake = make(() => ok({ streamId: 'stream-1' }))
    await expect(
      fake.primitives.shell.spawnPersistent({ shell: 'bash', command: 'x', logPath: '/l' }),
    ).rejects.toSatisfy(isNativePrimitiveUnsupported)
  })

  it('spawnPty needs shell.spawn.pty listed: an older host would run a pipe child', async () => {
    const without = make(() => ok({ streamId: 's' }), {
      capabilities: ['fs', 'shell'],
      primitives: ALL_PRIMITIVES.filter(p => p !== 'shell.spawn.pty'),
    })
    await expect(
      without.primitives.shell.spawnPty({ file: 'pwsh' }, { cols: 80, rows: 24 }, {}),
    ).rejects.toSatisfy(isNativePrimitiveUnsupported)
    expect(without.requests).toHaveLength(0)
    expect(without.handlerCount()).toBe(0)
  })

  it('spawnPty sends the argv form with pty, hears its own child only, and resize goes to shell.resize', async () => {
    const fake = make(request => (routeOf(request) === 'shell.resize' ? ok({ found: true }) : ok({ streamId: 'pty-1' })))
    const output: string[] = []
    const exits: number[] = []
    const child = await fake.primitives.shell.spawnPty(
      { file: 'pwsh', args: ['-NoLogo'], cwd: '/p' },
      { cols: 80, rows: 24 },
      {
        onOutput: (_stream, bytes) => output.push(new TextDecoder().decode(bytes)),
        onExit: exit => exits.push(exit.exitCode),
      },
    )
    expect(fake.requests[0]!.payload).toEqual({ file: 'pwsh', args: ['-NoLogo'], cwd: '/p', pty: { cols: 80, rows: 24 } })
    expect(child.streamId).toBe('pty-1')
    expect(await child.resize(100, 30)).toBe(true)
    expect(routeOf(fake.requests[1]!)).toBe('shell.resize')
    expect(fake.requests[1]!.payload).toEqual({ streamId: 'pty-1', cols: 100, rows: 30 })
    // The resize payload is plain JSON on the direct port: no binary field, no route policy entry needed.
    expect(__test_only_directPortRoutePolicy.shell?.resize).toBeUndefined()

    fake.emit('shell', 'onStreamOutput', { streamId: 'other', stream: 'stdout', dataBase64: bytesToBase64(new TextEncoder().encode('no')) })
    fake.emit('shell', 'onStreamOutput', { streamId: 'pty-1', stream: 'stdout', dataBase64: bytesToBase64(new TextEncoder().encode('hi')) })
    fake.emit('shell', 'onStreamExit', { streamId: 'pty-1', exitCode: 0, timedOut: false, killed: false, durationMs: 1 })
    expect(output).toEqual(['hi'])
    expect(exits).toEqual([0])
    expect(fake.handlerCount()).toBe(0)
  })

  it('persistentList / persistentKill / env', async () => {
    const fake = make(request => {
      switch (routeOf(request)) {
        case 'shell.persistentList':
          return ok({ shells: [{ id: 'persist-1', command: 'node', logPath: '/l', startedMs: 1, running: true }] })
        case 'shell.persistentKill':
          return ok({ found: true, wasRunning: true })
        default:
          return ok({ values: { HOME: '/h', NOPE: null } })
      }
    })
    expect((await fake.primitives.shell.persistentList())[0]!.id).toBe('persist-1')
    expect(await fake.primitives.shell.persistentKill('persist-1')).toEqual({
      found: true,
      wasRunning: true,
    })
    expect(await fake.primitives.shell.env(['HOME', 'NOPE'])).toEqual({ HOME: '/h', NOPE: null })
  })
})

describe('appInfo', () => {
  it('purgeRenderCaches sends the targets and level and returns the host reply', async () => {
    const reply = { purged: ['guest', 'gpu'], throttled: [], guestProcesses: 2, agentTabProcesses: 0, gpuProcesses: 1 }
    const fake = make(() => ok(reply))
    expect(
      await fake.primitives.appInfo.purgeRenderCaches({ targets: ['guest', 'gpu'], level: 'moderate' }),
    ).toEqual(reply)
    expect(fake.requests.map(routeOf)).toEqual(['appInfo.purgeRenderCaches'])
    expect(fake.requests[0].payload).toEqual({ targets: ['guest', 'gpu'], level: 'moderate' })
  })

  it('purgeRenderCaches is unsupported on a host that does not list it', async () => {
    const fake = make(() => ok({}), {
      capabilities: ['fs'],
      primitives: ALL_PRIMITIVES.filter(p => p !== 'appInfo.purgeRenderCaches'),
    })
    await expect(fake.primitives.appInfo.purgeRenderCaches()).rejects.toSatisfy(
      isNativePrimitiveUnsupported,
    )
    expect(fake.requests).toHaveLength(0)
  })
})

describe('network', () => {
  it('streamOpen / streamRead / streamCancel round-trip', async () => {
    const fake = make(request => {
      switch (routeOf(request)) {
        case 'network.streamOpen':
          return ok({ streamId: 's-1', status: 200, statusText: 'OK', finalUrl: 'https://a.example/', headers: {} })
        case 'network.streamRead':
          return ok({ done: true, chunk: new Uint8Array([104, 105]) })
        default:
          return ok({ ok: true })
      }
    })
    const head = await fake.primitives.network.streamOpen({
      url: 'https://a.example/',
      body: new Uint8Array(),
      headers: { Authorization: 'Bearer {{secret:provider:a}}' }, // listed: allowed
    })
    expect(head.streamId).toBe('s-1')
    const read = await fake.primitives.network.streamRead('s-1', { waitMs: 500 })
    expect(new TextDecoder().decode(read.chunk)).toBe('hi')
    await fake.primitives.network.streamCancel('s-1')
    expect(fake.requests.map(routeOf)).toEqual([
      'network.streamOpen',
      'network.streamRead',
      'network.streamCancel',
    ])
  })

  it('wsOpen routes only its own socket events, text and binary, then close', async () => {
    const fake = make(request =>
      routeOf(request) === 'network.wsOpen'
        ? ok({ socketId: (request.payload as { socketId: string }).socketId, protocol: 'chat' })
        : routeOf(request) === 'network.wsSend'
          ? ok({ sent: true })
          : ok({ found: true }),
    )
    const messages: Array<{ text?: string; data?: Uint8Array }> = []
    const closes: number[] = []
    const socket = await fake.primitives.network.wsOpen(
      { url: 'wss://rt.example/ws', protocols: ['chat'] },
      { onMessage: m => messages.push(m), onClose: c => closes.push(c.code) },
    )
    expect(socket.protocol).toBe('chat')
    const id = socket.socketId
    expect(id).toMatch(/^ws-[A-Za-z0-9_-]{4,}$/)
    expect(id.length).toBeLessThanOrEqual(64)

    fake.emit('network', 'onWsMessage', { socketId: id, text: 'hello' })
    fake.emit('network', 'onWsMessage', { socketId: 'someone-else', text: 'nope' })
    fake.emit('network', 'onWsMessage', { socketId: id, dataBase64: bytesToBase64(new Uint8Array([1, 2])) })
    expect(messages[0]).toEqual({ text: 'hello' })
    expect(Array.from(messages[1]!.data!)).toEqual([1, 2])
    expect(messages).toHaveLength(2)

    expect(await socket.send('ping')).toBe(true)
    expect(await socket.send(new Uint8Array([255]))).toBe(true)
    const sends = fake.requests.filter(r => routeOf(r) === 'network.wsSend').map(r => r.payload)
    expect(sends).toEqual([
      { socketId: id, text: 'ping' },
      { socketId: id, dataBase64: '/w==' },
    ])

    fake.emit('network', 'onWsClose', { socketId: id, code: 1000, reason: '', wasClean: true })
    expect(closes).toEqual([1000])
    expect(fake.handlerCount()).toBe(0)
  })
})

describe('secrets and alarms', () => {
  it('secrets never has a get, and speaks set / has / delete / listNames', async () => {
    const fake = make(request => {
      switch (routeOf(request)) {
        case 'secrets.has':
          return ok({ exists: true, origin: 'https://api.github.com' })
        case 'secrets.delete':
          return ok({ deleted: true })
        case 'secrets.listNames':
          return ok({ secrets: [{ name: 'mcp:github', origin: 'https://api.github.com' }] })
        default:
          return ok({ ok: true })
      }
    })
    expect('get' in fake.primitives.secrets).toBe(false)
    await fake.primitives.secrets.set('mcp:github', 'ghp_x', 'https://api.github.com')
    expect(await fake.primitives.secrets.has('mcp:github')).toEqual({
      exists: true,
      origin: 'https://api.github.com',
    })
    expect(await fake.primitives.secrets.delete('mcp:github')).toBe(true)
    expect(await fake.primitives.secrets.listNames('mcp')).toHaveLength(1)
    expect(fake.requests[3]!.payload).toEqual({ namespace: 'mcp' })
  })

  it('secrets.set sends a process-only secret without an origin, with the processEnv mark', async () => {
    const fake = make(() => ok({ ok: true }))
    await fake.primitives.secrets.set('mcp:gh/env/TOKEN', 't', undefined, { processEnv: true })
    await fake.primitives.secrets.set('mcp:gh/header/x', 'v', 'https://a.example')
    expect(fake.requests.map(r => r.payload)).toEqual([
      { name: 'mcp:gh/env/TOKEN', value: 't', processEnv: true },
      { name: 'mcp:gh/header/x', value: 'v', origin: 'https://a.example' },
    ])
  })

  it('alarms create / list / clear and onAlarm', async () => {
    const fake = make(request => {
      switch (routeOf(request)) {
        case 'alarms.list':
          return ok({ alarms: [{ name: 'daily', whenMs: 5, periodMs: 86_400_000 }], fired: [{ name: 'daily', scheduledMs: 1 }] })
        case 'alarms.clear':
          return ok({ cleared: true })
        default:
          return ok({ ok: true })
      }
    })
    await fake.primitives.alarms.create('daily', { periodMs: 86_400_000 })
    expect(fake.requests[0]!.payload).toEqual({ name: 'daily', periodMs: 86_400_000 })
    const listed = await fake.primitives.alarms.list()
    expect(listed.fired).toEqual([{ name: 'daily', scheduledMs: 1 }])
    expect(await fake.primitives.alarms.clear('daily')).toBe(true)

    const fires: string[] = []
    const off = fake.primitives.alarms.onAlarm(fire => fires.push(fire.name))
    fake.emit('alarms', 'onAlarm', { name: 'daily', scheduledMs: 2 })
    fake.emit('fs', 'onChange', { watchId: 'w1', paths: [], kind: 'change' })
    off()
    fake.emit('alarms', 'onAlarm', { name: 'daily', scheduledMs: 3 })
    expect(fires).toEqual(['daily'])
  })
})

describe('webWindow', () => {
  it('is gated on the advertised capability', async () => {
    const { primitives, requests } = make(() => ok({ windowId: 1 }), {
      capabilities: ['fs'],
      primitives: [],
    })
    await expect(primitives.webWindow.open('https://a.example/')).rejects.toSatisfy(
      isNativePrimitiveUnsupported,
    )
    expect(() => primitives.webWindow.onClosed(() => {})).toThrow()
    expect(requests).toHaveLength(0)
  })

  it('sends each action with its wire shape and unwraps the result', async () => {
    const fake = make(
      request => {
        switch (routeOf(request)) {
          case 'webWindow.open':
            return ok({ windowId: 7 })
          case 'webWindow.list':
            return ok({ windows: [{ windowId: 7, url: 'https://a.example/', title: 'A', state: 'normal' }] })
          case 'webWindow.back':
            return ok({ ok: false })
          default:
            return ok({ ok: true })
        }
      },
      { capabilities: ['webWindow'], primitives: [] },
    )
    const { webWindow } = fake.primitives
    expect(await webWindow.open('https://a.example/', { width: 800, height: 600, focus: false })).toBe(7)
    expect(await webWindow.list()).toEqual([
      { windowId: 7, url: 'https://a.example/', title: 'A', state: 'normal' },
    ])
    await webWindow.navigate(7, 'https://b.example/')
    expect(await webWindow.back(7)).toBe(false)
    expect(await webWindow.forward(7)).toBe(true)
    await webWindow.reload(7)
    await webWindow.setBounds(7, { left: 10 })
    await webWindow.setState(7, 'maximized')
    await webWindow.focus(7)
    await webWindow.close(7)

    expect(fake.requests.map(r => [routeOf(r), r.payload])).toEqual([
      ['webWindow.open', { url: 'https://a.example/', width: 800, height: 600, focus: false }],
      ['webWindow.list', {}],
      ['webWindow.navigate', { windowId: 7, url: 'https://b.example/' }],
      ['webWindow.back', { windowId: 7 }],
      ['webWindow.forward', { windowId: 7 }],
      ['webWindow.reload', { windowId: 7 }],
      ['webWindow.setBounds', { windowId: 7, left: 10 }],
      ['webWindow.setState', { windowId: 7, state: 'maximized' }],
      ['webWindow.focus', { windowId: 7 }],
      ['webWindow.close', { windowId: 7 }],
    ])
  })

  it('surfaces a host refusal with its code', async () => {
    const { primitives } = make(
      () => ({ ok: false, error: { code: 'url_not_allowed', message: 'only http, https and file URLs can be opened' } }),
      { capabilities: ['webWindow'], primitives: [] },
    )
    const error = await primitives.webWindow.open('chrome://settings').catch(e => e)
    expect(error).toBeInstanceOf(NativePrimitiveError)
    expect((error as NativePrimitiveError).code).toBe('url_not_allowed')
  })

  it('each event listener sees only its own action', async () => {
    const fake = make(() => ok({ ok: true }), { capabilities: ['webWindow'], primitives: [] })
    const seen: string[] = []
    const offs = [
      fake.primitives.webWindow.onNavigated(e => seen.push(`nav ${e.windowId} ${e.url}`)),
      fake.primitives.webWindow.onTitleChanged(e => seen.push(`title ${e.windowId} ${e.title}`)),
      fake.primitives.webWindow.onClosed(e => seen.push(`closed ${e.windowId} ${e.reason}`)),
    ]
    fake.emit('webWindow', 'onNavigated', { windowId: 3, url: 'https://a.example/', isSameDocument: false, isErrorPage: false })
    fake.emit('webWindow', 'onTitleChanged', { windowId: 3, title: 'A' })
    fake.emit('alarms', 'onAlarm', { name: 'x', scheduledMs: 1 })
    fake.emit('webWindow', 'onClosed', { windowId: 3, reason: 'user' })
    for (const off of offs) off()
    fake.emit('webWindow', 'onClosed', { windowId: 4, reason: 'api' })
    expect(seen).toEqual(['nav 3 https://a.example/', 'title 3 A', 'closed 3 user'])
  })
})

describe('base64', () => {
  it('round-trips bytes, including a large buffer', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
  })
})

describe('wire plumbing', () => {
  it('the manifest keeps the host primitives list', () => {
    const manifest = normalizeBrowserHostManifest({
      capabilities: ['fs', 'secrets'],
      primitives: ['fs.watch', 'fs.watch', ' fs.writeFile.ifMatch ', 3],
    })
    expect(manifest?.primitives).toEqual(['fs.watch', 'fs.writeFile.ifMatch'])
    expect(normalizeBrowserHostManifest({ capabilities: [] })?.primitives).toBeUndefined()
  })

  it('streamOpen sends its body on a port and streamRead stitches the chunk', () => {
    // Without these entries the body would be JSON-serialized (and the C++
    // dispatcher refuses a missing `bytes` input) and `chunk` would be lost.
    expect(__test_only_directPortRoutePolicy.network?.streamOpen).toEqual({
      mode: 'request_port',
      requestBinaryField: 'body',
    })
    expect(__test_only_directPortRoutePolicy.network?.streamRead).toEqual({
      mode: 'response_port',
      resultBinaryFields: ['chunk'],
    })
  })
})

describe('oauth templates', () => {
  it('need the manifest entry and a providerId', async () => {
    const fake = make(() => ok({ streamId: 's', status: 200, statusText: '', finalUrl: '', headers: {} }))
    const headers = { Authorization: 'Bearer {{oauth:access_token}}' }
    await expect(
      fake.primitives.network.streamOpen({ url: 'https://chatgpt.com/x', body: new Uint8Array(), headers }),
    ).rejects.toBeInstanceOf(NativePrimitiveError)
    await fake.primitives.network.streamOpen({
      url: 'https://chatgpt.com/x',
      body: new Uint8Array(),
      headers,
      providerId: 'chatgpt-pro',
    })
    expect(fake.requests).toHaveLength(1)
    expect(() => fake.primitives.model.assertRawStreamOAuthSupported()).not.toThrow()

    const old = make(() => ok({}), { capabilities: ['network'], primitives: ['network.streamOpen'] })
    await expect(
      old.primitives.network.streamOpen({
        url: 'https://chatgpt.com/x',
        body: new Uint8Array(),
        headers,
        providerId: 'chatgpt-pro',
      }),
    ).rejects.toSatisfy(isNativePrimitiveUnsupported)
    expect(() => old.primitives.model.assertRawStreamOAuthSupported()).toThrow()
    expect(old.requests).toHaveLength(0)
  })
})
