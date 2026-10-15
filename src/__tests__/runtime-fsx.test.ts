/**
 * `fsx`, client file access through the runtime (F-24). Security: `full` reaches any path; a scoped connection is
 * held to the session's project root on the literal path and its realpath; `~/.velloc` is not a root; writes are
 * `full`; bytes move only as `BlobRef`s; no client is advertised bare `fs`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { SYS_PUT_BLOB_ROUTE, type BlobRef, type ScopeMode } from '../browser/runtimeProtocol'
import { createMessagePortTransport, type FrameTransportLimits } from '../browser/runtimeTransport'
import {
  BlobInbox,
  CapabilityRegistry,
  ConnectionHub,
  DEFAULT_BLOB_INBOX_LIMITS,
  TopicBroker,
  hostProxySpecs,
  registerFsxCapability,
  type HostBridge,
  type RuntimeContext,
} from '../browser/runtimeHub'
import {
  connectRuntime,
  createRuntimeFileAccess,
  isRuntimeRequestError,
  type RuntimeConnection,
} from '../browser/runtimeClient'

const HOME = '/home/u'
const PROJECT = '/work/proj'
const SESSION = 's-1'

/** A disk of files + links; `realpath` follows links on every path prefix. */
function fakeDisk() {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>(['/', '/work', PROJECT, HOME, `${HOME}/${RUNTIME_DIR_NAME}`])
  const links = new Map<string, string>()
  const realpath = (path: string): string => {
    let out = ''
    for (const segment of path.split('/').filter(Boolean)) {
      out = `${out}/${segment}`
      let hops = 0
      while (links.has(out) && hops++ < 10) out = links.get(out)!
    }
    return out || '/'
  }
  const calls: string[] = []
  const reads: string[] = []
  const host: HostBridge = {
    async request(route, payload) {
      const action = String(route.action)
      calls.push(`${route.capability}.${action}`)
      if (action === 'readFile') reads.push(String((payload as { path?: string }).path))
      const p = payload as { path?: string; paths?: string[]; content?: Uint8Array }
      const fail = (message: string) => ({ ok: false as const, error: { code: 'FS_ERROR', message } })
      const statOf = (path: string) => {
        const real = realpath(path)
        if (files.has(real)) return { isFile: true, isDirectory: false }
        if (dirs.has(real)) return { isFile: false, isDirectory: true }
        return null
      }
      switch (action) {
        case 'realpath': {
          // Like the Windows host: links are followed only when asked for
          // (`resolveLinks`); the default form just normalizes.
          const real = (payload as { resolveLinks?: boolean }).resolveLinks ? realpath(p.path!) : p.path!
          return statOf(p.path!) ? { ok: true, result: { path: real } } : fail('Failed to resolve canonical path')
        }
        case 'readFile': {
          const bytes = files.get(realpath(p.path!))
          return bytes ? { ok: true, result: bytes } : fail('not found')
        }
        case 'statBatch':
          return { ok: true, result: p.paths!.map(path => ({ path, stat: statOf(path) })) }
        case 'writeFile':
          files.set(realpath(p.path!), p.content!)
          return { ok: true, result: undefined }
        case 'exists':
          return { ok: true, result: statOf(p.path!) !== null }
        case 'mkdir':
          dirs.add(realpath(p.path!))
          return { ok: true, result: undefined }
        case 'userHome':
          return { ok: true, result: HOME }
        default:
          return fail(`unexpected fs.${action}`)
      }
    },
  }
  const text = (path: string, value: string) => files.set(path, new TextEncoder().encode(value))
  return { files, dirs, links, host, calls, reads, text }
}

function makeServer(
  disk: ReturnType<typeof fakeDisk>,
  roots = { cwd: PROJECT, projectRoot: PROJECT },
  homeDir = HOME,
) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: disk.host,
    homeDir,
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: HOME, fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({
    registry,
    broker,
    context,
    runtimeVersion: 'fsx-test',
    bootstrap: () => ({ homeDir: HOME, platform: 'test', pathSep: '/' }),
  })
  for (const spec of hostProxySpecs()) registry.registerHostProxy(spec)
  registerFsxCapability(registry, { sessionRoots: id => (id === SESSION ? roots : null) })
  return { registry, hub }
}

