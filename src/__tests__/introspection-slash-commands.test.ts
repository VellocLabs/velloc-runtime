/**
 * `/agents`, `/skills`, `/hooks`, `/permissions` — the read-only introspection listings
 * (`input/introspectionCommands.ts`): the pure builders (the formatting contract) and the dispatch wiring through
 * `processUserInput`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import type { WorkingState } from '../runtime/RuntimeTypes'
import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { processUserInput } from '../input/submitUserInput'
import {
  buildAgentsListing,
  buildHooksListing,
  buildPermissionsListing,
  buildSkillsListing,
} from '../input/introspectionCommands'
import { renderPartsEnglish } from '../input/systemMessageParts'
import { attachInProcessHook, attachTransientHook } from '../lifecycleHooks/sessionScopedHooks'
import {
  getConditionalSkills,
  loadLocalPromptCommands,
} from '../skillLibrary/skillDiscovery'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFsEntry,
  type RuntimeFs,
} from '../utils/fs/runtimeFs'
import {
  BROWSER_SLASH_COMMANDS,
  BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS,
  NEXUS_SLASH_COMMANDS,
} from '../input/slashCommandCatalog'
import { en } from '../browser/webview/i18n/messages/en'

const runtimeConfig = new BrowserRuntimeConfig()

function stubHostBridge(): BrowserHostBridge {
  return {} as unknown as BrowserHostBridge
}

function skill(
  overrides: Partial<ChromiumCommandMetadata> &
    Pick<ChromiumCommandMetadata, 'name'>,
): ChromiumCommandMetadata {
  return {
    type: 'prompt',
    description: `${overrides.name} description`,
    content: 'body',
    path: `/skills/${overrides.name}.md`,
    loadedFrom: 'skills',
    source: 'project',
    ...overrides,
  }
}

// ---- builders ------------------------------------------------------------

describe('buildAgentsListing', () => {
  it('groups agents by source and always names the reserved fork route', () => {
    const text = renderPartsEnglish(buildAgentsListing({
      enabledAgents: [
        { name: 'Explore', description: 'Search fast', source: 'built-in' },
        {
          name: 'reviewer',
          description: 'Review a diff',
          source: 'project',
          model: 'opus',
          tools: ['Read', 'Grep'],
        },
      ],
      allAgents: [],
    }))
    expect(text).toContain('Agents: 2 registered')
    expect(text).toContain('built-in (1):')
    expect(text).toContain('project (1):')
    expect(text).toContain('- **reviewer** (project) [model=opus tools=Read,Grep]')
    // `withBuiltInAgents` keeps `fork` OUT of the registry, so a listing that
    // only walked activeAgents would hide an always-available route.
    expect(text).toContain('fork (reserved)')
  })

  it('reads a plugin agent through its plugin name', () => {
    const text = renderPartsEnglish(buildAgentsListing({
      enabledAgents: [
        {
          name: 'acme:linter',
          description: 'Lint',
          source: 'plugin',
          pluginName: 'acme',
          disallowedTools: ['Bash'],
        },
      ],
      allAgents: [],
    }))
    expect(text).toContain('- **acme:linter** (plugin: acme) [denied=Bash]')
  })

  it('tolerates a malformed definition instead of throwing', () => {
    // `AgentProfile` is `{ name?, [k]: unknown }` — a plugin agent is only
    // as well-formed as its frontmatter, and a bad one must not take the
    // command down.
    const text = renderPartsEnglish(buildAgentsListing({
      enabledAgents: [{ description: 42, tools: 'not-an-array' } as never],
      allAgents: [],
    }))
    expect(text).toContain('- **(unnamed)** (unknown)')
    expect(text).not.toContain('tools=')
  })

  it('explains where to author one when the registry is empty', () => {
    const text = renderPartsEnglish(buildAgentsListing({ enabledAgents: [], allAgents: [] }))
    expect(text).toContain('No agents are registered')
    expect(text).toContain('agents/')
    expect(text).toContain('fork (reserved)')
  })
})

describe('buildSkillsListing', () => {
  it('reports each skill’s invocation surface', () => {
    const text = renderPartsEnglish(buildSkillsListing([
      skill({ name: 'both' }),
      skill({ name: 'slash-only', hiddenFromModel: true }),
      skill({ name: 'model-only', userCallable: false }),
      skill({ name: 'neither', userCallable: false, hiddenFromModel: true }),
    ]))
    expect(text).toContain('Skills: 4 loaded')
    expect(text).toContain('- **/both** [slash+model]')
    expect(text).toContain('- **/slash-only** [slash-only]')
    expect(text).toContain('- **/model-only** [model-only]')
    expect(text).toContain('- **/neither** [not invocable]')
  })

  it('surfaces fork, model, and tool scope', () => {
    const text = renderPartsEnglish(buildSkillsListing([
      skill({
        name: 'reviewer',
        source: 'plugin',
        pluginName: 'acme',
        context: 'fork',
        agent: 'Explore',
        model: 'haiku',
        permittedTools: ['Read'],
      }),
    ]))
    expect(text).toContain('plugin=acme')
    expect(text).toContain('fork=Explore')
    expect(text).toContain('model=haiku')
    expect(text).toContain('tools=Read')
  })

  it('lists path-gated skills under their own withheld heading', () => {
    const text = renderPartsEnglish(buildSkillsListing(
      [skill({ name: 'always' })],
      [skill({ name: 'gated', paths: ['docs', 'src'] })],
    ))
    expect(text).toContain('Skills: 1 loaded, 1 withheld')
    expect(text).toContain('Withheld — path-gated (1):')
    expect(text).toContain('/gated')
    expect(text).toContain('paths=docs,src')
    expect(text).toContain('Not invocable yet')
    // The gated skill must not be counted among the dispatchable ones.
    expect(text).toContain('project (1):')
  })

  it('reports a withheld-only load rather than claiming nothing is loaded', () => {
    const text = renderPartsEnglish(buildSkillsListing([], [skill({ name: 'gated', paths: ['src'] })]))
    expect(text).not.toContain('No skills are loaded')
    expect(text).toContain('Skills: 0 loaded, 1 withheld')
    expect(text).toContain('/gated')
  })

  it('groups by source and sorts names within a group', () => {
    const text = renderPartsEnglish(buildSkillsListing([
      skill({ name: 'zeta' }),
      skill({ name: 'alpha' }),
      skill({ name: 'bundled-one', source: 'bundled', loadedFrom: 'bundled' }),
    ]))
    expect(text.indexOf('bundled (1):')).toBeLessThan(text.indexOf('project (2):'))
    expect(text.indexOf('/alpha')).toBeLessThan(text.indexOf('/zeta'))
  })

  it('explains where to author one when nothing is loaded', () => {
    expect(renderPartsEnglish(buildSkillsListing([]))).toContain('No skills are loaded')
    expect(renderPartsEnglish(buildSkillsListing(undefined))).toContain('No skills are loaded')
  })
})

