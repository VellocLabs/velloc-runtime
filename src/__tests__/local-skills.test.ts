import { renderSkillListing } from '../skillLibrary/skillListing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import {
  getConditionalSkills,
  getModelInvocableCommands,
  loadLocalPromptCommands,
} from '../skillLibrary/skillDiscovery'
import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFsEntry,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'
import { __resetBundledSkillsForTests } from '../skillLibrary/builtinSkills'
import { __resetBundledSkillsInitForTests } from '../skillLibrary/builtin/catalog'
import { E2E_THROW_SKILL_NAME } from '../skillLibrary/builtin/e2eThrow'

type FakeEntry =
  | { kind: 'file'; content: string }
  | { kind: 'dir' }

function makeDirent(name: string, kind: 'file' | 'dir'): RuntimeFsEntry {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  }
}

/**
 * Tiny in-memory fs facade. Just enough surface for `scanSkillFolder`:
 * `readdir` lists children of a path; `readFile` returns content for files
 * registered under their absolute path. Missing entries throw to match the
 * real fs behavior the loader catches.
 */
function makeFakeFs(
  tree: Record<string, FakeEntry>,
  options: { realpath?: (path: string) => Promise<string> } = {},
): RuntimeFs {
  return {
    ...unconfiguredFs,
    realpath: options.realpath,
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const seen = new Set<string>()
      const out: RuntimeFsEntry[] = []
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        const remainder = key.slice(prefix.length)
        const firstSegment = remainder.split('/')[0]!
        if (!firstSegment || seen.has(firstSegment)) continue
        seen.add(firstSegment)
        const fullChild = `${prefix}${firstSegment}`
        const entry = tree[fullChild]
        if (entry?.kind === 'dir') {
          out.push(makeDirent(firstSegment, 'dir'))
        } else if (entry?.kind === 'file') {
          out.push(makeDirent(firstSegment, 'file'))
        } else {
          // Implicit directory (only descendants exist in the map).
          out.push(makeDirent(firstSegment, 'dir'))
        }
      }
      if (out.length === 0 && !Object.keys(tree).some(k => k.startsWith(prefix))) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return out
    },
    async readFile(path: string): Promise<string> {
      const entry = tree[path]
      if (!entry || entry.kind !== 'file') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return entry.content
    },
  } as RuntimeFs
}

afterEach(() => {
  resetProcessFs()
})

