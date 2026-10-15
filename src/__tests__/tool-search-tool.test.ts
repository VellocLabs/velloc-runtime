import { afterEach, describe, expect, it } from 'vitest'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { WorkingState } from '../runtime/RuntimeTypes'
import type { ToolContractList } from '../toolkit/toolContract'
import { declareTool } from '../toolkit/toolContract'
import { deferredLoaderTool } from '../toolkit/builtin/toolSearch'
import { nameWords, parseSelectList, rankByKeywords } from '../toolkit/builtin/toolSearch/ranking'
import {
  getActiveSkills,
  registerDeferrableSkills,
} from '../toolkit/run/deferredTools'

afterEach(() => {
  registerDeferrableSkills([]) // resets unit defaults + group-tool map
})

const PARENT_MESSAGE = {
  type: 'assistant',
  uuid: 'a-1',
  message: { role: 'assistant', content: [] },
} as never
const ALLOW = async () => ({ behavior: 'allow' as const })

function browserTool(name: string, hint: string) {
  return declareTool({
    name,
    skill: 'browser',
    discoveryHint: hint,
    argsSchema: { type: 'object', properties: {} },
    description: async () => name,
    async call() {
      return { data: 'ok' }
    },
  })
}

const BROWSER_TOOLS: ToolContractList = [
  browserTool('BrowserClick', 'click an element on the page'),
  browserTool('BrowserScroll', 'scroll the page up or down'),
  browserTool('BrowserNavigate', 'open a url'),
]

function makeContext() {
  let state: WorkingState = createEmptyAppState()
  return createNoopToolUseContext({
    tools: [deferredLoaderTool, ...BROWSER_TOOLS],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: state,
    setAppState: updater => {
      state = updater(state)
    },
    sessionId: 'ts-test',
  })
}

