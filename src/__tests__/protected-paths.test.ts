import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describePathGuardAsk,
  evaluateWriteTarget,
  type PathGuardContext,
} from '../permissions/protectedPaths'

const CWD = 'D:/work/proj'
const base = (over: Partial<PathGuardContext> = {}): PathGuardContext => ({
  cwd: CWD,
  projectRoot: CWD,
  ...over,
})

describe('evaluateWriteTarget — sensitive paths (write tools)', () => {
  it('Write/Edit/NotebookEdit into .git internals → sensitive-path', () => {
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      expect(
        evaluateWriteTarget(tool, { file_path: '.git/config' }, base()),
      ).toBe('sensitive-path')
    }
  })

  it('Write to our settings files (under .velloc) → sensitive-path', () => {
    expect(
      evaluateWriteTarget('Write', { file_path: '.velloc/settings.json' }, base()),
    ).toBe('sensitive-path')
    expect(
      evaluateWriteTarget(
        'Edit',
        { file_path: 'D:/work/proj/.velloc/settings.local.json' },
        base(),
      ),
    ).toBe('sensitive-path')
  })

  it('READING .git / settings is NOT sensitive (write-only check)', () => {
    expect(evaluateWriteTarget('Read', { file_path: '.git/config' }, base())).toBeNull()
    expect(
      evaluateWriteTarget('Read', { file_path: '.velloc/settings.json' }, base()),
    ).toBeNull()
  })

  it('a project settings.json NOT under .velloc is not sensitive', () => {
    expect(
      evaluateWriteTarget('Write', { file_path: 'config/settings.json' }, base()),
    ).toBeNull()
  })
})

describe('evaluateWriteTarget — workspace boundary', () => {
  it('a write inside the project is allowed', () => {
    expect(
      evaluateWriteTarget('Write', { file_path: 'src/a.ts' }, base()),
    ).toBeNull()
    expect(
      evaluateWriteTarget('Write', { file_path: 'D:/work/proj/src/b.ts' }, base()),
    ).toBeNull()
  })

  it('a WRITE outside the project → outside-workspace', () => {
    expect(
      evaluateWriteTarget('Write', { file_path: '../sibling/secret.txt' }, base()),
    ).toBe('outside-workspace')
    expect(
      evaluateWriteTarget('Edit', { file_path: 'D:/other/x.ts' }, base()),
    ).toBe('outside-workspace')
  })

  it('READS are NEVER boundary-gated (only writes are)', () => {
    expect(
      evaluateWriteTarget('Read', { file_path: '../sibling/secret.txt' }, base()),
    ).toBeNull()
    expect(
      evaluateWriteTarget('Read', { file_path: 'D:/totally/elsewhere/x' }, base()),
    ).toBeNull()
  })

  it('an additional working directory widens the boundary (for writes)', () => {
    const ctx = base({
      extraWorkspaceRoots: new Map([['D:/data', true]]),
    })
    expect(evaluateWriteTarget('Write', { file_path: 'D:/data/file.csv' }, ctx)).toBeNull()
    expect(evaluateWriteTarget('Write', { file_path: 'D:/elsewhere/x' }, ctx)).toBe(
      'outside-workspace',
    )
  })

  it('the boundary is SKIPPED for a sandbox session (shared-workspace projectRoot)', () => {
    // Default/agent/chat + unbound-code sessions resolve projectRoot to the
    // per-type sandbox; writing outside it (tmp dir, user path) is normal there.
    const sandbox = base({
      cwd: 'D:/home/.velloc/shared-workspace/agent',
      projectRoot: 'D:/home/.velloc/shared-workspace/agent',
    })
    expect(
      evaluateWriteTarget('Write', { file_path: 'D:/tmp/audit/x.txt' }, sandbox),
    ).toBeNull()
    // …but the sensitive-path check still fires even for a sandbox session.
    expect(
      evaluateWriteTarget('Write', { file_path: 'D:/tmp/repo/.git/config' }, sandbox),
    ).toBe('sensitive-path')
  })
})