describe('loadLocalPromptCommands', () => {
  beforeEach(() => {
    resetProcessFs()
  })

  it('parses allowed-tools, model, version, and argument-hint from frontmatter', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/commit': { kind: 'dir' },
      '/workspace/.velloc/skills/commit/SKILL.md': {
        kind: 'file',
        content:
          '---\n'
          + 'description: Make a commit\n'
          + 'allowed-tools: Bash, Read, Write\n'
          + 'model: claude-sonnet-4-6\n'
          + 'version: 1.2.3\n'
          + 'argument-hint: <message>\n'
          + 'arguments: message\n'
          + '---\n'
          + 'Run the commit with $message.\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })

    expect(commands).toHaveLength(1)
    const skill = commands[0]!
    expect(skill.name).toBe('commit')
    expect(skill.description).toBe('Make a commit')
    expect(skill.permittedTools).toEqual(['Bash', 'Read', 'Write'])
    expect(skill.model).toBe('claude-sonnet-4-6')
    expect(skill.version).toBe('1.2.3')
    expect(skill.argumentHint).toBe('<message>')
    expect(skill.argNames).toEqual(['message'])
    expect(skill.baseDir).toBe('/workspace/.velloc/skills/commit')
    expect(skill.content).toContain('$message')
  })

  it('loads a `session-types` skill only into the listed session types', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/team-only.md': {
        kind: 'file',
        content:
          '---\n'
          + 'description: Team sessions only\n'
          + 'session-types: team, chat\n'
          + '---\n'
          + 'Only here in a team or chat session.\n',
      },
      '/workspace/.velloc/skills/everywhere.md': {
        kind: 'file',
        content: '---\ndescription: No restriction\n---\nAlways here.\n',
      },
    })
    installProcessFs(fs)
    const load = (templateType?: string) =>
      loadLocalPromptCommands({
        cwd: '/workspace',
        runtimeConfig: new BrowserRuntimeConfig(),
        includeBundled: false,
        templateType,
      })

    // Parsed as an OR-list, trimmed.
    const inTeam = await load('team')
    expect(inTeam.map(c => c.name).sort()).toEqual(['everywhere', 'team-only'])
    // `session-types` narrows BOTH surfaces — it always did, and the two
    // authored gates carry it now.
    expect(inTeam.find(c => c.name === 'team-only')?.userInvocation).toEqual([
      'team',
      'chat',
    ])
    expect(inTeam.find(c => c.name === 'team-only')?.modelInvocation).toEqual([
      'team',
      'chat',
    ])
    expect(inTeam.find(c => c.name === 'everywhere')?.userInvocation).toBeUndefined()
    expect(inTeam.find(c => c.name === 'everywhere')?.modelInvocation).toBeUndefined()
    // Any listed type qualifies…
    expect((await load('chat')).map(c => c.name)).toContain('team-only')
    // …and an unlisted one drops the skill from the registry entirely —
    // there is nothing left for the picker, slash dispatch or the model.
    expect((await load('code')).map(c => c.name)).toEqual(['everywhere'])
    // No known session type → no filtering (over-include).
    expect((await load(undefined)).map(c => c.name).sort()).toEqual([
      'everywhere',
      'team-only',
    ])
  })

  it('applies the template `skills:` allowlist before the name dedup (a denied skill cannot shadow an allowed one)', async () => {
    // `user:` outranks `project:` in the name dedup. Before the allowlist ran
    // inside the loader, the user `debug` won the dedup, the runtime's
    // allowlist then denied it, and the allowed `project:debug` was already
    // gone — the session had neither.
    const fs = makeFakeFs({
      '/home/u/.velloc/skills': { kind: 'dir' },
      '/home/u/.velloc/skills/debug.md': {
        kind: 'file',
        content: '---\ndescription: User debug\n---\nuser body\n',
      },
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/debug.md': {
        kind: 'file',
        content: '---\ndescription: Project debug\n---\nproject body\n',
      },
    })
    installProcessFs(fs)
    const denied: string[] = []
    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      homeDir: '/home/u',
      runtimeConfig: new BrowserRuntimeConfig(),
      includeBundled: false,
      templateConfig: { type: 'code', skills: ['project:debug'] },
      onSessionTypeDenied: name => denied.push(name),
    })
    expect(commands.map(c => `${c.source}:${c.name}`)).toEqual(['project:debug'])
    // `user:debug` was dropped, but `/debug` still dispatches (to the project
    // one) — so the NAME is not denied, and must not be reported as such: the
    // dispatch surfaces would otherwise tell the user a working skill is
    // "not available in this session type".
    expect(denied).toEqual([])

    // No allowlist → the ordinary first-wins dedup (user outranks project).
    const unfiltered = await loadLocalPromptCommands({
      cwd: '/workspace',
      homeDir: '/home/u',
      runtimeConfig: new BrowserRuntimeConfig(),
      includeBundled: false,
    })
    expect(unfiltered.map(c => `${c.source}:${c.name}`)).toEqual(['user:debug'])
  })

  it('reports a denied name once, and only when no same-named skill survives', async () => {
    const fs = makeFakeFs({
      '/home/u/.velloc/skills': { kind: 'dir' },
      '/home/u/.velloc/skills/review.md': {
        kind: 'file',
        content: '---\ndescription: User review\nsession-types: agent\n---\nuser body\n',
      },
      '/home/u/.velloc/skills/notes.md': {
        kind: 'file',
        content: '---\ndescription: User notes\nsession-types: agent\n---\nuser body\n',
      },
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/review.md': {
        kind: 'file',
        content: '---\ndescription: Project review\n---\nproject body\n',
      },
      '/workspace/.velloc/skills/notes.md': {
        kind: 'file',
        content: '---\ndescription: Project notes\nsession-types: agent\n---\nproject body\n',
      },
    })
    installProcessFs(fs)
    const denied: string[] = []
    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      homeDir: '/home/u',
      runtimeConfig: new BrowserRuntimeConfig(),
      includeBundled: false,
      templateType: 'code',
      onSessionTypeDenied: name => denied.push(name),
    })
    // `review`: the user copy is agent-only, the project copy is open → the
    // session HAS a `/review`, so nothing to explain. `notes`: both copies are
    // agent-only → denied, reported ONCE (not once per dropped source).
    expect(commands.map(c => `${c.source}:${c.name}`)).toEqual(['project:review'])
    expect(denied).toEqual(['notes'])
  })

  it('warns when a `session-types` entry names no registered template', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/typo.md': {
        kind: 'file',
        content: '---\ndescription: x\nsession-types: safe-code, team\n---\nbody\n',
      },
    })
    installProcessFs(fs)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await loadLocalPromptCommands({
        cwd: '/workspace',
        runtimeConfig: new BrowserRuntimeConfig(),
        includeBundled: false,
        templateType: 'code',
      })
      const messages = warn.mock.calls.map(call => String(call[0]))
      expect(messages.some(m => m.includes('typo') && m.includes('safe-code'))).toBe(true)
      // The registered id in the same list is not reported.
      expect(messages.some(m => m.includes(': team'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('accepts `session-types` as a YAML list and the camelCase alias', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/listed.md': {
        kind: 'file',
        content:
          '---\ndescription: x\nsession-types:\n  - team\n  - " code "\n---\nbody\n',
      },
      '/workspace/.velloc/skills/camel.md': {
        kind: 'file',
        content: '---\ndescription: x\nsessionTypes: chat\n---\nbody\n',
      },
      '/workspace/.velloc/skills/blank.md': {
        kind: 'file',
        content: '---\ndescription: x\nsession-types: " , "\n---\nbody\n',
      },
    })
    installProcessFs(fs)
    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      includeBundled: false,
    })
    const byName = new Map(commands.map(c => [c.name, c]))
    expect(byName.get('listed')?.userInvocation).toEqual(['team', 'code'])
    expect(byName.get('camel')?.userInvocation).toEqual(['chat'])
    // Blank entries collapse to "no restriction" — NOT to `[]`, which is
    // the DISABLED end of the tri-state. A skill carrying a
    // blank `session-types:` must stay invocable, not answer to nobody.
    expect(byName.get('blank')?.userInvocation).toBeUndefined()
    expect(byName.get('blank')?.modelInvocation).toBeUndefined()
  })

  it('parses context/agent/effort frontmatter for forked skills', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/research': { kind: 'dir' },
      '/workspace/.velloc/skills/research/SKILL.md': {
        kind: 'file',
        content:
          '---\n'
          + 'description: Deep research\n'
          + 'context: fork\n'
          + 'agent: Explore\n'
          + 'effort: high\n'
          + '---\n'
          + 'Investigate the question.\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })

    expect(commands).toHaveLength(1)
    const skill = commands[0]!
    expect(skill.context).toBe('fork')
    expect(skill.agent).toBe('Explore')
    expect(skill.effort).toBe('high')
  })

  it('leaves context undefined (inline) for unrecognized values', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/inline-skill': { kind: 'dir' },
      '/workspace/.velloc/skills/inline-skill/SKILL.md': {
        kind: 'file',
        content:
          '---\n'
          + 'description: A plain skill\n'
          + 'context: weird\n'
          + '---\n'
          + 'Do the thing.\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })

    expect(commands[0]!.context).toBeUndefined()
  })

  it('parses array-style allowed-tools frontmatter', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/demo': { kind: 'dir' },
      '/workspace/.velloc/skills/demo/SKILL.md': {
        kind: 'file',
        content:
          '---\n'
          + 'description: Demo\n'
          + "allowed-tools: [Bash, \"Read\", 'Write']\n"
          + '---\n'
          + 'body\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })

    expect(commands[0]!.permittedTools).toEqual(['Bash', 'Read', 'Write'])
  })

  it('strips wrapping quotes from frontmatter string values', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/demo': { kind: 'dir' },
      '/workspace/.velloc/skills/demo/SKILL.md': {
        kind: 'file',
        content:
          '---\n'
          + 'description: "Make a commit"\n'
          + "model: 'claude-sonnet-4-6'\n"
          + '---\n'
          + 'body\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })
    expect(commands[0]!.description).toBe('Make a commit')
    expect(commands[0]!.model).toBe('claude-sonnet-4-6')
  })

  it('partitions path-gated skills out of the model-visible listing', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/always': { kind: 'dir' },
      '/workspace/.velloc/skills/always/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: Always on\n---\nbody\n',
      },
      '/workspace/.velloc/skills/gated': { kind: 'dir' },
      '/workspace/.velloc/skills/gated/SKILL.md': {
        kind: 'file',
        content:
          '---\n'
          + 'description: Only for docs\n'
          + 'paths:\n'
          + '  - docs/**\n'
          + '  - src/**\n'
          + '---\n'
          + 'body\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })

    expect(commands.map(c => c.name)).toEqual(['always'])

    const conditional = getConditionalSkills()
    expect(conditional.map(c => c.name)).toEqual(['gated'])
    // The trailing `/**` is stripped (the `ignore` library treats
    // `docs` as matching `docs` and everything under it).
    expect(conditional[0]!.paths).toEqual(['docs', 'src'])
  })

  it('parses CRLF frontmatter delimiters', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/crlf': { kind: 'dir' },
      '/workspace/.velloc/skills/crlf/SKILL.md': {
        kind: 'file',
        content: '---\r\ndescription: CRLF skill\r\n---\r\nbody\r\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })

    expect(commands[0]!.description).toBe('CRLF skill')
    expect(commands[0]!.content.trim()).toBe('body')
  })

  it('ignores YAML comments in frontmatter values', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/cmt': { kind: 'dir' },
      '/workspace/.velloc/skills/cmt/SKILL.md': {
        kind: 'file',
        content:
          '---\n'
          + 'description: Demo\n'
          + 'model: opus # the fast one\n'
          + '---\n'
          + 'body\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })

    expect(commands[0]!.model).toBe('opus')
  })

  it('reads disableModelInvocation strictly: `true` hides a skill from the model, `yes` does not', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/yes-visible': { kind: 'dir' },
      '/workspace/.velloc/skills/yes-visible/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: Yes is not a boolean\ndisableModelInvocation: yes\n---\nbody\n',
      },
      '/workspace/.velloc/skills/true-hidden': { kind: 'dir' },
      '/workspace/.velloc/skills/true-hidden/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: Truly disabled\ndisableModelInvocation: true\n---\nbody\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      includeBundled: false,
    })

    const modelVisible = getModelInvocableCommands(commands).map(c => c.name)
    expect(modelVisible).toContain('yes-visible')
    expect(modelVisible).not.toContain('true-hidden')
  })

  it('a skill with malformed frontmatter does not stop its siblings from loading', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/good-helper': { kind: 'dir' },
      '/workspace/.velloc/skills/good-helper/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: A perfectly good skill\n---\nbody\n',
      },
      '/workspace/.velloc/skills/broken-helper': { kind: 'dir' },
      '/workspace/.velloc/skills/broken-helper/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: "unterminated string that never closes\n---\nbody\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      includeBundled: false,
    })

    const good = commands.find(c => c.name === 'good-helper')
    expect(good?.description).toBe('A perfectly good skill')
    expect(getModelInvocableCommands(commands).map(c => c.name)).toContain('good-helper')
  })

  it('honors kebab boolean keys (user-invocable / disable-model-invocation)', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/modelonly': { kind: 'dir' },
      '/workspace/.velloc/skills/modelonly/SKILL.md': {
        kind: 'file',
        content:
          '---\n'
          + 'description: Model only\n'
          + 'user-invocable: false\n'
          + 'disable-model-invocation: true\n'
          + '---\n'
          + 'body\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })

    expect(commands[0]!.userCallable).toBe(false)
    expect(commands[0]!.hiddenFromModel).toBe(true)
  })

  it('parses nested hooks frontmatter into HookTableByEvent', async () => {
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/hooked': { kind: 'dir' },
      '/workspace/.velloc/skills/hooked/SKILL.md': {
        kind: 'file',
        content:
          '---\n'
          + 'description: Has hooks\n'
          + 'hooks:\n'
          + '  PreToolUse:\n'
          + '    - matcher: Bash\n'
          + '      hooks:\n'
          + '        - type: command\n'
          + '          command: echo hi\n'
          + '---\n'
          + 'body\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })

    const skill = commands[0]!
    expect(skill.hooks?.PreToolUse).toHaveLength(1)
    expect(skill.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash')
    expect(skill.hooks?.PreToolUse?.[0]?.hooks[0]).toMatchObject({
      type: 'command',
      command: 'echo hi',
    })
  })

  it('uses fs.realpath for dedup when the bridge exposes it (symlink case)', async () => {
    // Two distinct on-disk paths that the fake realpath collapses onto a
    // single canonical file — simulates a symlink pointing from one
    // skills dir at a file inside another.
    const canonical = '/workspace/.velloc/skills/shared/SKILL.md'
    const realpathCalls: string[] = []
    const fs = makeFakeFs(
      {
        '/workspace/.velloc/skills': { kind: 'dir' },
        '/workspace/.velloc/skills/shared': { kind: 'dir' },
        [canonical]: {
          kind: 'file',
          content: '---\ndescription: From canonical\n---\nbody\n',
        },
        // Symlinked surface dir — same SKILL.md, different surface path.
        '/workspace/.bundled/shared': { kind: 'dir' },
        '/workspace/.bundled/shared/SKILL.md': {
          kind: 'file',
          content: '---\ndescription: From bundled alias\n---\nbody\n',
        },
      },
      {
        async realpath(path: string) {
          realpathCalls.push(path)
          if (path === '/workspace/.bundled/shared/SKILL.md') {
            return canonical
          }
          return path
        },
      },
    )
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({
        env: { NEXUS_BUNDLED_SKILLS_DIR: '/workspace/.bundled' },
      }),
      includeBundled: false,
    })

    // Realpath consulted for both surface paths.
    expect(realpathCalls).toContain(canonical)
    expect(realpathCalls).toContain('/workspace/.bundled/shared/SKILL.md')

    // Only one `shared` skill survives — the bundled source enumerates
    // first, so its (aliased) entry wins over the project copy.
    const shared = commands.filter(c => c.name === 'shared')
    expect(shared).toHaveLength(1)
    expect(shared[0]!.description).toBe('From bundled alias')
  })

  it('falls back to path normalization when fs.realpath throws', async () => {
    const fs = makeFakeFs(
      {
        '/workspace/.velloc/skills': { kind: 'dir' },
        '/workspace/.velloc/skills/demo': { kind: 'dir' },
        '/workspace/.velloc/skills/demo/SKILL.md': {
          kind: 'file',
          content: '---\ndescription: Demo\n---\nbody\n',
        },
      },
      {
        async realpath() {
          throw new Error('FS_ERROR: simulated realpath failure')
        },
      },
    )
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig(),
      // Exclude programmatically-registered bundled skills so these tests
      // can assert on the exact set of disk-discovered skills they author.
      includeBundled: false,
    })
    // The skill is still returned — realpath failure must not drop entries.
    expect(commands.map(c => c.name)).toEqual(['demo'])
  })

  it('collapses entries that load from the same canonical path under multiple sources', async () => {
    // Point NEXUS_BUNDLED_SKILLS_DIR at the same directory the project
    // walk inspects. Both sources then produce an entry for `shared/SKILL.md`
    // with the same normalized path; path-based dedup keeps the first (the
    // bundled source enumerates first), name dedup is then a no-op for it.
    const fs = makeFakeFs({
      '/workspace/.velloc/skills': { kind: 'dir' },
      '/workspace/.velloc/skills/shared': { kind: 'dir' },
      '/workspace/.velloc/skills/shared/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: Shared skill\n---\nbody\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({
        env: {
          NEXUS_BUNDLED_SKILLS_DIR: '/workspace/.velloc/skills',
        },
      }),
      includeBundled: false,
    })

    expect(commands).toHaveLength(1)
    expect(commands[0]!.source).toBe('bundled')
    expect(commands[0]!.loadedFrom).toBe('bundled')
  })

  it('also walks ~/.claude/skills/ for skills authored in that layout', async () => {
    const fs = makeFakeFs({
      // The .velloc home stays empty so we can prove the legacy path is
      // walked on its own. (The two-source merge case is tested below.)
      '/home/user/.claude/skills': { kind: 'dir' },
      '/home/user/.claude/skills/legacy-helper': { kind: 'dir' },
      '/home/user/.claude/skills/legacy-helper/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: From the other agent home\n---\nbody\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({
        env: { HOME: '/home/user' },
      }),
      includeBundled: false,
    })

    expect(commands.map(c => c.name)).toEqual(['legacy-helper'])
    expect(commands[0]!.source).toBe('user')
    expect(commands[0]!.path).toBe(
      '/home/user/.claude/skills/legacy-helper/SKILL.md',
    )
  })

  it('merges skills from ~/.velloc/skills/ and ~/.claude/skills/; .velloc wins name collisions', async () => {
    const fs = makeFakeFs({
      '/home/user/.velloc/skills': { kind: 'dir' },
      '/home/user/.velloc/skills/shared': { kind: 'dir' },
      '/home/user/.velloc/skills/shared/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: From .velloc\n---\nbody\n',
      },
      '/home/user/.velloc/skills/only-nexus': { kind: 'dir' },
      '/home/user/.velloc/skills/only-nexus/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: Only-nexus skill\n---\nbody\n',
      },
      '/home/user/.claude/skills': { kind: 'dir' },
      '/home/user/.claude/skills/shared': { kind: 'dir' },
      '/home/user/.claude/skills/shared/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: Should be shadowed\n---\nbody\n',
      },
      '/home/user/.claude/skills/only-claude': { kind: 'dir' },
      '/home/user/.claude/skills/only-claude/SKILL.md': {
        kind: 'file',
        content: '---\ndescription: Only-claude skill\n---\nbody\n',
      },
    })
    installProcessFs(fs)

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({
        env: { HOME: '/home/user' },
      }),
      includeBundled: false,
    })

    // All three skills surface (union of both homes).
    expect(commands.map(c => c.name).sort()).toEqual([
      'only-claude',
      'only-nexus',
      'shared',
    ])

    // The .velloc copy wins for `shared` — first-wins name dedup.
    const shared = commands.find(c => c.name === 'shared')!
    expect(shared.description).toBe('From .velloc')
    expect(shared.path).toBe('/home/user/.velloc/skills/shared/SKILL.md')
  })
})