describe('buildSkillsListing — against the real loader partition', () => {
  // The regression this pins: `loadLocalPromptCommands` moves a `paths:`
  // skill OUT of its return value and into the module-level conditional map,
  // so a listing built from `options.commands` alone omits it entirely. That
  // is invisible to any test that hands the builder a pre-made `paths` skill —
  // only driving the real loader proves the two halves are both read.
  afterEach(() => {
    resetProcessFs()
  })

  function fakeFs(tree: Record<string, string | null>): RuntimeFs {
    const dirent = (name: string, isDir: boolean): RuntimeFsEntry => ({
      name,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    })
    return {
      ...unconfiguredFs,
      async readdir(path: string): Promise<RuntimeFsEntry[]> {
        const prefix = path.endsWith('/') ? path : `${path}/`
        const seen = new Set<string>()
        const out: RuntimeFsEntry[] = []
        for (const key of Object.keys(tree)) {
          if (!key.startsWith(prefix)) continue
          const segment = key.slice(prefix.length).split('/')[0]!
          if (!segment || seen.has(segment)) continue
          seen.add(segment)
          out.push(dirent(segment, tree[`${prefix}${segment}`] === null))
        }
        if (out.length === 0) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return out
      },
      async readFile(path: string): Promise<string> {
        const content = tree[path]
        if (typeof content !== 'string') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return content
      },
    } as RuntimeFs
  }

  it('shows a path-gated skill the loader withheld from options.commands', async () => {
    installProcessFs(
      fakeFs({
        '/workspace/.velloc/skills': null,
        '/workspace/.velloc/skills/always': null,
        '/workspace/.velloc/skills/always/SKILL.md':
          '---\ndescription: Always on\n---\nbody\n',
        '/workspace/.velloc/skills/gated': null,
        '/workspace/.velloc/skills/gated/SKILL.md':
          '---\ndescription: Only for docs\npaths:\n  - docs/**\n---\nbody\n',
      }),
    )

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig,
      // Programmatically-registered bundled skills would drown out the two
      // authored here; this test is about the partition, not the catalog.
      includeBundled: false,
    })
    // The invariant the builder depends on — if this ever stops holding, the
    // second argument becomes redundant rather than wrong.
    expect(commands.map(c => c.name)).toEqual(['always'])

    const text = renderPartsEnglish(buildSkillsListing(commands, getConditionalSkills()))
    expect(text).toContain('Skills: 1 loaded, 1 withheld')
    expect(text).toContain('/always')
    expect(text).toContain('/gated')
    expect(text).toContain('Withheld — path-gated (1):')
    expect(text).toContain('paths=docs')
  })

  it("/skills lists a path-gated skill only when the session type's allowlist admits it", async () => {
    // The conditional map is module-global and never saw the `skills:`
    // allowlist (createAgentRuntime filters only the returned list), so the
    // dispatch filters it per session — otherwise a `review` session listed a
    // denied project skill as its own.
    installProcessFs(
      fakeFs({
        '/workspace/.velloc/skills': null,
        '/workspace/.velloc/skills/gated': null,
        '/workspace/.velloc/skills/gated/SKILL.md':
          '---\ndescription: Only for docs\npaths:\n  - docs/**\n---\nbody\n',
      }),
    )
    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig,
      includeBundled: false,
    })
    expect(commands).toEqual([])
    expect(getConditionalSkills().map(c => c.name)).toEqual(['gated'])

    const listing = async (templateType: string) => {
      const context = createNoopToolUseContext({
        tools: [],
        platformCapabilities: new NoopPlatformCapabilities(),
        appState: createEmptyAppState(),
        setAppState: () => {},
        sessionId: 'sess',
        cwd: '/workspace',
        commands,
      })
      context.options.templateType = templateType
      const out = await processUserInput(
        { input: '/skills', context },
        {
          hostBridge: stubHostBridge(),
          runtimeConfig,
          supportedSlashCommands: ['skills'],
        },
      )
      return JSON.stringify(out.messages.find(m => m.type === 'system') ?? {})
    }
    // `code` has no allowlist: the withheld skill is this session's.
    expect(await listing('code')).toContain('/gated')
    // `safe_code` carries an allowlist (`skills: []`), so nothing from
    // `project:` reaches its listing.
    expect(await listing('safe_code')).not.toContain('/gated')
  })
})

