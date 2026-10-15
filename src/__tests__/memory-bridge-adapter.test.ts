import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type {
  BrowserBridgeRequest,
  BrowserBridgeRoute,
} from '../browser/bridge/protocol'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import {
  memoryHandlers,
  handleMemoryBridgeRequest,
} from '../browser/bridge/adapter/memoryBridgeAdapter'

/**
 * Unit-level pinning for the `memory` capability handlers (the Settings →
 * Memory page). Mirrors `profile-bridge-adapter.test.ts`. The one behaviour
 * that differs from profile: an explicit `false` toggle is a MEANINGFUL
 * override (memory off) and must PERSIST, while `null` reverts to the unset
 * `true` default.
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

const HOME = '/home/test'
const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

beforeEach(() => {
  wipeSettingsMemos()
})

describe('memoryHandlers.snapshot', () => {
  it('returns the defaults when no settings file exists', async () => {
    const { fs } = makeMemoryFs()
    const result = await memoryHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.values).toEqual({
      autoMemoryEnabled: true, // on by default
      memoryMaintenance: 'off', // background memory mode OFF by default
      autoExtractEnabled: false, // capture fork OFF by default
      memoryRecallEnabled: true,
    })
    expect(result.source).toBe('default')
  })

  it('returns stored values merged over defaults, and never the directory', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        autoMemoryEnabled: false,
        autoMemoryDirectory: '/var/mem', // stored, but a host path: not returned
      }),
    })
    const result = await memoryHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.values).toEqual({
      autoMemoryEnabled: false, // stored override
      memoryMaintenance: 'off', // unset → default off
      autoExtractEnabled: false, // unset → default off
      memoryRecallEnabled: true, // unset → default on
    })
    expect(result.source).toBe('file')
  })

  it('reads a stored memoryMaintenance mode', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({ version: 1, memoryMaintenance: 'periodic' }),
    })
    const result = await memoryHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.values.memoryMaintenance).toBe('periodic')
  })
})

describe('memoryHandlers.setField', () => {
  it('persists an explicit false toggle (memory off is a real override)', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await memoryHandlers.setField(
      { patch: { autoMemoryEnabled: false } },
      { homeDir: HOME, fs },
    )
    expect(result.ok).toBe(true)
    expect(result.values.autoMemoryEnabled).toBe(false)
    expect(JSON.parse(files.get(SETTINGS_PATH)!)).toEqual({
      version: 1,
      autoMemoryEnabled: false,
    })
  })

  it('persists memoryMaintenance (opt-in to the consolidation service)', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await memoryHandlers.setField(
      { patch: { memoryMaintenance: 'periodic' } },
      { homeDir: HOME, fs },
    )
    expect(result.values.memoryMaintenance).toBe('periodic')
    expect(JSON.parse(files.get(SETTINGS_PATH)!)).toEqual({
      version: 1,
      memoryMaintenance: 'periodic',
    })
  })

  it('persists an explicit true autoExtractEnabled (opt-in to the capture fork)', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await memoryHandlers.setField(
      { patch: { autoExtractEnabled: true } },
      { homeDir: HOME, fs },
    )
    expect(result.values.autoExtractEnabled).toBe(true)
    // The two background mechanisms are independent — enabling extract must not
    // imply the consolidation service.
    expect(result.values.memoryMaintenance).toBe('off')
    expect(JSON.parse(files.get(SETTINGS_PATH)!)).toEqual({
      version: 1,
      autoExtractEnabled: true,
    })
  })

  it('null reverts a toggle to its unset default', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        autoMemoryEnabled: false,
        memoryRecallEnabled: false,
      }),
    })
    const result = await memoryHandlers.setField(
      { patch: { autoMemoryEnabled: null } },
      { homeDir: HOME, fs },
    )
    expect(result.values.autoMemoryEnabled).toBe(true) // reverted to default
    expect(result.values.memoryRecallEnabled).toBe(false) // unchanged override
    expect(JSON.parse(files.get(SETTINGS_PATH)!)).toEqual({
      version: 1,
      memoryRecallEnabled: false,
    })
  })

  // The directory is a host path outside any session, and `setField` is
  // `control` on the runtime hub. It is settings.json-only.
  it('refuses to set the directory override, and writes nothing', async () => {
    const { fs, files } = makeMemoryFs()
    const broadcastChanged = vi.fn()
    await expect(
      memoryHandlers.setField(
        { patch: { autoMemoryDirectory: '/home/test/.ssh' } } as never,
        { homeDir: HOME, fs, broadcastChanged },
      ),
    ).rejects.toThrow(/autoMemoryDirectory/)
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(files.has(SETTINGS_PATH)).toBe(false)
    expect(broadcastChanged).not.toHaveBeenCalled()
  })

  it('refuses to clear it too, and a toggle riding along is not written', async () => {
    const stored = JSON.stringify({ version: 1, autoMemoryDirectory: '/var/mem' })
    const { fs, files } = makeMemoryFs({ [SETTINGS_PATH]: stored })
    for (const patch of [
      { autoMemoryDirectory: '' },
      { autoMemoryDirectory: null },
      { autoMemoryEnabled: false, autoMemoryDirectory: null },
    ]) {
      await expect(
        memoryHandlers.setField({ patch } as never, { homeDir: HOME, fs }),
      ).rejects.toThrow(/autoMemoryDirectory/)
    }
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(files.get(SETTINGS_PATH)).toBe(stored)
  })

  it('applies multiple toggles in one patch', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await memoryHandlers.setField(
      { patch: { memoryRecallEnabled: false, memoryMaintenance: 'periodic' } },
      { homeDir: HOME, fs },
    )
    expect(result.values.memoryRecallEnabled).toBe(false)
    expect(result.values.memoryMaintenance).toBe('periodic')
    expect(result.values.autoMemoryEnabled).toBe(true) // untouched default
    expect(JSON.parse(files.get(SETTINGS_PATH)!)).toEqual({
      version: 1,
      memoryRecallEnabled: false,
      memoryMaintenance: 'periodic',
    })
  })

  it('fires broadcastChanged with the effective values after a write', async () => {
    const { fs } = makeMemoryFs()
    const broadcastChanged = vi.fn()
    await memoryHandlers.setField(
      { patch: { autoMemoryEnabled: false } },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(broadcastChanged).toHaveBeenCalledTimes(1)
    expect(broadcastChanged).toHaveBeenCalledWith({
      values: {
        autoMemoryEnabled: false,
        memoryMaintenance: 'off',
        autoExtractEnabled: false,
        memoryRecallEnabled: true,
      },
    })
  })
})

describe('handleMemoryBridgeRequest', () => {
  function makeRequest(
    action: 'snapshot' | 'setField',
    payload: unknown = {},
    id = 'req-1',
  ): BrowserBridgeRequest {
    return {
      id,
      route: {
        namespace: 'nexus',
        capability: 'memory',
        action,
      } as unknown as BrowserBridgeRoute,
      payload: payload as never,
    }
  }

  it('routes snapshot → ok envelope', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleMemoryBridgeRequest(makeRequest('snapshot'), {
      homeDir: HOME,
      fs,
    })
    expect(response.ok).toBe(true)
    if (response.ok) {
      const result = response.result as {
        values: { autoMemoryEnabled: boolean }
        source: string
      }
      expect(result.values.autoMemoryEnabled).toBe(true)
      expect(result.source).toBe('default')
    }
  })

  it('routes setField → ok envelope + persists', async () => {
    const { fs, files } = makeMemoryFs()
    const response = await handleMemoryBridgeRequest(
      makeRequest('setField', { patch: { autoMemoryEnabled: false } }),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(true)
    expect(JSON.parse(files.get(SETTINGS_PATH)!).autoMemoryEnabled).toBe(false)
  })

  it('reports a directory patch as invalid_payload, not a handler failure', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleMemoryBridgeRequest(
      makeRequest('setField', { patch: { autoMemoryDirectory: '/home/test/.ssh' } }),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('invalid_payload')
      expect(response.error.message).toContain('settings.json')
    }
  })

  it('catches handler errors → memory_handler_error envelope', async () => {
    const { fs } = makeMemoryFs()
    ;(fs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('disk full')
    })
    const response = await handleMemoryBridgeRequest(
      makeRequest('setField', { patch: { autoMemoryEnabled: false } }),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('memory_handler_error')
      expect(response.error.message).toContain('disk full')
    }
  })
})

// ---------------------------------------------------------------------------
// list / clear — visibility + cleanup over the resolved memory dir.
// ---------------------------------------------------------------------------

/** fs that backs `readdir` / `readFile` / `rm` over a single dir's children. */
function makeDirFs(
  dir: string,
  entries: Array<{ name: string; kind: 'file' | 'dir'; content?: string }>,
) {
  let live = [...entries]
  const removed: string[] = []
  const base = (p: string) => {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    return i >= 0 ? p.slice(i + 1) : p
  }
  const fs: Partial<RuntimeFs> = {
    readdir: vi.fn(async (p: string) => {
      if (p !== dir) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      }
      return live.map((e) => ({
        name: e.name,
        isFile: () => e.kind === 'file',
        isDirectory: () => e.kind === 'dir',
        isSymbolicLink: () => false,
      })) as never
    }),
    readFile: vi.fn(async (p: string) => {
      const e = live.find((x) => x.name === base(p))
      if (!e || e.kind !== 'file') {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      }
      return e.content ?? ''
    }),
    rm: vi.fn(async (p: string) => {
      removed.push(base(p))
      live = live.filter((x) => x.name !== base(p))
    }),
  }
  return { fs: fs as RuntimeFs, removed, getLive: () => live }
}