describe('renderSkillListing', () => {
  it('truncates entries that exceed the per-entry budget', () => {
    const longWhenToUse = 'when '.repeat(60).trim()
    const listing = renderSkillListing([
      {
        type: 'prompt',
        name: 'verbose',
        description: 'Tiny description',
        useWhen: longWhenToUse,
        content: 'body',
        path: '/skills/verbose/SKILL.md',
        loadedFrom: 'skills',
        source: 'project',
      },
    ])
    expect(listing.endsWith('…')).toBe(true)
    // `- <name>: <truncated-details>` — name + 4 framing chars + ≤250 details.
    expect(listing.length).toBeLessThanOrEqual('- verbose: '.length + 250)
  })
})

// The listing's total-budget logic. The per-entry
// cap above still applies; this exercises the budget that fires when N entries
// would exceed the model-facing total cap.
describe('renderSkillListing — total budget', () => {
  function makeSkill(
    name: string,
    description: string,
    source: 'project' | 'plugin' | 'user' | 'bundled' = 'project',
  ): ChromiumCommandMetadata {
    return {
      type: 'prompt',
      name,
      description,
      content: 'body',
      path: `/skills/${name}/SKILL.md`,
      loadedFrom: source === 'bundled' ? 'bundled' : 'skills',
      source,
    } as ChromiumCommandMetadata
  }

  it('returns an empty string for an empty command list', () => {
    expect(renderSkillListing([])).toBe('')
  })

  it('keeps full descriptions when the total fits the default 8k budget', () => {
    const commands = [
      makeSkill('a', 'first skill description'),
      makeSkill('b', 'second skill description'),
    ]
    const out = renderSkillListing(commands)
    expect(out).toBe(
      '- a: first skill description\n- b: second skill description',
    )
  })

  it('trims non-bundled descriptions to fit the budget', () => {
    // Make 60 entries whose full-description joined length blows a tiny budget.
    const commands = Array.from({ length: 60 }, (_, i) =>
      makeSkill(`skill${i.toString().padStart(2, '0')}`, 'X'.repeat(120)),
    )
    // Tight budget: 2 KB. Per-entry overhead ~14 chars × 60 = 840; available
    // for descriptions ≈ 1160 → ~19 chars each — just under MIN_DESC_LENGTH
    // (20), so this would actually hit the names-only branch. Use 3 KB so we
    // land in the trim branch instead.
    const out = renderSkillListing(commands, /* contextWindowTokens */ 75_000)
    expect(out.length).toBeLessThanOrEqual(3_000)
    // Each line still carries `- name: <some-desc>`; non-bundled trimmed with …
    expect(out.split('\n')).toHaveLength(60)
    expect(out).toContain('- skill00:')
    expect(out).toContain('- skill59:')
    expect(out).toContain('…')
  })

  it('collapses non-bundled entries to names-only when the budget is too tight', () => {
    const commands = Array.from({ length: 100 }, (_, i) =>
      makeSkill(`skill${i.toString().padStart(2, '0')}`, 'X'.repeat(200)),
    )
    // 50k context window → 2k char budget. 100 entries × (~11 chars framing)
    // = 1100 overhead → ~9 chars per desc available — below MIN_DESC_LENGTH
    // (20), so the non-bundled entries collapse to names-only.
    const out = renderSkillListing(commands, 50_000)
    // names-only branch: every line is `- name` (no colon).
    for (const line of out.split('\n')) {
      expect(line).toMatch(/^- skill\d{2}$/)
    }
  })

  it('never truncates bundled skills — they stay full while others trim', () => {
    const bundled = makeSkill(
      'bundled-one',
      'B'.repeat(200), // hits per-entry cap of 250, but stays full thereafter
      'bundled',
    )
    const others = Array.from({ length: 80 }, (_, i) =>
      makeSkill(`other${i.toString().padStart(2, '0')}`, 'X'.repeat(200)),
    )
    const out = renderSkillListing([bundled, ...others])
    // The bundled line still carries (most of) its full description.
    const bundledLine = out.split('\n').find(l => l.startsWith('- bundled-one:'))!
    expect(bundledLine.length).toBeGreaterThanOrEqual('- bundled-one: '.length + 100)
    // Non-bundled entries either trim (…) or collapse to names-only — but the
    // bundled one keeps a substantial description either way.
  })

  it('scales the budget up with the context window (1% of context × 4 chars)', () => {
    // 60 fat entries that wouldn't fit the 8k default but easily fit a
    // 1M-context-window budget (1% × 4 = 40k chars).
    const commands = Array.from({ length: 60 }, (_, i) =>
      makeSkill(`skill${i.toString().padStart(2, '0')}`, 'X'.repeat(200)),
    )
    // Default 8k → forces trim.
    const trimmed = renderSkillListing(commands)
    expect(trimmed).toContain('…')
    // 1M context window → 40k char budget → easily fits full.
    const full = renderSkillListing(commands, 1_000_000)
    expect(full).not.toContain('…')
    // Each line still has the full 200-char description.
    expect(full.split('\n').every(line => line.length > 200)).toBe(true)
  })
})