describe('evaluateWriteTarget — pre-emption + scope', () => {
  it('an explicit allow rule pre-empts both checks', () => {
    expect(
      evaluateWriteTarget(
        'Write',
        { file_path: '.git/config' },
        base({ hasExplicitAllowRule: true }),
      ),
    ).toBeNull()
    expect(
      evaluateWriteTarget(
        'Write',
        { file_path: 'D:/other/x.ts' },
        base({ hasExplicitAllowRule: true }),
      ),
    ).toBeNull()
  })

  it('non-file tools and missing targets are ignored', () => {
    expect(evaluateWriteTarget('Bash', { command: 'rm -rf /' }, base())).toBeNull()
    expect(evaluateWriteTarget('Write', {}, base())).toBeNull()
  })
})

describe('evaluateWriteTarget — dangerous files/dirs', () => {
  it('write to a dangerous directory anywhere in the path → sensitive-path', () => {
    for (const dir of ['.git', '.vscode', '.idea', '.claude']) {
      expect(
        evaluateWriteTarget('Write', { file_path: `${dir}/config` }, base()),
      ).toBe('sensitive-path')
      expect(
        evaluateWriteTarget('Edit', { file_path: `src/${dir}/x.json` }, base()),
      ).toBe('sensitive-path')
    }
  })

  it('directory match is case-insensitive (.GIT / .VsCode cannot bypass)', () => {
    expect(
      evaluateWriteTarget('Write', { file_path: '.GIT/config' }, base()),
    ).toBe('sensitive-path')
    expect(
      evaluateWriteTarget('Write', { file_path: 'src/.VsCode/settings.json' }, base()),
    ).toBe('sensitive-path')
  })

  it('write to a dangerous config file (basename) → sensitive-path', () => {
    for (const file of ['.bashrc', '.zshrc', '.gitconfig', '.profile', '.mcp.json']) {
      expect(
        evaluateWriteTarget('Write', { file_path: file }, base()),
      ).toBe('sensitive-path')
    }
  })

  it('dangerous-file basename match is case-insensitive (.BASHRC cannot bypass)', () => {
    expect(
      evaluateWriteTarget('Write', { file_path: '.BASHRC' }, base()),
    ).toBe('sensitive-path')
  })

  it('the .velloc runtime dir is protected EXCEPT internal-state subdirs', () => {
    // Config / loose files under .velloc are sensitive (agent must not rewrite
    // its own config/agents/skills/hooks).
    expect(
      evaluateWriteTarget('Write', { file_path: '.velloc/settings.json' }, base()),
    ).toBe('sensitive-path')
    expect(
      evaluateWriteTarget('Write', { file_path: '.velloc/notes.md' }, base()),
    ).toBe('sensitive-path')
    expect(
      evaluateWriteTarget('Write', { file_path: '.velloc/agents/foo.md' }, base()),
    ).toBe('sensitive-path')
    expect(
      evaluateWriteTarget('Write', { file_path: '.velloc/skills/x.md' }, base()),
    ).toBe('sensitive-path')
  })

  it('.velloc internal-state subdirs are carved out (plans/memory/sessions/worktrees/projects)', () => {
    // The agent legitimately writes its own plan/memory/state
    // (mirrors .claude/worktrees + checkEditableInternalPath).
    for (const sub of ['plans', 'memory', 'sessions', 'worktrees', 'projects']) {
      expect(
        evaluateWriteTarget('Write', { file_path: `.velloc/${sub}/x.md` }, base()),
      ).toBeNull()
    }
  })

  it('.velloc carve-out is case-insensitive on the runtime-dir segment', () => {
    expect(
      evaluateWriteTarget('Write', { file_path: '.VELLOC/plans/x.md' }, base()),
    ).toBeNull()
  })

  it('.velloc config subdirs (agents/skills/commands/hooks) stay blocked', () => {
    // Only the internal-state subdirs are carved out; config dirs are protected.
    for (const sub of ['agents', 'skills', 'commands', 'hooks']) {
      expect(
        evaluateWriteTarget('Write', { file_path: `.velloc/${sub}/x.md` }, base()),
      ).toBe('sensitive-path')
    }
  })

  it('a non-dangerous dotfile is allowed', () => {
    expect(evaluateWriteTarget('Write', { file_path: '.eslintrc.json' }, base())).toBeNull()
  })
})

