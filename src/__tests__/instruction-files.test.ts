import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  discoverInstructionFiles,
  extractIncludeRefs,
  formatMemoryFilesForPrompt,
  getConditionalRulesForPath,
  gatherInstructionDocs,
  INSTRUCTION_BLOCK_PREAMBLE,
  resolveUserInstructionPath,
  dropMarkupNotes,
} from '../memory/instructionFiles'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFsEntry,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'

// ----------------------------------------------------------------------------
// Tiny in-memory fs that supports readFile + readdir.
// `tree` keys are absolute paths. Directory entries are implicit — any
// key under `<dir>/` makes `<dir>` readable as a directory.
// ----------------------------------------------------------------------------

function makeDirent(name: string, kind: 'file' | 'dir'): RuntimeFsEntry {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  }
}

function makeFs(tree: Record<string, string>): RuntimeFs {
  return {
    ...unconfiguredFs,
    async readFile(path: string): Promise<string> {
      if (path in tree) return tree[path]!
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const seen = new Set<string>()
      const out: RuntimeFsEntry[] = []
      let anyMatch = false
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        anyMatch = true
        const rest = key.slice(prefix.length)
        const firstSeg = rest.split('/')[0]!
        if (!firstSeg || seen.has(firstSeg)) continue
        seen.add(firstSeg)
        const fullChild = `${prefix}${firstSeg}`
        if (fullChild in tree) {
          out.push(makeDirent(firstSeg, 'file'))
        } else {
          out.push(makeDirent(firstSeg, 'dir'))
        }
      }
      if (!anyMatch) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return out
    },
  } as RuntimeFs
}

function makeRuntimeConfig(env: Record<string, string> = {}): RuntimeConfig {
  return {
    getEnv: (name: string) => env[name],
    flagOn: (name: string) => {
      const v = env[name]
      return v === '1' || v === 'true' || v === 'yes'
    },
    now: () => 1_700_000_000_000,
    createUUID: () => 'uuid',
    createTimestamp: () => '2026-05-13T00:00:00.000Z',
    getMaxStructuredOutputRetries: () => 5,
  }
}

afterEach(() => {
  resetProcessFs()
})

// ============================================================================
// dropMarkupNotes
// ============================================================================

describe('dropMarkupNotes', () => {
  it('returns content unchanged when there are no comments', () => {
    const result = dropMarkupNotes('hello\nworld')
    expect(result.content).toBe('hello\nworld')
    expect(result.stripped).toBe(false)
  })

  it('strips block comments from prose', () => {
    const input = 'before\n<!-- hidden -->\nafter'
    const result = dropMarkupNotes(input)
    expect(result.stripped).toBe(true)
    expect(result.content).not.toContain('hidden')
    expect(result.content).toContain('before')
    expect(result.content).toContain('after')
  })

  it('preserves comments inside fenced code blocks', () => {
    const input = 'before\n```\n<!-- keep me -->\n```\nafter'
    const result = dropMarkupNotes(input)
    expect(result.content).toContain('keep me')
  })

  it('strips multi-line comments', () => {
    const input = 'before\n<!--\nhidden\nmulti\nline\n-->\nafter'
    const result = dropMarkupNotes(input)
    expect(result.content).not.toContain('hidden')
    expect(result.content).not.toContain('multi')
  })

  it('leaves an unclosed comment alone', () => {
    const input = 'before\n<!-- never closed\nmore'
    const result = dropMarkupNotes(input)
    expect(result.content).toContain('<!-- never closed')
  })
})

// ============================================================================
// extractIncludeRefs
// ============================================================================

describe('extractIncludeRefs', () => {
  it('finds @./relative paths', () => {
    expect(extractIncludeRefs('see @./other.md for details')).toEqual([
      './other.md',
    ])
  })

  it('finds @~/home paths', () => {
    expect(extractIncludeRefs('see @~/notes.md')).toEqual(['~/notes.md'])
  })

  it('finds @/absolute paths', () => {
    expect(extractIncludeRefs('see @/etc/notes.md')).toEqual(['/etc/notes.md'])
  })

  it('finds @bare relative paths', () => {
    expect(extractIncludeRefs('see @notes.md')).toEqual(['notes.md'])
  })

  it('multiple references on one line', () => {
    expect(extractIncludeRefs('see @a.md and @b.md')).toEqual(['a.md', 'b.md'])
  })

  it('strips fragment identifiers', () => {
    // Fragment stripping happens in resolveIncludePath, not here — verify
    // the raw extraction.
    expect(extractIncludeRefs('see @./notes.md#section')).toEqual([
      './notes.md#section',
    ])
  })

  it('skips references inside fenced code blocks', () => {
    const input = 'pre @real.md\n```\n@fake.md\n```\npost @other.md'
    expect(extractIncludeRefs(input)).toEqual(['real.md', 'other.md'])
  })

  it('handles email-like strings: rejects standalone `@user`', () => {
    // The regex requires the @-path follow whitespace or BOL. An
    // email-like `user@host` should not produce `host`.
    expect(extractIncludeRefs('contact user@host for help')).toEqual([])
  })

  it('returns empty on plain prose', () => {
    expect(extractIncludeRefs('no references here')).toEqual([])
  })
})