describe('bundled-skill modelInvocation list — gates the model surface, not the user /name surface', () => {
  beforeEach(() => {
    resetProcessFs()
  })

  /** Registers a fixture of 4 bundled skills with mixed MODEL gates:
   *    - `untyped`        no gate → every session type
   *    - `agent-only`     modelInvocation: 'agent'
   *    - `code-only`      modelInvocation: 'code'
   *    - `agent-or-code`  modelInvocation: ['agent', 'code']
   *  None of them narrows `userInvocation`, so `/name` stays open in every
   *  session type — which is the asymmetry these cases pin.
   */
  async function registerTypeFixture() {
    const {
      __resetBundledSkillsForTests,
      addStockSkill,
    } = await import('../skillLibrary/builtinSkills')
    const { __resetBundledSkillsInitForTests } = await import('../skillLibrary/builtin/catalog')
    __resetBundledSkillsForTests()
    __resetBundledSkillsInitForTests()
    addStockSkill({
      name: 'untyped',
      description: '',
      content: 'untyped body',
    })
    addStockSkill({
      name: 'agent-only',
      description: '',
      content: 'agent body',
      modelInvocation: 'agent',
    })
    addStockSkill({
      name: 'code-only',
      description: '',
      content: 'code body',
      modelInvocation: 'code',
    })
    addStockSkill({
      name: 'agent-or-code',
      description: '',
      content: 'agent or code body',
      modelInvocation: ['agent', 'code'],
    })
  }

  async function loadWithType(templateType: string | undefined) {
    // No disk skills — only bundled. Use the dedicated subdir setup so
    // the fs facade returns ENOENT for every dir lookup (no fixture
    // tree configured), and `includeBundled` stays true to exercise the
    // bundled path.
    installProcessFs(makeFakeFs({}))
    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({
        env: { HOME: '/home/u' },
      }),
      ...(templateType !== undefined ? { templateType } : {}),
    })
    return commands.map(c => c.name).sort()
  }

  /** Names the MODEL may auto-invoke for `templateType` — the merged list
   *  filtered by `getModelInvocableCommands`, which reads the boolean the
   *  loader already resolved from `modelInvocation` for this session type. */
  async function modelNames(templateType: string | undefined) {
    installProcessFs(makeFakeFs({}))
    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/u' } }),
      ...(templateType !== undefined ? { templateType } : {}),
    })
    return getModelInvocableCommands(commands)
      .map(c => c.name)
      .sort()
  }

  it('model surface (type=agent) keeps untyped, agent-only, agent-or-code; drops code-only — user /name keeps ALL', async () => {
    await registerTypeFixture()
    // Model surface: the `modelInvocation` list applies.
    const model = await modelNames('agent')
    expect(model).toContain('untyped')
    expect(model).toContain('agent-only')
    expect(model).toContain('agent-or-code')
    expect(model).not.toContain('code-only')
    // User /name surface: a MODEL gate does not touch it — even the
    // code-only skill is invocable in an agent session.
    const user = await loadWithType('agent')
    expect(user).toContain('code-only')
  })

  it('model surface (type=chat) keeps only untyped (every type-restricted skill drops) — user /name keeps ALL', async () => {
    await registerTypeFixture()
    const model = await modelNames('chat')
    expect(model).toContain('untyped')
    expect(model).not.toContain('agent-only')
    expect(model).not.toContain('code-only')
    expect(model).not.toContain('agent-or-code')
    // User /name surface keeps all four despite the chat session.
    const user = await loadWithType('chat')
    expect(user).toContain('agent-only')
    expect(user).toContain('code-only')
    expect(user).toContain('agent-or-code')
  })

  it('model surface (type=code) keeps untyped, code-only, agent-or-code; drops agent-only — user /name keeps ALL', async () => {
    await registerTypeFixture()
    const model = await modelNames('code')
    expect(model).toContain('untyped')
    expect(model).toContain('code-only')
    expect(model).toContain('agent-or-code')
    expect(model).not.toContain('agent-only')
    const user = await loadWithType('code')
    expect(user).toContain('agent-only')
  })

  it('omitting templateType keeps EVERYTHING (over-include — no silent hide)', async () => {
    await registerTypeFixture()
    const names = await loadWithType(undefined)
    expect(names).toContain('untyped')
    expect(names).toContain('agent-only')
    expect(names).toContain('code-only')
    expect(names).toContain('agent-or-code')
  })
})

