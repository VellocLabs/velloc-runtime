/**
 * `fsx.findFiles` / `fsx.searchText` (F-9 Files pane search): the runtime runs the search binary as a
 * streaming child in the searched folder, ranks or parses what it prints, and publishes the results as
 * state on a topic only the starting connection may read. Security: the folder is root-checked like a
 * listing before any child starts. A fake host answers the `fs` calls and a fake spawner plays the child.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import type { NativeStreamExit, NativeStreamHandlers } from '../browser/bridge/nativePrimitives'
import { NativePrimitiveUnsupportedError } from '../browser/bridge/nativePrimitives'
import {
  FSX_SEARCH_TEXT_MAX_PER_FILE,
  fsxSearchTopic,
  type FsxSearchState,
  type ScopeMode,
} from '../browser/runtimeProtocol'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import {
  CapabilityRegistry,
  ConnectionHub,
  FsxSearchService,
  TopicBroker,
  findFilesArgs,
  nestedRepoProbeArgs,
  unlistedRepoRoots,
  registerFsxCapability,
  type FsxStreamSpawner,
  type HostBridge,
  type RuntimeContext,
} from '../browser/runtimeHub'
import {
  connectRuntime,
  createRuntimeFileAccess,
  isRuntimeRequestError,
  startFileSearch,
  type FileSearchRequest,
  type RuntimeConnection,
  type RuntimeFileAccess,
} from '../browser/runtimeClient'

const HOME = '/home/u'
const PROJECT = '/work/proj'
const SESSION = 's-1'

/** Directories that exist; `stat` / `realpath` answer for them and for `FILES`. */
const DIRS = new Set(['/', '/work', PROJECT, `${PROJECT}/src`, '/etc', HOME])
const FILES = new Set([`${PROJECT}/README.md`])

const host: HostBridge = {
  async request(route, payload) {
    const path = (payload as { path?: string }).path ?? ''
    switch (route.action) {
      case 'userHome':
        return { ok: true, result: HOME }
      case 'realpath':
        return DIRS.has(path) || FILES.has(path)
          ? { ok: true, result: { path } }
          : { ok: false, error: { code: 'FS_ERROR', message: 'Failed to resolve canonical path' } }
      case 'stat':
        if (DIRS.has(path)) return { ok: true, result: { isFile: false, isDirectory: true, size: 0 } }
        if (FILES.has(path)) return { ok: true, result: { isFile: true, isDirectory: false, size: 1 } }
        return { ok: false, error: { code: 'FS_ERROR', message: 'not found' } }
      default:
        return { ok: false, error: { code: 'FS_ERROR', message: `unexpected fs.${String(route.action)}` } }
    }
  },
}

/** One child the fake spawner started: what it was asked to run, and the levers to play it. */
type FakeChild = {
  spec: { file: string; args: string[]; cwd: string }
  killed: boolean
  out(text: string): void
  err(text: string): void
  exit(exit?: Partial<NativeStreamExit>): void
}

/**
 * A fake spawner. The nested-repository probe never lands in `children`: it answers with the
 * `.git/HEAD` of each folder in `repos` and exits, and `probes` records its runs.
 */
function fakeSpawner(options: { repos?: string[] } = {}) {
  const children: FakeChild[] = []
  const probes: Array<{ args: string[]; cwd: string }> = []
  const spawner: FsxStreamSpawner = async (spec, handlers: NativeStreamHandlers) => {
    const encoder = new TextEncoder()
    if (spec.args.includes('--no-ignore')) {
      probes.push({ args: spec.args, cwd: spec.cwd })
      queueMicrotask(() => {
        const lines = (options.repos ?? []).map(repo => `./${repo}/.git/HEAD\n`).join('')
        if (lines) handlers.onOutput?.('stdout', encoder.encode(lines))
        handlers.onExit?.({ exitCode: lines ? 0 : 1, timedOut: false, killed: false, durationMs: 1 })
      })
      return { streamId: 'probe', write: async () => true, closeStdin: async () => true, kill: async () => true, detach: () => {} }
    }
    let exited = false
    const child: FakeChild = {
      spec,
      killed: false,
      out: text => handlers.onOutput?.('stdout', encoder.encode(text)),
      err: text => handlers.onOutput?.('stderr', encoder.encode(text)),
      exit: exit => {
        if (exited) return
        exited = true
        handlers.onExit?.({ exitCode: 0, timedOut: false, killed: false, durationMs: 1, ...exit })
      },
    }
    children.push(child)
    return {
      streamId: `stream-${children.length}`,
      write: async () => true,
      closeStdin: async () => true,
      kill: async () => {
        child.killed = true
        return true
      },
      detach: () => {},
    }
  }
  return { children, probes, spawner }
}