// ============================================================================
// gatherInstructionDocs — directory walk
// ============================================================================

describe('gatherInstructionDocs', () => {
  it('returns empty when no CLAUDE.md exists anywhere', async () => {
    installProcessFs(makeFs({}))
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result).toEqual([])
  })

  it('loads ~/.velloc/AGENTS.md from the user tier', async () => {
    installProcessFs(
      makeFs({
        '/home/user/.velloc/AGENTS.md': 'user-tier content',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('User')
    expect(result[0]?.content).toContain('user-tier content')
  })

  it('falls back to ~/.claude/CLAUDE.md when ~/.velloc/AGENTS.md absent', async () => {
    installProcessFs(
      makeFs({
        '/home/user/.claude/CLAUDE.md': 'legacy user-tier',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toContain('.claude')
  })

  it('walks up from cwd collecting Project + Local files in priority order', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/CLAUDE.md': 'project-root',
        '/home/user/project/sub/CLAUDE.md': 'project-cwd',
        '/home/user/project/CLAUDE.local.md': 'local-root',
        '/home/user/project/sub/CLAUDE.local.md': 'local-cwd',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project/sub',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    // Project tier loaded root → cwd (priority increasing), Local same.
    const projectFiles = result.filter(f => f.type === 'Project')
    const localFiles = result.filter(f => f.type === 'Local')
    expect(projectFiles.map(f => f.content.trim())).toEqual([
      'project-root',
      'project-cwd',
    ])
    expect(localFiles.map(f => f.content.trim())).toEqual([
      'local-root',
      'local-cwd',
    ])
  })

  it('respects walk-up boundary at home directory', async () => {
    // A CLAUDE.md above the home dir should NOT be discovered.
    installProcessFs(
      makeFs({
        '/home/user/.velloc/AGENTS.md': 'user',
        '/home/CLAUDE.md': 'ancestor-of-home',
        '/home/user/project/CLAUDE.md': 'project',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    const contents = result.map(f => f.content.trim())
    expect(contents).toContain('user')
    expect(contents).toContain('project')
    expect(contents.find(c => c.includes('ancestor-of-home'))).toBeUndefined()
  })

  it('expands @include directives', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/CLAUDE.md':
          'main\n@./extras.md\n',
        '/home/user/project/extras.md': 'extra content',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    const paths = result.map(f => f.path)
    expect(paths).toContain('/home/user/project/CLAUDE.md')
    expect(paths).toContain('/home/user/project/extras.md')
    const extras = result.find(f => f.path.endsWith('extras.md'))
    expect(extras?.parent).toBe('/home/user/project/CLAUDE.md')
  })

  it('prevents @include cycles', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/CLAUDE.md': 'main @./a.md',
        '/home/user/project/a.md': 'a @./b.md',
        '/home/user/project/b.md': 'b @./a.md',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    // 3 files, no infinite loop.
    expect(result).toHaveLength(3)
  })

  it('silently skips missing @include targets', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/CLAUDE.md': 'main @./missing.md tail',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('/home/user/project/CLAUDE.md')
  })

  it('strips HTML comments from loaded content', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/CLAUDE.md':
          'before\n<!-- hidden -->\nafter\n',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result[0]?.content).not.toContain('hidden')
  })

  it('strips frontmatter and exposes globs from `paths` field', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/CLAUDE.md':
          '---\npaths: src/**, test/**\n---\nbody\n',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result[0]?.content.trim()).toBe('body')
    expect(result[0]?.globs).toEqual(['src/**', 'test/**'])
  })

  it('eagerly discovers only always-on .claude/rules/*.md (path-scoped excluded)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/.claude/rules/test.md': 'project rule',
        '/home/user/project/.claude/rules/style.md':
          '---\npaths: src/**\n---\nstyle rule body',
        '/home/user/project/sub/CLAUDE.md': 'cwd marker',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project/sub',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    const ruleFiles = result.filter(f => f.path.includes('/rules/'))
    // Eager split: the always-on rule loads; the path-scoped
    // `style.md` (has `paths:`) is NOT loaded eagerly — it activates per
    // file-read via getConditionalRulesForPath.
    expect(ruleFiles.map(f => f.path)).toEqual([
      '/home/user/project/.claude/rules/test.md',
    ])
    expect(ruleFiles[0]?.globs).toBeUndefined()
  })

  // C7 regression (eager half): a `paths:`-scoped rule whose body @includes a
  // sibling file must NOT leak that included body into the eager load. The
  // whole chain is classified by the ROOT rule's globs, so a globbed root keeps
  // its @included child conditional too. The include-target key is inserted
  // FIRST (NTFS name-sort: `secure-extra.md` < `secure.md`) — the order that a
  // naive per-file filter mis-handles (child enumerated standalone as always-on).
  it('does NOT eagerly load an @include child of a paths:-scoped rule (C7 no leak)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/.velloc/rules/secure-extra.md':
          'Extra security guidance. SENTINEL_LEAK_X.',
        '/home/user/project/.velloc/rules/secure.md':
          '---\npaths: src/secure/**\n---\nReview strictly.\n@./secure-extra.md\n',
        '/home/user/project/sub/CLAUDE.md': 'cwd marker',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project/sub',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    // The cwd marker proves the project walk ran (non-vacuous), but no
    // /rules/ file is loaded eagerly — the globbed root + its @included child
    // are both deferred to per-read injection.
    expect(result.some(f => f.content.includes('cwd marker'))).toBe(true)
    expect(result.filter(f => f.path.includes('/rules/'))).toEqual([])
    const joined = result.map(f => f.content).join('\n')
    expect(joined).not.toContain('SENTINEL_LEAK_X')
    expect(joined).not.toContain('Review strictly')
  })

  // C7 regression (no over-correction): an ALWAYS-ON rule (no `paths:`) that
  // @includes a sibling must STILL load both the rule and its included body
  // eagerly — the chain classification only defers GLOBBED roots.
  it('still eagerly loads an @include child of an always-on rule (C7 no regression)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/.velloc/rules/onboarding-extra.md':
          'More onboarding. SENTINEL_ALWAYS_W.',
        '/home/user/project/.velloc/rules/onboarding.md':
          'Onboarding basics.\n@./onboarding-extra.md\n',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    const rulePaths = result
      .filter(f => f.path.includes('/rules/'))
      .map(f => f.path)
    expect(rulePaths).toContain('/home/user/project/.velloc/rules/onboarding.md')
    expect(rulePaths).toContain(
      '/home/user/project/.velloc/rules/onboarding-extra.md',
    )
    expect(result.map(f => f.content).join('\n')).toContain('SENTINEL_ALWAYS_W')
  })

  it('recursively walks .claude/rules/ subdirectories', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/.claude/rules/top.md': 'top',
        '/home/user/project/.claude/rules/lang/python.md': 'python rule',
        '/home/user/project/.claude/rules/lang/go.md': 'go rule',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    const paths = result.map(f => f.path).sort()
    expect(paths).toContain('/home/user/project/.claude/rules/top.md')
    expect(paths).toContain('/home/user/project/.claude/rules/lang/python.md')
    expect(paths).toContain('/home/user/project/.claude/rules/lang/go.md')
  })

  it('loads user-tier rules from ~/.velloc/rules and ~/.claude/rules', async () => {
    installProcessFs(
      makeFs({
        '/home/user/.velloc/rules/cli.md': 'nexus cli rule',
        '/home/user/.claude/rules/editor.md': 'legacy editor rule',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    const paths = result.map(f => f.path)
    expect(paths).toContain('/home/user/.velloc/rules/cli.md')
    expect(paths).toContain('/home/user/.claude/rules/editor.md')
    expect(result.every(f => f.type === 'User')).toBe(true)
  })

  // ==========================================================================
  // AGENTS.md first, CLAUDE.md its fallback
  // (fallback-not-additive: one file per location)
  // ==========================================================================

  it('loads ~/.velloc/AGENTS.md as the user-tier file', async () => {
    installProcessFs(
      makeFs({ '/home/user/.velloc/AGENTS.md': 'user agents file' }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('/home/user/.velloc/AGENTS.md')
    expect(result[0]?.type).toBe('User')
  })

  it('~/.velloc/AGENTS.md wins over ~/.claude/CLAUDE.md (fallback, not additive)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/.velloc/AGENTS.md': 'agents',
        '/home/user/.claude/CLAUDE.md': 'fallback tier',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result.map(f => f.path)).toEqual(['/home/user/.velloc/AGENTS.md'])
  })

  it('a project AGENTS.md wins over the CLAUDE.md beside it', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/AGENTS.md': 'agents',
        '/home/user/project/CLAUDE.md': 'fallback tier',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    const project = result.filter(f => f.type === 'Project')
    expect(project.map(f => f.path)).toEqual(['/home/user/project/AGENTS.md'])
  })

  it('loads AGENTS.md (root) + .claude/CLAUDE.md at the project tier', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/AGENTS.md': 'root agents',
        '/home/user/project/.claude/CLAUDE.md': 'nested fallback',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    // Both slots contribute; the root slot is emitted last (highest
    // attention).
    expect(result.map(f => f.path)).toEqual([
      '/home/user/project/.claude/CLAUDE.md',
      '/home/user/project/AGENTS.md',
    ])
    expect(result.every(f => f.type === 'Project')).toBe(true)
  })

  it('loads CLAUDE.local.md at the local tier', async () => {
    installProcessFs(
      makeFs({ '/home/user/project/CLAUDE.local.md': 'local' }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    const localFiles = result.filter(f => f.type === 'Local')
    expect(localFiles.map(f => f.path)).toEqual([
      '/home/user/project/CLAUDE.local.md',
    ])
  })

  it('does NOT recognize NEXUS.md', async () => {
    installProcessFs(
      makeFs({ '/home/user/project/NEXUS.md': 'old nexus file' }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result).toEqual([])
  })

  it('discovers .velloc/rules/*.md at the project tier (preferred over .claude/rules/)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/.velloc/rules/style.md': 'nexus rule',
        '/home/user/project/.claude/rules/legacy.md': 'legacy rule',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    const rulePaths = result
      .filter(f => f.path.includes('/rules/'))
      .map(f => f.path)
    expect(rulePaths).toContain('/home/user/project/.velloc/rules/style.md')
    expect(rulePaths).toContain('/home/user/project/.claude/rules/legacy.md')
  })

  // ==========================================================================
  // projectRoot anchor
  // ==========================================================================

  // ── Read boundary (untrusted child): the hierarchy is assembled from INSIDE
  // the root only. These reads are made by the runtime, not a tool, so the
  // tool-level boundary never sees them — this is where they are scoped.
  it('under a read boundary, loads no user tier and does not climb above the root', async () => {
    installProcessFs(
      makeFs({
        '/home/user/.velloc/AGENTS.md': 'USER TIER — who the user is',
        '/home/user/AGENTS.md': 'home-level instructions',
        '/home/user/project/AGENTS.md': 'canonical repo instructions',
        '/home/user/project/wt/AGENTS.md': 'worktree instructions',
        '/home/user/project/wt/CLAUDE.local.md': 'worktree local',
        '/home/user/project/wt/.velloc/rules/always.md': 'worktree rule',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project/wt',
      // The canonical repo is the memory/skills anchor and lies OUTSIDE the
      // worktree — without readRoot the walk would start there.
      projectRoot: '/home/user/project',
      homeDir: '/home/user',
      readRoot: '/home/user/project/wt',
      runtimeConfig: makeRuntimeConfig({ HOME: '/home/user' }),
    })
    expect(result.map(f => f.path).sort()).toEqual([
      '/home/user/project/wt/.velloc/rules/always.md',
      '/home/user/project/wt/AGENTS.md',
      '/home/user/project/wt/CLAUDE.local.md',
    ])
    expect(result.some(f => f.type === 'User')).toBe(false)
    expect(result.some(f => f.type === 'AutoMem')).toBe(false)
  })

  it('under a read boundary, drops an @include that resolves outside the root', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/AGENTS.md':
          'main\n@./docs/inside.md\n@~/.velloc/secrets.md\n@../outside.md\n',
        '/home/user/project/docs/inside.md': 'inside content',
        '/home/user/.velloc/secrets.md': 'SECRET',
        '/home/user/outside.md': 'OUTSIDE',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      projectRoot: '/home/user/project',
      homeDir: '/home/user',
      readRoot: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({ HOME: '/home/user' }),
    })
    const paths = result.map(f => f.path)
    expect(paths).toContain('/home/user/project/AGENTS.md')
    expect(paths).toContain('/home/user/project/docs/inside.md')
    expect(paths.some(p => p.includes('secrets') || p.includes('outside'))).toBe(false)
    expect(result.map(f => f.content).join('\n')).not.toMatch(/SECRET|OUTSIDE/)
  })

  it('without readRoot the same tree loads the user tier (the boundary is opt-in)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/.velloc/AGENTS.md': 'USER TIER',
        '/home/user/project/wt/AGENTS.md': 'worktree instructions',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project/wt',
      projectRoot: '/home/user/project',
      homeDir: '/home/user',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result.some(f => f.type === 'User')).toBe(true)
  })

  it('walks from projectRoot, not cwd, when projectRoot is provided', async () => {
    // AGENTS.md sits under the projectRoot dir, which is unrelated to cwd.
    installProcessFs(
      makeFs({
        '/home/user/.velloc/sess-1/workspace/AGENTS.md': 'workspace agents',
        // A stray AGENTS.md at cwd that should NOT be loaded.
        '/home/user/elsewhere/AGENTS.md': 'should not load',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/elsewhere',
      projectRoot: '/home/user/.velloc/sess-1/workspace',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    const paths = result.map(f => f.path)
    expect(paths).toContain('/home/user/.velloc/sess-1/workspace/AGENTS.md')
    expect(paths.find(p => p.includes('elsewhere'))).toBeUndefined()
  })

  it('falls back to cwd walk when projectRoot is not provided (back-compat)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/AGENTS.md': 'cwd-anchored',
      }),
    )
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig({
        HOME: '/home/user',
        VELLOC_MEMORY: 'off',
      }),
    })
    expect(result.map(f => f.path)).toContain(
      '/home/user/project/AGENTS.md',
    )
  })
})