describe('buildHooksListing', () => {
  function stateWithHooks(): { state: WorkingState; sessionId: string } {
    let state = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      state = updater(state)
    }
    attachTransientHook(setAppState, 'sess', 'PreToolUse', 'Bash', {
      type: 'command',
      command: 'echo guard',
      timeout: 5000,
    })
    attachTransientHook(setAppState, 'sess', 'Stop', '', {
      type: 'http',
      url: 'https://example.com/hook',
    })
    return { state, sessionId: 'sess' }
  }

  it('lists persistable hooks under their event and matcher', () => {
    const { state, sessionId } = stateWithHooks()
    const text = renderPartsEnglish(buildHooksListing(state, sessionId))
    expect(text).toContain('Hooks: 2 across 2 matchers')
    expect(text).toContain('PreToolUse:')
    expect(text).toContain('matcher Bash')
    expect(text).toContain('command: echo guard [timeout=5000ms]')
    expect(text).toContain('Stop:')
    // An empty matcher means match-all; printing it blank would read as a bug.
    expect(text).toContain('matcher * (match all)')
    expect(text).toContain('http: https://example.com/hook')
  })

  it('merges in-memory function hooks into the same matcher bundle', () => {
    // The store holds both kinds but hands them back through two accessors —
    // "what runs on PreToolUse" is one question, so they must not print twice.
    let state = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      state = updater(state)
    }
    attachTransientHook(setAppState, 'sess', 'PreToolUse', 'Bash', {
      type: 'command',
      command: 'echo guard',
    })
    attachInProcessHook(
      setAppState,
      'sess',
      'PreToolUse',
      'Bash',
      () => true,
      'blocked',
      { id: 'guard-fn' },
    )
    const text = renderPartsEnglish(buildHooksListing(state, 'sess'))
    expect(text).toContain('Hooks: 2 across 1 matcher')
    expect(text.match(/matcher Bash/g)).toHaveLength(1)
    expect(text).toContain('function: guard-fn')
  })

  it('reports an empty store and a missing session distinctly', () => {
    expect(renderPartsEnglish(buildHooksListing(createEmptyAppState(), 'sess'))).toContain(
      'No hooks are registered for this session',
    )
    expect(renderPartsEnglish(buildHooksListing(undefined, 'sess'))).toContain(
      'No session is active',
    )
    expect(renderPartsEnglish(buildHooksListing(createEmptyAppState(), undefined))).toContain(
      'No session is active',
    )
  })
})

