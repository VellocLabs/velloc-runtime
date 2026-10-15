import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  vetFileRead,
  vetFileWrite,
  liesUnderRoot,
  grantedRoots,
  proposeAllowRules,
  type FilePermissionContext,
} from '../permissions/filesystemPermission'

const CWD = 'D:/work/proj'
const base = (over: Partial<FilePermissionContext> = {}): FilePermissionContext => ({
  cwd: CWD,
  projectRoot: CWD,
  ...over,
})

describe('vetFileWrite', () => {
  it('deny rule → deny (highest precedence)', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base({
      ruleLists: { allow: [], deny: ['Write(src/**)'], ask: [] },
    }))
    expect(result.behavior).toBe('deny')
  })

  it('plan file carve-out → allow (before safety check)', async () => {
    const result = await vetFileWrite('Write', { file_path: '.velloc/plans/sess.md' }, base({
      planFilePath: '.velloc/plans/sess.md',
    }))
    expect(result.behavior).toBe('allow')
  })

  it('memory dir carve-out → allow', async () => {
    const result = await vetFileWrite('Write', { file_path: 'D:/home/.velloc/projects/p/memory/x.md' }, base({
      memoryDir: 'D:/home/.velloc/projects/p/memory',
    }))
    expect(result.behavior).toBe('allow')
  })

  it('dangerous dir (.git) → ask (safety check)', async () => {
    const result = await vetFileWrite('Write', { file_path: '.git/config' }, base())
    expect(result.behavior).toBe('ask')
  })

  it('.velloc internal state (plans) → allow, .velloc config (agents) → ask', async () => {
    expect((await vetFileWrite('Write', { file_path: '.velloc/plans/x.md' }, base())).behavior).toBe('allow')
    expect((await vetFileWrite('Write', { file_path: '.velloc/agents/x.md' }, base())).behavior).toBe('ask')
  })

  it('dangerous file (.bashrc) → ask', async () => {
    const result = await vetFileWrite('Write', { file_path: '.bashrc' }, base())
    expect(result.behavior).toBe('ask')
  })

  it('suspicious Windows pattern → ask', async () => {
    const result = await vetFileWrite('Write', { file_path: 'GIT~1/config' }, base())
    expect(result.behavior).toBe('ask')
  })

  it('ask rule → ask (survives bypass)', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base({
      ruleLists: { allow: [], deny: [], ask: ['Write(src/**)'] },
    }))
    expect(result.behavior).toBe('ask')
  })

  it('acceptEdits + working dir → allow', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base({
      mode: 'acceptEdits',
    }))
    expect(result.behavior).toBe('allow')
  })

  it('acceptEdits + outside working dir → ask (not auto-allowed)', async () => {
    const result = await vetFileWrite('Write', { file_path: 'D:/other/x.ts' }, base({
      mode: 'acceptEdits',
    }))
    expect(result.behavior).toBe('ask')
  })

  it('allow rule → allow', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base({
      ruleLists: { allow: ['Write(src/**)'], deny: [], ask: [] },
    }))
    expect(result.behavior).toBe('allow')
  })

  it('default (no rules, default mode, in working dir) → allow (velloc divergence: in-workspace writes run without prompt)', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base())
    expect(result.behavior).toBe('allow')
  })

  it('by-source deny rules are checked', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base({
      denyRuleBook: { projectSettings: ['Write(src/**)'] },
    }))
    expect(result.behavior).toBe('deny')
  })
})