function makeServer(options: { spawner?: FsxStreamSpawner | null; indexMaxFiles?: number } = {}) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host,
    homeDir: HOME,
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: HOME, fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({
    registry,
    broker,
    context,
    runtimeVersion: 'fsx-search-test',
    bootstrap: () => ({ homeDir: HOME, platform: 'test', pathSep: '/' }),
  })
  const search = new FsxSearchService({
    spawner: () => (options.spawner === undefined ? null : options.spawner),
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    dropTopic: id => broker.dropTopic(id),
    connections: () => hub.list(),
    ...(options.indexMaxFiles !== undefined ? { indexMaxFiles: options.indexMaxFiles } : {}),
  })
  broker.registerProvider(search.topicProvider())
  registerFsxCapability(registry, { sessionRoots: id => (id === SESSION ? { cwd: PROJECT, projectRoot: PROJECT } : null) }, search)
  return { hub, search }
}

function connect(server: ReturnType<typeof makeServer>, scopeCeiling?: ScopeMode): Promise<RuntimeConnection> {
  const channel = new MessageChannel()
  server.hub.attach(createMessagePortTransport(channel.port1))
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: 'page', kind: 'desktop-shell' },
    ...(scopeCeiling ? { scopeCeiling } : {}),
  })
}

async function client(server: ReturnType<typeof makeServer>, scope?: ScopeMode) {
  const connection = await connect(server, scope)
  const files = createRuntimeFileAccess({ connection: async () => connection })
  return { connection, files }
}

/** Start `request` and collect every state it publishes. */
async function follow(files: RuntimeFileAccess, request: FileSearchRequest) {
  const states: FsxSearchState[] = []
  const stop = await startFileSearch(files, SESSION, request, state => states.push(state))
  return { states, stop, last: () => states.at(-1) }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return isRuntimeRequestError(error) ? error.code : `thrown: ${String(error)}`
  }
}

/** One `rg --json` match line. `start`/`end` are byte offsets into `line`. */
function matchLine(path: string, lineNumber: number, line: string, subs: Array<[number, number]>): string {
  return `${JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text: `${line}\n` },
      line_number: lineNumber,
      submatches: subs.map(([start, end]) => ({ match: { text: '' }, start, end })),
    },
  })}\n`
}