describe('buildPermissionsListing', () => {
  it('shows the mode and both rule stores', () => {
    const state = createEmptyAppState()
    state.permissionRules = {
      mode: 'plan',
      modeBeforePlan: 'default',
      extraWorkspaceRoots: new Map([
        ['/extra', { path: '/extra', source: 'cliArg' }],
      ]),
      ruleLists: { allow: ['Read'], deny: ['Bash(rm:*)'], ask: [] },
      // The legacy per-source dicts decide real outcomes too (WebFetch
      // self-gates on them), so a listing that showed only `ruleLists` would
      // report a posture the session does not have.
      denyRuleBook: { localSettings: ['WebFetch(domain:evil.test)'] },
      bypassPermissionsModeDisabled: true,
    }
    const text = renderPartsEnglish(buildPermissionsListing(state))
    expect(text).toContain('Permission mode: plan')
    expect(text).toContain('Mode before plan mode: default')
    expect(text).toContain('Bypass mode: disabled by settings')
    expect(text).toContain('**Allow (1):**')
    expect(text).toContain('- Read')
    expect(text).toContain('**Deny (1):**')
    expect(text).toContain('- Bash(rm:*)')
    expect(text).not.toContain('Ask (')
    expect(text).toContain('Always deny (1):')
    expect(text).toContain('- WebFetch(domain:evil.test) (localSettings)')
    expect(text).toContain('Additional working directories (1):')
    expect(text).toContain('- /extra (cliArg)')
  })

  it('reports bypass availability from the settings kill switch alone', () => {
    const state = createEmptyAppState()
    state.permissionRules = { mode: 'default' }
    const open = renderPartsEnglish(buildPermissionsListing(state))
    expect(open).toContain('Bypass mode: available')
    expect(open).not.toContain('unavailable')
    expect(open).not.toContain('disabled by settings')

    state.permissionRules = { mode: 'default', bypassPermissionsModeDisabled: true }
    const closed = renderPartsEnglish(buildPermissionsListing(state))
    expect(closed).toContain('Bypass mode: disabled by settings')
    expect(closed).not.toContain('Bypass mode: available')
  })

  it('says the rule gate is a no-op when nothing is configured', () => {
    const text = renderPartsEnglish(buildPermissionsListing(createEmptyAppState()))
    expect(text).toContain('Permission mode: default')
    expect(text).toContain('the rule gate is a no-op')
  })

  it('handles a missing permission context', () => {
    expect(renderPartsEnglish(buildPermissionsListing(undefined))).toContain(
      'No permission context is available',
    )
  })
})