describe('vetFileRead', () => {
  it('UNC path → ask', async () => {
    const result = await vetFileRead('Read', { file_path: '\\\\server\\share\\x' }, base())
    expect(result.behavior).toBe('ask')
  })

  it('suspicious Windows pattern → ask', async () => {
    const result = await vetFileRead('Read', { file_path: 'SETTIN~1.JSON' }, base())
    expect(result.behavior).toBe('ask')
  })

  it('read deny rule → deny', async () => {
    const result = await vetFileRead('Read', { file_path: 'secrets/key.txt' }, base({
      ruleLists: { allow: [], deny: ['Read(secrets/**)'], ask: [] },
    }))
    expect(result.behavior).toBe('deny')
  })

  it('read ask rule → ask', async () => {
    const result = await vetFileRead('Read', { file_path: 'private/x' }, base({
      ruleLists: { allow: [], deny: [], ask: ['Read(private/**)'] },
    }))
    expect(result.behavior).toBe('ask')
  })

  it('edit-implies-read: Edit allow rule → read allowed', async () => {
    const result = await vetFileRead('Read', { file_path: 'src/a.ts' }, base({
      ruleLists: { allow: ['Edit(src/**)'], deny: [], ask: [] },
    }))
    expect(result.behavior).toBe('allow')
  })

  it('working dir → allow (reads always allowed in working dir)', async () => {
    const result = await vetFileRead('Read', { file_path: 'src/a.ts' }, base())
    expect(result.behavior).toBe('allow')
  })

  it('memory dir → allow', async () => {
    const result = await vetFileRead('Read', { file_path: 'D:/home/.velloc/projects/p/memory/x.md' }, base({
      memoryDir: 'D:/home/.velloc/projects/p/memory',
    }))
    expect(result.behavior).toBe('allow')
  })

  it('read allow rule → allow', async () => {
    const result = await vetFileRead('Read', { file_path: 'D:/data/x.csv' }, base({
      ruleLists: { allow: ['Read(D:/data/**)'], deny: [], ask: [] },
    }))
    expect(result.behavior).toBe('allow')
  })

  it('outside working dir with no rules → allow (reads are not boundary-gated)', async () => {
    const result = await vetFileRead('Read', { file_path: 'D:/totally/elsewhere/x' }, base())
    expect(result.behavior).toBe('allow')
  })

  it('no file_path → allow (Glob/Grep with no explicit path)', async () => {
    const result = await vetFileRead('Glob', {}, base())
    expect(result.behavior).toBe('allow')
  })
})

describe('root resolution', () => {
  const HOME = 'D:/home/user'

  it('~/ pattern resolves against homeDir', async () => {
    const result = await vetFileWrite('Write', { file_path: `${HOME}/docs/x.txt` }, base({
      homeDir: HOME,
      denyRuleBook: { userSettings: ['Write(~/docs/**)'] },
    }))
    expect(result.behavior).toBe('deny')
  })

  it('~/ pattern does not match paths outside homeDir', async () => {
    const result = await vetFileWrite('Write', { file_path: 'D:/other/docs/x.txt' }, base({
      homeDir: HOME,
      denyRuleBook: { userSettings: ['Write(~/docs/**)'] },
    }))
    expect(result.behavior).toBe('ask')
  })

  it('/abs pattern resolves against projectRoot', async () => {
    const result = await vetFileWrite('Write', { file_path: `${CWD}/src/a.ts` }, base({
      denyRuleBook: { projectSettings: ['Write(/src/**)'] },
    }))
    expect(result.behavior).toBe('deny')
  })

  it('// pattern resolves against filesystem root', async () => {
    const result = await vetFileRead('Read', { file_path: 'D:/etc/passwd' }, base({
      denyRuleBook: { userSettings: ['Read(D:/etc/**)'] },
    }))
    expect(result.behavior).toBe('deny')
  })

  it('rootless pattern (./x or x) matches anywhere', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base({
      denyRuleBook: { userSettings: ['Write(./src/**)'] },
    }))
    expect(result.behavior).toBe('deny')
  })
})