describe('fsx.findFiles', () => {
  it('lists the folder once with the search binary and ranks an exact name above a scattered match', async () => {
    const { children, spawner } = fakeSpawner()
    const server = makeServer({ spawner })
    const { files } = await client(server)
    const search = await follow(files, { kind: 'files', path: PROJECT, query: 'deep' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const child = children[0]!
    expect(child.spec.file).toBe('rg')
    expect(child.spec.cwd).toBe(PROJECT)
    expect(child.spec.args).toEqual(expect.arrayContaining(['--files', '--hidden', '--no-require-git', '!.git', `!${RUNTIME_DIR_NAME}`]))
    expect(child.spec.args).not.toContain('--follow')
    expect(child.spec.args).not.toContain('--sort')
    child.out('docs/dxexexp.md\nsrc/deeper/x.ts\na/b/c/deep.txt\n')
    child.exit({ exitCode: 0 })
    await vi.waitFor(() => expect(search.last()?.scanning).toBe(false))
    const state = search.last()!
    expect(state.kind).toBe('files')
    if (state.kind !== 'files') return
    expect(state.files[0]).toEqual({ path: 'a/b/c/deep.txt', ranges: [6, 10] })
    expect(state.files.map(file => file.path)).toContain('docs/dxexexp.md')
    expect(state.matched).toBe(state.files.length)
  })

  it('publishes partial results while the child still lists, then a final state', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner }))
    const search = await follow(files, { kind: 'files', path: PROJECT, query: 'main' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0]!.out('src/main.ts\nsrc/ot')
    await vi.waitFor(() => {
      const state = search.last()
      expect(state?.kind === 'files' && state.files.map(file => file.path)).toEqual(['src/main.ts'])
    })
    expect(search.last()?.scanning).toBe(true)
    // The unterminated line waits for its end.
    children[0]!.out('her/main.rs\n')
    children[0]!.exit()
    await vi.waitFor(() => expect(search.last()?.scanning).toBe(false))
    const state = search.last()!
    expect(state.kind === 'files' && state.files.map(file => file.path).sort()).toEqual(['src/main.ts', 'src/other/main.rs'])
  })

  it('reuses the folder list for later queries, and lists again on refresh or after invalidate', async () => {
    const { children, spawner } = fakeSpawner()
    const server = makeServer({ spawner })
    const { files } = await client(server)
    const first = await follow(files, { kind: 'files', path: PROJECT, query: 'a' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0]!.out('alpha.ts\nbeta.ts\n')
    children[0]!.exit()
    await vi.waitFor(() => expect(first.last()?.scanning).toBe(false))

    const second = await follow(files, { kind: 'files', path: PROJECT, query: 'beta' })
    await vi.waitFor(() => expect(second.last()?.scanning).toBe(false))
    expect(children).toHaveLength(1)
    const state = second.last()!
    expect(state.kind === 'files' && state.files.map(file => file.path)).toEqual(['beta.ts'])

    const third = await follow(files, { kind: 'files', path: PROJECT, query: 'beta', refresh: true })
    await vi.waitFor(() => expect(children).toHaveLength(2))
    children[1]!.exit()
    await vi.waitFor(() => expect(third.last()?.scanning).toBe(false))
    server.search.invalidate()
    await follow(files, { kind: 'files', path: PROJECT, query: 'beta' })
    await vi.waitFor(() => expect(children).toHaveLength(3))
  })

  it('keeps a listing in progress when the next keystroke searches the same folder', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner }))
    const first = await follow(files, { kind: 'files', path: PROJECT, query: 'a' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const second = await follow(files, { kind: 'files', path: PROJECT, query: 'al' })
    first.stop()
    children[0]!.out('alpha.ts\n')
    children[0]!.exit()
    await vi.waitFor(() => expect(second.last()?.scanning).toBe(false))
    expect(children).toHaveLength(1)
    expect(children[0]!.killed).toBe(false)
  })

  it('a newer search in another folder kills the older listing', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner }))
    await follow(files, { kind: 'files', path: PROJECT, query: 'a' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    await follow(files, { kind: 'files', path: `${PROJECT}/src`, query: 'a' })
    await vi.waitFor(() => expect(children).toHaveLength(2))
    await vi.waitFor(() => expect(children[0]!.killed).toBe(true))
    expect(children[1]!.killed).toBe(false)
  })

  it('stops listing at the cap: the child is killed and the list says it is incomplete', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner, indexMaxFiles: 3 }))
    const search = await follow(files, { kind: 'files', path: PROJECT, query: 'f' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0]!.out('f1\nf2\nf3\nf4\nf5\n')
    await vi.waitFor(() => expect(search.last()?.scanning).toBe(false))
    expect(children[0]!.killed).toBe(true)
    const state = search.last()!
    expect(state.kind === 'files' && state.indexTruncated).toBe(true)
    expect(state.kind === 'files' && state.matched).toBe(3)
  })

  it('lists, under its own path, a repository the folder\'s ignore files left out, and leaves an inner one to its own listing', async () => {
    const { children, probes, spawner } = fakeSpawner({ repos: ['vendor/lib', 'tracked', 'vendor/lib/inner'] })
    const { files } = await client(makeServer({ spawner }))
    const search = await follow(files, { kind: 'files', path: PROJECT, query: 'custom' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    expect(probes).toEqual([{ args: nestedRepoProbeArgs(), cwd: PROJECT }])
    expect(nestedRepoProbeArgs()).toEqual(expect.arrayContaining(['--no-ignore', '--max-depth', '5', '**/.git/HEAD', '!node_modules']))
    children[0]!.out('a.ts\ntracked/t.ts\n')
    children[0]!.exit()

    await vi.waitFor(() => expect(children).toHaveLength(2))
    expect(children[1]!.spec).toEqual({ file: 'rg', args: findFilesArgs(), cwd: `${PROJECT}/vendor/lib/inner` })
    children[1]!.out('./i.ts\n')
    children[1]!.exit()
    await vi.waitFor(() => expect(children).toHaveLength(3))
    expect(children[2]!.spec).toEqual({ file: 'rg', args: findFilesArgs(['inner']), cwd: `${PROJECT}/vendor/lib` })
    expect(findFilesArgs(['inner'])).toEqual(expect.arrayContaining(['--glob', '!/inner/**']))
    children[2]!.out('./custom.cc\n')
    children[2]!.exit()

    await vi.waitFor(() => expect(search.last()?.scanning).toBe(false))
    expect(children).toHaveLength(3)
    const state = search.last()!
    expect(state.kind === 'files' && state.files.map(file => file.path)).toEqual(['vendor/lib/custom.cc'])
    const all = await follow(files, { kind: 'files', path: PROJECT, query: 'ts' })
    await vi.waitFor(() => expect(all.last()?.scanning).toBe(false))
    const listed = all.last()!
    expect(listed.kind === 'files' && listed.files.map(file => file.path).sort()).toEqual(['a.ts', 'tracked/t.ts', 'vendor/lib/inner/i.ts'])
  })

  it('gives each left-out repository an equal share of what the cap has left', async () => {
    const { children, spawner } = fakeSpawner({ repos: ['y', 'x'] })
    const { files } = await client(makeServer({ spawner, indexMaxFiles: 6 }))
    const search = await follow(files, { kind: 'files', path: PROJECT, query: 'f' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0]!.out('f1\nf2\n')
    children[0]!.exit()
    await vi.waitFor(() => expect(children).toHaveLength(2))
    expect(children[1]!.spec.cwd).toBe(`${PROJECT}/x`)
    children[1]!.out('fa\nfb\nfc\n')
    await vi.waitFor(() => expect(children).toHaveLength(3))
    expect(children[1]!.killed).toBe(true)
    children[2]!.out('fd\n')
    children[2]!.exit()
    await vi.waitFor(() => expect(search.last()?.scanning).toBe(false))
    const state = search.last()!
    expect(state.kind === 'files' && state.matched).toBe(5)
    expect(state.kind === 'files' && state.indexTruncated).toBe(true)
  })

  it('finds left-out repositories deepest first and escapes glob characters in an inner one', () => {
    expect(unlistedRepoRoots(['.git/HEAD', 'a/.git/HEAD', 'a/b/.git/HEAD', 'c/.git/HEAD', 'd/.git'], ['c/x.ts'])).toEqual(['a/b', 'a'])
    expect(findFilesArgs(['we[1]/x'])).toEqual(expect.arrayContaining(['--glob', '!/we\\[1\\]/x/**']))
  })

  it('a scoped connection searches inside the project and is forbidden_scope outside it, before any child starts', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner }), 'observe')
    expect(await codeOf(files.findFiles(SESSION, '/etc', 'passwd'))).toBe('forbidden_scope')
    expect(await codeOf(files.searchText(SESSION, '/etc', 'root'))).toBe('forbidden_scope')
    expect(children).toHaveLength(0)
    expect(await codeOf(files.findFiles(SESSION, 'src', 'x'))).toBe('ok')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    expect(children[0]!.spec.cwd).toBe(`${PROJECT}/src`)
  })

  it('a missing folder is not_found and a file is conflict; a bad payload is refused', async () => {
    const { files } = await client(makeServer({ spawner: fakeSpawner().spawner }))
    expect(await codeOf(files.findFiles(SESSION, 'nope', 'x'))).toBe('not_found')
    expect(await codeOf(files.findFiles(SESSION, 'README.md', 'x'))).toBe('conflict')
    expect(await codeOf(files.findFiles(SESSION, '.', ''))).toBe('bad_payload')
    expect(await codeOf(files.findFiles(SESSION, '.', 'x', { limit: 10_000 }))).toBe('bad_payload')
  })

  it('says the search is unavailable when the host cannot run the binary', async () => {
    const refusing: FsxStreamSpawner = async () => {
      throw new NativePrimitiveUnsupportedError('shell.spawn.argv')
    }
    const { files } = await client(makeServer({ spawner: refusing }))
    const search = await follow(files, { kind: 'files', path: PROJECT, query: 'x' })
    await vi.waitFor(() => expect(search.last()?.error).toBe('unavailable'))
    expect(search.last()?.scanning).toBe(false)
  })

  it('only the starting connection may read the results, and cancelSearch kills the child', async () => {
    const { children, spawner } = fakeSpawner()
    const server = makeServer({ spawner })
    const owner = await client(server)
    const other = await client(server)
    const searchId = await owner.files.searchText(SESSION, PROJECT, 'needle')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const seen: unknown[] = []
    other.connection.subscribe(fsxSearchTopic(searchId), event => seen.push(event.payload))
    await other.files.cancelSearch(searchId)
    expect(children[0]!.killed).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen).toEqual([])
    await owner.files.cancelSearch(searchId)
    expect(children[0]!.killed).toBe(true)
  })
})