describe('the four builders return translatable parts', () => {
  // Guards against a builder silently reverting to a plain English string —
  // every `.toContain` assertion above would still pass (renderPartsEnglish
  // renders either shape to the same English text), but the webview would
  // then render English in every locale regardless of the active locale.
  it('buildAgentsListing', () => {
    const parts = buildAgentsListing({ enabledAgents: [], allAgents: [] })
    expect(parts.some(part => 'key' in part && part.key === 'slash.out.agents.empty')).toBe(true)
  })
  it('buildSkillsListing', () => {
    const parts = buildSkillsListing([skill({ name: 'a' })])
    expect(parts.some(part => 'key' in part && part.key === 'slash.out.skills.header')).toBe(true)
  })
  it('buildHooksListing', () => {
    const parts = buildHooksListing(createEmptyAppState(), 'sess')
    expect(parts.some(part => 'key' in part && part.key === 'slash.out.hooks.empty')).toBe(true)
  })
  it('buildPermissionsListing', () => {
    const parts = buildPermissionsListing(createEmptyAppState())
    expect(parts.some(part => 'key' in part && part.key === 'slash.out.permissions.mode')).toBe(
      true,
    )
  })
})

// ---- catalog + dispatch --------------------------------------------------

describe('introspection commands — catalog', () => {
  it('registers all four in both command sets with a description', () => {
    for (const name of ['agents', 'skills', 'hooks', 'permissions'] as const) {
      expect(BROWSER_SLASH_COMMANDS).toContain(name)
      expect(NEXUS_SLASH_COMMANDS).toContain(name)
      expect(en[BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS[name]]).toBeTruthy()
    }
  })
})

describe('processUserInput — introspection commands', () => {
  function makeContext(commands: ChromiumCommandMetadata[] = []) {
    return createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      sessionId: 'sess',
      cwd: '/w',
      commands,
    })
  }

  async function run(
    input: string,
    context = makeContext(),
  ): Promise<{ text: string; shouldQuery: boolean | undefined }> {
    const out = await processUserInput(
      { input, context },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
        supportedSlashCommands: ['agents', 'skills', 'hooks', 'permissions'],
      },
    )
    const system = out.messages.find(message => message.type === 'system')
    return {
      text: JSON.stringify(system ?? {}),
      shouldQuery: out.shouldQuery,
    }
  }

  it('/agents reports the session registry', async () => {
    const context = makeContext()
    context.options.agentDefinitions.enabledAgents.push({
      name: 'reviewer',
      description: 'Review a diff',
      source: 'project',
    })
    const { text, shouldQuery } = await run('/agents', context)
    expect(shouldQuery).toBe(false)
    expect(text).toContain('Agents: 1 registered')
    expect(text).toContain('reviewer')
  })

  it('/skills reports the loaded skill registry', async () => {
    const { text, shouldQuery } = await run(
      '/skills',
      makeContext([skill({ name: 'echo' })]),
    )
    expect(shouldQuery).toBe(false)
    expect(text).toContain('Skills: 1 loaded')
    expect(text).toContain('/echo')
  })

  it('/hooks reports the session hook store', async () => {
    const { text, shouldQuery } = await run('/hooks')
    expect(shouldQuery).toBe(false)
    expect(text).toContain('No hooks are registered')
  })

  it('/permissions reports the mode', async () => {
    const { text, shouldQuery } = await run('/permissions')
    expect(shouldQuery).toBe(false)
    expect(text).toContain('Permission mode: default')
  })

  it('ignores trailing args — each has a single behavior', async () => {
    const { text } = await run('/permissions add allow Bash')
    expect(text).toContain('Permission mode: default')
  })
})