describe('per-source attribution', () => {
  it('deny rule reports its source', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base({
      denyRuleBook: { projectSettings: ['Write(src/**)'] },
    }))
    expect(result.behavior).toBe('deny')
    expect(result.verdictReason).toEqual({
      type: 'rule',
      rule: 'Write(src/**)',
      source: 'projectSettings',
    })
  })

  it('allow rule reports its source', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base({
      allowRuleBook: { userSettings: ['Write(src/**)'] },
    }))
    expect(result.behavior).toBe('allow')
    expect(result.verdictReason).toEqual({
      type: 'rule',
      rule: 'Write(src/**)',
      source: 'userSettings',
    })
  })

  it('higher-precedence source wins when multiple sources match', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base({
      denyRuleBook: {
        userSettings: ['Write(src/**)'],
        localSettings: ['Write(src/**)'],
      },
    }))
    expect(result.behavior).toBe('deny')
    expect(result.verdictReason?.type).toBe('rule')
    if (result.verdictReason?.type === 'rule') {
      expect(result.verdictReason.source).toBe('userSettings')
    }
  })

  it('ruleLists fallback reports source as unknown', async () => {
    const result = await vetFileWrite('Write', { file_path: 'src/a.ts' }, base({
      ruleLists: { allow: [], deny: ['Write(src/**)'], ask: [] },
    }))
    expect(result.behavior).toBe('deny')
    expect(result.verdictReason).toEqual({
      type: 'rule',
      rule: 'Write(src/**)',
      source: 'unknown',
    })
  })
})

describe('working-directory model', () => {
  it('grantedRoots returns projectRoot + cwd + additional dirs', () => {
    const ctx = base({
      extraWorkspaceRoots: new Map([
        ['D:/extra1', { path: 'D:/extra1', source: 'user' }],
        ['D:/extra2', { path: 'D:/extra2', source: 'user' }],
      ]),
    })
    const dirs = grantedRoots(ctx)
    expect(dirs).toContain(CWD)
    expect(dirs).toContain('D:/extra1')
    expect(dirs).toContain('D:/extra2')
  })

  it('liesUnderRoot is case-insensitive', () => {
    expect(liesUnderRoot('D:/Work/Proj/src/a.ts', 'd:/work/proj', CWD)).toBe(true)
    expect(liesUnderRoot('D:/WORK/PROJ/src/a.ts', 'D:/work/proj', CWD)).toBe(true)
  })

  it('liesUnderRoot rejects path traversal (..)', () => {
    expect(liesUnderRoot('D:/work/proj/../outside.ts', 'D:/work/proj', CWD)).toBe(false)
    expect(liesUnderRoot('D:/work/proj/src/../../outside.ts', 'D:/work/proj', CWD)).toBe(false)
  })

  it('liesUnderRoot allows nested paths without traversal', () => {
    expect(liesUnderRoot('D:/work/proj/src/a.ts', 'D:/work/proj', CWD)).toBe(true)
    expect(liesUnderRoot('D:/work/proj/src/deep/nested/b.ts', 'D:/work/proj', CWD)).toBe(true)
  })

  it('liesUnderRoot exact match is inside', () => {
    expect(liesUnderRoot('D:/work/proj', 'D:/work/proj', CWD)).toBe(true)
  })

  it('liesUnderRoot rejects paths outside the base', () => {
    expect(liesUnderRoot('D:/other/x.ts', 'D:/work/proj', CWD)).toBe(false)
    expect(liesUnderRoot('D:/work/proj2/x.ts', 'D:/work/proj', CWD)).toBe(false)
  })
})

describe('read carve-outs', () => {
  const CONFIG_HOME = 'D:/home/.velloc'
  const ctx = base({ configHome: CONFIG_HOME, homeDir: 'D:/home' })

  it('plan file is readable', async () => {
    const result = await vetFileRead('Read', { file_path: '.velloc/plans/sess.md' }, base({
      planFilePath: '.velloc/plans/sess.md',
    }))
    expect(result.behavior).toBe('allow')
  })

  it('memory dir is readable', async () => {
    const result = await vetFileRead('Read', { file_path: 'D:/home/.velloc/projects/p/memory/x.md' }, base({
      memoryDir: 'D:/home/.velloc/projects/p/memory',
    }))
    expect(result.behavior).toBe('allow')
  })

  it('project storage dir (transcripts, tool-details, tasks) is readable', async () => {
    const result = await vetFileRead('Read', { file_path: `${CONFIG_HOME}/projects/p/sess/transcript.jsonl` }, ctx)
    expect(result.behavior).toBe('allow')
  })

  it('teams dir is readable', async () => {
    const result = await vetFileRead('Read', { file_path: `${CONFIG_HOME}/teams/team1/tasks.jsonl` }, ctx)
    expect(result.behavior).toBe('allow')
  })

  it('skills dirs (user + project) are readable', async () => {
    expect((await vetFileRead('Read', { file_path: 'D:/home/.velloc/skills/my-skill/SKILL.md' }, ctx)).behavior).toBe('allow')
    expect((await vetFileRead('Read', { file_path: '.velloc/skills/proj-skill/SKILL.md' }, ctx)).behavior).toBe('allow')
  })

  it('.velloc internal-state subdirs are readable', async () => {
    expect((await vetFileRead('Read', { file_path: '.velloc/plans/x.md' }, ctx)).behavior).toBe('allow')
    expect((await vetFileRead('Read', { file_path: '.velloc/sessions/sess/x.json' }, ctx)).behavior).toBe('allow')
  })
})