describe('evaluateWriteTarget — suspicious Windows path patterns', () => {
  it('8.3 short names → suspicious-path', () => {
    expect(evaluateWriteTarget('Write', { file_path: 'GIT~1/config' }, base())).toBe(
      'suspicious-path',
    )
    expect(evaluateWriteTarget('Write', { file_path: 'SETTIN~1.JSON' }, base())).toBe(
      'suspicious-path',
    )
  })

  it('long-path prefixes → suspicious-path', () => {
    expect(evaluateWriteTarget('Write', { file_path: '\\\\?\\C:\\x' }, base())).toBe(
      'suspicious-path',
    )
    expect(evaluateWriteTarget('Write', { file_path: '//?/C:/x' }, base())).toBe(
      'suspicious-path',
    )
  })

  it('trailing dots/spaces → suspicious-path', () => {
    expect(evaluateWriteTarget('Write', { file_path: 'src/a.ts.' }, base())).toBe(
      'suspicious-path',
    )
    expect(evaluateWriteTarget('Write', { file_path: 'src/a.ts ' }, base())).toBe(
      'suspicious-path',
    )
  })

  it('DOS device names → suspicious-path', () => {
    expect(evaluateWriteTarget('Write', { file_path: 'src/file.CON' }, base())).toBe(
      'suspicious-path',
    )
    expect(evaluateWriteTarget('Write', { file_path: 'src/file.NUL' }, base())).toBe(
      'suspicious-path',
    )
  })

  it('three-or-more dots as a path component → suspicious-path', () => {
    expect(evaluateWriteTarget('Write', { file_path: '.../file.txt' }, base())).toBe(
      'suspicious-path',
    )
    expect(evaluateWriteTarget('Write', { file_path: 'a/.../b' }, base())).toBe(
      'suspicious-path',
    )
  })

  it('a normal path with a single dot segment is NOT suspicious', () => {
    expect(evaluateWriteTarget('Write', { file_path: 'src/./a.ts' }, base())).toBeNull()
    expect(evaluateWriteTarget('Write', { file_path: 'src/file.ts' }, base())).toBeNull()
  })
})

describe('evaluateWriteTarget — memory-dir carve-out', () => {
  // A bound code session whose auto-memory dir sits OUTSIDE the project root.
  const MEM = 'D:/home/.velloc/projects/work-proj/memory'
  const boundWithMem = (over: Partial<PathGuardContext> = {}) =>
    base({ memoryDir: MEM, ...over })

  it('a write to the memory dir is exempt even though it is outside the project', () => {
    // Without the carve-out this would be outside-workspace (bound projectRoot).
    expect(
      evaluateWriteTarget('Write', { file_path: `${MEM}/MEMORY.md` }, boundWithMem()),
    ).toBeNull()
    expect(
      evaluateWriteTarget('Edit', { file_path: `${MEM}/topics/foo.md` }, boundWithMem()),
    ).toBeNull()
  })

  it('the carve-out is scoped — a sibling outside the memory dir still asks', () => {
    expect(
      evaluateWriteTarget('Write', { file_path: 'D:/home/.velloc/projects/work-proj/notes.md' }, boundWithMem()),
    ).toBe('outside-workspace')
  })

  it('without memoryDir in ctx, behavior is unchanged (a memory-path write still asks)', () => {
    expect(
      evaluateWriteTarget('Write', { file_path: `${MEM}/MEMORY.md` }, base()),
    ).toBe('outside-workspace')
  })
})