function connect(
  server: ReturnType<typeof makeServer>,
  scopeCeiling?: ScopeMode,
  limits?: FrameTransportLimits,
): Promise<RuntimeConnection> {
  const channel = new MessageChannel()
  server.hub.attach(createMessagePortTransport(channel.port1, limits))
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2, limits),
    client: { clientId: 'page', kind: 'desktop-shell' },
    ...(scopeCeiling ? { scopeCeiling } : {}),
  })
}

/** The page holds ONE connection; so does every facade here. */
function once(open: () => Promise<RuntimeConnection>): () => Promise<RuntimeConnection> {
  let connection: Promise<RuntimeConnection> | null = null
  return () => (connection ??= open())
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return isRuntimeRequestError(error) ? error.code : `thrown: ${String(error)}`
  }
}

describe('fsx — the desktop (`full`)', () => {
  it('reads any path as text or as a BlobRef, stats a batch, and writes', async () => {
    const disk = fakeDisk()
    disk.text('/etc/notes.txt', 'outside the project')
    disk.text(`${PROJECT}/src/a.ts`, 'export {}')
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk))) })

    expect(await files.readText(SESSION, '/etc/notes.txt')).toBe('outside the project')
    // A relative path resolves against the session's cwd.
    expect(await files.readText(SESSION, 'src/a.ts')).toBe('export {}')
    const bytes = await files.readBytes(SESSION, `${PROJECT}/src/a.ts`)
    expect(new TextDecoder().decode(bytes)).toBe('export {}')

    expect(await files.statBatch(SESSION, ['src/a.ts', `${PROJECT}/src`, '/nope'])).toEqual([
      { path: 'src/a.ts', exists: true, isFile: true, isDirectory: false },
      { path: `${PROJECT}/src`, exists: false, isFile: false, isDirectory: false },
      { path: '/nope', exists: false, isFile: false, isDirectory: false },
    ])

    await files.writeText(SESSION, '/etc/notes.txt', 'edited')
    expect(new TextDecoder().decode(disk.files.get('/etc/notes.txt'))).toBe('edited')
  })

  it('userHome is what the runtime knows, else the host\'s answer', async () => {
    const known = createRuntimeFileAccess({ connection: once(() => connect(makeServer(fakeDisk()), 'observe')) })
    expect(await known.userHome()).toBe(HOME)
    const disk = fakeDisk()
    const asked = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk, undefined, ''), 'observe')) })
    expect(await asked.userHome()).toBe(HOME)
    expect(disk.calls).toEqual(['fs.userHome'])
  })

  it('an unknown session is not_found, before any host call', async () => {
    const disk = fakeDisk()
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk))) })
    expect(await codeOf(files.readText('nobody', '/etc/notes.txt'))).toBe('not_found')
    expect(disk.calls).toEqual([])
  })
})