// ============================================================================
// Read in place — needs a WRITABLE fs, to prove loading writes nothing
// ============================================================================

/** In-memory fs that supports readFile + readdir + writeFile + mkdir, and
 *  records every write — loading must make none. */
function makeWritableFs(initial: Record<string, string> = {}) {
  const tree: Record<string, string> = { ...initial }
  const writes: string[] = []
  const fs = {
    ...unconfiguredFs,
    async readFile(path: string): Promise<string> {
      if (path in tree) return tree[path]!
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const seen = new Set<string>()
      const out: RuntimeFsEntry[] = []
      let anyMatch = false
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        anyMatch = true
        const firstSeg = key.slice(prefix.length).split('/')[0]!
        if (!firstSeg || seen.has(firstSeg)) continue
        seen.add(firstSeg)
        const fullChild = `${prefix}${firstSeg}`
        out.push(makeDirent(firstSeg, fullChild in tree ? 'file' : 'dir'))
      }
      if (!anyMatch) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return out
    },
    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      writes.push(path)
      tree[path] = typeof data === 'string' ? data : new TextDecoder().decode(data)
    },
    async mkdir(): Promise<void> {
      // Dirs are implicit in this tree model — nothing to create.
    },
  } as RuntimeFs
  return { fs, tree, writes }
}