/** fs backing `readdir`/`readFile`/`rm` over MULTIPLE dirs (keyed by the
 *  trailing-separator-normalized dir path), for the enumerate-all list path. */
function makeMultiDirFs(
  dirs: Record<
    string,
    Array<{ name: string; kind: 'file' | 'dir'; content?: string }>
  >,
) {
  const norm = (p: string) => p.replace(/[\\/]+$/, '')
  const cut = (p: string) => {
    const s = norm(p)
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
    return { parent: i >= 0 ? s.slice(0, i) : s, base: i >= 0 ? s.slice(i + 1) : s }
  }
  const removed: string[] = []
  const fs: Partial<RuntimeFs> = {
    readdir: vi.fn(async (p: string) => {
      const entries = dirs[norm(p)]
      if (!entries) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      }
      return entries.map((e) => ({
        name: e.name,
        isFile: () => e.kind === 'file',
        isDirectory: () => e.kind === 'dir',
        isSymbolicLink: () => false,
      })) as never
    }),
    readFile: vi.fn(async (p: string) => {
      const { parent, base } = cut(p)
      const e = (dirs[parent] ?? []).find((x) => x.name === base)
      if (!e || e.kind !== 'file') {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      }
      return e.content ?? ''
    }),
    rm: vi.fn(async (p: string) => {
      removed.push(p)
    }),
  }
  return { fs: fs as RuntimeFs, removed }
}