describe('deferred-tool loader (skill-gating)', () => {
  it('is enabled only when at least one skill is currently deferred', () => {
    expect(deferredLoaderTool.offeredNow()).toBe(false) // empty registry
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    expect(deferredLoaderTool.offeredNow()).toBe(true)
  })

  it('description lists deferred-skill tools by name', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const desc = await deferredLoaderTool.description({ query: '' }, {
      isNonInteractiveSession: true,
      permissionRules: { mode: 'default' } as never,
      tools: [deferredLoaderTool, ...BROWSER_TOOLS],
    })
    expect(desc).toContain('BrowserClick')
    expect(desc).toContain('BrowserScroll')
  })

  it('select: activates the owning skill of the named tool', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const ctx = makeContext()
    const r = await deferredLoaderTool.call(
      { query: 'select:BrowserClick' },
      ctx,
      ALLOW,
      PARENT_MESSAGE,
    )
    expect(r.data).toContain('BrowserClick')
    // Activating one browser tool unlocks the whole browser skill.
    expect(getActiveSkills(ctx.readAppState())).toContain('browser')
  })

  it('keyword search activates the matched tool’s skill', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const ctx = makeContext()
    const r = await deferredLoaderTool.call(
      { query: 'scroll' },
      ctx,
      ALLOW,
      PARENT_MESSAGE,
    )
    expect(r.data).toContain('BrowserScroll')
    expect(getActiveSkills(ctx.readAppState())).toContain('browser')
  })

  it('returns a no-match message without activating anything', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const ctx = makeContext()
    const r = await deferredLoaderTool.call(
      { query: 'wxyz-nonexistent' },
      ctx,
      ALLOW,
      PARENT_MESSAGE,
    )
    expect(r.data).toMatch(/No matching deferred tools/)
    expect(getActiveSkills(ctx.readAppState()).size).toBe(0)
  })

  describe('sealed units (never surfaceable)', () => {
    // SafeCode's shell wiring: Bash is registered (for the exec tool's
    // dispatch) but sealed — ToolSearch must not list, select, or activate it.
    const sealedShell = {
      name: 'shell',
      defaultDeferred: true,
      toolNames: ['BrowserClick', 'BrowserScroll', 'BrowserNavigate'] as const,
      sealed: true,
    }

    it('a sealed unit alone leaves ToolSearch disabled', () => {
      registerDeferrableSkills([sealedShell])
      expect(deferredLoaderTool.offeredNow()).toBe(false)
    })

    it('sealed tools are absent from the catalog', async () => {
      registerDeferrableSkills([sealedShell])
      const desc = await deferredLoaderTool.description({ query: '' }, {
        isNonInteractiveSession: true,
        permissionRules: { mode: 'default' } as never,
        tools: [deferredLoaderTool, ...BROWSER_TOOLS],
      })
      expect(desc).not.toContain('BrowserClick')
      expect(desc).toContain('No deferred tools are currently available.')
    })

    it('select: cannot resolve or activate a sealed tool', async () => {
      registerDeferrableSkills([sealedShell])
      const ctx = makeContext()
      const r = await deferredLoaderTool.call(
        { query: 'select:BrowserClick' },
        ctx,
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(r.data).toMatch(/No matching deferred tools/)
      expect(getActiveSkills(ctx.readAppState()).size).toBe(0)
    })

    it('keyword search never matches a sealed tool', async () => {
      registerDeferrableSkills([sealedShell])
      const ctx = makeContext()
      const r = await deferredLoaderTool.call(
        { query: 'click' },
        ctx,
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(r.data).toMatch(/No matching deferred tools/)
      expect(getActiveSkills(ctx.readAppState()).size).toBe(0)
    })
  })

  describe('per-runtime keying (sibling sessions in one SharedWorker realm)', () => {
    // Each runtime registers ITS deferral config under its RuntimeConfig key,
    // and ToolSearch resolves against the CALLER's key (context / description
    // options). Pre-fix the registry was module-global: a sibling session's
    // registration replaced it wholesale, so a sealed tool became selectable
    // and the catalog rendered the sibling's world.
    const keyA = { runtime: 'A' }
    const keyB = { runtime: 'B' }
    const sealedShell = {
      name: 'shell',
      defaultDeferred: true,
      toolNames: ['BrowserClick', 'BrowserScroll', 'BrowserNavigate'] as const,
      sealed: true,
    }
    function keyedContext(key: object) {
      const ctx = makeContext()
      ;(ctx.options as { runtimeConfig?: object }).runtimeConfig = key
      return ctx
    }

    it('select: still refuses a sealed tool after a sibling session registers', async () => {
      registerDeferrableSkills([sealedShell], keyA)
      // Sibling session: ordinary config, registered LAST (this used to wipe
      // A's sealed set and make the select succeed).
      registerDeferrableSkills([{ name: 'a2ui', defaultDeferred: true }], keyB)
      const ctx = keyedContext(keyA)
      const r = await deferredLoaderTool.call(
        { query: 'select:BrowserClick' },
        ctx,
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(r.data).toMatch(/No matching deferred tools/)
      expect(getActiveSkills(ctx.readAppState()).size).toBe(0)
    })

    it('the catalog renders the calling runtime’s deferred set, not the last-registered sibling’s', async () => {
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], keyA)
      registerDeferrableSkills([], keyB) // sibling: nothing deferred
      const descOptions = (key: object) => ({
        isNonInteractiveSession: true,
        permissionRules: { mode: 'default' } as never,
        tools: [deferredLoaderTool, ...BROWSER_TOOLS],
        runtimeConfig: key as never,
      })
      const descA = await deferredLoaderTool.description({ query: '' }, descOptions(keyA))
      expect(descA).toContain('BrowserClick')
      const descB = await deferredLoaderTool.description({ query: '' }, descOptions(keyB))
      expect(descB).toContain('No deferred tools are currently available.')
    })

    it('select: through runtime A’s context still works after runtime B registers', async () => {
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], keyA)
      registerDeferrableSkills([], keyB) // pre-fix this wiped A's deferral
      const ctx = keyedContext(keyA)
      const r = await deferredLoaderTool.call(
        { query: 'select:BrowserClick' },
        ctx,
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(r.data).toContain('BrowserClick')
      expect(getActiveSkills(ctx.readAppState())).toContain('browser')
    })
  })
})

// ── behaviour pins: ranking, select form, activation, frozen texts ──

function plainTool(name: string, opts: { skill?: string; hint?: string } = {}) {
  return declareTool({
    name,
    ...(opts.skill ? { skill: opts.skill } : {}),
    ...(opts.hint !== undefined ? { discoveryHint: opts.hint } : {}),
    argsSchema: { type: 'object', properties: {} },
    description: async () => name,
    async call() {
      return { data: 'ok' }
    },
  })
}