describe('fsx — a scoped connection is held to the session project', () => {
  it('inside the project reads; outside, through a link, or under ~/.velloc is forbidden_scope', async () => {
    const disk = fakeDisk()
    disk.text(`${PROJECT}/README.md`, 'hello')
    disk.text('/etc/passwd', 'secret')
    disk.text(`${HOME}/${RUNTIME_DIR_NAME}/settings.json`, '{"apiKey":"k"}')
    disk.links.set(`${PROJECT}/escape`, '/etc')
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'observe')) })

    expect(await files.readText(SESSION, 'README.md')).toBe('hello')
    expect(await codeOf(files.readText(SESSION, '/etc/passwd'))).toBe('forbidden_scope')
    expect(await codeOf(files.readText(SESSION, '../../etc/passwd'))).toBe('forbidden_scope')
    // The literal path is inside the project; its realpath is not.
    expect(await codeOf(files.readText(SESSION, 'escape/passwd'))).toBe('forbidden_scope')
    expect(await codeOf(files.readBytes(SESSION, 'escape/passwd'))).toBe('forbidden_scope')
    expect(await codeOf(files.readText(SESSION, `${HOME}/${RUNTIME_DIR_NAME}/settings.json`))).toBe('forbidden_scope')
    // Only the one allowed read ever reached the host.
    expect(disk.reads).toEqual([`${PROJECT}/README.md`])
  })

  it('a NEW file under a link out of the project is refused: the write is checked where the host would land it', async () => {
    // `writeText { path: 'link/newfile' }`: the leaf does not exist, so it has
    // no realpath of its own and only the literal path (inside the project)
    // used to be checked — the host then followed the link and wrote outside.
    const disk = fakeDisk()
    disk.dirs.add('/etc')
    disk.links.set(`${PROJECT}/link`, '/etc')
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'manager')) })

    expect(await codeOf(files.writeText(SESSION, 'link/newfile', 'pwned'))).toBe('forbidden_scope')
    expect(disk.files.has('/etc/newfile')).toBe(false)
    // Two levels of missing path resolve the same way.
    expect(await codeOf(files.writeText(SESSION, 'link/deeper/newfile', 'pwned'))).toBe('forbidden_scope')
    expect(disk.files.size).toBe(0)
    // A new file under a plain project directory is still written.
    expect(await codeOf(files.writeText(SESSION, 'src/new.ts', 'export {}'))).toBe('ok')
    expect(new TextDecoder().decode(disk.files.get(`${PROJECT}/src/new.ts`))).toBe('export {}')
  })

  it('~/.velloc is refused even when the session root is the home directory', async () => {
    // A session whose cwd IS the home directory has `~/.velloc` inside its
    // root; the runtime dir is excluded from the check outright, so the
    // credentials and transcripts under it stay out of a scoped connection's reach.
    const disk = fakeDisk()
    disk.text(`${HOME}/notes.txt`, 'mine')
    disk.text(`${HOME}/${RUNTIME_DIR_NAME}/settings.json`, '{"apiKey":"k"}')
    const server = makeServer(disk, { cwd: HOME, projectRoot: HOME })
    const files = createRuntimeFileAccess({ connection: once(() => connect(server, 'control')) })

    expect(await files.readText(SESSION, 'notes.txt')).toBe('mine')
    expect(await codeOf(files.readText(SESSION, `${RUNTIME_DIR_NAME}/settings.json`))).toBe('forbidden_scope')
    expect(await codeOf(files.readText(SESSION, `${HOME}/${RUNTIME_DIR_NAME}/settings.json`))).toBe('forbidden_scope')
    expect(await files.statBatch(SESSION, [`${RUNTIME_DIR_NAME}/settings.json`])).toEqual([
      { path: `${RUNTIME_DIR_NAME}/settings.json`, exists: false, isFile: false, isDirectory: false },
    ])
    expect(disk.reads).toEqual([`${HOME}/notes.txt`])
  })

  it('a project root that is itself a link still works', async () => {
    const disk = fakeDisk()
    disk.dirs.add('/real')
    disk.dirs.add('/real/proj')
    disk.text('/real/proj/a.txt', 'via link')
    disk.links.set('/work/linked', '/real/proj')
    const server = makeServer(disk, { cwd: '/work/linked', projectRoot: '/work/linked' })
    const files = createRuntimeFileAccess({ connection: once(() => connect(server, 'control')) })
    expect(await files.readText(SESSION, 'a.txt')).toBe('via link')
  })

  it('statBatch reports what the connection may not see as absent instead of failing', async () => {
    const disk = fakeDisk()
    disk.text(`${PROJECT}/in.txt`, 'x')
    disk.text('/etc/out.txt', 'y')
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'control')) })
    expect(await files.statBatch(SESSION, ['in.txt', '/etc/out.txt'])).toEqual([
      { path: 'in.txt', exists: true, isFile: true, isDirectory: false },
      { path: '/etc/out.txt', exists: false, isFile: false, isDirectory: false },
    ])
  })

  it('a scoped statBatch resolves the session roots once, not once per path', async () => {
    // The root check needs the host's realpath of each root and of each path.
    // 500 paths used to cost 1500 round trips: both roots re-resolved per path.
    const disk = fakeDisk()
    disk.text(`${PROJECT}/a.txt`, 'a')
    disk.text(`${PROJECT}/b.txt`, 'b')
    disk.text(`${PROJECT}/c.txt`, 'c')
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'control')) })
    await files.statBatch(SESSION, ['a.txt', 'b.txt', 'c.txt'])
    // One for the (shared) root, one for the excluded `~/.velloc`, one per path.
    expect(disk.calls.filter(call => call === 'fs.realpath')).toHaveLength(5)
  })

  it('a scoped statBatch of absent paths resolves each ancestor once, not once per path', async () => {
    // An absent path is placed by its nearest existing ancestor, one host
    // `realpath` per level. 500 mention paths six levels deep used to cost up
    // to ~3000 round trips, serially; siblings share their ancestors now.
    const disk = fakeDisk()
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'control')) })
    expect(await files.statBatch(SESSION, ['gone/x/a.ts', 'gone/x/b.ts', 'gone/x/c.ts'])).toEqual([
      { path: 'gone/x/a.ts', exists: false, isFile: false, isDirectory: false },
      { path: 'gone/x/b.ts', exists: false, isFile: false, isDirectory: false },
      { path: 'gone/x/c.ts', exists: false, isFile: false, isDirectory: false },
    ])
    // The root (shared with the ancestor walk), `~/.velloc`, the three leaves,
    // and `gone/x` and `gone` once each.
    expect(disk.calls.filter(call => call === 'fs.realpath')).toHaveLength(7)
  })

  it('~/.velloc is refused in its resolved form too when the home directory is a link', async () => {
    // `/home/u` -> `/data/u`: the roots were matched in both forms, the
    // exclusion only as written, so `/data/u/.velloc/settings.json` was inside
    // the resolved root and outside the literal exclusion — and readable.
    const disk = fakeDisk()
    disk.dirs.add('/data')
    disk.dirs.add('/data/u')
    disk.dirs.add(`/data/u/${RUNTIME_DIR_NAME}`)
    disk.links.set(HOME, '/data/u')
    disk.text(`/data/u/notes.txt`, 'mine')
    disk.text(`/data/u/${RUNTIME_DIR_NAME}/settings.json`, '{"apiKey":"k"}')
    const server = makeServer(disk, { cwd: HOME, projectRoot: HOME })
    const files = createRuntimeFileAccess({ connection: once(() => connect(server, 'control')) })

    expect(await files.readText(SESSION, 'notes.txt')).toBe('mine')
    expect(await codeOf(files.readText(SESSION, `/data/u/${RUNTIME_DIR_NAME}/settings.json`))).toBe('forbidden_scope')
    expect(await codeOf(files.readText(SESSION, `${HOME}/${RUNTIME_DIR_NAME}/settings.json`))).toBe('forbidden_scope')
    expect(await files.statBatch(SESSION, [`/data/u/${RUNTIME_DIR_NAME}/settings.json`])).toEqual([
      { path: `/data/u/${RUNTIME_DIR_NAME}/settings.json`, exists: false, isFile: false, isDirectory: false },
    ])
    expect(disk.reads).toEqual([`${HOME}/notes.txt`])
  })

  it('writing a named path is `full` only', async () => {
    const disk = fakeDisk()
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'control')) })
    expect(await codeOf(files.writeText(SESSION, 'a.txt', 'nope'))).toBe('forbidden_scope')
    expect(disk.files.size).toBe(0)
  })
})