describe('memoryHandlers.list', () => {
  it('lists one project: top-level .md files (excludes the lock + subdirs), name-sorted, with frontmatter type', async () => {
    const dir = '/mem'
    const { fs } = makeDirFs(dir, [
      {
        name: 'user_role.md',
        kind: 'file',
        content: '---\nname: User Role\ntype: user\n---\n\nbody',
      },
      { name: 'MEMORY.md', kind: 'file', content: '# Memory Index\n- a' },
      { name: '.consolidate-lock', kind: 'file', content: '{}' },
      { name: 'logs', kind: 'dir' },
    ])
    const result = await memoryHandlers.list({
      homeDir: HOME,
      fs,
      listMemoryDirs: async () => [{ label: 'myproj', dir }],
    })
    expect(result.projects).toHaveLength(1)
    const group = result.projects[0]!
    expect(group.dir).toBe(dir)
    expect(group.label).toBe('myproj')
    // Only .md files, name-sorted; MEMORY.md has no type, user_role.md is 'user'.
    expect(group.files.map((f) => ({ name: f.name, type: f.type }))).toEqual([
      { name: 'MEMORY.md', type: undefined },
      { name: 'user_role.md', type: 'user' },
    ])
    // Sizes reflect the UTF-8 byte length of the content.
    expect(group.files.every((f) => f.bytes > 0)).toBe(true)
  })

  it('exposes the frontmatter type for the nested `metadata:`/`type:` shape too', async () => {
    const { fs } = makeDirFs('/mem', [
      {
        name: 'pref.md',
        kind: 'file',
        content: '---\nname: Pref\nmetadata:\n  type: feedback\n---\n\nx',
      },
    ])
    const result = await memoryHandlers.list({
      homeDir: HOME,
      fs,
      listMemoryDirs: async () => [{ label: 'p', dir: '/mem' }],
    })
    expect(result.projects[0]?.files[0]?.type).toBe('feedback')
  })

  it('enumerates MULTIPLE project dirs, label-sorted, dropping ones that do not exist', async () => {
    const { fs } = makeMultiDirFs({
      '/p/zeta/memory': [{ name: 'MEMORY.md', kind: 'file', content: '# idx' }],
      '/p/alpha/memory': [
        { name: 'note.md', kind: 'file', content: '---\ntype: project\n---\nx' },
      ],
      // '/p/ghost/memory' intentionally absent → readdir throws → dropped.
    })
    const result = await memoryHandlers.list({
      homeDir: HOME,
      fs,
      listMemoryDirs: async () => [
        { label: 'zeta', dir: '/p/zeta/memory' },
        { label: 'alpha', dir: '/p/alpha/memory' },
        { label: 'ghost', dir: '/p/ghost/memory' },
      ],
    })
    // label-sorted (alpha before zeta); the non-existent 'ghost' is dropped.
    expect(result.projects.map((g) => g.label)).toEqual(['alpha', 'zeta'])
    expect(
      result.projects.find((g) => g.label === 'alpha')?.files[0]?.name,
    ).toBe('note.md')
  })

  it('returns projects:[] when there are no memory dirs', async () => {
    const { fs } = makeDirFs('/mem', [])
    const result = await memoryHandlers.list({
      homeDir: HOME,
      fs,
      listMemoryDirs: async () => [],
    })
    expect(result).toEqual({ projects: [] })
  })

  it('drops a listed dir that does not exist yet (readdir throws)', async () => {
    const { fs } = makeDirFs('/other', []) // readdir('/mem') throws ENOENT
    const result = await memoryHandlers.list({
      homeDir: HOME,
      fs,
      listMemoryDirs: async () => [{ label: 'p', dir: '/mem' }],
    })
    expect(result).toEqual({ projects: [] })
  })
})

