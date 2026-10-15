/**
 * Pins the dev server's `server.watch.ignored` (vite/devServerWatch.ts) against Vite's real watcher: each case
 * boots a middleware-mode server on a throwaway tree that mirrors a main checkout with a nested worktree (plus a
 * junction onto main) and reads what chokidar watches.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createLogger, createServer, normalizePath, type InlineConfig, type UserConfigFnObject,
  type ViteDevServer,
} from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { devServerWatch } from '../../vite/devServerWatch'

// Spy-through: the real helper runs everywhere; the wiring test reads the
// call vite.config.ts made.
vi.mock('../../vite/devServerWatch', { spy: true })

const NEXUS_WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

let tmp: string
let mainRoot: string
let worktreeRoot: string
let junctionRoot: string
const servers: ViteDevServer[] = []

function seedTree(root: string): void {
  mkdirSync(path.join(root, 'src', 'public'), { recursive: true })
  mkdirSync(path.join(root, 'public'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 1\n')
  writeFileSync(path.join(root, 'public', 'logo.txt'), 'logo\n')
  writeFileSync(path.join(root, 'public', 'managed-binaries.json'), '{}\n')
  // The e2e spec's backup of the file it overrides.
  writeFileSync(path.join(root, 'public', 'managed-binaries.json.e2e-bak'), '{}\n')
  // Same-named files the e2e does NOT own: a developer's scratch copy, and one
  // outside the served public/. Both must stay watched.
  writeFileSync(path.join(root, 'public', 'managed-binaries.json.draft'), '{}\n')
  writeFileSync(path.join(root, 'src', 'public', 'managed-binaries.json'), '{}\n')
}

beforeAll(() => {
  // realpath: %TEMP% may be an 8.3 short path, and chokidar reports long ones.
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'nexus-watch-')))
  // A glob character in the checkout path: an absolute-glob ignore silently
  // stops matching under it (see vite/devServerWatch.ts).
  mainRoot = path.join(tmp, 'checkout (1)', 'nexus_web')
  worktreeRoot = path.join(mainRoot, '.velloc', 'worktrees', 'some-branch')
  seedTree(mainRoot)
  seedTree(worktreeRoot)
  // `junction` is honoured on Windows (no admin rights) and makes an ordinary
  // directory symlink elsewhere — the same spelling mismatch either way.
  junctionRoot = path.join(tmp, 'junction-to-main')
  symlinkSync(mainRoot, junctionRoot, 'junction')
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

afterAll(() => {
  if (!tmp) return
  // Unlink the junction itself first — a recursive delete must never follow it.
  if (junctionRoot && existsSync(junctionRoot)) unlinkSync(junctionRoot)
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * A dev server on `root`, wired the way vite.config.ts wires it:
 * devServerWatch(anchor) supplies both the plugin and server.watch.ignored.
 * `anchor` defaults to `root`; vite.config.ts passes its own __dirname, which
 * is the REAL path even when the server is started through a junction.
 */
async function startDevServer(
  root: string, anchor = root,
): Promise<{ server: ViteDevServer; infos: string[] }> {
  const watch = devServerWatch(anchor)
  const infos: string[] = []
  const logger = createLogger('silent')
  logger.info = (msg) => { infos.push(msg) }
  const config: InlineConfig = {
    configFile: false,
    root,
    customLogger: logger,
    appType: 'custom',
    plugins: [watch.plugin],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      middlewareMode: true,
      ws: false,
      watch: { ignored: watch.ignored },
    },
  }
  const server = await createServer(config)
  servers.push(server)
  return { server, infos }
}

/** chokidar's getWatched(), keyed by forward-slash absolute directory. */
function watched(server: ViteDevServer): Record<string, string[]> {
  const byDir: Record<string, string[]> = {}
  for (const [dir, children] of Object.entries(server.watcher.getWatched())) {
    byDir[normalizePath(dir)] = children
  }
  return byDir
}

const dir = (...segments: string[]): string => normalizePath(path.join(...segments))

/**
 * Waits until the initial scan has listed `root`, src/ and public/. Each ignore
 * decision below is made while the scan reads the entry's parent directory, so
 * once a parent is listed, its ignored entries are final.
 */
async function scanned(server: ViteDevServer, root: string): Promise<Record<string, string[]>> {
  await vi.waitFor(
    () => {
      const tree = watched(server)
      expect(tree[dir(root)]).toEqual(expect.arrayContaining(['public', 'src']))
      expect(tree[dir(root, 'src')]).toContain('app.ts')
      expect(tree[dir(root, 'public')]).toContain('logo.txt')
    },
    { timeout: 5_000, interval: 20 },
  )
  return watched(server)
}

