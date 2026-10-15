/**
 * `$.fs` (F-25) — `fileModFs` over a fake fs, and the noun
 * through a real `ModRuntime`: read (text, bytes, the size cap), write (its
 * directories made), list, exists, stat (link, realPath), ancestors (root
 * first, `of`, `below`); the untrusted-session read boundary; each call its
 * own op event a guard hooks; a host without a file system refusing by name.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import { fileModFs, MOD_FS_READ_LIMIT } from '../mods/modFs'
import type { RuntimeFsEntry, RuntimeFs, RuntimeFsStat } from '../utils/fs/runtimeFs'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

/** An in-memory fs: files by absolute path, directories implied by them and
 *  by `mkdir`, symbolic links by target. */
function fakeFs(initial: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>(['/'])
  const links = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/'
  const addDirs = (p: string) => {
    let d = parentOf(p)
    while (!dirs.has(d)) {
      dirs.add(d)
      d = parentOf(d)
    }
  }
  for (const [path, content] of Object.entries(initial)) {
    files.set(path, typeof content === 'string' ? encoder.encode(content) : content)
    mtimes.set(path, 1_000)
    addDirs(path)
  }
  const follow = (p: string): string => {
    let seen = 0
    while (links.has(p) && seen++ < 8) p = links.get(p)!
    return p
  }
  const statOf = (p: string): RuntimeFsStat => {
    const t = follow(p)
    const isFile = files.has(t)
    const isDir = dirs.has(t)
    if (!isFile && !isDir) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return {
      size: isFile ? files.get(t)!.length : 0,
      mtimeMs: mtimes.get(t) ?? 0,
      isFile: () => isFile,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isCharacterDevice: () => false,
      isBlockDevice: () => false,
    }
  }
  const fs = {
    cwd: () => '/work/project',
    async stat(p: string) {
      return statOf(p)
    },
    lstatSync(p: string): RuntimeFsStat {
      if (links.has(p)) {
        return { ...statOf(follow(p)), isSymbolicLink: () => true }
      }
      return statOf(p)
    },
    async readdir(p: string): Promise<RuntimeFsEntry[]> {
      if (!dirs.has(p)) throw new Error('ENOENT')
      const names = new Set<string>()
      for (const f of [...files.keys(), ...dirs, ...links.keys()]) {
        if (f !== p && parentOf(f) === p) names.add(f.slice(p.length === 1 ? 1 : p.length + 1))
      }
      return [...names].sort().map(name => {
        const full = p === '/' ? `/${name}` : `${p}/${name}`
        return {
          name,
          isFile: () => files.has(full),
          isDirectory: () => dirs.has(full),
          isSymbolicLink: () => links.has(full),
        }
      })
    },
    async readFile(p: string) {
      const t = follow(p)
      if (!files.has(t)) throw new Error('ENOENT')
      return decoder.decode(files.get(t)!)
    },
    async readFileBytes(p: string) {
      const t = follow(p)
      if (!files.has(t)) throw new Error('ENOENT')
      return files.get(t)!
    },
    async writeFile(p: string, data: string | Uint8Array) {
      if (!dirs.has(parentOf(p))) throw new Error(`ENOENT: no directory ${parentOf(p)}`)
      files.set(p, typeof data === 'string' ? encoder.encode(data) : data)
      mtimes.set(p, 2_000)
    },
    async mkdir(p: string) {
      if (!dirs.has(parentOf(p))) throw new Error('ENOENT')
      dirs.add(p)
    },
    async realpath(p: string) {
      const t = follow(p)
      if (!files.has(t) && !dirs.has(t)) throw new Error('ENOENT')
      return t
    },
  }
  return {
    fs: fs as unknown as RuntimeFs,
    link(from: string, to: string) {
      links.set(from, to)
      addDirs(from)
    },
    text(p: string) {
      return files.has(p) ? decoder.decode(files.get(p)!) : undefined
    },
    hasDir: (p: string) => dirs.has(p),
  }
}

