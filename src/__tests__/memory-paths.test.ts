import { describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  getMemoryDir,
  isMemoryEnabled,
  resolveMemoryDir,
  checkNotesDir,
} from '../memory/memoryPaths'
import type { RuntimeFs, RuntimeFsStat } from '../utils/fs/runtimeFs'
import { UNTRUSTED_CHILD_MEMORY_SETTINGS } from '../memory/resolveMemorySettings'

function makeRuntimeConfig(env: Record<string, string> = {}): RuntimeConfig {
  return {
    getEnv: (name: string) => env[name],
    flagOn: (name: string) => {
      const v = env[name]
      return v === '1' || v === 'true' || v === 'yes'
    },
    now: () => 1_700_000_000_000,
    createUUID: () => 'test-uuid',
    createTimestamp: () => '2026-05-13T00:00:00.000Z',
    getMaxStructuredOutputRetries: () => 5,
  }
}

describe('checkNotesDir', () => {
  it.each([
    ['undefined input', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['relative path', '../foo'],
    ['relative dot', './foo'],
    ['bare filename', 'foo'],
    ['root', '/'],
    ['near-root (length < 3)', '/a'],
    ['Windows drive only', 'C:'],
    ['Windows drive root', 'C:\\'],
    ['Windows drive root forward slash', 'C:/'],
    ['UNC backslash', '\\\\server\\share'],
    ['UNC forward slash', '//server/share'],
    ['null byte', '/etc/pa\0sswd'],
  ])('rejects %s', (_label, value) => {
    expect(checkNotesDir(value, false)).toBeUndefined()
  })

  it.each([
    ['POSIX absolute', '/var/lib/memory', '/var/lib/memory/'],
    ['POSIX with trailing slash', '/var/lib/memory/', '/var/lib/memory/'],
    [
      'Windows drive path',
      'C:\\Users\\me\\.velloc\\memory',
      'C:\\Users\\me\\.velloc\\memory\\',
    ],
    [
      'Windows drive path with forward slashes',
      'C:/Users/me/.velloc/memory',
      'C:/Users/me/.velloc/memory/',
    ],
    [
      'Windows drive path with trailing backslash',
      'C:\\Users\\me\\.velloc\\memory\\',
      'C:\\Users\\me\\.velloc\\memory\\',
    ],
  ])('accepts %s', (_label, input, expected) => {
    expect(checkNotesDir(input, false)).toBe(expected)
  })

  it('trims surrounding whitespace before validating', () => {
    expect(checkNotesDir('  /var/lib/memory  ', false)).toBe(
      '/var/lib/memory/',
    )
  })
})

describe('isMemoryEnabled', () => {
  it('enabled by default', () => {
    expect(isMemoryEnabled(makeRuntimeConfig())).toBe(true)
  })

  it('is OFF under the untrusted-child snapshot, whatever the user set', () => {
    // The snapshot `createAgentRuntime` substitutes for a child with a read
    // boundary. It must beat the on-by-default AND a user who turned memory
    // on explicitly — the prompt-time MEMORY.md read goes to the relay.
    expect(isMemoryEnabled(makeRuntimeConfig(), UNTRUSTED_CHILD_MEMORY_SETTINGS)).toBe(false)
    expect(
      isMemoryEnabled(makeRuntimeConfig(), {
        ...{ autoMemoryEnabled: true },
        ...UNTRUSTED_CHILD_MEMORY_SETTINGS,
      }),
    ).toBe(false)
    // Every memory feature is explicitly off, none left to "default on".
    expect(UNTRUSTED_CHILD_MEMORY_SETTINGS).toEqual({
      autoMemoryEnabled: false,
      memoryMaintenance: 'off',
      autoExtractEnabled: false,
      memoryRecallEnabled: false,
    })
  })

  it.each(['off', 'OFF', '0', 'false', 'no'])('disabled when VELLOC_MEMORY=%s', (value) => {
    expect(isMemoryEnabled(makeRuntimeConfig({ VELLOC_MEMORY: value }))).toBe(false)
  })

  it.each(['on', '1', 'true', 'yes'])('VELLOC_MEMORY=%s force-enables over settings', (value) => {
    const config = makeRuntimeConfig({ VELLOC_MEMORY: value })
    expect(isMemoryEnabled(config)).toBe(true)
    expect(isMemoryEnabled(config, { autoMemoryEnabled: false })).toBe(true)
  })

  it('an unrecognised VELLOC_MEMORY value leaves the settings toggle in charge', () => {
    const config = makeRuntimeConfig({ VELLOC_MEMORY: 'maybe' })
    expect(isMemoryEnabled(config, { autoMemoryEnabled: false })).toBe(false)
    expect(isMemoryEnabled(config, { autoMemoryEnabled: true })).toBe(true)
  })

  it('honors settings.autoMemoryEnabled when no env gate applies', () => {
    expect(
      isMemoryEnabled(makeRuntimeConfig(), { autoMemoryEnabled: false }),
    ).toBe(false)
    expect(
      isMemoryEnabled(makeRuntimeConfig(), { autoMemoryEnabled: true }),
    ).toBe(true)
  })

  it('env kill switch beats settings.autoMemoryEnabled=true', () => {
    const config = makeRuntimeConfig({ VELLOC_MEMORY: 'off' })
    expect(isMemoryEnabled(config, { autoMemoryEnabled: true })).toBe(false)
  })

  it('defaults to enabled when settings are unset', () => {
    expect(isMemoryEnabled(makeRuntimeConfig(), {})).toBe(true)
  })
})

describe('getMemoryDir', () => {
  it('defaults to <cwd>/.velloc/memory/ when no env vars are set', () => {
    expect(getMemoryDir('/home/user/project', makeRuntimeConfig())).toBe(
      '/home/user/project/.velloc/memory/',
    )
  })

  it('uses VELLOC_MEMORY_PIN_DIR when valid', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_PIN_DIR: '/var/lib/memory',
    })
    expect(getMemoryDir('/home/user/project', config)).toBe('/var/lib/memory/')
  })

  it('falls through when VELLOC_MEMORY_PIN_DIR is invalid', () => {
    // An invalid override no longer wins. Previously
    // nexus would resolve "/" → "/" as the memory dir (filesystem root).
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_PIN_DIR: '/',
    })
    expect(getMemoryDir('/home/user/project', config)).toBe(
      '/home/user/project/.velloc/memory/',
    )
  })

  it('falls through when VELLOC_MEMORY_PIN_DIR is a UNC path', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_PIN_DIR: '\\\\evil\\share',
    })
    expect(getMemoryDir('/home/user/project', config)).toBe(
      '/home/user/project/.velloc/memory/',
    )
  })

  it('uses VELLOC_MEMORY_ROOT when valid (path is sanitized-cwd-keyed)', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_ROOT: '/var/lib/cc',
    })
    expect(getMemoryDir('/home/user/project foo', config)).toBe(
      '/var/lib/cc/projects/home-user-project-foo/memory/',
    )
  })

  it('falls through when VELLOC_MEMORY_ROOT is invalid', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_ROOT: 'relative/path',
    })
    expect(getMemoryDir('/home/user/project', config)).toBe(
      '/home/user/project/.velloc/memory/',
    )
  })

  it('VELLOC_MEMORY_PIN_DIR wins over VELLOC_MEMORY_ROOT', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_PIN_DIR: '/explicit/path',
      VELLOC_MEMORY_ROOT: '/var/lib/cc',
    })
    expect(getMemoryDir('/home/user/project', config)).toBe('/explicit/path/')
  })

  it('uses memorySettings.autoMemoryDirectory as the candidate #2 override', () => {
    expect(
      getMemoryDir('/home/user/project', makeRuntimeConfig(), {
        memorySettings: { autoMemoryDirectory: '/var/lib/settings-mem' },
      }),
    ).toBe('/var/lib/settings-mem/')
  })

  it('expands ~/ in memorySettings.autoMemoryDirectory against homeDir', () => {
    expect(
      getMemoryDir('/home/user/project', makeRuntimeConfig(), {
        homeDir: '/home/user',
        memorySettings: { autoMemoryDirectory: '~/my-mem' },
      }),
    ).toBe('/home/user/my-mem/')
  })

  it('VELLOC_MEMORY_PIN_DIR still wins over memorySettings.autoMemoryDirectory', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_PIN_DIR: '/explicit/path',
    })
    expect(
      getMemoryDir('/home/user/project', config, {
        memorySettings: { autoMemoryDirectory: '/settings/path' },
      }),
    ).toBe('/explicit/path/')
  })

  it('falls through an invalid memorySettings.autoMemoryDirectory to the default', () => {
    expect(
      getMemoryDir('/home/user/project', makeRuntimeConfig(), {
        memorySettings: { autoMemoryDirectory: 'relative/not-absolute' },
      }),
    ).toBe('/home/user/project/.velloc/memory/')
  })

  it('Windows cwd gets forward-slash join when override is POSIX', () => {
    // The separator is detected from the cwd. A Windows-style cwd with
    // no override uses backslash for the join.
    expect(
      getMemoryDir('C:\\Users\\me\\project', makeRuntimeConfig()),
    ).toBe('C:\\Users\\me\\project\\.velloc\\memory\\')
  })

  it('memorySettings.autoMemoryDirectory wins over VELLOC_MEMORY_ROOT', () => {
    const config = makeRuntimeConfig({ VELLOC_MEMORY_ROOT: '/var/lib/cc' })
    expect(
      getMemoryDir('/home/user/project', config, {
        memorySettings: { autoMemoryDirectory: '/explicit/auto/dir' },
      }),
    ).toBe('/explicit/auto/dir/')
  })

  it('memorySettings.autoMemoryDirectory expands ~/ against HOME', () => {
    const config = makeRuntimeConfig({ HOME: '/home/user' })
    expect(
      getMemoryDir('/home/user/project', config, {
        memorySettings: { autoMemoryDirectory: '~/my-memory' },
      }),
    ).toBe('/home/user/my-memory/')
  })

  it('memorySettings.autoMemoryDirectory rejects ~/ alone (would resolve to $HOME)', () => {
    const config = makeRuntimeConfig({ HOME: '/home/user' })
    expect(
      getMemoryDir('/home/user/project', config, {
        memorySettings: { autoMemoryDirectory: '~/' },
      }),
    ).toBe('/home/user/project/.velloc/memory/')
  })

  it('memorySettings.autoMemoryDirectory with ~/ is rejected when HOME is unset', () => {
    expect(
      getMemoryDir('/home/user/project', makeRuntimeConfig(), {
        memorySettings: { autoMemoryDirectory: '~/my-memory' },
      }),
    ).toBe('/home/user/project/.velloc/memory/')
  })

  it('VELLOC_MEMORY_ROOT uses canonicalRoot for keying when set', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_ROOT: '/var/lib/cc',
    })
    expect(
      getMemoryDir('/home/user/wt-feature/sub', config, {
        canonicalRoot: '/home/user/main-repo',
      }),
    ).toBe('/var/lib/cc/projects/home-user-main-repo/memory/')
  })

  // ==========================================================================
  // projectRoot — the session's stable project root
  // ==========================================================================

  it('uses projectRoot as the default memory base when provided', () => {
    // Memory lives at `<projectRoot>/memory/`.
    const result = getMemoryDir('/home/user/project', makeRuntimeConfig(), {
      projectRoot: '/home/user/project/.velloc/sess-1/workspace/',
    })
    expect(result).toBe(
      '/home/user/project/.velloc/sess-1/workspace/memory/',
    )
  })

  it('falls back to cwd-based default when projectRoot is not provided', () => {
    // Back-compat: callers that don't pass projectRoot keep the legacy
    // `${cwd}/.velloc/memory/` layout.
    const result = getMemoryDir('/home/user/project', makeRuntimeConfig())
    expect(result).toBe('/home/user/project/.velloc/memory/')
  })

  it('VELLOC_MEMORY_ROOT slug derives from projectRoot when set', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_ROOT: '/var/lib/cc',
    })
    expect(
      getMemoryDir('/home/user/anywhere', config, {
        projectRoot: '/home/user/project/.velloc/sess-1/workspace/',
      }),
    ).toBe(
      '/var/lib/cc/projects/home-user-project-.velloc-sess-1-workspace/memory/',
    )
  })

  it('canonicalRoot wins over projectRoot for the REMOTE_MEMORY_DIR slug', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_ROOT: '/var/lib/cc',
    })
    expect(
      getMemoryDir('/home/user/anywhere', config, {
        canonicalRoot: '/home/user/main-repo',
        projectRoot: '/home/user/anywhere/.velloc/sess-1/workspace/',
      }),
    ).toBe('/var/lib/cc/projects/home-user-main-repo/memory/')
  })

  it('explicit override env vars beat projectRoot', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_PIN_DIR: '/explicit/dir',
    })
    expect(
      getMemoryDir('/home/user/project', config, {
        projectRoot: '/home/user/project/.velloc/sess-1/workspace/',
      }),
    ).toBe('/explicit/dir/')
  })

  // ==========================================================================
  // homeDir present — bound-project memory lives OUT of the
  // repo at `<configHome>/projects/<projectFolderKey(projectRoot)>/memory/`.
  // ==========================================================================

  it('bound project with homeDir → <configHome>/projects/<slug>/memory/ (POSIX)', () => {
    // This is the core behaviour: a bound project's memory must
    // NOT land inside the user's repo (`/work/myrepo/memory/`).
    expect(
      getMemoryDir('/home/user/anywhere', makeRuntimeConfig(), {
        projectRoot: '/work/myrepo/',
        homeDir: '/home/user',
      }),
    ).toBe('/home/user/.velloc/projects/-work-myrepo/memory/')
  })

  it('bound project with homeDir → <configHome>/projects/<slug>/memory/ (Windows)', () => {
    expect(
      getMemoryDir('C:\\Users\\me\\anywhere', makeRuntimeConfig(), {
        projectRoot: 'D:\\project\\Maxh\\',
        homeDir: 'C:\\Users\\me',
      }),
    ).toBe('C:\\Users\\me\\.velloc\\projects\\D--project-Maxh\\memory\\')
  })

  it('bare sandbox workspace projectRoot ALSO routes to projects/<slug>/memory/ (POSIX)', () => {
    // Uniform layout: the bare shared sandbox no longer keeps an in-place
    // `<shared-workspace>/memory/` — it gets a `projects/<slug>/` home like every
    // other bound session, so the Settings → Memory list enumerates one tree.
    expect(
      getMemoryDir('/home/user/anywhere', makeRuntimeConfig(), {
        projectRoot: '/home/user/.velloc/shared-workspace/',
        homeDir: '/home/user',
      }),
    ).toBe(
      '/home/user/.velloc/projects/-home-user--velloc-shared-workspace/memory/',
    )
  })

  it('bare sandbox workspace projectRoot ALSO routes to projects/<slug>/memory/ (Windows)', () => {
    expect(
      getMemoryDir('C:\\Users\\me\\anywhere', makeRuntimeConfig(), {
        projectRoot: 'C:\\Users\\me\\.velloc\\shared-workspace\\',
        homeDir: 'C:\\Users\\me',
      }),
    ).toBe(
      'C:\\Users\\me\\.velloc\\projects\\C--Users-me--velloc-shared-workspace\\memory\\',
    )
  })

  it('per-type <shared-workspace>/<type> root routes to projects/<slug>/memory/ (POSIX)', () => {
    // A `<type>` default root is NOT the bare shared-workspace, so it flows
    // through the normal bound-project branch (NOT the in-place sandbox case) →
    // `~/.velloc/projects/<projectFolderKey(shared-workspace/<type>)>/memory/`.
    expect(
      getMemoryDir('/home/user/anywhere', makeRuntimeConfig(), {
        projectRoot: '/home/user/.velloc/shared-workspace/agent/',
        homeDir: '/home/user',
      }),
    ).toBe(
      '/home/user/.velloc/projects/-home-user--velloc-shared-workspace-agent/memory/',
    )
  })

  it('per-type <shared-workspace>/<type> root routes to projects/<slug>/memory/ (Windows)', () => {
    // Locks the exact on-disk slug the user expects for the chat type.
    expect(
      getMemoryDir('C:\\Users\\alice\\anywhere', makeRuntimeConfig(), {
        projectRoot: 'C:\\Users\\alice\\.velloc\\shared-workspace\\chat\\',
        homeDir: 'C:\\Users\\alice',
      }),
    ).toBe(
      'C:\\Users\\alice\\.velloc\\projects\\C--Users-alice--velloc-shared-workspace-chat\\memory\\',
    )
  })

  it('PATH_OVERRIDE still wins over the homeDir config-home layout', () => {
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_PIN_DIR: '/explicit/dir',
    })
    expect(
      getMemoryDir('/home/user/anywhere', config, {
        projectRoot: '/work/myrepo/',
        homeDir: '/home/user',
      }),
    ).toBe('/explicit/dir/')
  })

  it('REMOTE_MEMORY_DIR base is still used even when homeDir is present', () => {
    // homeDir must not divert the remote-dir branch to the config home.
    const config = makeRuntimeConfig({
      VELLOC_MEMORY_ROOT: '/var/lib/cc',
    })
    expect(
      getMemoryDir('/home/user/anywhere', config, {
        projectRoot: '/work/repo/',
        homeDir: '/home/user',
      }),
    ).toBe('/var/lib/cc/projects/work-repo/memory/')
  })

  it('no homeDir falls back to the legacy project-local layout', () => {
    // Back-compat: without a host-resolved home, the old `<projectRoot>/memory/`
    // behaviour stays so bootstrap never writes to a bogus root.
    expect(
      getMemoryDir('/home/user/anywhere', makeRuntimeConfig(), {
        projectRoot: '/work/myrepo/',
      }),
    ).toBe('/work/myrepo/memory/')
  })
})