describe('gatherInstructionDocs — instruction files are read in place', () => {
  const env = { HOME: '/home/user', VELLOC_MEMORY: 'off' }

  it('loads a lone CLAUDE.md where it stands and writes nothing', async () => {
    const { fs, tree, writes } = makeWritableFs({
      '/home/user/.claude/CLAUDE.md': 'user fallback',
      '/home/user/project/CLAUDE.md': 'project fallback',
      '/home/user/project/.claude/CLAUDE.md': 'nested fallback',
      '/home/user/project/CLAUDE.local.md': 'local fallback',
    })
    installProcessFs(fs)
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(env),
    })
    expect(result.map(f => f.path).sort()).toEqual([
      '/home/user/.claude/CLAUDE.md',
      '/home/user/project/.claude/CLAUDE.md',
      '/home/user/project/CLAUDE.local.md',
      '/home/user/project/CLAUDE.md',
    ])
    expect(writes).toEqual([])
    expect(Object.keys(tree).some(p => p.endsWith('AGENTS.md'))).toBe(false)
  })

  // Previously the brand file `VELLOC.md` was the instruction file. It
  // is no instruction file's name any more, but it is the LAST candidate of
  // each slot: a user who wrote one still has it loaded — read in place, never
  // written or copied — until they rename it.
  it('still loads a legacy VELLOC.md / ~/.velloc/CLAUDE.md where nothing newer exists', async () => {
    const { fs, writes } = makeWritableFs({
      '/home/user/.velloc/VELLOC.md': 'old brand user',
      '/home/user/project/VELLOC.md': 'old brand project',
      '/home/user/project/.velloc/VELLOC.md': 'old brand project dir',
    })
    installProcessFs(fs)
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(env),
    })
    expect(result.map(f => f.path).sort()).toEqual([
      '/home/user/.velloc/VELLOC.md',
      '/home/user/project/.velloc/VELLOC.md',
      '/home/user/project/VELLOC.md',
    ])
    expect(writes).toEqual([])

    const { fs: userFs } = makeWritableFs({
      '/home/user/.velloc/CLAUDE.md': 'pre-AGENTS velloc user',
    })
    installProcessFs(userFs)
    const user = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(env),
    })
    expect(user.map(f => f.path)).toEqual(['/home/user/.velloc/CLAUDE.md'])
  })

  it('a legacy file never loads beside a newer one in its slot', async () => {
    const { fs } = makeWritableFs({
      '/home/user/.velloc/AGENTS.md': 'new user',
      '/home/user/.velloc/VELLOC.md': 'old user',
      '/home/user/project/CLAUDE.md': 'project fallback',
      '/home/user/project/VELLOC.md': 'old project',
      '/home/user/project/.claude/CLAUDE.md': 'dot-dir fallback',
      '/home/user/project/.velloc/VELLOC.md': 'old project dir',
      '/home/user/project/CLAUDE.local.md': 'local fallback',
    })
    installProcessFs(fs)
    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(env),
    })
    expect(result.map(f => f.content).sort()).toEqual([
      'dot-dir fallback',
      'local fallback',
      'new user',
      'project fallback',
    ])
  })

  // The default project lives under `~/.velloc/`, so that directory is an
  // ancestor the project walk visits: its VELLOC.md / CLAUDE.md are the user
  // slot's legacy candidates, and must not load again as Project files when
  // the user slot is won by `~/.claude/CLAUDE.md`.
  it('the user tier\'s own files are not loaded again by a project that sits under ~/.velloc', async () => {
    const files = {
      '/home/user/.claude/CLAUDE.md': 'user fallback',
      '/home/user/.velloc/VELLOC.md': 'old user brand',
      '/home/user/.velloc/CLAUDE.md': 'old user velloc fallback',
      '/home/user/.velloc/shared-workspace/agent/AGENTS.md': 'agent project',
    }
    const { fs } = makeWritableFs(files)
    installProcessFs(fs)
    const loaded = await gatherInstructionDocs({
      cwd: '/home/user/.velloc/shared-workspace/agent',
      runtimeConfig: makeRuntimeConfig(env),
    })
    expect(loaded.map(f => f.content)).toEqual(['user fallback', 'agent project'])

    const discovered = await discoverInstructionFiles({
      cwd: '/home/user/.velloc/shared-workspace/agent',
      homeDir: '/home/user',
      fs,
    })
    expect(discovered.map(f => f.path)).toEqual([
      '/home/user/.claude/CLAUDE.md',
      '/home/user/.velloc/shared-workspace/agent/AGENTS.md',
    ])
  })

  it('the Settings editor resolves to the legacy user file only while it is the one loaded', async () => {
    const { fs } = makeWritableFs({ '/home/user/.velloc/VELLOC.md': 'old user' })
    expect(await resolveUserInstructionPath(fs, '/home/user')).toBe(
      '/home/user/.velloc/VELLOC.md',
    )
    const { fs: both } = makeWritableFs({
      '/home/user/.velloc/VELLOC.md': 'old user',
      '/home/user/.claude/CLAUDE.md': 'fallback user',
    })
    expect(await resolveUserInstructionPath(both, '/home/user')).toBe(
      '/home/user/.claude/CLAUDE.md',
    )
  })

  // Data-loss guard: an AGENTS.md that EXISTS but cannot be read right now
  // (locked file / perms / bridge timeout) holds its slot — the CLAUDE.md
  // beside it must not stand in, or the prompt would silently carry the
  // other file's (possibly stale) text.
  it.each([
    ['EACCES', () => Object.assign(new Error('EACCES'), { code: 'EACCES' })],
    ['bridge_timeout', () =>
      Object.assign(new Error('bridge_timeout: Bridge request timed out'), {
        bridgeCode: 'bridge_timeout',
      })],
  ])('an unreadable AGENTS.md (%s) does not let CLAUDE.md stand in', async (_name, makeError) => {
    const { fs } = makeWritableFs({
      '/home/user/project/AGENTS.md': 'edited agents',
      '/home/user/project/CLAUDE.md': 'stale fallback',
    })
    const agentsPath = '/home/user/project/AGENTS.md'
    const realReadFile = fs.readFile.bind(fs)
    ;(fs as { readFile: RuntimeFs['readFile'] }).readFile = (async (
      path: string,
      options: { encoding: string },
    ) => {
      if (path === agentsPath) throw makeError()
      return realReadFile(path, options)
    }) as RuntimeFs['readFile']
    installProcessFs(fs)

    const result = await gatherInstructionDocs({
      cwd: '/home/user/project',
      runtimeConfig: makeRuntimeConfig(env),
    })
    expect(result.map(f => f.content).join('\n')).not.toContain('stale fallback')
  })
})

