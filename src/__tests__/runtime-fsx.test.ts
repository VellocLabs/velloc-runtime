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
import {
  FSX_LIST_MAX_ENTRIES,
  FSX_READ_TEXT_MAX_BYTES,
  FSX_TREE_MAX_ENTRIES,
  SYS_PUT_BLOB_ROUTE,
  type BlobRef,
  type ScopeMode,
} from '../browser/runtimeProtocol'
import { createMessagePortTransport, type FrameTransportLimits } from '../browser/runtimeTransport'
import {
  BlobInbox,
  CapabilityRegistry,
  ConnectionHub,
  DEFAULT_BLOB_INBOX_LIMITS,
  FSX_TREE_SKIPPED_DIRS,
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
  const readdirs: string[] = []
  const host: HostBridge = {
    async request(route, payload) {
      const action = String(route.action)
      calls.push(`${route.capability}.${action}`)
      if (action === 'readFile') reads.push(String((payload as { path?: string }).path))
      if (action === 'readdir') readdirs.push(String((payload as { path?: string }).path))
      const p = payload as { path?: string; paths?: string[]; content?: Uint8Array }
      const fail = (message: string) => ({ ok: false as const, error: { code: 'FS_ERROR', message } })
      const statOf = (path: string) => {
        const real = realpath(path)
        if (files.has(real)) return { isFile: true, isDirectory: false, size: files.get(real)!.byteLength }
        if (dirs.has(real)) return { isFile: false, isDirectory: true, size: 0 }
        return null
      }
      // The children of `real`: every known path (file, dir, link) one segment
      // below it, a directory when something lies deeper. A link reports the
      // kind of its target and NO `isSymbolicLink`, as the host's readdir does
      // (a junction reads as a directory there).
      const childrenOf = (real: string) => {
        const prefix = real === '/' ? '/' : `${real}/`
        const names = new Map<string, { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>()
        for (const known of [...files.keys(), ...dirs, ...links.keys()]) {
          if (!known.startsWith(prefix) || known === real) continue
          const name = known.slice(prefix.length).split('/')[0]!
          const full = `${prefix}${name}`
          const current = names.get(name) ?? { name, isFile: false, isDirectory: false, isSymbolicLink: false }
          if (known !== full) current.isDirectory = true
          else if (links.has(full)) {
            const target = statOf(full)
            current.isDirectory = target?.isDirectory === true
            current.isFile = target?.isFile === true
          } else if (files.has(full)) current.isFile = true
          else current.isDirectory = true
          names.set(name, current)
        }
        return Array.from(names.values())
      }
      switch (action) {
        case 'stat': {
          const stat = statOf(p.path!)
          return stat ? { ok: true, result: stat } : fail('not found')
        }
        case 'readdir': {
          const real = realpath(p.path!)
          if (files.has(real)) return fail('not a directory')
          if (!dirs.has(real) && childrenOf(real).length === 0) return fail('not found')
          return { ok: true, result: childrenOf(real) }
        }
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
  return { files, dirs, links, host, calls, reads, readdirs, text }
}

function makeServer(
  disk: ReturnType<typeof fakeDisk>,
  roots = { cwd: PROJECT, projectRoot: PROJECT },
  homeDir = HOME,
  showInViewer?: (url: string) => Promise<void>,
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
  registerFsxCapability(registry, {
    sessionRoots: id => (id === SESSION ? roots : null),
    ...(showInViewer ? { showInViewer } : {}),
  })
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

  it('userHome is not_found when the host names no home, and the cwd is never asked', async () => {
    const disk = fakeDisk()
    const inner = disk.host
    disk.host = {
      async request(route, payload) {
        if (route.action === 'userHome') {
          disk.calls.push('fs.userHome')
          return { ok: true, result: '' }
        }
        if (route.action === 'cwd') {
          disk.calls.push('fs.cwd')
          return { ok: true, result: PROJECT }
        }
        return inner.request(route, payload)
      },
    }
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk, undefined, ''), 'observe')) })
    await expect(files.userHome()).rejects.toMatchObject({ code: 'not_found' })
    expect(disk.calls).toEqual(['fs.userHome'])
  })

  it('readText refuses a binary file, and an oversized one before reading it', async () => {
    const disk = fakeDisk()
    disk.files.set(`${PROJECT}/clip.mp4`, new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))
    disk.files.set(`${PROJECT}/huge.log`, new Uint8Array(FSX_READ_TEXT_MAX_BYTES + 1).fill(0x61))
    disk.text(`${PROJECT}/ok.txt`, 'plain')
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk))) })

    await expect(files.readText(SESSION, 'clip.mp4')).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'binary', size: 8 },
    })
    await expect(files.readText(SESSION, 'huge.log')).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'tooLarge', size: FSX_READ_TEXT_MAX_BYTES + 1 },
    })
    expect(disk.reads).not.toContain(`${PROJECT}/huge.log`)
    expect(await files.readText(SESSION, 'ok.txt')).toBe('plain')
    // The bytes stay readable for a client that wants them.
    expect((await files.readBytes(SESSION, 'clip.mp4')).byteLength).toBe(8)
  })

  it('openInWindow shows only a media file, as a file URL in the viewer, and only to the desktop', async () => {
    const disk = fakeDisk()
    disk.files.set(`${PROJECT}/clips/a b.mp4`, new Uint8Array([0, 0, 0, 0x18]))
    disk.text(`${PROJECT}/notes.txt`, 'text')
    const shown: string[] = []
    const server = makeServer(disk, undefined, HOME, async url => {
      shown.push(url)
    })
    const files = createRuntimeFileAccess({ connection: once(() => connect(server)) })

    await files.openInWindow(SESSION, 'clips/a b.mp4')
    expect(shown).toEqual([`file://${PROJECT}/clips/a%20b.mp4`])
    // Never read: the viewer loads the file itself.
    expect(disk.reads).toEqual([])
    expect(await codeOf(files.openInWindow(SESSION, 'notes.txt'))).toBe('bad_payload')
    expect(await codeOf(files.openInWindow(SESSION, 'missing.mp4'))).toBe('not_found')
    expect(shown).toHaveLength(1)

    const control = createRuntimeFileAccess({ connection: once(() => connect(server, 'control')) })
    expect(await codeOf(control.openInWindow(SESSION, 'clips/a b.mp4'))).toBe('forbidden_scope')
    const bare = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk))) })
    expect(await codeOf(bare.openInWindow(SESSION, 'clips/a b.mp4'))).toBe('not_found')
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

  it('a root inside ~/.velloc (the shared workspace) reaches its own files and its uploads, nothing beside it', async () => {
    // An unbound session's cwd is `~/.velloc/shared-workspace/agent`: the whole root sits inside the
    // excluded tree, yet its own files and uploads stay readable.
    const disk = fakeDisk()
    const workspace = `${HOME}/${RUNTIME_DIR_NAME}/shared-workspace/agent`
    disk.dirs.add(`${HOME}/${RUNTIME_DIR_NAME}/shared-workspace`)
    disk.dirs.add(workspace)
    disk.text(`${workspace}/notes.txt`, 'workspace')
    disk.text(`${HOME}/${RUNTIME_DIR_NAME}/settings.json`, '{"apiKey":"k"}')
    disk.text(`${HOME}/${RUNTIME_DIR_NAME}/shared-workspace/other.txt`, 'beside')
    const server = makeServer(disk, { cwd: workspace, projectRoot: workspace })
    const files = createRuntimeFileAccess({ connection: once(() => connect(server, 'control')) })

    expect(await files.readText(SESSION, 'notes.txt')).toBe('workspace')
    const uploaded = await files.upload(SESSION, 'shot.png', new Uint8Array([1, 2, 3]), 'image/png')
    expect(uploaded.startsWith(`${workspace}/${RUNTIME_DIR_NAME}/uploads/${SESSION}/`)).toBe(true)
    expect(Array.from(await files.readBytes(SESSION, uploaded))).toEqual([1, 2, 3])
    // The rest of ~/.velloc is still out of reach.
    expect(await codeOf(files.readText(SESSION, `${HOME}/${RUNTIME_DIR_NAME}/settings.json`))).toBe('forbidden_scope')
    expect(await codeOf(files.readText(SESSION, '../../settings.json'))).toBe('forbidden_scope')
    expect(await codeOf(files.readText(SESSION, '../other.txt'))).toBe('forbidden_scope')
  })

  it('the bare shared workspace, which holds every per-type sandbox, reaches nothing', async () => {
    const disk = fakeDisk()
    const sandbox = `${HOME}/${RUNTIME_DIR_NAME}/shared-workspace`
    disk.dirs.add(sandbox)
    disk.dirs.add(`${sandbox}/chat`)
    disk.text(`${sandbox}/notes.txt`, 'shared')
    disk.text(`${sandbox}/chat/${RUNTIME_DIR_NAME}/uploads/other/a.png`, 'theirs')
    const server = makeServer(disk, { cwd: sandbox, projectRoot: sandbox })
    const files = createRuntimeFileAccess({ connection: once(() => connect(server, 'control')) })
    expect(await codeOf(files.readText(SESSION, 'notes.txt'))).toBe('forbidden_scope')
    expect(await codeOf(files.readText(SESSION, `chat/${RUNTIME_DIR_NAME}/uploads/other/a.png`))).toBe('forbidden_scope')
    expect(disk.reads).toEqual([])
  })

  it('with no home known, a scoped request is refused instead of skipping the exclusion', async () => {
    const disk = fakeDisk()
    const inner = disk.host
    disk.host = {
      async request(route, payload) {
        if (route.action === 'userHome') return { ok: true, result: '' }
        return inner.request(route, payload)
      },
    }
    disk.text(`${HOME}/${RUNTIME_DIR_NAME}/settings.json`, '{"apiKey":"k"}')
    const server = makeServer(disk, { cwd: HOME, projectRoot: HOME }, '')
    const files = createRuntimeFileAccess({ connection: once(() => connect(server, 'control')) })
    expect(await codeOf(files.readText(SESSION, `${RUNTIME_DIR_NAME}/settings.json`))).toBe('forbidden_scope')
    const stats = await files.statBatch(SESSION, [`${RUNTIME_DIR_NAME}/settings.json`]).catch(error => error)
    expect(isRuntimeRequestError(stats) ? stats.code : stats).toBe('forbidden_scope')
    expect(disk.reads).toEqual([])
  })

  it('with no home on the runtime, a scoped request asks the host and keeps the exclusion', async () => {
    const disk = fakeDisk()
    disk.text(`${HOME}/${RUNTIME_DIR_NAME}/settings.json`, '{"apiKey":"k"}')
    disk.text(`${HOME}/notes.txt`, 'mine')
    const server = makeServer(disk, { cwd: HOME, projectRoot: HOME }, '')
    const files = createRuntimeFileAccess({ connection: once(() => connect(server, 'control')) })
    expect(await files.readText(SESSION, 'notes.txt')).toBe('mine')
    expect(await codeOf(files.readText(SESSION, `${RUNTIME_DIR_NAME}/settings.json`))).toBe('forbidden_scope')
  })

  it('a root that IS ~/.velloc reaches nothing', async () => {
    const disk = fakeDisk()
    const runtimeDir = `${HOME}/${RUNTIME_DIR_NAME}`
    disk.text(`${runtimeDir}/settings.json`, '{"apiKey":"k"}')
    const server = makeServer(disk, { cwd: runtimeDir, projectRoot: runtimeDir })
    const files = createRuntimeFileAccess({ connection: once(() => connect(server, 'control')) })
    expect(await codeOf(files.readText(SESSION, 'settings.json'))).toBe('forbidden_scope')
    expect(disk.reads).toEqual([])
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

describe('fsx — directory listings', () => {
  /** A project with VCS, dependency and runtime directories beside its sources, and a link out. */
  function projectDisk() {
    const disk = fakeDisk()
    disk.text(`${PROJECT}/README.md`, 'hello')
    disk.text(`${PROJECT}/zeta.ts`, 'z')
    disk.text(`${PROJECT}/Alpha.ts`, 'A')
    disk.text(`${PROJECT}/src/a.ts`, 'export {}')
    disk.text(`${PROJECT}/src/lib/deep/deeper/leaf.ts`, 'leaf')
    disk.text(`${PROJECT}/.git/HEAD`, 'ref')
    disk.text(`${PROJECT}/node_modules/dep/index.js`, 'dep')
    disk.text(`${PROJECT}/src/node_modules/nested/index.js`, 'nested')
    disk.text(`${PROJECT}/${RUNTIME_DIR_NAME}/settings.json`, '{}')
    disk.dirs.add(`${PROJECT}/empty`)
    // A link target must stat as a directory for the fake realpath to resolve it.
    disk.dirs.add(`${PROJECT}/src`)
    disk.dirs.add('/etc')
    disk.text('/etc/passwd', 'secret')
    disk.links.set(`${PROJECT}/escape`, '/etc')
    return disk
  }

  it('listDir: folders first, then names case-insensitively; a link reads as what it points to', async () => {
    const disk = projectDisk()
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'observe')) })
    const listing = await files.listDir(SESSION, '.')
    expect(listing.truncated).toBe(false)
    expect(listing.entries.map(entry => entry.name)).toEqual([
      '.git',
      RUNTIME_DIR_NAME,
      'empty',
      'escape',
      'node_modules',
      'src',
      'Alpha.ts',
      'README.md',
      'zeta.ts',
    ])
    // The host reports no links from a directory read: the junction out of the
    // project is a directory to `listDir`, and the root rule is what keeps a
    // scoped walk out of it (below).
    expect(listing.entries.find(entry => entry.name === 'escape')).toEqual({
      name: 'escape',
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    })
    expect(listing.entries.find(entry => entry.name === 'Alpha.ts')).toEqual({
      name: 'Alpha.ts',
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    })
    // A relative path resolves against the cwd; an empty directory lists as empty.
    expect((await files.listDir(SESSION, 'src')).entries.map(entry => entry.name)).toEqual(['lib', 'node_modules', 'a.ts'])
    expect((await files.listDir(SESSION, 'empty')).entries).toEqual([])
    expect(disk.calls.filter(call => call === 'fs.readdir')).toHaveLength(3)
  })

  it('a scoped connection lists inside the root and is forbidden_scope outside, through `..` and through a link', async () => {
    const disk = projectDisk()
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'control')) })
    expect((await files.listDir(SESSION, `${PROJECT}/src`)).entries.length).toBeGreaterThan(0)
    expect(await codeOf(files.listDir(SESSION, '/etc'))).toBe('forbidden_scope')
    expect(await codeOf(files.listDir(SESSION, '../../etc'))).toBe('forbidden_scope')
    expect(await codeOf(files.listDir(SESSION, 'escape'))).toBe('forbidden_scope')
    expect(await codeOf(files.listTree(SESSION, '/etc'))).toBe('forbidden_scope')
    expect(await codeOf(files.listTree(SESSION, 'escape'))).toBe('forbidden_scope')
    expect(disk.calls.filter(call => call === 'fs.readdir')).toHaveLength(1)
  })

  it('`full` lists anywhere', async () => {
    const disk = projectDisk()
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk))) })
    expect((await files.listDir(SESSION, '/etc')).entries.map(entry => entry.name)).toEqual(['passwd'])
    expect((await files.listTree(SESSION, '/etc')).entries.map(entry => entry.path)).toEqual(['passwd'])
  })

  it('a missing directory is not_found; a file is conflict — for both listings', async () => {
    const disk = projectDisk()
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'control')) })
    expect(await codeOf(files.listDir(SESSION, 'nope'))).toBe('not_found')
    expect(await codeOf(files.listDir(SESSION, 'README.md'))).toBe('conflict')
    expect(await codeOf(files.listTree(SESSION, 'nope'))).toBe('not_found')
    expect(await codeOf(files.listTree(SESSION, 'README.md'))).toBe('conflict')
  })

  it('listDir cuts at the cap and says so', async () => {
    const disk = fakeDisk()
    for (let index = 0; index < FSX_LIST_MAX_ENTRIES + 1; index += 1) disk.text(`${PROJECT}/many/f${index}.txt`, 'x')
    for (let index = 0; index < FSX_LIST_MAX_ENTRIES; index += 1) disk.text(`${PROJECT}/exact/f${index}.txt`, 'x')
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk))) })
    const many = await files.listDir(SESSION, 'many')
    expect(many.entries).toHaveLength(FSX_LIST_MAX_ENTRIES)
    expect(many.truncated).toBe(true)
    const exact = await files.listDir(SESSION, 'exact')
    expect(exact.entries).toHaveLength(FSX_LIST_MAX_ENTRIES)
    expect(exact.truncated).toBe(false)
  })

  it('listTree walks breadth-first with relative `/` paths and sizes, skipping VCS, dependency and runtime dirs at any depth', async () => {
    const disk = projectDisk()
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'observe')) })
    const tree = await files.listTree(SESSION, '.')
    expect(tree.truncated).toBe(false)
    expect(tree.entries.map(entry => entry.path)).toEqual([
      // Level 1: folders first, then files; `.git`, `node_modules` and the runtime dir are absent.
      'empty',
      'escape',
      'src',
      'Alpha.ts',
      'README.md',
      'zeta.ts',
      // Level 2: `src/node_modules` is skipped too; `escape` (a link out of the
      // root, a plain directory to the host) failed the root check: listed, not entered.
      'src/lib',
      'src/a.ts',
      'src/lib/deep',
      // The default depth is 4: `src/lib/deep/deeper` is level 4, its leaf (level 5) is not.
      'src/lib/deep/deeper',
    ])
    for (const name of FSX_TREE_SKIPPED_DIRS) {
      expect(tree.entries.some(entry => entry.path.split('/').includes(name))).toBe(false)
    }
    expect(tree.entries.find(entry => entry.path === 'src/a.ts')).toEqual({ path: 'src/a.ts', isDirectory: false, size: 9 })
    expect(tree.entries.find(entry => entry.path === 'src')).toEqual({ path: 'src', isDirectory: true, size: 0 })
    // Sizes come from one `statBatch` over the files, not a stat each.
    expect(disk.calls.filter(call => call === 'fs.statBatch')).toHaveLength(1)
    expect(disk.calls.filter(call => call === 'fs.stat')).toHaveLength(0)
    // `/etc` was never read: the link is listed, not entered.
    expect(disk.calls.filter(call => call === 'fs.readdir')).toHaveLength(5)
  })

  it('a scoped walk enters a directory only when it passes the root check; `full` walks through links', async () => {
    // What the host hands the walk: `escape` -> /etc and `alias` -> src are
    // both plain directories (no link flag). Only the realpath check tells
    // them apart, so it runs on every directory before the walk enters it.
    const disk = projectDisk()
    disk.links.set(`${PROJECT}/alias`, `${PROJECT}/src`)
    const scoped = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'control')) })
    const tree = await scoped.listTree(SESSION, '.', 2)
    const paths = tree.entries.map(entry => entry.path)
    expect(paths).toContain('escape')
    expect(paths.some(path => path.startsWith('escape/'))).toBe(false)
    // A link that stays inside the root is entered like any directory.
    expect(paths).toContain('alias/a.ts')
    // `/etc` itself was never read.
    expect(disk.readdirs).not.toContain('/etc')

    const full = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk))) })
    const everything = await full.listTree(SESSION, '.', 2)
    expect(everything.entries.map(entry => entry.path)).toContain('escape/passwd')
  })

  it('listTree honours `depth`: 1 is the directory itself, 8 is the most a client may ask for', async () => {
    const disk = projectDisk()
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk), 'observe')) })
    expect((await files.listTree(SESSION, '.', 1)).entries.map(entry => entry.path)).toEqual([
      'empty',
      'escape',
      'src',
      'Alpha.ts',
      'README.md',
      'zeta.ts',
    ])
    const deep = await files.listTree(SESSION, '.', 8)
    expect(deep.entries.map(entry => entry.path)).toContain('src/lib/deep/deeper/leaf.ts')
    expect(await codeOf(files.listTree(SESSION, '.', 0))).toBe('bad_payload')
    expect(await codeOf(files.listTree(SESSION, '.', 9))).toBe('bad_payload')
    expect(await codeOf(files.listTree(SESSION, '.', 2.5))).toBe('bad_payload')
  })

  it('listTree stops at the cap, keeps the shallow entries and says so', async () => {
    const disk = fakeDisk()
    disk.text(`${PROJECT}/top.txt`, 'x')
    for (let index = 0; index < FSX_TREE_MAX_ENTRIES; index += 1) disk.text(`${PROJECT}/many/f${index}.txt`, 'x')
    const files = createRuntimeFileAccess({ connection: once(() => connect(makeServer(disk))) })
    const tree = await files.listTree(SESSION, '.')
    expect(tree.truncated).toBe(true)
    expect(tree.entries).toHaveLength(FSX_TREE_MAX_ENTRIES)
    expect(tree.entries.slice(0, 2).map(entry => entry.path)).toEqual(['many', 'top.txt'])
    // Every listed file got its size, in host-sized stat batches.
    expect(tree.entries.every(entry => entry.isDirectory || entry.size === 1)).toBe(true)
    expect(disk.calls.filter(call => call === 'fs.statBatch')).toHaveLength(10)
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
      ['cancelSearch', 'commitUpload', 'findFiles', 'listDir', 'listTree', 'openInWindow', 'readBlob', 'readText', 'searchText', 'statBatch', 'userHome', 'writeText'],
    )
    const control = registry.advertise({ mode: 'control', sessions: 'all' })
    expect(control.find(entry => entry.cap === 'fsx')?.acts.slice().sort()).toEqual(
      ['cancelSearch', 'commitUpload', 'findFiles', 'listDir', 'listTree', 'readBlob', 'readText', 'searchText', 'statBatch', 'userHome'],
    )
    // A manager writes session files: everything control has, plus writeText.
    const manager = registry.advertise({ mode: 'manager', sessions: 'all' })
    expect(manager.find(entry => entry.cap === 'fsx')?.acts.slice().sort()).toEqual(
      ['cancelSearch', 'commitUpload', 'findFiles', 'listDir', 'listTree', 'readBlob', 'readText', 'searchText', 'statBatch', 'userHome', 'writeText'],
    )
    // Listings and searches are reads: an observer browses the project it may already read.
    const observe = registry.advertise({ mode: 'observe', sessions: 'all' })
    expect(observe.find(entry => entry.cap === 'fsx')?.acts.slice().sort()).toEqual(
      ['cancelSearch', 'findFiles', 'listDir', 'listTree', 'readBlob', 'readText', 'searchText', 'statBatch', 'userHome'],
    )
  })

  it('page code never reaches the host `fs` routes — files are `fsx`', () => {
    // The exception is the boot read made on the bootstrap port BEFORE the
    // runtime connection exists: the `agent.log` / `agent.trace` flags from
    // settings.json.
    const EXCEPTIONS = new Set([join('browser', 'boot', 'loadAgentTracerFlags.ts')])
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