describe('invocation gates — the tri-state both surfaces share', () => {
  beforeEach(() => {
    resetProcessFs()
  })

  async function registerGateFixture() {
    const {
      __resetBundledSkillsForTests,
      addStockSkill,
    } = await import('../skillLibrary/builtinSkills')
    const { __resetBundledSkillsInitForTests } = await import('../skillLibrary/builtin/catalog')
    __resetBundledSkillsForTests()
    __resetBundledSkillsInitForTests()
    // Narrowed to `team` on BOTH surfaces — the retired `sessionTypes`
    // behaviour: absent from any other session type entirely.
    addStockSkill({
      name: 'team-narrowed',
      description: '',
      content: 'body',
      modelInvocation: ['team'],
      userInvocation: ['team'],
    })
    // `[]` shuts ONE surface and keeps the skill present everywhere.
    addStockSkill({
      name: 'slash-only',
      description: '',
      content: 'body',
      modelInvocation: [],
    })
    addStockSkill({
      name: 'model-only',
      description: '',
      content: 'body',
      userInvocation: [],
    })
    // The explicit wildcard means the same as writing nothing at all.
    addStockSkill({
      name: 'wild',
      description: '',
      content: 'body',
      modelInvocation: '*',
      userInvocation: ['*'],
    })
    // One surface narrowed, the other left open.
    addStockSkill({
      name: 'model-in-code-only',
      description: '',
      content: 'body',
      modelInvocation: ['code'],
    })
  }

  async function loadByName(templateType?: string) {
    installProcessFs(makeFakeFs({}))
    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/u' } }),
      ...(templateType !== undefined ? { templateType } : {}),
    })
    return new Map(commands.map(c => [c.name, c]))
  }

  it('a TYPE mismatch on both surfaces removes the skill from the session', async () => {
    await registerGateFixture()
    expect((await loadByName('code')).has('team-narrowed')).toBe(false)
    // Back in a team session, open on both surfaces.
    const inTeam = (await loadByName('team')).get('team-narrowed')
    expect(inTeam?.hiddenFromModel).toBe(false)
    expect(inTeam?.userCallable).toBe(true)
  })

  it('an explicit `[]` shuts one surface and KEEPS the skill present', async () => {
    await registerGateFixture()
    const inCode = await loadByName('code')
    // Slash-only: still loaded, just never advertised to the model.
    expect(inCode.get('slash-only')?.hiddenFromModel).toBe(true)
    expect(inCode.get('slash-only')?.userCallable).toBe(true)
    // Model-only: still loaded, just not offered as `/model-only`.
    expect(inCode.get('model-only')?.hiddenFromModel).toBe(false)
    expect(inCode.get('model-only')?.userCallable).toBe(false)
  })

  it('`*` widens a gate back to every session type', async () => {
    await registerGateFixture()
    const wild = (await loadByName('chat')).get('wild')
    // Normalized away at registration — an explicit wildcard is not stored.
    expect(wild?.modelInvocation).toBeUndefined()
    expect(wild?.userInvocation).toBeUndefined()
    expect(wild?.hiddenFromModel).toBe(false)
    expect(wild?.userCallable).toBe(true)
  })

  it('one surface can be type-narrowed while the other stays open', async () => {
    await registerGateFixture()
    // Present in chat through `/name`, but not advertised to the model.
    const inChat = (await loadByName('chat')).get('model-in-code-only')
    expect(inChat?.userCallable).toBe(true)
    expect(inChat?.hiddenFromModel).toBe(true)
    expect((await loadByName('code')).get('model-in-code-only')
      ?.hiddenFromModel).toBe(false)
  })

  it('no known session type filters nothing — over-include, never silent hide', async () => {
    await registerGateFixture()
    const any = await loadByName(undefined)
    expect(any.has('team-narrowed')).toBe(true)
    // The explicit `[]` still holds: it is not a type question.
    expect(any.get('slash-only')?.hiddenFromModel).toBe(true)
    expect(any.get('model-only')?.userCallable).toBe(false)
  })
})