describe('devServerWatchIgnored — against the real Vite watcher', () => {
  it('main checkout: watches its own tree, ignores the worktrees nested in .velloc/', async () => {
    const { server } = await startDevServer(mainRoot)
    const tree = await scanned(server, mainRoot)

    expect(tree[dir(mainRoot)]).not.toContain('.velloc')
    expect(Object.keys(tree).filter((d) => d.includes('/.velloc'))).toEqual([])
  }, 15_000)

  it('env-script worktree (root inside .velloc/worktrees/): watches its own tree and sees an edit', async () => {
    // Under f9ac9e64's `**/.velloc/**` this server watched NOTHING: every path
    // below its root contains /.velloc/, so the scan never listed src/, and an
    // edit neither hot-updated, nor reloaded, nor restarted the server.
    const { server } = await startDevServer(worktreeRoot)
    await scanned(server, worktreeRoot)

    const file = path.join(worktreeRoot, 'src', 'app.ts')
    const changes: string[] = []
    server.watcher.on('change', (changed) => changes.push(normalizePath(changed)))
    writeFileSync(file, 'export const app = 2\n')
    await vi.waitFor(() => expect(changes).toContain(normalizePath(file)), { timeout: 5_000 })
  }, 15_000)

  it.each([
    ['main checkout', () => mainRoot],
    ['env-script worktree', () => worktreeRoot],
  ])('%s: ignores public/managed-binaries.json (an e2e spec rewrites it mid-run)', async (_, rootOf) => {
    const root = rootOf()
    const { server } = await startDevServer(root)
    const tree = await scanned(server, root)

    expect(tree[dir(root, 'public')]).not.toContain('managed-binaries.json')
    expect(tree[dir(root, 'public')]).not.toContain('managed-binaries.json.e2e-bak')
  }, 15_000)

  it('ignores only the e2e-owned registry names, only in the served public/, and says so once', async () => {
    // The old `**/public/managed-binaries.json*` glob also swallowed any
    // managed-binaries.json* under any public/ at any depth — a developer's
    // edit there reloaded nothing and nothing said so.
    const { server, infos } = await startDevServer(mainRoot)
    await scanned(server, mainRoot)

    await vi.waitFor(
      () => {
        const tree = watched(server)
        expect(tree[dir(mainRoot, 'public')]).toContain('managed-binaries.json.draft')
        expect(tree[dir(mainRoot, 'src', 'public')]).toContain('managed-binaries.json')
      },
      { timeout: 5_000, interval: 20 },
    )
    // The suppression is said once, not once per event.
    const said = infos.filter((m) => m.includes('managed-binaries.json'))
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/will not reload open pages/)
  }, 15_000)

  it('served through a junction, anchored at the real path: still ignores .velloc/ and the registry', async () => {
    // vite.config.ts anchors at __dirname — the config's REAL path — while
    // chokidar reports paths in the served root's spelling. Served through a
    // junction (the e2e harness's internal/.velloc/worktrees/nexus_web), an
    // ignore that is not re-anchored at config.root never matches: the server
    // watched main's nested worktrees again, and the registry with them.
    const { server } = await startDevServer(junctionRoot, mainRoot)
    const tree = await scanned(server, junctionRoot)

    expect(tree[dir(junctionRoot)]).not.toContain('.velloc')
    expect(Object.keys(tree).filter((d) => d.includes('/.velloc'))).toEqual([])
    expect(tree[dir(junctionRoot, 'public')]).not.toContain('managed-binaries.json')
  }, 15_000)
})

describe('devServerWatch predicates — spellings', () => {
  const [registry, nested] = devServerWatch(NEXUS_WEB_ROOT).ignored as Array<(file: string) => boolean>
  const root = normalizePath(NEXUS_WEB_ROOT)
  const swapDriveCase = (p: string) =>
    p.replace(/^[A-Za-z]/, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))

  it('match forward- and back-slash spellings of the anchor, and nothing beside it', () => {
    // No plugin here, so the once-only registry notice goes to console.info.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(nested(`${root}/.velloc/worktrees/x/src/a.ts`)).toBe(true)
    expect(nested(path.join(NEXUS_WEB_ROOT, '.velloc', 'worktrees', 'x'))).toBe(true)
    expect(nested(`${root}/src/.velloc-not/a.ts`)).toBe(false)
    expect(nested(`${root}/src/a.ts`)).toBe(false)
    expect(registry(`${root}/public/managed-binaries.json`)).toBe(true)
    expect(registry(`${root}/public/managed-binaries.json.e2e-bak`)).toBe(true)
    expect(registry(`${root}/public/managed-binaries.json.draft`)).toBe(false)
    expect(registry(`${root}/src/public/managed-binaries.json`)).toBe(false)
    expect(info).toHaveBeenCalledTimes(1)
    info.mockRestore()
  })

  it.runIf(process.platform === 'win32')('ignore drive-letter and path case on Windows', () => {
    // A cwd typed as d:\project\... is the same directory as D:\project\...,
    // and chokidar reports whichever spelling the server was started with.
    expect(nested(`${swapDriveCase(root)}/.velloc/worktrees/x`)).toBe(true)
    expect(nested(`${root.toUpperCase()}/.VELLOC/worktrees/x`)).toBe(true)
    expect(registry(`${swapDriveCase(root)}/public/managed-binaries.json`)).toBe(true)
  })
})

describe('vite.config.ts', () => {
  it('wires devServerWatch: its plugin is registered, its ignored is server.watch.ignored', async () => {
    const helper = vi.mocked(devServerWatch)
    helper.mockClear()
    const { default: config } = await import('../../vite.config')
    const resolved = await (config as UserConfigFnObject)({ command: 'serve', mode: 'development' })

    expect(helper).toHaveBeenCalledTimes(1)
    expect(normalizePath(helper.mock.calls[0][0])).toBe(normalizePath(NEXUS_WEB_ROOT))
    const watch = helper.mock.results[0].value
    expect(resolved.server?.watch?.ignored).toBe(watch.ignored)
    // Without the plugin the ignore stays anchored at __dirname's spelling.
    expect(resolved.plugins).toContain(watch.plugin)
  })
})