describe('fileModFs', () => {
  it('read: text, bytes as base64, a relative path under cwd, a missing file as ENOENT, over the cap refused', async () => {
    const world = fakeFs({ '/work/project/README.md': '# hi', '/work/project/a.bin': new Uint8Array([0, 255, 16]) })
    const fs = fileModFs(world.fs, { cwd: '/work/project', readLimit: 4 })
    expect(await fs.read('README.md', 'text')).toBe('# hi'.slice(0, 4))
    expect(await fs.read('/work/project/a.bin', 'bytes')).toEqual({ base64: 'AP8Q' })
    await expect(fs.read('missing.md', 'text')).rejects.toMatchObject({ name: 'NotFoundError', code: 'ENOENT' })
    const big = fileModFs(world.fs, { cwd: '/work/project', readLimit: 2 })
    await expect(big.read('README.md', 'text')).rejects.toMatchObject({ name: 'RangeError' })
    expect(MOD_FS_READ_LIMIT).toBe(4 * 1024 * 1024)
  })

  it('write creates the directories it needs; list, exists, stat and a link', async () => {
    const world = fakeFs({ '/work/project/src/a.ts': 'a' })
    const fs = fileModFs(world.fs, { cwd: '/work/project' })
    await fs.write('out/deep/notes.md', 'n')
    expect(world.text('/work/project/out/deep/notes.md')).toBe('n')
    expect(world.hasDir('/work/project/out/deep')).toBe(true)
    world.link('/work/project/src/link.ts', '/work/project/src/a.ts')
    expect(await fs.list('src')).toEqual([
      { name: 'a.ts', kind: 'file', size: 1, mtimeMs: 1_000, isLink: false },
      { name: 'link.ts', kind: 'other', size: 0, mtimeMs: 0, isLink: true },
    ])
    expect((await fs.list()).map(e => e.name)).toEqual(['out', 'src'])
    expect(await fs.exists('src/a.ts')).toBe(true)
    expect(await fs.exists('src/b.ts')).toBe(false)
    expect(await fs.stat('src/a.ts', false)).toEqual({ kind: 'file', size: 1, mtimeMs: 1_000, isLink: false })
    expect(await fs.stat('src/link.ts', true)).toEqual({
      kind: 'file',
      size: 1,
      mtimeMs: 1_000,
      isLink: true,
      realPath: '/work/project/src/a.ts',
    })
    expect(await fs.stat('src', false)).toMatchObject({ kind: 'dir', size: 0 })
    await expect(fs.stat('nope', false)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.list('src/a.ts')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('ancestors: root first, from cwd or from `of`, stopping at `below`; names checked', async () => {
    const world = fakeFs({
      '/AGENTS.md': 'root',
      '/work/AGENTS.md': 'work',
      '/work/project/src/AGENTS.md': 'src',
      '/work/project/src/deep/file.ts': 'x',
    })
    const fs = fileModFs(world.fs, { cwd: '/work/project' })
    expect(await fs.ancestors({ names: ['AGENTS.md'] })).toEqual([
      { dir: '/', name: 'AGENTS.md', content: 'root', parts: [{ path: '/AGENTS.md', content: 'root' }] },
      { dir: '/work', name: 'AGENTS.md', content: 'work', parts: [{ path: '/work/AGENTS.md', content: 'work' }] },
    ])
    expect(await fs.ancestors({ names: ['AGENTS.md'], of: 'src/deep/file.ts', below: '/work/project' })).toEqual([
      { dir: '/work/project/src', name: 'AGENTS.md', content: 'src', parts: [{ path: '/work/project/src/AGENTS.md', content: 'src' }] },
    ])
    await expect(fs.ancestors({ names: ['../x.md'] })).rejects.toBeInstanceOf(TypeError)
    await expect(fs.ancestors({ names: ['notes.txt'] })).rejects.toBeInstanceOf(TypeError)
  })

  it('ancestors under `below`: only the directories strictly inside it, and nothing for a walk that is not', async () => {
    const world = fakeFs({
      '/work/project/AGENTS.md': 'root of the project',
      '/work/project/src/AGENTS.md': 'src',
      '/work/project/src/file.ts': 'x',
      '/elsewhere/AGENTS.md': 'elsewhere',
      '/elsewhere/file.ts': 'y',
    })
    const fs = fileModFs(world.fs, { cwd: '/work/project' })
    // The floor's own file is the walk's, not the nested one's.
    expect((await fs.ancestors({ names: ['AGENTS.md'], of: 'src/file.ts', below: '/work/project' })).map(a => a.dir)).toEqual([
      '/work/project/src',
    ])
    expect(await fs.ancestors({ names: ['AGENTS.md'], of: 'AGENTS.md', below: '/work/project' })).toEqual([])
    expect(await fs.ancestors({ names: ['AGENTS.md'], of: '/elsewhere/file.ts', below: '/work/project' })).toEqual([])
  })

  it('ancestors read as the memory loader reads: @ imports as parts, comments stripped, an empty file not found', async () => {
    const world = fakeFs({
      '/work/project/AGENTS.md': 'Top.<!-- private -->\n@./docs/style.md\n',
      '/work/project/docs/style.md': 'Use tabs.',
      '/work/AGENTS.md': '<!-- only a comment -->\n',
    })
    const fs = fileModFs(world.fs, { cwd: '/work/project' })
    const found = await fs.ancestors({ names: ['AGENTS.md'] })
    expect(found).toHaveLength(1)
    expect(found[0]!.parts.map(part => part.path)).toEqual(['/work/project/AGENTS.md', '/work/project/docs/style.md'])
    expect(found[0]!.parts[0]!.content).not.toContain('private')
    expect(found[0]!.content).toBe(found[0]!.parts.map(part => part.content).join('\n\n'))
    expect(found[0]!.content).toContain('Use tabs.')
  })

  it('an untrusted child reaches nothing outside its root, writes included', async () => {
    const world = fakeFs({ '/home/u/secret.txt': 's', '/home/u/work/child/ok.txt': 'o' })
    const fs = fileModFs(world.fs, { cwd: '/home/u/work/child', readRoot: '/home/u/work/child' })
    expect(await fs.read('ok.txt', 'text')).toBe('o')
    await expect(fs.read('/home/u/secret.txt', 'text')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(fs.read('../../secret.txt', 'text')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(fs.write('/home/u/pwned.txt', 'x')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(fs.list('/home/u')).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(world.text('/home/u/pwned.txt')).toBeUndefined()
  })

  it('an untrusted child\'s ancestors climb no further than its root', async () => {
    const world = fakeFs({ '/home/u/AGENTS.md': 'outside', '/home/u/work/child/AGENTS.md': 'inside' })
    const fs = fileModFs(world.fs, { cwd: '/home/u/work/child', readRoot: '/home/u/work/child' })
    expect(await fs.ancestors({ names: ['AGENTS.md'] })).toEqual([
      { dir: '/home/u/work/child', name: 'AGENTS.md', content: 'inside', parts: [{ path: '/home/u/work/child/AGENTS.md', content: 'inside' }] },
    ])
  })
})

describe('$.fs through the runtime', () => {
  let uniq = 0
  function world(modules: Record<string, string>, host: Partial<ModNounHost> = {}) {
    const reports: string[] = []
    const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
    const runtime = new ModRuntime({
      modules: refs,
      readModule: async path => `${modules[path.split('/')[2]!]}\n// load ${++uniq}`,
      openWorker: async (): Promise<ModWorkerHandle> => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
        const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
          settle = resolve
        })
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      session: { id: () => 's', cwd: () => '/work/project', ...host },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)
    return { runtime, reports }
  }

  it('a mod reads, writes, lists and stats through the session fs; another plugin\'s guard denies a write by hooking fs.write', async () => {
    const files = fakeFs({ '/work/project/README.md': '# project' })
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('fs.write', ($, e, next) => /secret/.test(e.path) ? { deny: 'GUARD: not that file' } : next(e));
          }
        `,
        worker: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const text = await $.fs.read('README.md');
              await $.fs.write('notes/out.md', text + '!');
              const names = (await $.fs.list()).map(x => x.name + ':' + x.kind);
              const stat = await $.fs.stat('notes/out.md', { resolve: true });
              let denied;
              try { await $.fs.write('secret.md', 'x') } catch (error) { denied = error.message }
              const bytes = await $.fs.read('README.md', { as: 'bytes' });
              await $.ui.log(JSON.stringify({ text, names, stat, denied, bytes, exists: await $.fs.exists('nope') }));
              return next(e);
            });
          }
        `,
      },
      { fs: fileModFs(files.fs, { cwd: '/work/project' }) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('worker: {'))!
    expect(JSON.parse(line.slice('worker: '.length))).toEqual({
      text: '# project',
      names: ['README.md:file', 'notes:dir'],
      stat: { kind: 'file', size: 10, mtimeMs: 2_000, isLink: false, realPath: '/work/project/notes/out.md' },
      denied: 'GUARD: not that file',
      bytes: { base64: 'IyBwcm9qZWN0' },
      exists: false,
    })
    expect(files.text('/work/project/notes/out.md')).toBe('# project!')
    expect(files.text('/work/project/secret.md')).toBeUndefined()
  })

  it('a bad argument is refused in the hook by name; a host without a file system refuses the noun', async () => {
    const { runtime, reports } = world(
      {
        probe: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const a = await $.fs.read('').catch(err => err.name + ': ' + err.message);
              const b = await $.fs.write('x.md', 7).catch(err => err.name + ': ' + err.message);
              await $.ui.log(a + ' | ' + b);
              return next(e);
            });
          }
        `,
      },
      { fs: fileModFs(fakeFs().fs, { cwd: '/work/project' }) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual([
      'probe: TypeError: $.fs.read(path): path must be a non-empty string | TypeError: $.fs.write(path, text): text must be a string',
    ])
    const bare = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(await $.fs.exists('x').catch(err => err.name + ': ' + err.message));
            return next(e);
          });
        }
      `,
    })
    await bare.runtime.ready
    await bare.runtime.promptSubmit('go')
    expect(bare.reports).toEqual(['probe: NotSupportedError: $.fs is not available: this session has no file system'])
  })
})