// ============================================================================
// formatMemoryFilesForPrompt
// ============================================================================

describe('formatMemoryFilesForPrompt', () => {
  it('returns empty string for empty input', () => {
    expect(formatMemoryFilesForPrompt([])).toBe('')
  })

  it('prepends the instruction header and labels each file', () => {
    const formatted = formatMemoryFilesForPrompt([
      {
        path: '/p/CLAUDE.md',
        type: 'Project',
        content: 'rule one',
      },
    ])
    expect(formatted).toContain(INSTRUCTION_BLOCK_PREAMBLE)
    expect(formatted).toContain('Contents of /p/CLAUDE.md')
    expect(formatted).toContain('rule one')
  })
})

// ============================================================================
// getConditionalRulesForPath — per-file-read conditional (paths:) rules
// ============================================================================

describe('getConditionalRulesForPath', () => {
  const rc = makeRuntimeConfig({ HOME: '/home/user' })

  it('returns a project rule whose glob matches the read path', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/.velloc/rules/style.md':
          '---\npaths: src/**\n---\nstyle rule body',
      }),
    )
    const result = await getConditionalRulesForPath(
      '/home/user/project/src/a.ts',
      { projectRoot: '/home/user/project', homeDir: '/home/user', runtimeConfig: rc },
    )
    expect(result.map(r => r.path)).toEqual([
      '/home/user/project/.velloc/rules/style.md',
    ])
    expect(result[0]?.content.trim()).toBe('style rule body')
  })

  it('does NOT return the rule when the read path is outside its glob', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/.velloc/rules/style.md':
          '---\npaths: src/**\n---\nstyle rule body',
      }),
    )
    const result = await getConditionalRulesForPath(
      '/home/user/project/docs/readme.md',
      { projectRoot: '/home/user/project', homeDir: '/home/user', runtimeConfig: rc },
    )
    expect(result).toEqual([])
  })

  it('under a read boundary, skips user-tier rules and rules above the root', async () => {
    installProcessFs(
      makeFs({
        '/home/user/.velloc/rules/user.md': '---\npaths: **/*.ts\n---\nuser rule',
        '/home/user/project/.velloc/rules/repo.md': '---\npaths: **/*.ts\n---\nrepo rule',
        '/home/user/project/wt/.velloc/rules/wt.md': '---\npaths: src/**\n---\nwt rule',
      }),
    )
    const result = await getConditionalRulesForPath(
      '/home/user/project/wt/src/a.ts',
      {
        // A worktree-isolated untrusted child: projectRoot is the canonical
        // repo (outside its root), the read root is the worktree.
        projectRoot: '/home/user/project',
        homeDir: '/home/user',
        readRoot: '/home/user/project/wt',
        runtimeConfig: rc,
      },
    )
    expect(result.map(r => r.path)).toEqual([
      '/home/user/project/wt/.velloc/rules/wt.md',
    ])
  })

  it('ignores always-on rules (no paths:) — those load eagerly instead', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/.claude/rules/always.md': 'always-on body',
      }),
    )
    const result = await getConditionalRulesForPath(
      '/home/user/project/src/a.ts',
      { projectRoot: '/home/user/project', homeDir: '/home/user', runtimeConfig: rc },
    )
    expect(result).toEqual([])
  })

  it('matches a nested rule against a deeper read path (per-dir baseDir)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/src/.velloc/rules/ts.md':
          '---\npaths: "*.ts"\n---\nts rule',
      }),
    )
    const result = await getConditionalRulesForPath(
      '/home/user/project/src/a.ts',
      { projectRoot: '/home/user/project', homeDir: '/home/user', runtimeConfig: rc },
    )
    expect(result.map(r => r.path)).toEqual([
      '/home/user/project/src/.velloc/rules/ts.md',
    ])
  })

  // C7 regression (conditional half): when a `paths:`-scoped rule matches the
  // read path, its @include child rides along — even though the child has no
  // globs of its own. Extra-first key order (NTFS name-sort) proves the fix is
  // order-independent (the order that breaks a naive per-file/per-chain filter).
  it('injects the @include child of a matching paths:-scoped rule (C7)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/.velloc/rules/secure-extra.md':
          'Extra security guidance. SENTINEL_INCLUDE_Y.',
        '/home/user/project/.velloc/rules/secure.md':
          '---\npaths: src/secure/**\n---\nReview strictly.\n@./secure-extra.md\n',
      }),
    )
    const result = await getConditionalRulesForPath(
      '/home/user/project/src/secure/auth.ts',
      { projectRoot: '/home/user/project', homeDir: '/home/user', runtimeConfig: rc },
    )
    const paths = result.map(r => r.path)
    expect(paths).toContain('/home/user/project/.velloc/rules/secure.md')
    expect(paths).toContain('/home/user/project/.velloc/rules/secure-extra.md')
    // The included body travels with the matched rule.
    expect(result.map(r => r.content).join('\n')).toContain(
      'SENTINEL_INCLUDE_Y',
    )
  })

  // C7 regression: the @include child must NOT be injected when its scoped root
  // does NOT match the read path (the child has no globs, so it must inherit the
  // root's non-match — not fall through as always-on).
  it('does NOT inject the @include child when the scoped root does not match (C7)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/.velloc/rules/secure-extra.md':
          'Extra security guidance. SENTINEL_INCLUDE_Z.',
        '/home/user/project/.velloc/rules/secure.md':
          '---\npaths: src/secure/**\n---\nReview strictly.\n@./secure-extra.md\n',
      }),
    )
    const result = await getConditionalRulesForPath(
      '/home/user/project/docs/readme.md',
      { projectRoot: '/home/user/project', homeDir: '/home/user', runtimeConfig: rc },
    )
    expect(result).toEqual([])
  })
})