describe('memoryHandlers.clear', () => {
  it('removes every entry in the target dir (files + subdirs) and reports the count', async () => {
    const dir = '/mem'
    const { fs, removed, getLive } = makeDirFs(dir, [
      { name: 'MEMORY.md', kind: 'file' },
      { name: 'user_role.md', kind: 'file' },
      { name: '.consolidate-lock', kind: 'file' },
      { name: 'logs', kind: 'dir' },
    ])
    const result = await memoryHandlers.clear(
      { dir },
      { homeDir: HOME, fs, listMemoryDirs: async () => [{ label: 'p', dir }] },
    )
    expect(result).toEqual({ ok: true, cleared: 4, dir })
    expect(removed.sort()).toEqual(
      ['.consolidate-lock', 'MEMORY.md', 'logs', 'user_role.md'].sort(),
    )
    // Subdirs are removed recursively.
    expect(fs.rm).toHaveBeenCalledWith(expect.stringContaining('logs'), {
      recursive: true,
      force: true,
    })
    expect(getLive()).toEqual([])
  })

  it('REFUSES a dir that is not among the enumerated memory dirs (no deletion)', async () => {
    const dir = '/mem'
    const { fs, removed } = makeDirFs(dir, [
      { name: 'MEMORY.md', kind: 'file' },
    ])
    const result = await memoryHandlers.clear(
      { dir: '/evil/path' },
      { homeDir: HOME, fs, listMemoryDirs: async () => [{ label: 'p', dir }] },
    )
    // Refused → nothing removed, dir echoed as null.
    expect(result).toEqual({ ok: true, cleared: 0, dir: null })
    expect(removed).toEqual([])
  })

  it('no-ops (cleared:0, dir:null) when no dir is given', async () => {
    const { fs } = makeDirFs('/mem', [])
    const result = await memoryHandlers.clear(
      { dir: '' },
      { homeDir: HOME, fs, listMemoryDirs: async () => [] },
    )
    expect(result).toEqual({ ok: true, cleared: 0, dir: null })
  })
})