describe('fsx — uploads', () => {
  it('bytes go up as a BlobRef and land in the session uploads directory under a runtime-chosen name', async () => {
    const disk = fakeDisk()
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'control')) })
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
    const path = await files.upload(SESSION, '../x/evil name.png', bytes, 'image/png')

    const dir = `${PROJECT}/${RUNTIME_DIR_NAME}/uploads/${SESSION}`
    expect(path.startsWith(`${dir}/`)).toBe(true)
    expect(path).toMatch(/\/[a-zA-Z0-9_-]{8}-evil_name\.png$/)
    expect(Array.from(disk.files.get(path)!)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(disk.dirs.has(dir)).toBe(true)
  })

  it('works on a windowed transport: small chunks, ack-credited, both directions', async () => {
    const disk = fakeDisk()
    disk.text(`${PROJECT}/big.bin`, 'abcdefghijklmnopqrstuvwxyz')
    const limits = { chunkBytes: 3, windowChunks: 2 }
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'full', limits)) })
    const upBytes = new TextEncoder().encode('0123456789ABCDEFG')
    const path = await files.upload(SESSION, 'up.bin', upBytes)
    expect(new TextDecoder().decode(disk.files.get(path))).toBe('0123456789ABCDEFG')
    const down = await files.readBytes(SESSION, 'big.bin')
    expect(new TextDecoder().decode(down)).toBe('abcdefghijklmnopqrstuvwxyz')
  })

  it('an observe connection cannot put bytes; a ref this connection never announced is not_found', async () => {
    const disk = fakeDisk()
    const server = makeServer(disk)
    const observer = await connect(server, 'observe')
    expect(await codeOf(observer.putBlob(new Uint8Array([1])))).toBe('forbidden_scope')

    const other = await connect(server, 'control')
    const ref: BlobRef = await other.putBlob(new Uint8Array([9, 9]))
    const thief = await connect(server, 'control')
    expect(
      await codeOf(thief.request('fsx.commitUpload', { sessionId: SESSION, blob: ref, name: 'stolen.bin' })),
    ).toBe('not_found')
    // The owner still can.
    expect(await codeOf(other.request('fsx.commitUpload', { sessionId: SESSION, blob: ref, name: 'mine.bin' }))).toBe('ok')
  })

  it('sys.putBlob rejects a malformed announcement', async () => {
    const server = makeServer(fakeDisk())
    const connection = await connect(server)
    expect(await codeOf(connection.request(SYS_PUT_BLOB_ROUTE, { bytes: -1 }))).toBe('bad_payload')
  })
})