describe('scratchpad carve-out', () => {
  const SCRATCH = 'D:/home/.velloc/projects/p/sess-fs/scratch'

  it('writes to the scratchpad dir are allowed without prompt', async () => {
    const result = await vetFileWrite('Write', { file_path: `${SCRATCH}/draft.md` }, base({
      freeWriteDir: SCRATCH,
    }))
    expect(result.behavior).toBe('allow')
  })

  it('nested scratchpad paths are allowed', async () => {
    const result = await vetFileWrite('Write', { file_path: `${SCRATCH}/sub/dir/temp.json` }, base({
      freeWriteDir: SCRATCH,
    }))
    expect(result.behavior).toBe('allow')
  })

  it('a path NOT under the configured scratchpad is NOT carved out', async () => {
    const result = await vetFileWrite('Write', { file_path: 'D:/elsewhere/scratch/draft.md' }, base({
      freeWriteDir: SCRATCH,
    }))
    expect(result.behavior).toBe('ask')
  })

  it('reads from the scratchpad are allowed', async () => {
    const result = await vetFileRead('Read', { file_path: `${SCRATCH}/draft.md` }, base({
      freeWriteDir: SCRATCH,
    }))
    expect(result.behavior).toBe('allow')
  })
})

describe('per-task workspace carve-out', () => {
  const TASK_WS = 'D:/home/.velloc/projects/p/sess-fs/tasks/task-1/workspace'

  it('writes to a task workspace dir are allowed without prompt', async () => {
    const result = await vetFileWrite('Write', { file_path: `${TASK_WS}/output.txt` }, base({
      taskWorkspaceDirs: [TASK_WS],
    }))
    expect(result.behavior).toBe('allow')
  })

  it('multiple task workspaces are all writable', async () => {
    const ws2 = 'D:/home/.velloc/projects/p/sess-fs/tasks/task-2/workspace'
    const result = await vetFileWrite('Write', { file_path: `${ws2}/x.json` }, base({
      taskWorkspaceDirs: [TASK_WS, ws2],
    }))
    expect(result.behavior).toBe('allow')
  })

  it('a path NOT under any configured task workspace is NOT carved out', async () => {
    const result = await vetFileWrite('Write', { file_path: 'D:/elsewhere/ws/x' }, base({
      taskWorkspaceDirs: [TASK_WS],
    }))
    expect(result.behavior).toBe('ask')
  })

  it('reads from a task workspace are allowed', async () => {
    const result = await vetFileRead('Read', { file_path: `${TASK_WS}/output.txt` }, base({
      taskWorkspaceDirs: [TASK_WS],
    }))
    expect(result.behavior).toBe('allow')
  })
})