// ============================================================================
// resolveMemoryDir — async path with git-root resolution
// ============================================================================

function fakeStat(kind: 'file' | 'dir'): RuntimeFsStat {
  return {
    size: 0,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isCharacterDevice: () => false,
    isBlockDevice: () => false,
  }
}

function makeFs(tree: Record<string, 'file' | 'dir' | { content: string }>):
  Pick<RuntimeFs, 'stat' | 'readFile'> {
  return {
    async stat(path: string): Promise<RuntimeFsStat> {
      const entry = tree[path]
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (typeof entry === 'string') return fakeStat(entry)
      return fakeStat('file')
    },
    async readFile(path: string): Promise<string> {
      const entry = tree[path]
      if (entry && typeof entry === 'object' && 'content' in entry) {
        return entry.content
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  }
}

describe('resolveMemoryDir', () => {
  it('no-ops to getMemoryDir when VELLOC_MEMORY_ROOT is unset', async () => {
    const config = makeRuntimeConfig()
    const fs = makeFs({})
    const result = await resolveMemoryDir(
      '/home/user/project',
      config,
      fs as unknown as RuntimeFs,
    )
    expect(result).toBe('/home/user/project/.velloc/memory/')
  })

  it('routes a bound project to <configHome>/projects/<slug>/memory/ when homeDir is set and REMOTE is unset', async () => {
    const config = makeRuntimeConfig()
    const fs = makeFs({})
    const result = await resolveMemoryDir(
      '/home/user/anywhere',
      config,
      fs as unknown as RuntimeFs,
      { projectRoot: '/work/myrepo/', homeDir: '/home/user' },
    )
    expect(result).toBe('/home/user/.velloc/projects/-work-myrepo/memory/')
  })

  it('uses cwd-keyed slug when cwd is not in a git repo', async () => {
    const config = makeRuntimeConfig({
      HOME: '/home/user',
      VELLOC_MEMORY_ROOT: '/var/lib/cc',
    })
    const fs = makeFs({})
    const result = await resolveMemoryDir(
      '/home/user/project',
      config,
      fs as unknown as RuntimeFs,
    )
    expect(result).toBe('/var/lib/cc/projects/home-user-project/memory/')
  })

  it('keys by canonical git root for worktree dedup', async () => {
    const config = makeRuntimeConfig({
      HOME: '/home/user',
      VELLOC_MEMORY_ROOT: '/var/lib/cc',
    })
    const fs = makeFs({
      '/home/user/main-repo/.git': 'dir',
    })
    // From the main repo:
    expect(
      await resolveMemoryDir(
        '/home/user/main-repo/src',
        config,
        fs as unknown as RuntimeFs,
      ),
    ).toBe('/var/lib/cc/projects/home-user-main-repo/memory/')

    // From a worktree pointing back to the same repo:
    const fsWorktree = makeFs({
      '/home/user/wt-feature/.git': {
        content: 'gitdir: /home/user/main-repo/.git/worktrees/feature\n',
      },
    })
    expect(
      await resolveMemoryDir(
        '/home/user/wt-feature/src',
        config,
        fsWorktree as unknown as RuntimeFs,
      ),
    ).toBe('/var/lib/cc/projects/home-user-main-repo/memory/')
  })
})