describe('BlobInbox', () => {
  const header = (id: string, index: number, last: boolean) => ({ id, index, last })

  it('drops chunks for an id it never handed out', () => {
    const inbox = new BlobInbox()
    expect(inbox.accept(header('ghost', 0, true), new Uint8Array([1]))).toBe(false)
  })

  it('a blob that carries more or fewer bytes than announced fails its waiter with bad_payload', async () => {
    const inbox = new BlobInbox()
    inbox.expect('a', 2)
    const tooMuch = inbox.receive('a')
    inbox.accept(header('a', 0, false), new Uint8Array([1, 2, 3]))
    await expect(tooMuch).rejects.toMatchObject({ code: 'bad_payload' })

    inbox.expect('b', 4)
    const tooLittle = inbox.receive('b')
    inbox.accept(header('b', 0, true), new Uint8Array([1]))
    await expect(tooLittle).rejects.toMatchObject({ code: 'bad_payload' })
  })

  it('the pending-upload budget is per inbox; an unread blob expires', async () => {
    let now = 0
    const inbox = new BlobInbox({ maxBytes: 10, ttlMs: 100 }, () => now)
    inbox.expect('a', 8)
    expect(() => inbox.expect('b', 3)).toThrow(expect.objectContaining({ code: 'conflict' }))
    now = 200
    inbox.expect('b', 3)
    await expect(inbox.receive('a')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a chunk index past what the declared size allows fails the blob', async () => {
    // 4 bytes at 2 per chunk is 2 chunks (+1 of slack): index 1000 is not a
    // chunk of this blob, it is a table entry nobody would ever pay for.
    const inbox = new BlobInbox({ maxBytes: 100, ttlMs: 1000 }, () => 0, 2)
    inbox.expect('a', 4)
    const waiting = inbox.receive('a')
    expect(inbox.accept(header('a', 1000, false), new Uint8Array([1]))).toBe(true)
    await expect(waiting).rejects.toMatchObject({ code: 'bad_payload' })
    // The blob is gone: nothing more is accepted (or acked) for it.
    expect(inbox.accept(header('a', 0, false), new Uint8Array([1, 2]))).toBe(false)
  })

  it('a flood of zero-byte chunks cannot grow the chunk table past the declared size', async () => {
    // Empty chunks spend no byte budget, so `received > declared` never fired
    // and every fresh index used to be one more Map entry, forever.
    const inbox = new BlobInbox({ maxBytes: 100, ttlMs: 1000 }, () => 0, 2)
    inbox.expect('z', 4)
    const waiting = inbox.receive('z')
    let accepted = 0
    for (let index = 0; index < 1000; index += 1) {
      if (inbox.accept(header('z', index, false), new Uint8Array(0))) accepted += 1
    }
    // ceil(4 / 2) + 1 = 3 indexes are legal; the 4th fails the blob and is
    // the last chunk the blob ever takes.
    expect(accepted).toBe(4)
    await expect(waiting).rejects.toMatchObject({ code: 'bad_payload' })
  })

  it('an expired blob is dropped on its next chunk, not only on the next announcement', () => {
    let now = 0
    const inbox = new BlobInbox({ maxBytes: 100, ttlMs: 100 }, () => now, 2)
    inbox.expect('a', 4)
    now = 200
    expect(inbox.accept(header('a', 0, false), new Uint8Array([1, 2]))).toBe(false)
  })

  it('the default per-connection budget is 64 MiB', () => {
    expect(DEFAULT_BLOB_INBOX_LIMITS.maxBytes).toBe(64 * 1024 * 1024)
  })
})

describe('R7 guards', () => {
  it('no client is advertised bare `fs`; `fsx` writes are `full`-only in the advert', () => {
    const { registry } = makeServer(fakeDisk())
    const full = registry.advertise({ mode: 'full', sessions: 'all' })
    expect(full.find(entry => entry.cap === 'fs')).toBeUndefined()
    expect(full.find(entry => entry.cap === 'fsx')?.acts.slice().sort()).toEqual(
      ['commitUpload', 'readBlob', 'readText', 'statBatch', 'userHome', 'writeText'],
    )
    const control = registry.advertise({ mode: 'control', sessions: 'all' })
    expect(control.find(entry => entry.cap === 'fsx')?.acts.slice().sort()).toEqual(
      ['commitUpload', 'readBlob', 'readText', 'statBatch', 'userHome'],
    )
    // A manager writes session files: everything control has, plus writeText.
    const manager = registry.advertise({ mode: 'manager', sessions: 'all' })
    expect(manager.find(entry => entry.cap === 'fsx')?.acts.slice().sort()).toEqual(
      ['commitUpload', 'readBlob', 'readText', 'statBatch', 'userHome', 'writeText'],
    )
    const observe = registry.advertise({ mode: 'observe', sessions: 'all' })
    expect(observe.find(entry => entry.cap === 'fsx')?.acts.slice().sort()).toEqual(['readBlob', 'readText', 'statBatch', 'userHome'])
  })

  it('page code never reaches the host `fs` routes — files are `fsx`', () => {
    // The exceptions are the two boot reads made on the bootstrap port BEFORE
    // the runtime connection exists: the `?template=local` overlay and the
    // `agent.log` / `agent.trace` flags from settings.json. They move when boot
    // is restructured around the connection (phase-4 row).
    const EXCEPTIONS = new Set([
      join('browser', 'boot', 'loadLocalTemplates.ts'),
      join('browser', 'boot', 'loadAgentTracerFlags.ts'),
    ])
    // A bridge route built by hand, or an import of a helper that builds them.
    const REACHES_FS = [
      /createBridgeRoute\(\s*['"]fs['"]/,
      /capability:\s*['"]fs['"]/,
      /from\s+['"][^'"]*\/(BrowserFsOperations|resolveHomeDirViaBridge|resolveRuntimeCwd)['"]/,
    ]
    const SRC = join(__dirname, '..')
    const roots = ['browser/webview', 'browser/boot', 'components'].map(dir => join(SRC, dir))
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
        } else if (/\.(ts|tsx)$/.test(name)) {
          const source = readFileSync(path, 'utf8')
          const rel = relative(SRC, path)
          if (EXCEPTIONS.has(rel)) continue
          if (REACHES_FS.some(pattern => pattern.test(source))) offenders.push(rel)
        }
      }
    }
    roots.forEach(walk)
    expect(offenders).toEqual([])
  })
})