// ============================================================================
// discoverInstructionFiles — read-only listing for Settings → Memory
// ============================================================================

describe('discoverInstructionFiles', () => {
  it('reports existing instruction files per tier', async () => {
    installProcessFs(
      makeFs({
        '/home/user/.velloc/AGENTS.md': 'user agents',
        // No AGENTS.md beside it → the CLAUDE.md is the project's file.
        '/home/user/project/CLAUDE.md': 'project fallback',
        '/home/user/project/.velloc/rules/style.md':
          '---\npaths: src/**\n---\nrule body',
        '/home/user/project/CLAUDE.local.md': 'local',
        // AutoMem (MEMORY.md) must NOT appear — that's an agent memory.
        '/home/user/project/.velloc/memory/MEMORY.md': '# index',
      }),
    )
    const result = await discoverInstructionFiles({
      cwd: '/home/user/project',
      projectRoot: '/home/user/project',
      homeDir: '/home/user',
    })
    const byTier = (tier: 'User' | 'Project' | 'Local') =>
      result.filter(r => r.tier === tier).map(r => r.path)

    expect(byTier('User')).toContain('/home/user/.velloc/AGENTS.md')
    expect(byTier('Project')).toContain('/home/user/project/CLAUDE.md')
    expect(byTier('Project')).toContain(
      '/home/user/project/.velloc/rules/style.md',
    )
    expect(byTier('Local')).toContain('/home/user/project/CLAUDE.local.md')
    // MEMORY.md is a memory, not an instruction file.
    expect(result.some(r => r.path.endsWith('MEMORY.md'))).toBe(false)
  })

  it('prefers AGENTS.md over a CLAUDE.md sibling (no duplicates)', async () => {
    installProcessFs(
      makeFs({
        '/home/user/project/AGENTS.md': 'agents',
        '/home/user/project/CLAUDE.md': 'fallback tier',
      }),
    )
    const result = await discoverInstructionFiles({
      cwd: '/home/user/project',
      projectRoot: '/home/user/project',
      homeDir: '/home/user',
    })
    const projectRoots = result
      .filter(r => r.tier === 'Project')
      .map(r => r.path)
    expect(projectRoots).toContain('/home/user/project/AGENTS.md')
    expect(projectRoots).not.toContain('/home/user/project/CLAUDE.md')
  })

  it('returns [] when nothing exists', async () => {
    installProcessFs(makeFs({}))
    const result = await discoverInstructionFiles({
      cwd: '/home/user/project',
      projectRoot: '/home/user/project',
      homeDir: '/home/user',
    })
    expect(result).toEqual([])
  })
})
