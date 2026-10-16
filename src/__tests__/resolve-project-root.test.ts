import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PROJECT_ROOT_NAME,
  launchDir,
  sessionProjectRoute,
  projectRootIsSandbox,
  resolveProjectRoot,
} from '../utils/resolveProjectRoot'
import {
  unconfiguredFs,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'
import {
  getNexusWorkspaceDir,
  getNexusWorkspaceDirForType,
} from '../utils/conversationStoragePaths'

function makeFs(opts: { mkdir?: (path: string) => Promise<void> } = {}): RuntimeFs {
  return {
    ...unconfiguredFs,
    async mkdir(path: string): Promise<void> {
      if (opts.mkdir) await opts.mkdir(path)
    },
  } as RuntimeFs
}

describe('resolveProjectRoot', () => {
  it('defaults to the shared ~/.velloc/shared-workspace/ when no override is given', async () => {
    const result = await resolveProjectRoot({
      homeDir: '/home/user',
      fs: makeFs(),
    })
    expect(result).toBe(
      `/home/user/.velloc/${DEFAULT_PROJECT_ROOT_NAME}/`,
    )
  })

  it('uses the override when it passes validation', async () => {
    const result = await resolveProjectRoot({
      homeDir: '/home/user',
      projectRoot: '/explicit/workspace',
      fs: makeFs(),
    })
    expect(result).toBe('/explicit/workspace/')
  })

  it('falls through to the shared default when the override is invalid', async () => {
    const result = await resolveProjectRoot({
      homeDir: '/home/user',
      projectRoot: '/', // root rejected by checkNotesDir
      fs: makeFs(),
    })
    expect(result).toBe(
      `/home/user/.velloc/${DEFAULT_PROJECT_ROOT_NAME}/`,
    )
  })

  it('falls through to the shared default when the override is a relative path', async () => {
    const result = await resolveProjectRoot({
      homeDir: '/home/user',
      projectRoot: './workspace',
      fs: makeFs(),
    })
    expect(result).toBe(
      `/home/user/.velloc/${DEFAULT_PROJECT_ROOT_NAME}/`,
    )
  })

  it('calls fs.mkdir on the resolved path', async () => {
    const mkdir = vi.fn(async () => {})
    await resolveProjectRoot({
      homeDir: '/home/user',
      fs: makeFs({ mkdir }),
    })
    expect(mkdir).toHaveBeenCalledTimes(1)
    // mkdir gets the path without trailing separator.
    expect(mkdir).toHaveBeenCalledWith(
      `/home/user/.velloc/${DEFAULT_PROJECT_ROOT_NAME}`,
    )
  })

  it('two calls with different (or absent) sessionIds resolve to the same shared default', async () => {
    // Demonstrates the "shared by default" semantics: any two sessions
    // that don't pass an explicit projectRoot land in the same dir, so
    // memory accumulates across conversations instead of being siloed.
    const a = await resolveProjectRoot({
      homeDir: '/home/user',
      fs: makeFs(),
    })
    const b = await resolveProjectRoot({
      homeDir: '/home/user',
      fs: makeFs(),
    })
    expect(a).toBe(b)
  })

  it('two calls with explicit overrides keep their isolation', async () => {
    const a = await resolveProjectRoot({
      homeDir: '/home/user',
      projectRoot: '/explicit/alpha',
      fs: makeFs(),
    })
    const b = await resolveProjectRoot({
      homeDir: '/home/user',
      projectRoot: '/explicit/beta',
      fs: makeFs(),
    })
    expect(a).toBe('/explicit/alpha/')
    expect(b).toBe('/explicit/beta/')
  })

  it('swallows mkdir errors silently — still returns the path', async () => {
    const result = await resolveProjectRoot({
      homeDir: '/home/user',
      fs: makeFs({
        mkdir: async () => {
          throw new Error('EACCES')
        },
      }),
    })
    expect(result).toBe(
      `/home/user/.velloc/${DEFAULT_PROJECT_ROOT_NAME}/`,
    )
  })

  it('handles a Windows-style home correctly', async () => {
    const result = await resolveProjectRoot({
      homeDir: 'C:\\Users\\me',
      fs: makeFs(),
    })
    expect(result).toBe(
      `C:\\Users\\me\\.velloc\\${DEFAULT_PROJECT_ROOT_NAME}\\`,
    )
  })

  it('DEFAULT_PROJECT_ROOT_NAME is the shared "shared-workspace" string', () => {
    // Locked-in for callers + docs that hardcode the path shape on disk.
    expect(DEFAULT_PROJECT_ROOT_NAME).toBe('shared-workspace')
  })
})

describe('resolveProjectRoot per-type-shared defaults', () => {
  const homeDir = '/home/user'

  it('non-code types default to ~/.velloc/shared-workspace/<type>/ (home-anchored)', async () => {
    // The live non-code types (agent/chat). NB: no phantom 'project' — the rule
    // is derived, not a hardcoded list.
    for (const type of ['agent', 'chat'] as const) {
      const result = await resolveProjectRoot({
        homeDir,
        templateType: type,
        fs: makeFs(),
      })
      expect(result).toBe(`${getNexusWorkspaceDirForType(homeDir, type)}/`)
      expect(result).toContain(`shared-workspace/${type}`)
    }
  })

  it('an unsafe templateType (path injection) falls back to the bare workspace', async () => {
    const result = await resolveProjectRoot({
      homeDir,
      templateType: '../../etc',
      fs: makeFs(),
    })
    expect(result).toBe(`${getNexusWorkspaceDir(homeDir)}/`)
    expect(result).not.toContain('etc')
  })

  it('code keeps the bare ~/.velloc/shared-workspace/ (it forces a real folder instead)', async () => {
    const result = await resolveProjectRoot({
      homeDir,
      templateType: 'code',
      fs: makeFs(),
    })
    expect(result).toBe(`${getNexusWorkspaceDir(homeDir)}/`)
    expect(result).not.toContain('-shared')
  })

  it('absent templateType keeps the bare workspace (back-compat)', async () => {
    const absent = await resolveProjectRoot({ homeDir, fs: makeFs() })
    expect(absent).toBe(`${getNexusWorkspaceDir(homeDir)}/`)
  })

  it('a safe-named unknown (non-code) type still gets its own <type> subdir (rule, not a list)', async () => {
    // No hardcoded type list → a future safe-named type gets a per-type sandbox
    // automatically. Only `code` / unsafe / absent fall back to bare.
    const unknown = await resolveProjectRoot({
      homeDir,
      templateType: 'research',
      fs: makeFs(),
    })
    expect(unknown).toBe(`${getNexusWorkspaceDir(homeDir)}/research/`)
  })

  it('an explicit projectRoot override beats the per-type default', async () => {
    const result = await resolveProjectRoot({
      homeDir,
      templateType: 'agent',
      projectRoot: '/explicit/folder',
      fs: makeFs(),
    })
    expect(result).toBe('/explicit/folder/')
  })

  it('with no home and no valid override it refuses, and never falls back to a cwd', async () => {
    const mkdir = vi.fn(async () => {})
    for (const templateType of ['chat', 'code', undefined]) {
      await expect(
        resolveProjectRoot({ projectRoot: './relative', templateType, fs: makeFs({ mkdir }) }),
      ).rejects.toThrow(/no user home/)
    }
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('with no home a valid override still resolves', async () => {
    const result = await resolveProjectRoot({ projectRoot: '/explicit/folder', templateType: 'chat', fs: makeFs() })
    expect(result).toBe('/explicit/folder/')
  })
})

describe('path-state accessors', () => {
  // `launchDir` and `projectRouteOf` have fixed answers here
  // because the operations that would make them diverge (git worktrees,
  // cross-project resume) don't exist in Nexus. These guards lock that in
  // so a future edit can't silently re-introduce a divergent value.
  it('launchDir ≡ projectRoot (no worktrees → it never diverges)', () => {
    expect(launchDir('/home/user/project')).toBe('/home/user/project')
    expect(launchDir('C:\\dev\\myrepo')).toBe('C:\\dev\\myrepo')
  })

  it('projectRouteOf is always null (flat sessionStoragePath, no per-session routing)', () => {
    expect(sessionProjectRoute()).toBeNull()
  })
})

describe('projectRootIsSandbox', () => {
  // The predicate must agree EXACTLY with `resolveProjectRoot`'s own
  // override gate — true ⇒ the session falls back to the shared sandbox
  // workspace (i.e. it is NOT bound to a real folder). Drives the code
  // session's `needsProjectFolder` / forced picker.
  it('is true when there is no usable override', () => {
    expect(projectRootIsSandbox(undefined)).toBe(true)
    expect(projectRootIsSandbox('')).toBe(true)
    expect(projectRootIsSandbox('   ')).toBe(true)
    expect(projectRootIsSandbox('/')).toBe(true) // root rejected
    expect(projectRootIsSandbox('./workspace')).toBe(true) // relative rejected
  })

  it('is false for a valid absolute override (POSIX + Windows)', () => {
    expect(projectRootIsSandbox('/explicit/workspace')).toBe(false)
    expect(projectRootIsSandbox('C:\\Users\\me\\project')).toBe(false)
  })

  it('agrees with resolveProjectRoot: sandbox ⇔ resolved path is the default', async () => {
    const sandboxInput = './nope'
    const boundInput = '/explicit/alpha'
    expect(projectRootIsSandbox(sandboxInput)).toBe(true)
    expect(projectRootIsSandbox(boundInput)).toBe(false)
    const sandboxResolved = await resolveProjectRoot({
      homeDir: '/home/user',
      projectRoot: sandboxInput,
      fs: makeFs(),
    })
    const boundResolved = await resolveProjectRoot({
      homeDir: '/home/user',
      projectRoot: boundInput,
      fs: makeFs(),
    })
    expect(sandboxResolved).toBe(
      `/home/user/.velloc/${DEFAULT_PROJECT_ROOT_NAME}/`,
    )
    expect(boundResolved).toBe('/explicit/alpha/')
  })
})