describe('memoryHandlers.instructions', () => {
  it('returns the injected instruction files (read-only) for the session the client names', async () => {
    const { fs } = makeMemoryFs()
    const files = [
      { path: '/home/u/.velloc/AGENTS.md', tier: 'User' as const, bytes: 40 },
      { path: '/repo/AGENTS.md', tier: 'Project' as const, bytes: 80 },
    ]
    const asked: Array<string | undefined> = []
    const ctx = {
      homeDir: HOME,
      fs,
      listInstructionFiles: async (sessionId: string | undefined) => {
        asked.push(sessionId)
        return files
      },
    }
    const result = await memoryHandlers.instructions({ sessionId: 's-1' }, ctx)
    expect(result.files).toEqual(files)
    // No session named: the lister is told so — there is no "current session".
    await memoryHandlers.instructions({}, ctx)
    expect(asked).toEqual(['s-1', undefined])
  })

  it('returns [] when no lister is wired', async () => {
    const { fs } = makeMemoryFs()
    const result = await memoryHandlers.instructions({}, { homeDir: HOME, fs })
    expect(result.files).toEqual([])
  })
})

/**
 * The USER-tier instruction file (`~/.velloc/AGENTS.md`) is now the ONLY store
 * for standing free-text instructions — it replaced the `profile.instructions`
 * settings key. Two stores with the same semantics is what let a project-scoped
 * convention get persisted user-global, so these handlers are what the Settings
 * page writes through, and the conflict check is what keeps a stale textarea
 * from discarding someone else's edit.
 */