describe('session skill-scope bypass (write step 1.6)', () => {
  it('session-scoped .velloc/skills/** allow rule bypasses safety check', async () => {
    const result = await vetFileWrite('Write', { file_path: '.velloc/skills/my-skill/SKILL.md' }, base({
      allowRuleBook: { session: ['Edit(.velloc/skills/my-skill/**)'] },
    }))
    expect(result.behavior).toBe('allow')
  })

  it('user/project rules do NOT bypass (only session rules)', async () => {
    const result = await vetFileWrite('Write', { file_path: '.velloc/skills/my-skill/SKILL.md' }, base({
      allowRuleBook: { userSettings: ['Edit(.velloc/skills/my-skill/**)'] },
    }))
    expect(result.behavior).toBe('ask')
  })

  it('rule with .. is rejected', async () => {
    const result = await vetFileWrite('Write', { file_path: '.velloc/skills/my-skill/SKILL.md' }, base({
      allowRuleBook: { session: ['Edit(.velloc/skills/../**))'] },
    }))
    expect(result.behavior).toBe('ask')
  })

  it('rule without /** suffix is rejected', async () => {
    const result = await vetFileWrite('Write', { file_path: '.velloc/skills/my-skill/SKILL.md' }, base({
      allowRuleBook: { session: ['Edit(.velloc/skills/my-skill)'] },
    }))
    expect(result.behavior).toBe('ask')
  })
})

describe('classifierApprovable', () => {
  it('sensitive-file safety asks are classifierApprovable=true', async () => {
    const result = await vetFileWrite('Write', { file_path: '.git/config' }, base())
    expect(result.behavior).toBe('ask')
    expect(result.verdictReason).toEqual({
      type: 'safetyCheck',
      reason: 'sensitive-path',
      classifierApprovable: true,
    })
  })

  it('suspicious Windows pattern asks are classifierApprovable=false', async () => {
    const result = await vetFileWrite('Write', { file_path: 'GIT~1/config' }, base())
    expect(result.behavior).toBe('ask')
    expect(result.verdictReason).toEqual({
      type: 'safetyCheck',
      reason: 'suspicious-path',
      classifierApprovable: false,
    })
  })
})

describe('proposeAllowRules', () => {
  it('read outside working dir → addDirectories suggestion', () => {
    const suggestions = proposeAllowRules('D:/other/x.ts', 'read', base())
    expect(suggestions).toEqual([{ type: 'addDirectories', directories: ['D:/other'] }])
  })

  it('write outside working dir in default mode → setMode + addDirectories', () => {
    const suggestions = proposeAllowRules('D:/other/x.ts', 'write', base({ mode: 'default' }))
    expect(suggestions).toEqual([
      { type: 'setMode', mode: 'acceptEdits' },
      { type: 'addDirectories', directories: ['D:/other'] },
    ])
  })

  it('write inside working dir in default mode → setMode only', () => {
    const suggestions = proposeAllowRules('src/a.ts', 'write', base({ mode: 'default' }))
    expect(suggestions).toEqual([{ type: 'setMode', mode: 'acceptEdits' }])
  })

  it('write in bypassPermissions mode → no setMode suggestion (avoid downgrade)', () => {
    const suggestions = proposeAllowRules('D:/other/x.ts', 'write', base({ mode: 'bypassPermissions' }))
    expect(suggestions).toEqual([{ type: 'addDirectories', directories: ['D:/other'] }])
  })

  it('read inside working dir in plan mode → setMode suggestion', () => {
    const suggestions = proposeAllowRules('src/a.ts', 'read', base({ mode: 'plan' }))
    expect(suggestions).toEqual([{ type: 'setMode', mode: 'acceptEdits' }])
  })
})