describe('evaluateWriteTarget — alternate data stream colon', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('Windows host: a colon past index 1 is suspicious, a drive colon is not', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(evaluateWriteTarget('Write', { file_path: 'C:\work\proj\a:b' }, base({ cwd: 'C:/work/proj', projectRoot: 'C:/work/proj' }))).toBe('suspicious-path')
    expect(evaluateWriteTarget('Write', { file_path: 'src/a.ts:stream' }, base())).toBe('suspicious-path')
    expect(evaluateWriteTarget('Write', { file_path: 'D:/work/proj/a.ts' }, base())).toBeNull()
  })

  it('non-Windows host: the colon rule is skipped', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    expect(evaluateWriteTarget('Write', { file_path: 'src/a.ts:stream' }, base())).toBeNull()
  })
})

describe('evaluateWriteTarget — further runtime-dir and traversal cases', () => {
  it('working and shared-workspace state subdirs are writable', () => {
    for (const sub of ['working', 'shared-workspace']) {
      expect(evaluateWriteTarget('Write', { file_path: `.velloc/${sub}/x.md` }, base())).toBeNull()
    }
  })

  it('a near-miss state name or deep runtime dir is still protected', () => {
    expect(evaluateWriteTarget('Write', { file_path: '.velloc/plansX/x.md' }, base())).toBe('sensitive-path')
    expect(evaluateWriteTarget('Write', { file_path: 'sub/.velloc/agents/x' }, base())).toBe('sensitive-path')
    expect(evaluateWriteTarget('Write', { file_path: '.velloc' }, base())).toBe('sensitive-path')
  })

  it('a later .git inside an exempt state subdir is still protected', () => {
    expect(evaluateWriteTarget('Write', { file_path: '.velloc/projects/slug/.git/x' }, base())).toBe('sensitive-path')
  })

  it('.. traversal into .git is caught after resolution', () => {
    expect(evaluateWriteTarget('Write', { file_path: 'src/../.git/config' }, base())).toBe('sensitive-path')
  })

  it('mixed separators are split on both', () => {
    expect(evaluateWriteTarget('Write', { file_path: 'D:\work\proj/.git\config' }, base())).toBe('sensitive-path')
  })

  it('a target equal to a base, or a base with a trailing separator, is inside', () => {
    expect(evaluateWriteTarget('Write', { file_path: 'D:/work/proj' }, base())).toBeNull()
    expect(evaluateWriteTarget('Write', { file_path: 'D:/work/proj/a.ts' }, base({ projectRoot: 'D:/work/proj/', cwd: 'D:/work/proj/' }))).toBeNull()
  })

  it('a different drive is outside the workspace', () => {
    expect(evaluateWriteTarget('Write', { file_path: 'E:/work/proj/a.ts' }, base())).toBe('outside-workspace')
  })

  it('a project path merely containing the sandbox text is still bound', () => {
    const ctx = base({ cwd: 'D:/my-shared-workspace-app', projectRoot: 'D:/my-shared-workspace-app' })
    expect(evaluateWriteTarget('Write', { file_path: 'D:/elsewhere/x' }, ctx)).toBe('outside-workspace')
  })

  it('memory dir pre-empts the suspicious check too', () => {
    const MEM = 'D:/home/.velloc/projects/work-proj/memory'
    expect(evaluateWriteTarget('Write', { file_path: `${MEM}/GIT~1.md` }, base({ memoryDir: MEM }))).toBeNull()
  })
})

describe('describePathGuardAsk', () => {
  it('produces the frozen one-line texts', () => {
    expect(describePathGuardAsk('Write', 'sensitive-path', '.git/config')).toBe('Write a protected path (.git/config)')
    expect(describePathGuardAsk('Edit', 'suspicious-path', 'GIT~1/x')).toBe('Edit a path with a suspicious pattern (GIT~1/x)')
    expect(describePathGuardAsk('Write', 'outside-workspace', 'D:/x')).toBe('Write a file outside the workspace (D:/x)')
  })
})