describe('fsx.searchText', () => {
  it('builds the argv from the toggles', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner }))
    await files.searchText(SESSION, PROJECT, '-needle')
    await files.searchText(SESSION, PROJECT, 'a.b', { caseSensitive: true, wholeWord: true, regex: true })
    await vi.waitFor(() => expect(children).toHaveLength(2))
    const [literal, regex] = children.map(child => child.spec.args)
    expect(literal).toEqual(expect.arrayContaining(['--json', '--fixed-strings', '--ignore-case', '--regexp', '-needle']))
    expect(literal).not.toContain('--word-regexp')
    expect(literal!.slice(-2)).toEqual(['--', '.'])
    expect(literal![literal!.indexOf('--max-count') + 1]).toBe(String(FSX_SEARCH_TEXT_MAX_PER_FILE + 1))
    expect(regex).toEqual(expect.arrayContaining(['--case-sensitive', '--word-regexp', '--regexp', 'a.b']))
    expect(regex).not.toContain('--fixed-strings')
    expect(regex).not.toContain('--ignore-case')
  })

  it('groups the JSON hits by file, with UTF-16 ranges and paths relative to the folder', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner }))
    const search = await follow(files, { kind: 'text', path: PROJECT, query: 'needle' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const child = children[0]!
    child.out(`${JSON.stringify({ type: 'begin', data: { path: { text: './a/b.ts' } } })}\n`)
    child.out(matchLine('./a/b.ts', 3, 'const needle = 1', [[6, 12]]))
    // "é" is two bytes: the byte offsets 3..9 are UTF-16 2..8.
    child.out(matchLine('./a/b.ts', 7, 'é needle\r', [[3, 9]]))
    child.out(matchLine('./c.md', 1, 'needle', [[0, 6]]))
    child.out('{"type":"summary","data":{}}\nnot json\n')
    child.exit({ exitCode: 0 })
    await vi.waitFor(() => expect(search.last()?.scanning).toBe(false))
    const state = search.last()!
    expect(state).toMatchObject({
      kind: 'text',
      truncated: false,
      files: [
        {
          path: 'a/b.ts',
          moreInFile: false,
          hits: [
            { line: 3, text: 'const needle = 1', ranges: [6, 12] },
            { line: 7, text: 'é needle', ranges: [2, 8] },
          ],
        },
        { path: 'c.md', hits: [{ line: 1, text: 'needle', ranges: [0, 6] }] },
      ],
    })
  })

  it('marks a file with more hits than it keeps, and stops at the limit with the child killed', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner }))
    const perFile = await follow(files, { kind: 'text', path: PROJECT, query: 'x' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    for (let line = 1; line <= FSX_SEARCH_TEXT_MAX_PER_FILE + 1; line += 1) children[0]!.out(matchLine('f.ts', line, 'x', [[0, 1]]))
    children[0]!.exit()
    await vi.waitFor(() => expect(perFile.last()?.scanning).toBe(false))
    const kept = perFile.last()!
    expect(kept.kind === 'text' && kept.files[0]!.hits).toHaveLength(FSX_SEARCH_TEXT_MAX_PER_FILE)
    expect(kept.kind === 'text' && kept.files[0]!.moreInFile).toBe(true)

    const limited = await follow(files, { kind: 'text', path: PROJECT, query: 'y', limit: 2 })
    await vi.waitFor(() => expect(children).toHaveLength(2))
    children[1]!.out(matchLine('a.ts', 1, 'y', [[0, 1]]) + matchLine('b.ts', 1, 'y', [[0, 1]]) + matchLine('c.ts', 1, 'y', [[0, 1]]))
    await vi.waitFor(() => expect(limited.last()?.scanning).toBe(false))
    expect(children[1]!.killed).toBe(true)
    const state = limited.last()!
    expect(state.kind === 'text' && state.truncated).toBe(true)
    expect(state.kind === 'text' && state.files.map(file => file.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('a newer query from the same client kills the older child', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner }))
    const older = await follow(files, { kind: 'text', path: PROJECT, query: 'ne' })
    await follow(files, { kind: 'text', path: PROJECT, query: 'needle' })
    await vi.waitFor(() => expect(children).toHaveLength(2))
    await vi.waitFor(() => expect(children[0]!.killed).toBe(true))
    expect(children[1]!.killed).toBe(false)
    // The older search publishes nothing more once replaced.
    const seen = older.states.length
    children[0]!.out(matchLine('late.ts', 1, 'ne', [[0, 2]]))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(older.states).toHaveLength(seen)
  })

  it('a regular expression the binary rejects comes back as invalid_regex', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner }))
    const search = await follow(files, { kind: 'text', path: PROJECT, query: 'a(', regex: true })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0]!.err('rg: regex parse error:\n    (?:a()\n    ^\nerror: unclosed group\n')
    children[0]!.exit({ exitCode: 2 })
    await vi.waitFor(() => expect(search.last()?.error).toBe('invalid_regex'))
  })

  it('cuts a long line around its first hit', async () => {
    const { children, spawner } = fakeSpawner()
    const { files } = await client(makeServer({ spawner }))
    const search = await follow(files, { kind: 'text', path: PROJECT, query: 'needle' })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const line = `${'x'.repeat(5000)}needle${'y'.repeat(500)}`
    children[0]!.out(matchLine('min.js', 1, line, [[5000, 5006]]))
    children[0]!.exit()
    await vi.waitFor(() => expect(search.last()?.scanning).toBe(false))
    const state = search.last()!
    const hit = state.kind === 'text' ? state.files[0]!.hits[0]! : null
    expect(hit!.text.length).toBeLessThanOrEqual(242)
    expect(hit!.text.slice(hit!.ranges[0], hit!.ranges[1])).toBe('needle')
  })
})