describe('memoryHandlers.userInstructions', () => {
  const PATH = `${HOME}/.velloc/AGENTS.md`

  it('reads the user instruction file', async () => {
    const { fs } = makeMemoryFs({ [PATH]: 'Prefer TypeScript.' })
    const result = await memoryHandlers.userInstructions({ homeDir: HOME, fs })
    expect(result).toEqual({
      path: PATH,
      content: 'Prefer TypeScript.',
      exists: true,
      readable: true,
    })
  })

  it('reports a missing file as empty, not an error', async () => {
    const { fs } = makeMemoryFs()
    const result = await memoryHandlers.userInstructions({ homeDir: HOME, fs })
    expect(result).toEqual({
      path: PATH,
      content: '',
      exists: false,
      readable: true,
    })
  })

  // A NON-ENOENT read failure is NOT an empty file: the content may exist on
  // disk unseen, so it must be reported as unreadable rather than collapsed
  // into `''` — otherwise the conflict guard compares `'' === ''` and the
  // next write clobbers instructions nobody could read.
  it('reports an unreadable file as existing but not readable', async () => {
    const { fs } = makeMemoryFs()
    fs.readFile = async () => {
      const err = new Error('EACCES: permission denied') as Error & {
        code?: string
      }
      err.code = 'EACCES'
      throw err
    }
    const result = await memoryHandlers.userInstructions({ homeDir: HOME, fs })
    expect(result).toEqual({
      path: PATH,
      content: '',
      exists: true,
      readable: false,
    })
  })

  it('refuses to overwrite a file it could not read', async () => {
    const { fs } = makeMemoryFs()
    fs.readFile = async () => {
      const err = new Error('EACCES: permission denied') as Error & {
        code?: string
      }
      err.code = 'EACCES'
      throw err
    }
    let wrote = false
    fs.writeFile = async () => {
      wrote = true
    }
    const result = await memoryHandlers.writeUserInstructions(
      { content: 'Be terse.', expected: '' },
      { homeDir: HOME, fs },
    )
    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(true)
    expect(wrote).toBe(false)
  })

  // The PRODUCTION fs (`createBrowserFsOperations`) flattens an `ok:false`
  // envelope into `Error('FS_ERROR: EACCES: …')` — no Node-style `.code` for a
  // host that doesn't discriminate, and never one for transport failures. A
  // classifier that only looked at `.code` read every one of these as "missing
  // file" and let the guard below pass `'' === ''`.
  it.each([
    ['host EACCES', new Error('FS_ERROR: EACCES: permission denied')],
    ['host EBUSY', new Error('FS_ERROR: EBUSY: file is in use or locked')],
    ['undiscriminated host failure', new Error('FS_ERROR: Failed to read file')],
    ['dead transport', new Error('transport_disposed: DirectPortBridgeTransport has been disposed')],
    ['bridge timeout', new Error("bridge_timeout: Bridge request 'fs/readFile' timed out after 30000ms")],
    ['path echo embedding ENOENT', new Error('FS_ERROR: EACCES: permission denied, open "/x/ENOENT/AGENTS.md"')],
    ['non-Error throwable', 'boom'],
  ])('treats a code-less %s as unreadable, not empty', async (_label, thrown) => {
    const { fs } = makeMemoryFs()
    fs.readFile = async () => {
      throw thrown
    }
    const result = await memoryHandlers.userInstructions({ homeDir: HOME, fs })
    expect(result).toEqual({ path: PATH, content: '', exists: true, readable: false })
  })

  it('still reads a code-less `FS_ERROR: ENOENT` (the real absent-path wire shape) as missing', async () => {
    const { fs } = makeMemoryFs()
    fs.readFile = async () => {
      throw new Error('FS_ERROR: ENOENT: no such file or directory')
    }
    const result = await memoryHandlers.userInstructions({ homeDir: HOME, fs })
    expect(result).toEqual({ path: PATH, content: '', exists: false, readable: true })
  })

  it('refuses to overwrite when the read failed with a code-less production error', async () => {
    const { fs } = makeMemoryFs()
    fs.readFile = async () => {
      throw new Error('FS_ERROR: EACCES: permission denied')
    }
    let wrote = false
    fs.writeFile = async () => {
      wrote = true
    }
    const result = await memoryHandlers.writeUserInstructions(
      { content: '', expected: '' },
      { homeDir: HOME, fs },
    )
    expect(result).toEqual({ ok: false, path: PATH, content: '', conflict: true })
    expect(wrote).toBe(false)
  })
})