/**
 * The layout contract for all four listings: slash output renders as markdown, where a single newline is a soft
 * break, so entries are separated as markdown blocks.
 */
describe('listing layout — markdown blocks, not soft-wrapped lines', () => {
  const NL = String.fromCharCode(10)
  const BLANK = NL + NL

  const isBullet = (line: string) => /^ *- /.test(line)

  /**
   * Every block boundary is a BLANK line.
   *
   * Consecutive bullets are the one legal single-newline join — that is what
   * makes them one list. Anything else (a bullet after prose, a lead-in after
   * a bullet, a heading after anything) needs the blank line, or markdown
   * folds it into the paragraph above.
   */
  function expectBlockLayout(text: string): void {
    const rows = text.split(NL)
    rows.forEach((row, i) => {
      if (i === 0 || row === '') return
      const previous = rows[i - 1]!
      const where = `line ${i + 1}: ${JSON.stringify(row)} after ${JSON.stringify(previous)}`
      if (isBullet(row)) {
        expect(previous === '' || isBullet(previous), where).toBe(true)
        return
      }
      if (row.startsWith('#') || row.startsWith('**')) {
        expect(previous, where).toBe('')
      }
    })
    // …and the old indent-only layout, which markdown simply swallowed, is
    // gone: an indented line is now a nested bullet or nothing.
    for (const row of rows) {
      if (row.startsWith('  ')) expect(isBullet(row), row).toBe(true)
    }
  }

  it('/agents opens with a title and bullets every agent', () => {
    const text = renderPartsEnglish(
      buildAgentsListing({
        enabledAgents: [
          { name: 'a', description: 'A', source: 'built-in' },
          { name: 'b', description: 'B', source: 'project' },
        ],
        allAgents: [],
      }),
    )
    expect(text.startsWith('### ')).toBe(true)
    expect(text).toContain(`${BLANK}**built-in (1):**${BLANK}- **a**`)
    expectBlockLayout(text)
  })

  it('/skills bullets every skill under its source lead-in', () => {
    const text = renderPartsEnglish(
      buildSkillsListing([skill({ name: 'one' }), skill({ name: 'two' })]),
    )
    expect(text.startsWith('### ')).toBe(true)
    expect(text).toContain(`${BLANK}**project (2):**${BLANK}- **/one**`)
    // Two entries in one list: consecutive bullets, one newline BETWEEN them
    // (that is what makes them one list) but never before the first.
    expect(text).toContain(`— one description${NL}- **/two**`)
    expectBlockLayout(text)
  })

  it('/hooks nests hooks under their matcher, under their event', () => {
    let state = createEmptyAppState()
    const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
      state = updater(state)
    }
    attachTransientHook(setAppState, 'sess', 'PreToolUse', 'Bash', {
      type: 'command',
      command: 'echo hi',
    })
    const text = renderPartsEnglish(buildHooksListing(state, 'sess'))
    expect(text.startsWith('### ')).toBe(true)
    expect(text).toContain(`${BLANK}**PreToolUse:**${BLANK}- matcher Bash`)
    // The hook itself is one level in — it belongs to the matcher above it.
    expect(text).toContain(`${NL}  - command: echo hi`)
    expectBlockLayout(text)
  })

  it('/permissions bullets each rule under its list lead-in', () => {
    const state = createEmptyAppState()
    state.permissionRules.ruleLists = {
      allow: ['Read', 'Grep'],
      ask: [],
      deny: [],
    }
    const text = renderPartsEnglish(buildPermissionsListing(state))
    expect(text.startsWith('### ')).toBe(true)
    expect(text).toContain(`${BLANK}**Allow (2):**${BLANK}- Read${NL}- Grep`)
    expectBlockLayout(text)
  })
})