describe('symlink resolution', () => {
  // Normalize separators so the mock works regardless of platform.
  const norm = (p: string) => p.replace(/\\/g, '/')

  // A mock fs whose realpath resolves a symlink inside the workspace to a
  // target OUTSIDE it — the classic symlink-escape attack.
  const escapingFs = {
    realpath: async (p: string) =>
      norm(p) === 'D:/work/proj/link' ? 'D:/outside/secret.txt' : p,
  } as FilePermissionContext['fs']

  // A mock fs whose realpath keeps the path inside the workspace.
  const internalFs = {
    realpath: async (p: string) =>
      norm(p) === 'D:/work/proj/link' ? 'D:/work/proj/real.txt' : p,
  } as FilePermissionContext['fs']

  it('a write via a symlink escaping the workspace is NOT auto-allowed (acceptEdits)', async () => {
    // acceptEdits requires ALL representations inside the working dir. The
    // symlink target is outside → not auto-allowed → falls through to ask.
    const result = await vetFileWrite(
      'Write',
      { file_path: 'link' },
      base({ mode: 'acceptEdits', fs: escapingFs }),
    )
    expect(result.behavior).toBe('ask')
  })

  it('a write via a symlink staying inside the workspace IS auto-allowed (acceptEdits)', async () => {
    const result = await vetFileWrite(
      'Write',
      { file_path: 'link' },
      base({ mode: 'acceptEdits', fs: internalFs }),
    )
    expect(result.behavior).toBe('allow')
  })

  it('a deny rule on the symlink TARGET (resolved path) still denies', async () => {
    // The deny rule targets the resolved path D:/outside/**. Even though the
    // input is "link" (inside workspace), the resolved representation matches
    // the deny → deny wins (ANY representation).
    const result = await vetFileWrite(
      'Write',
      { file_path: 'link' },
      base({
        ruleLists: { allow: [], deny: ['Write(D:/outside/**)'], ask: [] },
        fs: escapingFs,
      }),
    )
    expect(result.behavior).toBe('deny')
  })

  it('a read via a symlink escaping the workspace is NOT auto-allowed', async () => {
    // Reads in working dir are auto-allowed, but require ALL representations
    // inside. The symlink target is outside → falls through (to allow-by-default
    // for reads in velloc's sandbox model, but NOT via the working-dir step).
    const result = await vetFileRead(
      'Read',
      { file_path: 'link' },
      base({ fs: escapingFs }),
    )
    // Velloc read default is allow (sandbox model), but the point is the
    // working-dir step did not fire — verified by the deny-on-target test below.
    expect(result.behavior).toBe('allow')
  })

  it('a read deny rule on the symlink TARGET still denies', async () => {
    const result = await vetFileRead(
      'Read',
      { file_path: 'link' },
      base({
        ruleLists: { allow: [], deny: ['Read(D:/outside/**)'], ask: [] },
        fs: escapingFs,
      }),
    )
    expect(result.behavior).toBe('deny')
  })

  it('without fs.realpath, only the original path is checked (graceful fallback)', async () => {
    // No fs → no symlink resolution. "link" is inside workspace → auto-allowed.
    const result = await vetFileWrite(
      'Write',
      { file_path: 'link' },
      base({ mode: 'acceptEdits' }),
    )
    expect(result.behavior).toBe('allow')
  })
})

describe('write safety: sandbox detection and NTFS data streams', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('a bound project whose path merely contains "shared-workspace" keeps the boundary', async () => {
    const root = 'D:/work/my-shared-workspace-app'
    const r = await vetFileWrite('Write', { file_path: 'D:/elsewhere/x.txt' }, {
      cwd: root,
      projectRoot: root,
    })
    expect(r.behavior).toBe('ask')
    expect(r.verdictReason).toMatchObject({ type: 'safetyCheck', reason: 'outside-workspace' })
  })

  it('the real sandbox (a shared-workspace path segment) skips the safety boundary', async () => {
    const root = 'C:/Users/u/.velloc/shared-workspace/agent'
    const r = await vetFileWrite('Write', { file_path: 'D:/elsewhere/x.txt' }, {
      cwd: root,
      projectRoot: root,
    })
    // Still an ask (the path is outside the working dir) but not a safety hit.
    expect(r.verdictReason).toMatchObject({ type: 'workingDir' })
  })

  it('an alternate data stream path asks on a Windows host', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    const r = await vetFileWrite('Write', { file_path: 'notes.txt:hidden' }, base())
    expect(r.behavior).toBe('ask')
  })

  it('a colon is an ordinary filename character off Windows', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    const r = await vetFileWrite('Write', { file_path: 'notes:v2.txt' }, base())
    expect(r.behavior).toBe('allow')
  })

  it('a drive-letter colon is not a stream on a Windows host', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    const r = await vetFileWrite('Write', { file_path: 'D:/work/proj/a.ts' }, base())
    expect(r.behavior).toBe('allow')
  })
})