describe('memoryHandlers.writeUserInstructions', () => {
  const PATH = `${HOME}/.velloc/AGENTS.md`

  it('creates the file when it does not exist yet', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await memoryHandlers.writeUserInstructions(
      { content: 'Be terse.', expected: '' },
      { homeDir: HOME, fs },
    )
    expect(result).toEqual({ ok: true, path: PATH, content: 'Be terse.' })
    expect(files.get(PATH)).toBe('Be terse.')
  })

  // Where the user keeps only ~/.claude/CLAUDE.md, THAT is the loaded user
  // file: an AGENTS.md created beside it would win its slot and hide it.
  it('edits ~/.claude/CLAUDE.md where only it exists, creating no AGENTS.md', async () => {
    const FALLBACK_FILE = `${HOME}/.claude/CLAUDE.md`
    const { fs, files } = makeMemoryFs({ [FALLBACK_FILE]: 'old' })
    const result = await memoryHandlers.writeUserInstructions(
      { content: 'Be terse.', expected: 'old' },
      { homeDir: HOME, fs },
    )
    expect(result).toEqual({ ok: true, path: FALLBACK_FILE, content: 'Be terse.' })
    expect(files.get(FALLBACK_FILE)).toBe('Be terse.')
    expect(files.has(PATH)).toBe(false)
  })

  it('writes VERBATIM — leading whitespace and line breaks survive', async () => {
    const { fs, files } = makeMemoryFs({ [PATH]: 'old' })
    await memoryHandlers.writeUserInstructions(
      { content: '  Keep   spacing.\nLine two.\n', expected: 'old' },
      { homeDir: HOME, fs },
    )
    expect(files.get(PATH)).toBe('  Keep   spacing.\nLine two.\n')
  })

  it('empties the file on a blank write instead of deleting it', async () => {
    const { fs, files } = makeMemoryFs({ [PATH]: 'old' })
    const result = await memoryHandlers.writeUserInstructions(
      { content: '', expected: 'old' },
      { homeDir: HOME, fs },
    )
    expect(result.ok).toBe(true)
    // Present but empty — the instruction loader skips empty files, and the
    // user's file is never removed out from under them.
    expect(files.has(PATH)).toBe(true)
    expect(files.get(PATH)).toBe('')
  })

  /** The guard: disk moved on since the caller loaded its baseline. */
  it('refuses the write and returns the on-disk text when `expected` is stale', async () => {
    const { fs, files } = makeMemoryFs({ [PATH]: 'written by someone else' })
    const result = await memoryHandlers.writeUserInstructions(
      { content: 'my edit', expected: 'what I loaded' },
      { homeDir: HOME, fs },
    )
    expect(result).toEqual({
      ok: false,
      path: PATH,
      content: 'written by someone else',
      conflict: true,
    })
    // Crucially, nothing was overwritten.
    expect(files.get(PATH)).toBe('written by someone else')
  })

  it('treats a missing file as the empty baseline (no false conflict)', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await memoryHandlers.writeUserInstructions(
      { content: 'first', expected: '' },
      { homeDir: HOME, fs },
    )
    expect(result.ok).toBe(true)
    expect(files.get(PATH)).toBe('first')
  })

  it('forces the write when `expected` is omitted', async () => {
    const { fs, files } = makeMemoryFs({ [PATH]: 'whatever' })
    const result = await memoryHandlers.writeUserInstructions(
      { content: 'forced' },
      { homeDir: HOME, fs },
    )
    expect(result.ok).toBe(true)
    expect(files.get(PATH)).toBe('forced')
  })

  // A non-string `content` reaches the bridge's `toUint8Array` as "nothing I
  // can read" → a 0-byte write that silently truncates the file.
  it.each([undefined, null, 42, { text: 'x' }, ['a']])(
    'rejects a non-string content (%j) as invalid_payload without writing',
    async (content) => {
      const { fs, files } = makeMemoryFs({ [PATH]: 'keep me' })
      const response = await handleMemoryBridgeRequest(
        {
          id: 'req-w',
          route: {
            namespace: 'nexus',
            capability: 'memory',
            action: 'writeUserInstructions',
          } as unknown as BrowserBridgeRoute,
          payload: { content, expected: 'keep me' } as never,
        },
        { homeDir: HOME, fs },
      )
      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.error.code).toBe('invalid_payload')
        expect(response.error.message).toMatch(/content must be a string/)
      }
      expect(fs.writeFile).not.toHaveBeenCalled()
      expect(files.get(PATH)).toBe('keep me')
    },
  )
})