describe('bundled-skill enable/disable gates the model listing (prompt)', () => {
  beforeEach(() => {
    resetProcessFs()
  })

  async function registerGated() {
    const {
      __resetBundledSkillsForTests,
      addStockSkill,
    } = await import('../skillLibrary/builtinSkills')
    const { __resetBundledSkillsInitForTests } = await import('../skillLibrary/builtin/catalog')
    __resetBundledSkillsForTests()
    __resetBundledSkillsInitForTests()
    // Model-invocable, OFF by default (default:false) → toggle feature with
    // an auto-wired isEnabled gate.
    addStockSkill({
      name: 'gated-skill',
      description: 'A gated model-invocable skill.',
      content: 'body',
      default: false,
    })
  }

  async function loadWithAppState(appState: unknown) {
    installProcessFs(makeFakeFs({}))
    return loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/u' } }),
      appState: appState as never,
    })
  }

  it('a DISABLED model-invocable skill is excluded from the prompt listing; enabling includes it', async () => {
    await registerGated()

    // default:false + no override → disabled → absent from the merged list AND
    // the model-facing skill listing (the prompt). This is "when we disable it,
    // the prompt will not show it".
    const disabled = await loadWithAppState({ enabledFeatures: {} })
    expect(disabled.find(c => c.name === 'gated-skill')).toBeUndefined()
    expect(
      renderSkillListing(getModelInvocableCommands(disabled)),
    ).not.toContain('gated-skill')

    // Override true → enabled → present in the listing (the prompt shows it).
    const enabled = await loadWithAppState({
      enabledFeatures: { 'bundled-skills.gated-skill': true },
    })
    expect(enabled.find(c => c.name === 'gated-skill')).toBeDefined()
    expect(
      renderSkillListing(getModelInvocableCommands(enabled)),
    ).toContain('gated-skill')
  })
})

