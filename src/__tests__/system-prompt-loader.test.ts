import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetProductNameForTest,
  setProductNameOverride,
} from '../branding/productName'
import {
  loadSystemPromptHolders,
  loadSystemPromptSections,
  PromptUnavailableError,
  selectSystemPromptVariant,
  type SelectSystemPromptParams,
  type PromptChunk,
} from '../prompting/systemPromptLoader'
import { __resetPromptCacheForTest } from '../prompting/systemPromptFetcher'
import { sessionGuidanceChunk } from '../prompting/systemPromptSessionGuidance'
import { renderPromptSection } from '../prompting/sections/promptSectionRenderer'
import type { ToolContractList } from '../toolkit/toolContract'
import {
  __resetSkillCatalogsForTest,
  registerSkillCatalog,
} from '../toolkit/run/skillCatalogs'

// Minimal stand-in for a real Tool. The loader only reads .name on each
// element to build the enabled-tool set.
function tool(name: string): ToolContractList[number] {
  return { name } as unknown as ToolContractList[number]
}

// Phase-4 split: pre-Phase-4 the catalog had a single `browser_actions`
// umbrella tool; the prompt section now keys off the individual split
// tool names (the canonical set lives in
// `src/custom_browser/browser/nexus/tools/declarations/browser_tool/`).
// Stub two representative ones so the section renders.
const STUBBED_BROWSER_TOOLS: ToolContractList = [
  tool('navigate'),
  tool('click'),
] as ToolContractList
const NO_TOOLS: ToolContractList = [] as ToolContractList

// Stubs the section renderer. Mimics the real output's shape (header +
// per-section blocks gated on enabledToolNames). Doesn't need to match the
// real renderer byte-for-byte (promptSectionRenderer.test.ts pins that); just representative enough that the
// substitution + cache-shape assertions hold.
function fakeCatalogRenderer(): (params: {
  name: 'using-your-tools' | 'system-prompt-tools'
  enabledToolNames: string[]
}) => { text: string } {
  return ({ enabledToolNames }) => {
    const browserish = new Set([
      'navigate', 'click', 'input', 'back', 'forward', 'wait',
      'create_tab', 'close_tab', 'activate_tab', 'select', 'hover',
      'drag_and_drop', 'scroll', 'scroll_to', 'search',
      'media_play', 'media_pause', 'media_state', 'media_seek',
      'screenshot', 'read_page', 'read_element', 'find_text', 'done',
    ])
    const hasBrowser = enabledToolNames.some(n => browserish.has(n))
    const sections: string[] = []
    if (hasBrowser) {
      sections.push(
        '## Browser tools\n\nBEFORE each call, ...\nOne browser tool call per turn.\n\nclick { index, ...\ninput { index, ...',
      )
    }
    sections.push('## Parallelism\n\nYou can call multiple tools ...')
    if (sections.length === 0) return { text: '' }
    return { text: ['# Using your tools', '', ...sections].join('\n') }
  }
}

const FAKE_TEMPLATE_BODY = [
  'You are {{AGENT_NAME}} — body intro.',
  '',
  '# Some section',
  'placeholder before the catalog',
  '',
  '{{TOOL_CATALOG}}',
  '',
  'tail content',
].join('\n')

function withFetchMock(template: string = FAKE_TEMPLATE_BODY) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    void url
    return new Response(template, {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    }) as unknown as Response
  })
  vi.stubGlobal('fetch', mock as unknown as typeof fetch)
  return mock
}

// The loader's named sections, plus the final text exactly as the model sees
// it: the host joins the non-empty sections with a blank line.
async function resolveLoaded(
  params: SelectSystemPromptParams,
  renderer?: ReturnType<typeof fakeCatalogRenderer>,
): Promise<{ parts: PromptChunk[]; text: string }> {
  const parts = await loadSystemPromptSections({
    ...params,
    promptSectionRenderer: renderer,
  })
  const text = parts
    .map(part => part.text)
    .filter(part => part.length > 0)
    .join('\n\n')
  return { parts, text }
}