function contextWith(tools: ToolContractList) {
  let state: WorkingState = createEmptyAppState()
  return createNoopToolUseContext({
    tools: [deferredLoaderTool, ...tools],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: state,
    setAppState: updater => {
      state = updater(state)
    },
    sessionId: 'ts-gap',
  })
}

async function run(tools: ToolContractList, query: string, max_results?: number) {
  const ctx = contextWith(tools)
  const input = max_results === undefined ? { query } : { query, max_results }
  const r = await deferredLoaderTool.call(input, ctx, ALLOW, PARENT_MESSAGE)
  return { text: r.data, active: [...getActiveSkills(ctx.readAppState())] }
}

const loaded = (names: string[]) =>
  `Loaded ${names.length} tool schema(s): ${names.join(', ')}. They are now callable — invoke them directly.`

describe('deferred-tool loader: ranking', () => {
  it('splits camel-case and mcp__ names into words', () => {
    expect(nameWords('BrowserScrollToElement')).toEqual(['browser', 'scroll', 'to', 'element'])
    expect(nameWords('mcp__my_server__do_thing')).toEqual(['my', 'server', 'do', 'thing'])
    expect(nameWords('a2ui_create_surface')).toEqual(['a2ui', 'create', 'surface'])
  })

  it('weights an exact word 10, a partial word 5, a hint hit 4', () => {
    const c = [
      { name: 'ReadLog', discoveryHint: '' },
      { name: 'FileRead', discoveryHint: 'read a file' },
      { name: 'FileWriter', discoveryHint: 'write files' },
    ]
    // FileRead 10+4 beats ReadLog 10; FileWriter scores 0 and is dropped.
    expect(rankByKeywords('read', c, 5)).toEqual(['FileRead', 'ReadLog'])
    // 'fil': FileRead 5+4 and FileWriter 5+4 tie → list order kept.
    expect(rankByKeywords('fil', c, 5)).toEqual(['FileRead', 'FileWriter'])
    // Hint-only hits (4 each) also keep list order.
    expect(rankByKeywords('a', [{ name: 'Zz', discoveryHint: 'a' }, { name: 'Yy', discoveryHint: 'a b' }], 5))
      .toEqual(['Zz', 'Yy'])
  })

  it('sums scores across terms', () => {
    const c = [
      { name: 'BrowserClick', discoveryHint: 'click an element on the page' },
      { name: 'BrowserScroll', discoveryHint: 'scroll the page up or down' },
    ]
    // scroll: 10+4 on BrowserScroll; page: 4 each.
    expect(rankByKeywords('page scroll', c, 5)).toEqual(['BrowserScroll', 'BrowserClick'])
  })

  it('+terms are required; a lone + is an ordinary (non-matching) term', () => {
    const c = [
      { name: 'BrowserClick', discoveryHint: 'click an element on the page' },
      { name: 'BrowserScroll', discoveryHint: 'scroll the page up or down' },
    ]
    expect(rankByKeywords('+click page', c, 5)).toEqual(['BrowserClick'])
    expect(rankByKeywords('+absent page', c, 5)).toEqual([])
    expect(rankByKeywords('+ page', c, 5)).toEqual(['BrowserClick', 'BrowserScroll'])
  })

  it('an exact (case-insensitive) name returns just that tool, ignoring max_results', () => {
    const c = [{ name: 'BrowserScroll' }, { name: 'BrowserScrollToElement' }]
    expect(rankByKeywords('  browserscroll ', c, 5)).toEqual(['BrowserScroll'])
    expect(rankByKeywords('BrowserScroll', c, 0)).toEqual(['BrowserScroll'])
  })

  it('max_results ≤ 0 yields no keyword matches', () => {
    const c = [{ name: 'BrowserScroll' }]
    expect(rankByKeywords('scroll', c, 0)).toEqual([])
    expect(rankByKeywords('scroll', c, -1)).toEqual([])
  })

  it('parses select lists case-insensitively, only at position 0', () => {
    expect(parseSelectList('SELECT: A , ,b')).toEqual(['A', 'b'])
    expect(parseSelectList(' select:A')).toBeNull()
    expect(parseSelectList('scroll')).toBeNull()
  })
})