describe('getModelInvocableCommands — plugin/MCP description gate', () => {
  // A plugin/MCP command must carry an
  // author-specified description (or useWhen) before it can appear in the
  // model-facing listing — an auto-derived first-line description does NOT
  // qualify. Bundled and on-disk user/project dir skills always qualify.
  const base = {
    type: 'prompt' as const,
    content: 'body',
    path: '/p',
  }

  it('hides an undescribed plugin command but keeps it with a description or useWhen', () => {
    const commands: ChromiumCommandMetadata[] = [
      {
        ...base,
        name: 'plugin-nodesc',
        description: 'first body line', // auto-derived
        loadedFrom: 'plugin',
        source: 'plugin',
        describedByAuthor: false,
      },
      {
        ...base,
        name: 'plugin-desc',
        description: 'a real description',
        loadedFrom: 'plugin',
        source: 'plugin',
        describedByAuthor: true,
      },
      {
        ...base,
        name: 'plugin-when',
        description: 'first body line',
        loadedFrom: 'plugin',
        source: 'plugin',
        describedByAuthor: false,
        useWhen: 'when X happens',
      },
      {
        ...base,
        name: 'user-skill',
        description: 'first body line', // auto-derived, but a trusted dir
        loadedFrom: 'skills',
        source: 'user',
        describedByAuthor: false,
      },
    ]

    expect(
      getModelInvocableCommands(commands)
        .map(c => c.name)
        .sort(),
    ).toEqual(['plugin-desc', 'plugin-when', 'user-skill'])
  })
})