function holderNames(parts: PromptChunk[]): string[] {
  return parts.flatMap(part => (part.name === undefined ? [] : [part.name]))
}

beforeEach(() => {
  __resetPromptCacheForTest()
  __resetProductNameForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('selectSystemPromptVariant', () => {
  const base: SelectSystemPromptParams = { tools: NO_TOOLS }

  it('flash + anthropic → system_prompt_anthropic_flash', () => {
    expect(
      selectSystemPromptVariant({ ...base, flashMode: true, providerId: 'anthropic' }),
    ).toBe('system_prompt_anthropic_flash')
  })

  it('flash + non-anthropic → system_prompt_flash', () => {
    expect(
      selectSystemPromptVariant({ ...base, flashMode: true, providerId: 'openai' }),
    ).toBe('system_prompt_flash')
    expect(
      selectSystemPromptVariant({ ...base, flashMode: true, providerId: undefined }),
    ).toBe('system_prompt_flash')
  })

  it('no flash → system_prompt (the one full prompt; no thinking variant)', () => {
    expect(selectSystemPromptVariant(base)).toBe('system_prompt')
    expect(selectSystemPromptVariant({ ...base, providerId: 'anthropic' })).toBe(
      'system_prompt',
    )
  })
})

describe('loadSystemPromptHolders — substitution & shape', () => {
  it('emits base.pre + catalog + base.post holders when {{TOOL_CATALOG}} is present', async () => {
    withFetchMock()
    const { parts, text } = await resolveLoaded(
      { tools: STUBBED_BROWSER_TOOLS },
      fakeCatalogRenderer(),
    )
    expect(holderNames(parts)).toEqual(['base.pre', 'using-your-tools', 'base.post'])
    // Resolved text places the catalog between the intro and the tail.
    expect(text).toMatch(/^# Using your tools/m)
    expect(text).toMatch(/body intro\./)
    expect(text).toMatch(/tail content$/)
  })

  it('substitutes {{AGENT_NAME}} from getProductName()', async () => {
    withFetchMock()
    const { text } = await resolveLoaded({ tools: NO_TOOLS }, fakeCatalogRenderer())
    expect(text).not.toMatch(/\{\{AGENT_NAME\}\}/)
    expect(text).toMatch(/You are Velloc Code —/)
  })

  it('a session product-name override (/debug name) lands in {{AGENT_NAME}}', async () => {
    // The override is read lazily at prompt-BUILD time, not at module load —
    // the seam the hidden `/debug name` subcommand relies on for renaming
    // what the model is called mid-session.
    withFetchMock()
    setProductNameOverride('Velloc abc')
    try {
      const { text } = await resolveLoaded(
        { tools: NO_TOOLS },
        fakeCatalogRenderer(),
      )
      expect(text).toMatch(/You are Velloc abc —/)
      expect(text).not.toMatch(/You are Velloc Code —/)
    } finally {
      setProductNameOverride(undefined)
    }
  })

  it('omits per-tool descriptions when tools = []', async () => {
    withFetchMock()
    const { text } = await resolveLoaded({ tools: NO_TOOLS }, fakeCatalogRenderer())
    // Empty tool set ⇒ catalog still contains the unconditional Parallelism
    // subsection (the fake renderer mirrors the C++ behavior of always
    // emitting the parallelism trailer when ANY content is rendered) but
    // no browser/file/todo/skill blocks.
    expect(text).toMatch(/## Parallelism/)
    expect(text).not.toMatch(/## Browser tool/)
    expect(text).not.toMatch(/## File and shell tools/)
    expect(text).not.toMatch(/## Task tracking/)
    expect(text).not.toMatch(/## Skills/)
  })

  it('includes Browser tools section when split browser tools are present', async () => {
    withFetchMock()
    const { text } = await resolveLoaded(
      { tools: STUBBED_BROWSER_TOOLS },
      fakeCatalogRenderer(),
    )
    // Section heading uses the new split-tools framing.
    expect(text).toMatch(/## Browser tools/)
    // Pre-Phase-4 framing should be GONE — the umbrella tool name and its
    // required reflection fields are no longer part of the prompt's vocabulary.
    expect(text).not.toMatch(/browser_actions/)
    expect(text).not.toMatch(/evaluation_previous_goal/)
    // Each individual tool is documented with its required-field shape.
    expect(text).toMatch(/click \{ index/)
    expect(text).toMatch(/input \{ index/)
    // The narrate-before-each-call pattern is the single biggest behavioral
    // nudge in the rewritten prompt; verify it lands.
    expect(text).toMatch(/BEFORE each call/)
    expect(text).toMatch(/One browser tool call per turn/)
  })

  it('renders the runtime\'s own sections when no renderer is injected', async () => {
    // The runtime renders both sections itself
    // (promptSections/promptSectionRenderer.ts) — no host round-trip whose
    // absence could drop them. Both placeholders are filled, no marker leaks.
    withFetchMock(
      ['You are {{AGENT_NAME}}.', '{{system-prompt-tools}}', '', '{{TOOL_CATALOG}}', '', 'tail'].join('\n'),
    )
    const enabledToolNames = ['BrowserClick', 'Read']
    const parts = await loadSystemPromptSections({
      tools: enabledToolNames.map(tool) as ToolContractList,
    })
    expect(holderNames(parts)).toEqual(['base.pre', 'using-your-tools', 'base.post'])
    const pre = parts.find(p => p.name === 'base.pre')!
    expect(pre.text).toContain(
      renderPromptSection({ name: 'system-prompt-tools', enabledToolNames }).text,
    )
    expect(pre.text).not.toMatch(/\{\{system-prompt-tools\}\}/)
    expect(pre.text).not.toMatch(/\{\{AGENT_NAME\}\}/)
    expect(parts.find(p => p.name === 'using-your-tools')!.text).toBe(
      renderPromptSection({ name: 'using-your-tools', enabledToolNames }).text,
    )
  })
})

describe('loadSystemPromptHolders — caching & laziness', () => {
  it('does not call fetch at module import time', async () => {
    // The import happens at the top of this file. If anything fetched
    // eagerly, our beforeEach reset would not be enough — verify by
    // checking that no global fetch has been invoked yet in this test.
    const fetchMock = vi.fn(async () => new Response(FAKE_TEMPLATE_BODY, { status: 200 }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    expect(fetchMock).not.toHaveBeenCalled()

    await loadSystemPromptSections({ tools: NO_TOOLS })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches per variant — second call to same variant does not refetch', async () => {
    const fetchMock = withFetchMock()
    await loadSystemPromptSections({ tools: NO_TOOLS })
    await loadSystemPromptSections({ tools: NO_TOOLS })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('switching variants triggers exactly one fetch per variant', async () => {
    const fetchMock = withFetchMock()
    await loadSystemPromptSections({ tools: NO_TOOLS })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await loadSystemPromptSections({ tools: NO_TOOLS, flashMode: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Switching back to the original variant should hit the cache.
    await loadSystemPromptSections({ tools: NO_TOOLS })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('de-duplicates concurrent fetches for the same variant', async () => {
    const fetchMock = withFetchMock()
    await Promise.all([
      loadSystemPromptHolders({ tools: NO_TOOLS }),
      loadSystemPromptHolders({ tools: NO_TOOLS }),
      loadSystemPromptHolders({ tools: NO_TOOLS }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('loadSystemPromptHolders — failure handling', () => {
  it('throws PromptUnavailableError when fetch returns non-OK and no cache exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }) as unknown as Response) as unknown as typeof fetch,
    )
    await expect(loadSystemPromptHolders({ tools: NO_TOOLS })).rejects.toBeInstanceOf(PromptUnavailableError)
  })

  it('throws PromptUnavailableError when fetch rejects and no cache exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network')
      }) as unknown as typeof fetch,
    )
    await expect(loadSystemPromptHolders({ tools: NO_TOOLS })).rejects.toBeInstanceOf(PromptUnavailableError)
  })

  it('serves stale cache when a refetch attempt fails', async () => {
    const goodMock = withFetchMock()
    await loadSystemPromptSections({ tools: NO_TOOLS })
    expect(goodMock).toHaveBeenCalledTimes(1)

    // Simulate the next request failing — but the cache should already be
    // populated, so the loader still resolves. With our current cache (no
    // TTL) the second call hits the cache without ever calling fetch, so the
    // base prose still carries the cached template body.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network')
      }) as unknown as typeof fetch,
    )
    const parts = await loadSystemPromptSections({ tools: NO_TOOLS })
    const pre = parts.find(
      p => (p.name === 'base.pre' || p.name === 'base.full'),
    )!
    expect(pre.text).toMatch(/body intro/)
  })
})

describe('sessionGuidanceChunk', () => {
  it('returns null when neither the Agent tool nor the Skill tool is enabled', () => {
    expect(sessionGuidanceChunk(new Set())).toBeNull()
    expect(
      sessionGuidanceChunk(new Set(['Glob', 'Grep'])),
    ).toBeNull()
  })

  it('emits the `/<skill-name>` bullet when the Skill tool is enabled', () => {
    // Moved here from the static `# Tools` block; Skill-only
    // sessions get just this bullet, Agent+Skill sessions get it last.
    const skillOnly = sessionGuidanceChunk(new Set(['Skill']))!
    expect(skillOnly).toMatch(/^# Skills$/m)
    expect(skillOnly).toContain('When the user types `/<skill-name>`, run that skill with the Skill tool')
    expect(skillOnly).not.toMatch(/Use the Agent tool/)
    const both = sessionGuidanceChunk(new Set(['Agent', 'Skill']))!
    expect(both.indexOf('Use the Agent tool')).toBeLessThan(both.indexOf('/<skill-name>'))
  })

  it('names the section after the tools that are on', () => {
    expect(sessionGuidanceChunk(new Set(['Agent']))!.split(String.fromCharCode(10))[0]).toBe('# Subagents')
    expect(sessionGuidanceChunk(new Set(['Skill']))!.split(String.fromCharCode(10))[0]).toBe('# Skills')
    expect(sessionGuidanceChunk(new Set(['Agent', 'Skill']))!.split(String.fromCharCode(10))[0]).toBe('# Subagents and skills')
  })

  it('emits only the specialized-agents bullet when no search tools exist', () => {
    const section = sessionGuidanceChunk(new Set(['Agent']))
    expect(section).not.toBeNull()
    expect(section).toMatch(/^# Subagents$/m)
    expect(section).toMatch(/Use the Agent tool with a specialized agent/)
    // No codebase-search guidance without Glob/Grep.
    expect(section).not.toMatch(/subagent_type=Explore/)
  })

  it('adds the Explore bullet and names the available search tools', () => {
    const both = sessionGuidanceChunk(
      new Set(['Agent', 'Glob', 'Grep']),
    )!
    expect(both).toMatch(/subagent_type=Explore/)
    expect(both).toMatch(/use Glob or Grep directly/)

    const globOnly = sessionGuidanceChunk(
      new Set(['Agent', 'Glob']),
    )!
    expect(globOnly).toMatch(/use Glob directly/)
    expect(globOnly).not.toMatch(/Grep/)

    const grepOnly = sessionGuidanceChunk(
      new Set(['Agent', 'Grep']),
    )!
    expect(grepOnly).toMatch(/use Grep directly/)
    expect(grepOnly).not.toMatch(/Glob/)
  })

  it('falls back to find/grep via Bash when no Glob/Grep tools exist', () => {
    // The Glob/Grep TS tools were removed, but the C++ host republishes them
    // as hosted tools — so in host mode Glob/Grep is the live path (covered
    // above). This Bash fallback covers mock-host / pure-browser modes that
    // ship neither, so the Explore bullet still renders (naming Bash) instead
    // of going dark.
    const bashOnly = sessionGuidanceChunk(
      new Set(['Agent', 'Bash']),
    )!
    expect(bashOnly).toMatch(/subagent_type=Explore/)
    expect(bashOnly).toContain('`find` or `grep` via the Bash tool')
    expect(bashOnly).not.toContain('Glob')
    expect(bashOnly).not.toContain('Grep')
  })
})

describe('loadSystemPromptHolders — manifest path picks the prompt-profile holder variants', () => {
  // The `code` template carries `<holder>-lean.md` variants (the lean
  // prompt profile). The manifest path must hand the per-turn `promptProfile` to
  // `getHolderProse` so the variant is carried as the holder default for the
  // lean profile only.
  const holder = (parts: PromptChunk[], name: string) =>
    parts.find(
      p => p.name === name,
    )

  it('lean → the -lean variants (+ the profile-independent autonomy holder)', async () => {
    const parts = await loadSystemPromptSections({
      tools: NO_TOOLS,
      templateType: 'code',
      promptProfile: 'lean',
    })
    expect(holder(parts, 'system')?.text).toContain('# Harness')
    expect(holder(parts, 'system')?.text).not.toContain('# How this session works')
    // `!code_doing_tasks @standard` is gated OUT under lean — no part at all.
    expect(holder(parts, 'code_doing_tasks')).toBeUndefined()
    expect(holder(parts, 'code_tone_and_style')?.text).toContain(
      '# Writing for the user',
    )
    expect(holder(parts, 'autonomy')?.text).toContain(
      'You are working unattended',
    )
    // The shared caution renders its LEAN paragraph …
    expect(holder(parts, 'executing_with_care')?.text).toContain(
      'Before an action that is hard to undo',
    )
    expect(holder(parts, 'executing_with_care')?.text).not.toContain(
      '# Acting carefully',
    )
    // Position: right after delivering_work, before any dynamic part.
    const names = holderNames(parts)
    expect(names.indexOf('autonomy')).toBe(names.indexOf('delivering_work') + 1)
  })

  it('standard (or no profile) → the base files', async () => {
    for (const promptProfile of ['standard', undefined] as const) {
      const parts = await loadSystemPromptSections({
        tools: NO_TOOLS,
        templateType: 'code',
        promptProfile,
      })
      expect(holder(parts, 'system')?.text, `profile=${promptProfile}`).toContain(
        '# How this session works',
      )
      expect(holder(parts, 'system')?.text).not.toContain('# Harness')
      expect(holder(parts, 'code_doing_tasks')?.text).toContain('# Approach to tasks')
      // Skeleton order survives the gate: intro → system → doing_tasks → tools.
      const names = holderNames(parts)
      expect(names.indexOf('system')).toBe(names.indexOf('code_intro') + 1)
      expect(names.indexOf('code_doing_tasks')).toBe(names.indexOf('system') + 1)
      expect(names.indexOf('code_using_your_tools')).toBe(
        names.indexOf('executing_with_care') + 1,
      )
      expect(holder(parts, 'code_tone_and_style')?.text).toContain(
        '# Writing for the user (not tool calls)',
      )
      // The autonomy block is profile-independent — carried here too.
      expect(holder(parts, 'autonomy')?.text).toContain(
        'You are working unattended',
      )
      // … and under standard the SAME holder renders the full section,
      // from the earlier `@standard` slot.
      expect(holder(parts, 'executing_with_care')?.text).toContain(
        '# Acting carefully',
      )
      expect(names.indexOf('executing_with_care')).toBe(
        names.indexOf('code_doing_tasks') + 1,
      )
    }
  })

  it('a `=standard` render pin keeps the full care section under lean (agent)', async () => {
    // Without the pin, `executing_with_care` under lean rendered the shared
    // `-lean` paragraph for every type — `agent` lost its whole
    // `# Acting carefully` list (payments, sending, unsaved tabs)
    // for exactly the models that run most sessions, while `agent_autonomy`
    // still told the model "the rules above still hold".
    const parts = await loadSystemPromptSections({
      tools: NO_TOOLS,
      templateType: 'agent',
      promptProfile: 'lean',
    })
    // Lean is still the turn's profile: the shared system holder renders
    // `# Harness` …
    expect(holder(parts, 'system')?.text).toContain('# Harness')
    // … while the pinned holder emits the STANDARD prose.
    expect(holder(parts, 'executing_with_care')?.text).toContain(
      '# Acting carefully',
    )
    expect(holder(parts, 'executing_with_care')?.text).toContain(
      'closing a tab with unsaved content',
    )
    // Position unchanged: right after the doing-tasks block, before autonomy.
    const names = holderNames(parts)
    expect(names.indexOf('executing_with_care')).toBe(
      names.indexOf('agent_doing_tasks') + 1,
    )
    expect(names.indexOf('agent_autonomy')).toBe(
      names.indexOf('executing_with_care') + 1,
    )
  })

  it('providerId alone selects NO prose variant — the profile is the only prose axis', async () => {
    // Guards the plumbing contract: the resolution (provider/model → profile)
    // lives in `engine/systemPromptSources.ts`. A caller that passes only `providerId`
    // gets the base files, even for the first-party Anthropic id.
    const parts = await loadSystemPromptSections({
      tools: NO_TOOLS,
      templateType: 'code',
      providerId: 'anthropic',
    })
    expect(holder(parts, 'system')?.text).toContain('# How this session works')
    expect(holder(parts, 'system')?.text).not.toContain('# Harness')
    expect(holder(parts, 'code_doing_tasks')?.text).toContain('# Approach to tasks')
  })
})

describe('loadSystemPromptHolders — session-specific guidance', () => {
  const AGENT_ONLY: ToolContractList = [tool('Agent')] as ToolContractList
  const AGENT_WITH_SEARCH: ToolContractList = [
    tool('Agent'),
    tool('Glob'),
    tool('Grep'),
  ] as ToolContractList

  it('folds the guidance into base.post — after the catalog, before the tail', async () => {
    withFetchMock()
    const { parts, text } = await resolveLoaded(
      { tools: AGENT_WITH_SEARCH },
      fakeCatalogRenderer(),
    )
    // Folded into base.post rather than adding a 4th cache breakpoint.
    expect(holderNames(parts)).toEqual(['base.pre', 'using-your-tools', 'base.post'])
    // Ordering in the resolved text: catalog → guidance → static tail closer.
    const catalogAt = text.indexOf('# Using your tools')
    const guidanceAt = text.search(/^# Subagents$/m)
    const tailAt = text.indexOf('tail content')
    expect(catalogAt).toBeGreaterThanOrEqual(0)
    expect(catalogAt).toBeLessThan(guidanceAt)
    expect(guidanceAt).toBeLessThan(tailAt)
    expect(text).toMatch(/subagent_type=Explore/)
    expect(text).toMatch(/tail content$/)
  })

  it('omits the Explore bullet when the session has no search tools', async () => {
    withFetchMock()
    const { text } = await resolveLoaded({ tools: AGENT_ONLY }, fakeCatalogRenderer())
    expect(text).toMatch(/^# Subagents$/m)
    expect(text).toMatch(/Use the Agent tool with a specialized agent/)
    expect(text).not.toMatch(/subagent_type=Explore/)
  })

  it('emits no guidance section when the Agent tool is absent', async () => {
    withFetchMock()
    const { text } = await resolveLoaded(
      { tools: STUBBED_BROWSER_TOOLS },
      fakeCatalogRenderer(),
    )
    expect(text).not.toMatch(/^# (Subagents|Skills|Subagents and skills)$/m)
  })
})

describe('loadSystemPromptHolders — JS skill catalogs (a2ui-style)', () => {
  afterEach(() => __resetSkillCatalogsForTest())

  it('emits a registered skill catalog holder after using-your-tools when its tool is visible', async () => {
    withFetchMock()
    registerSkillCatalog({
      skillName: 'demo',
      toolNames: ['demo_tool'],
      holderName: 'skill.demo.catalog',
      content: '## Demo tools\n- demo_tool — does a thing.',
    })
    const parts = await loadSystemPromptSections({
      tools: [tool('demo_tool')] as ToolContractList,
      visibleToolNames: ['demo_tool'],
      promptSectionRenderer: fakeCatalogRenderer(),
    })
    // Positioned right AFTER the host-rendered catalog, before base.post.
    expect(holderNames(parts)).toEqual([
      'base.pre',
      'using-your-tools',
      'skill.demo.catalog',
      'base.post',
    ])
    const demo = parts.find(
      p => p.name === 'skill.demo.catalog',
    )!
    // Ships its content as the carried default (host resolves override ?? default).
    expect(demo.text).toContain('## Demo tools')
  })

  it('omits the skill catalog holder when its tool is NOT visible (deferred)', async () => {
    withFetchMock()
    registerSkillCatalog({
      skillName: 'demo',
      toolNames: ['demo_tool'],
      holderName: 'skill.demo.catalog',
      content: '## Demo tools',
    })
    const parts = await loadSystemPromptSections({
      tools: [tool('demo_tool')] as ToolContractList,
      visibleToolNames: [], // deferred-inactive → not visible
      promptSectionRenderer: fakeCatalogRenderer(),
    })
    expect(holderNames(parts)).not.toContain('skill.demo.catalog')
  })

  it('gates by PREDICATE when the skill\'s tools are host-published', async () => {
    // The browser skill's `Browser*` tools come from the C++ catalog per build,
    // so its registration cannot enumerate them without drifting from the host
    // — it supplies `matchesToolName` instead of `toolNames`. This is what makes
    // the browser catalog appear on Skill('browser') and stay hidden before it,
    // now that `# Tools` is static per-type prose that cannot gate
    // anything. Pinned end-to-end by nexus-tools-defer.spec.ts; pinned here so a
    // regression fails in seconds instead of in an 11-minute e2e.
    withFetchMock()
    registerSkillCatalog({
      skillName: 'browser',
      toolNames: [], // deliberately empty — the predicate is the gate
      matchesToolName: name => name.startsWith('Browser'),
      holderName: 'skill.browser.catalog',
      content: '## Browser tools\n- BrowserNavigate { url }',
    })
    // Deferred-inactive: no Browser* tool is visible → no catalog.
    const hidden = await loadSystemPromptSections({
      tools: [tool('BrowserNavigate')] as ToolContractList,
      visibleToolNames: [],
      promptSectionRenderer: fakeCatalogRenderer(),
    })
    expect(holderNames(hidden)).not.toContain('skill.browser.catalog')
    // Activated: a host-published Browser* name the registration never listed
    // still matches, which a fixed `toolNames` array could not do.
    const shown = await loadSystemPromptSections({
      tools: [tool('BrowserNavigate')] as ToolContractList,
      visibleToolNames: ['BrowserSomeFutureTool'],
      promptSectionRenderer: fakeCatalogRenderer(),
    })
    expect(holderNames(shown)).toContain('skill.browser.catalog')
  })
})

describe('loadSystemPromptHolders — deferred skills are fully hidden (regression)', () => {
  // Regression for the deferred-tool catalog leak: a deferred-and-inactive
  // skill (browser, a2ui, …) must NOT appear in the catalog's enabledToolNames,
  // must NOT have its JS skill-catalog emitted, and (browser) must NOT leave its
  // cross-cutting `{{system-prompt-tools}}` cheatsheet inlined mid-prompt — its
  // schemas are already correctly absent from tools[]. Before the fix the
  // browser cheatsheet rendered unconditionally; assertion (c) catches that.
  afterEach(() => __resetSkillCatalogsForTest())

  // Inlines the cross-cutting browser prose mid-body, like the real
  // `doing_tasks` holder does via {{system-prompt-tools}}.
  const TPL = [
    'You are {{AGENT_NAME}}.',
    '',
    '# Approach to tasks',
    '- act',
    '{{system-prompt-tools}}',
    '- report',
    '',
    '{{TOOL_CATALOG}}',
    '',
    'tail',
  ].join('\n')

  // The host renders the browser-only cheatsheet for the system-prompt-tools
  // slot. Every render request is recorded so a test can read the tool set
  // the catalog was rendered for.
  let renderCalls: Array<{ name: string; enabledToolNames: string[] }> = []
  const sysToolsRenderer = (params: {
    name: 'system-prompt-tools' | 'using-your-tools'
    enabledToolNames: string[]
  }) => {
    renderCalls.push({ name: params.name, enabledToolNames: [...params.enabledToolNames] })
    return { text: '<<BROWSER-CHEATSHEET>>' }
  }
  beforeEach(() => {
    renderCalls = []
  })

  function catalogArgs(): string[] {
    return renderCalls.find(c => c.name === 'using-your-tools')?.enabledToolNames ?? []
  }
  function preDefault(parts: PromptChunk[]): string {
    const pre = parts.find(
      p => p.name === 'base.pre',
    )!
    return pre.text ?? ''
  }

  it('hides catalog tools, the a2ui catalog, AND the browser cheatsheet while deferred-inactive', async () => {
    withFetchMock(TPL)
    registerSkillCatalog({
      skillName: 'a2ui',
      toolNames: ['a2ui_create_surface'],
      holderName: 'skill.a2ui.catalog',
      content: '## A2UI tools',
    })
    const parts = await loadSystemPromptSections({
      tools: [tool('BrowserClick'), tool('a2ui_create_surface')] as ToolContractList,
      visibleToolNames: [], // browser + a2ui deferred-inactive
      promptSectionRenderer: sysToolsRenderer,
    })
    // (a) the catalog is rendered for ONLY the visible set (empty here).
    expect(catalogArgs()).toEqual([])
    // (b) the a2ui JS skill-catalog is not emitted.
    expect(holderNames(parts)).not.toContain('skill.a2ui.catalog')
    // (c) the browser-only system-prompt-tools cheatsheet is not inlined.
    expect(preDefault(parts)).not.toContain('<<BROWSER-CHEATSHEET>>')
  })

  it('reveals catalog tools, the a2ui catalog, AND the cheatsheet once the skills are active', async () => {
    withFetchMock(TPL)
    registerSkillCatalog({
      skillName: 'a2ui',
      toolNames: ['a2ui_create_surface'],
      holderName: 'skill.a2ui.catalog',
      content: '## A2UI tools',
    })
    const parts = await loadSystemPromptSections({
      tools: [tool('BrowserClick'), tool('a2ui_create_surface')] as ToolContractList,
      visibleToolNames: ['BrowserClick', 'a2ui_create_surface'], // both active
      promptSectionRenderer: sysToolsRenderer,
    })
    expect(catalogArgs()).toEqual(['BrowserClick', 'a2ui_create_surface'])
    expect(holderNames(parts)).toContain('skill.a2ui.catalog')
    expect(preDefault(parts)).toContain('<<BROWSER-CHEATSHEET>>')
  })
})