describe('deferred-tool loader: call behaviour', () => {
  it('max_results defaults to 5 and honours explicit values', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const many = [1, 2, 3, 4, 5, 6, 7].map(i => plainTool(`Item${i}`, { skill: 'browser', hint: 'thing' }))
    expect((await run(many, 'thing')).text).toBe(loaded(['Item1', 'Item2', 'Item3', 'Item4', 'Item5']))
    expect((await run(many, 'thing', 2)).text).toBe(loaded(['Item1', 'Item2']))
    expect((await run(many, 'thing', 0)).text).toBe(
      'No matching deferred tools found for "thing". 7 deferred tool(s) available — try a different keyword or "select:<name>".',
    )
  })

  it('select: is case-insensitive, de-duplicated, drops unknown names, ignores max_results', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const r = await run(BROWSER_TOOLS, 'SELECT:browserclick, BrowserClick ,nope,browsernavigate', 1)
    expect(r.text).toBe(loaded(['BrowserClick', 'BrowserNavigate']))
    expect(r.active).toEqual(['browser'])
  })

  it('a leading space turns select: into a keyword search', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const r = await run(BROWSER_TOOLS, ' select:BrowserClick')
    expect(r.text).toMatch(/^No matching deferred tools found for " select:BrowserClick"\. 3 deferred/)
  })

  it('select: falls back to an already-loaded, non-sealed tool', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const r = await run([...BROWSER_TOOLS, plainTool('Plain')], 'select:plain')
    expect(r.text).toBe(loaded(['Plain']))
    expect(r.active).toEqual([])
  })

  it('activates group units and de-duplicates units across matches', async () => {
    registerDeferrableSkills([
      { name: 'grp', defaultDeferred: true, toolNames: ['G1', 'G2'] },
      { name: 'browser', defaultDeferred: true },
    ])
    const tools = [plainTool('G1'), plainTool('G2'), ...BROWSER_TOOLS]
    const r = await run(tools, 'select:G1,G2,BrowserClick,BrowserScroll')
    expect(r.text).toBe(loaded(['G1', 'G2', 'BrowserClick', 'BrowserScroll']))
    expect(r.active).toEqual(['grp', 'browser'])
  })

  it('rejects an empty or whitespace query', async () => {
    const ctx = contextWith([])
    for (const query of ['', '   ']) {
      expect(await deferredLoaderTool.checkInput!({ query }, ctx)).toEqual({
        result: false,
        message: 'query is required and must be a non-empty string.',
        errorCode: 1,
      })
    }
    expect(await deferredLoaderTool.checkInput!({ query: 'x' }, ctx)).toEqual({ result: true })
  })
})

describe('deferred-tool loader: frozen texts', () => {
  const descOpts = (tools: ToolContractList) => ({
    isNonInteractiveSession: true,
    permissionRules: { mode: 'default' } as never,
    tools,
  })
  const SUMMARY =
    'Loads the parameter schema for a deferred tool so it can be called. Until loaded, only a deferred tool\'s name is known — calling it directly fails. Provide "select:Name" to load specific tools, or keywords to search.'
  const CATALOG =
    'Deferred tools (names known, schemas NOT loaded — call ToolSearch to load before invoking):\n' +
    '- BrowserClick — click an element on the page\n' +
    '- NoHint'

  it('renders the description byte-for-byte', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const tools = [deferredLoaderTool, BROWSER_TOOLS[0]!, plainTool('NoHint', { skill: 'browser' })]
    expect(await deferredLoaderTool.description({ query: '' }, descOpts(tools))).toBe(
      `${SUMMARY}\n\n${CATALOG}`,
    )
  })

  it('renders the empty-catalog line', async () => {
    const tools = [deferredLoaderTool, ...BROWSER_TOOLS]
    expect(await deferredLoaderTool.description({ query: '' }, descOpts(tools))).toBe(
      `${SUMMARY}\n\nNo deferred tools are currently available.`,
    )
  })

  it('keeps the tool name, schema and flags', () => {
    expect(deferredLoaderTool.name).toBe('ToolSearch')
    expect(deferredLoaderTool.discoveryHint).toBe(
      'load the parameter schema for a deferred tool so it can be called',
    )
    expect(deferredLoaderTool.readsOnly({ query: 'x' })).toBe(true)
    expect(deferredLoaderTool.parallelSafe({ query: 'x' })).toBe(true)
  })
})