describe('deriveDescription — first body line as the description', () => {
  // When a skill has no frontmatter `description`, the body's first non-empty
  // line is used: an ATX heading ("# Foo", needs a space) yields its text; a
  // no-space "#tag" line is kept verbatim; everything is capped at 100 chars.
  it('extracts heading text, keeps no-space # verbatim, and caps at 100 chars', async () => {
    const longLine = 'x'.repeat(150)
    installProcessFs(
      makeFakeFs({
        '/workspace/.velloc/skills': { kind: 'dir' },
        '/workspace/.velloc/skills/notag': { kind: 'dir' },
        '/workspace/.velloc/skills/notag/SKILL.md': {
          kind: 'file',
          content: '#hashtag note\nbody',
        },
        '/workspace/.velloc/skills/heading': { kind: 'dir' },
        '/workspace/.velloc/skills/heading/SKILL.md': {
          kind: 'file',
          content: '# Real Heading\nbody',
        },
        '/workspace/.velloc/skills/long': { kind: 'dir' },
        '/workspace/.velloc/skills/long/SKILL.md': {
          kind: 'file',
          content: `${longLine}\nbody`,
        },
      }),
    )

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      includeBundled: false,
    })
    const desc = (name: string) =>
      commands.find(c => c.name === name)?.description

    expect(desc('notag')).toBe('#hashtag note') // no-space # NOT stripped
    expect(desc('heading')).toBe('Real Heading') // ATX heading text extracted
    expect(desc('long')).toBe(`${'x'.repeat(97)}...`) // 100-char cap
  })
})

describe('loadLocalPromptCommands — e2eOnly bundled-skill gate', () => {
  beforeEach(() => {
    resetProcessFs()
    // Re-register the bundled set fresh so `installStockSkills()` (invoked by the
    // loader) actually re-runs and registers the e2e-throw fixture.
    __resetBundledSkillsForTests()
    __resetBundledSkillsInitForTests()
    // Empty project skills dir → no disk skills; only the bundled set appends.
    installProcessFs(makeFakeFs({}))
  })

  it('drops the e2e-only fixture skill when the runtime is NOT under e2eTrace', async () => {
    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      // No `e2eTrace` env → production-like runtime.
      runtimeConfig: new BrowserRuntimeConfig(),
    })
    // The regular bundled skills still load…
    expect(commands.some(c => c.name === 'simplify')).toBe(true)
    // …but the e2e-only fixture is gated out.
    expect(commands.some(c => c.name === E2E_THROW_SKILL_NAME)).toBe(false)
  })

  it('includes the e2e-only fixture skill when e2eTrace is set', async () => {
    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: { e2eTrace: '1' } }),
    })
    expect(commands.some(c => c.name === E2E_THROW_SKILL_NAME)).toBe(true)
  })
})
