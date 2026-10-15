import { afterEach, describe, expect, it } from 'vitest'
import type { WorkingState, ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import { executeToolCall } from '../toolkit/run/executeToolCall'
import {
  activateSkills,
  augmentedAppStateForDeferral,
  deriveActivatedSkillsFromMessages,
  getActiveSkills,
  groupUnitForTool,
  hiddenToolCallMessage,
  isAnySkillDeferred,
  isDeferredSkill,
  isSkillActive,
  isSkillDeferred,
  isSkillSealed,
  registerDeferrableSkills,
  shouldHideToolFromModel,
} from '../toolkit/run/deferredTools'

// The per-unit registry is process-global; reset after each test so the empty
// invariants hold for unrelated suites.
afterEach(() => {
  registerDeferrableSkills([]) // resets unit defaults + group-tool map
})

function appState(overrides: Partial<WorkingState> = {}): WorkingState {
  return {
    permissionRules: { mode: 'default' },
    ...overrides,
  } as WorkingState
}

type ToolLike = { name: string; skill?: string }
const browserTool: ToolLike = { name: 'BrowserClick', skill: 'browser' }
const fileTool: ToolLike = { name: 'Read' } // no skill → always loaded
const alwaysOnSkillTool: ToolLike = { name: 'TodoWrite', skill: 'core' } // not registered

describe('deferredTools (per-skill gating)', () => {
  describe('per-unit default (template-driven, no override)', () => {
    it('nothing deferred by default (empty registry)', () => {
      expect(isAnySkillDeferred()).toBe(false)
      expect(isSkillDeferred('browser')).toBe(false)
    })
    it('a defaultDeferred:true unit is deferred; defaultDeferred:false is not', () => {
      registerDeferrableSkills([
        { name: 'agent-teams', defaultDeferred: true },
        { name: 'browser', defaultDeferred: false },
      ])
      expect(isSkillDeferred('agent-teams')).toBe(true)
      expect(isSkillDeferred('browser')).toBe(false)
      expect(isAnySkillDeferred()).toBe(true)
    })
    it('a deferred GROUP unit defers its tools by name', () => {
      registerDeferrableSkills([
        { name: 'shell', defaultDeferred: true, toolNames: ['Bash', 'PowerShell'] },
      ])
      expect(isSkillDeferred('shell')).toBe(true)
      expect(isAnySkillDeferred()).toBe(true)
    })
  })

  describe('deferrable-skill registry', () => {
    it('is empty by default', () => {
      expect(isDeferredSkill('browser')).toBe(false)
    })
    it('reflects registered deferrable skills (regardless of default)', () => {
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: false }])
      expect(isDeferredSkill('browser')).toBe(true)
      expect(isDeferredSkill('core')).toBe(false)
      expect(isDeferredSkill(undefined)).toBe(false)
    })
  })

  describe('shouldHideToolFromModel', () => {
    it('does not hide a skill whose switch is off (defaultDeferred:false)', () => {
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: false }])
      expect(shouldHideToolFromModel(browserTool, appState())).toBe(false)
    })
    it('hides a deferred-skill tool that is not yet active', () => {
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
      expect(shouldHideToolFromModel(browserTool, appState())).toBe(true)
    })
    it('does NOT hide once the skill is active', () => {
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
      const s = appState({ activeSkills: ['browser'] })
      expect(shouldHideToolFromModel(browserTool, s)).toBe(false)
    })
    it('never hides a tool with no skill', () => {
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
      expect(shouldHideToolFromModel(fileTool, appState())).toBe(false)
    })
    it('never hides a tool whose skill is not registered', () => {
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
      expect(shouldHideToolFromModel(alwaysOnSkillTool, appState())).toBe(false)
    })
  })

  describe('activation', () => {
    it('reads active skills from the JSONL-friendly array', () => {
      const s = appState({ activeSkills: ['browser', 'code'] })
      expect(getActiveSkills(s)).toEqual(new Set(['browser', 'code']))
      expect(isSkillActive(s, 'browser')).toBe(true)
      expect(isSkillActive(s, 'nope')).toBe(false)
    })

    it('activateSkills is additive, de-duped, and sticky', () => {
      let state = appState({ activeSkills: ['a'] })
      const setAppState = (f: (prev: WorkingState) => WorkingState) => {
        state = f(state)
      }
      activateSkills(setAppState, ['b', 'c', 'b'])
      expect(state.activeSkills).toEqual(['a', 'b', 'c'])
      const before = state
      activateSkills(setAppState, ['a', 'c'])
      expect(state).toBe(before) // no change → identity preserved
    })

    it('no-ops on empty input', () => {
      let state = appState()
      const before = state
      activateSkills(f => {
        state = f(state)
      }, [])
      expect(state).toBe(before)
    })
  })

  describe('sealed units (template sealedTools — the hard tier)', () => {
    // SafeCode's shell wiring: Bash registered so the `exec` tool can dispatch
    // through the Bash gate, but permanently invisible and non-activatable.
    const sealedShell = {
      name: 'shell',
      defaultDeferred: true,
      toolNames: ['Bash', 'PowerShell'] as const,
      sealed: true,
    }
    const bash: ToolLike = { name: 'Bash' }

    it('a sealed unit is deferred AND sealed', () => {
      registerDeferrableSkills([sealedShell])
      expect(isSkillDeferred('shell')).toBe(true)
      expect(isSkillSealed('shell')).toBe(true)
    })

    it('does NOT count toward isAnySkillDeferred (ToolSearch has nothing to load)', () => {
      registerDeferrableSkills([sealedShell])
      expect(isAnySkillDeferred()).toBe(false)
      // A regular deferred unit alongside still arms ToolSearch.
      registerDeferrableSkills([sealedShell, { name: 'browser', defaultDeferred: true }])
      expect(isAnySkillDeferred()).toBe(true)
    })

    it('stays hidden even when (buggily) present in activeSkills', () => {
      registerDeferrableSkills([sealedShell])
      const active = appState({ activeSkills: ['shell'] })
      expect(shouldHideToolFromModel(bash, active)).toBe(true)
    })

    it('activateSkills refuses a sealed unit (defense in depth)', () => {
      registerDeferrableSkills([sealedShell, { name: 'browser', defaultDeferred: true }])
      let state = appState()
      activateSkills(f => {
        state = f(state)
      }, ['shell', 'browser'])
      expect(state.activeSkills).toEqual(['browser'])
    })
  })

  describe('per-runtime keyed registries (SharedWorker realm coexistence)', () => {
    // The SharedWorker hosts EVERY session's runtime in one JS realm, and each
    // createAgentRuntime registers its own template's deferral config. These
    // pin the fix for the last-writer-wins bug: creating a SECOND session used
    // to replace the FIRST session's registry wholesale, so the first
    // session's deferred (or sealed) tools un-hid on its very next turn.
    const keyA = { runtime: 'A' }
    const keyB = { runtime: 'B' }

    it('a sibling registration does not replace a keyed runtime’s config', () => {
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], keyA)
      // Runtime B (a newly created sibling session) registers a DIFFERENT
      // config — on the old module-global registry this wiped A's.
      registerDeferrableSkills([{ name: 'a2ui', defaultDeferred: true }], keyB)

      // A's view is untouched…
      expect(isSkillDeferred('browser', keyA)).toBe(true)
      expect(shouldHideToolFromModel(browserTool, appState(), keyA)).toBe(true)
      // …and does not leak into B's.
      expect(isSkillDeferred('browser', keyB)).toBe(false)
      expect(shouldHideToolFromModel(browserTool, appState(), keyB)).toBe(false)
      expect(isSkillDeferred('a2ui', keyB)).toBe(true)
    })

    it('a SEALED unit survives a sibling registration (the security shape)', () => {
      const sealedShell = {
        name: 'shell',
        defaultDeferred: true,
        toolNames: ['Bash', 'PowerShell'] as const,
        sealed: true,
      }
      const bash: ToolLike = { name: 'Bash' }
      registerDeferrableSkills([sealedShell], keyA)
      // Sibling session with an ordinary config (no shell unit at all).
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], keyB)

      // Pre-fix: groupToolUnits was emptied for Bash → units=[] → the gate
      // returned false and Bash re-entered tools[] / passed dispatch.
      expect(groupUnitForTool('Bash', keyA)).toBe('shell')
      expect(isSkillSealed('shell', keyA)).toBe(true)
      expect(shouldHideToolFromModel(bash, appState(), keyA)).toBe(true)
      // Even a (buggy) activeSkills entry cannot surface it.
      expect(
        shouldHideToolFromModel(bash, appState({ activeSkills: ['shell'] }), keyA),
      ).toBe(true)
      // activateSkills keyed to A still refuses the sealed unit.
      let state = appState()
      activateSkills(
        f => {
          state = f(state)
        },
        ['shell'],
        keyA,
      )
      expect(state.activeSkills ?? []).toEqual([])
    })

    it('a keyed MISS resolves to the empty registry, never the last writer', () => {
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
      const neverRegistered = { runtime: 'ghost' }
      expect(isSkillDeferred('browser', neverRegistered)).toBe(false)
      expect(isAnySkillDeferred(neverRegistered)).toBe(false)
      expect(groupUnitForTool('Bash', neverRegistered)).toBeUndefined()
    })

    it('keyless reads track the most recent registration (construction-time isEnabled contract)', () => {
      // createAgentRuntime evaluates tool isEnabled() synchronously right
      // after ITS registration — the keyless slot must hold it there.
      registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], keyA)
      expect(isAnySkillDeferred()).toBe(true)
      registerDeferrableSkills([], keyB)
      expect(isAnySkillDeferred()).toBe(false)
    })

    it('augmentedAppStateForDeferral keys off context.options.runtimeConfig', () => {
      registerDeferrableSkills([{ name: 'a2ui', defaultDeferred: true }], keyA)
      registerDeferrableSkills([], keyB) // sibling: nothing deferred
      const a2uiTool = { name: 'a2ui_update_data_model', skill: 'a2ui' }
      const toolSearchCall = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolName: 'ToolSearch',
              args: { query: 'select:a2ui_update_data_model' },
            },
          ],
        },
      } as unknown as Message
      const ctx = (runtimeConfig: object, messages: readonly Message[]) => ({
        readAppState: () =>
          ({ permissionRules: { mode: 'default' }, activeSkills: [] }) as WorkingState,
        messages,
        options: { tools: [a2uiTool], runtimeConfig },
      })

      // Runtime A: gate armed, transcript-derived activation recovered via
      // A's OWN registry — a sibling's later (empty) registration is inert.
      expect(
        shouldHideToolFromModel(a2uiTool, augmentedAppStateForDeferral(ctx(keyA, [])), keyA),
      ).toBe(true)
      expect(
        shouldHideToolFromModel(
          a2uiTool,
          augmentedAppStateForDeferral(ctx(keyA, [toolSearchCall])),
          keyA,
        ),
      ).toBe(false)
      // Runtime B: nothing deferred → nothing hidden.
      expect(
        shouldHideToolFromModel(a2uiTool, augmentedAppStateForDeferral(ctx(keyB, [])), keyB),
      ).toBe(false)
    })
  })

  describe('deriveActivatedSkillsFromMessages (resume rehydration)', () => {
    function assistantSkillCall(skill: string): Message {
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 't1', toolName: 'Skill', args: { skill, args: '…' } },
          ],
        },
      } as unknown as Message
    }

    it('derives a skill from a Skill tool-call', () => {
      expect(
        deriveActivatedSkillsFromMessages([
          { type: 'user', message: { role: 'user', content: 'make a counter' } } as unknown as Message,
          assistantSkillCall('a2ui'),
        ]),
      ).toEqual(['a2ui'])
    })

    it('derives skills from an invoked_skills attachment (survives compaction)', () => {
      const messages = [
        {
          type: 'attachment',
          attachment: {
            type: 'invoked_skills',
            skills: [{ name: 'browser', path: '/x', content: '…' }],
          },
        },
      ] as unknown as Message[]
      expect(deriveActivatedSkillsFromMessages(messages)).toEqual(['browser'])
    })

    it('de-dupes across both signals and ignores non-Skill tool-calls', () => {
      const messages = [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolName: 'Read', args: { file_path: '/a' } },
              { type: 'tool-call', toolName: 'Skill', args: { skill: 'a2ui' } },
            ],
          },
        },
        {
          type: 'attachment',
          attachment: { type: 'invoked_skills', skills: [{ name: 'a2ui', path: '/x', content: '…' }] },
        },
      ] as unknown as Message[]
      expect(deriveActivatedSkillsFromMessages(messages)).toEqual(['a2ui'])
    })

    it('re-opens the gate after resume (the reload-re-defer bug)', () => {
      // A deferred skill activated in a prior turn must stay visible after a
      // reload — otherwise its tools re-hide and the model re-invokes Skill.
      registerDeferrableSkills([{ name: 'a2ui', defaultDeferred: true }])
      const a2uiTool = { name: 'a2ui_update_data_model', skill: 'a2ui' }

      // Fresh WorkingState (as a reload produces) → tool hidden.
      expect(shouldHideToolFromModel(a2uiTool, appState())).toBe(true)

      // Seed activeSkills from a transcript that shows a2ui was activated.
      const derived = deriveActivatedSkillsFromMessages([assistantSkillCall('a2ui')])
      expect(
        shouldHideToolFromModel(a2uiTool, appState({ activeSkills: derived })),
      ).toBe(false)
    })

    it('derives a skill from a ToolSearch select: call (via the tool→skill resolver)', () => {
      // The OTHER activation trigger: a real model (gpt-5.5) brings a2ui online
      // with `ToolSearch select:a2ui_create_surface`, not Skill('a2ui'). The
      // transcript records the TOOL name, so a resolver maps it back to the skill.
      const toolSearchCall = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolName: 'ToolSearch',
              args: { query: 'select:a2ui_create_surface', max_results: 1 },
            },
          ],
        },
      } as unknown as Message
      const resolve = (name: string) =>
        name.startsWith('a2ui_') ? 'a2ui' : undefined

      expect(deriveActivatedSkillsFromMessages([toolSearchCall], resolve)).toEqual([
        'a2ui',
      ])
      // Without the resolver, a ToolSearch activation is NOT recognized (the
      // transcript has tool names, not skill names) — so omitting it is exactly
      // why the reminder kept re-firing after a reload.
      expect(deriveActivatedSkillsFromMessages([toolSearchCall])).toEqual([])
    })

    it('the deferral GATE stays open after resume for a ToolSearch-activated skill (the reported bug)', () => {
      // Mirrors serializeToolsForModel (engine/turn/turnDependencies.ts): a2ui is deferred; on
      // resume appState.activeSkills is empty, so its tools would RE-HIDE and the
      // model would re-run ToolSearch on every action turn — UNLESS the gate
      // augments the active set with skills derived from the live transcript
      // (here a prior `ToolSearch select:a2ui_update_data_model`).
      registerDeferrableSkills([{ name: 'a2ui', defaultDeferred: true }])
      const a2uiTool = { name: 'a2ui_update_data_model', skill: 'a2ui' }
      const toolSearchCall = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolName: 'ToolSearch',
              args: { query: 'select:a2ui_update_data_model' },
            },
          ],
        },
      } as unknown as Message
      const resolve = (name: string) =>
        name.startsWith('a2ui_') ? 'a2ui' : undefined

      // Fresh WorkingState (as a reload produces) → tool hidden → forces ToolSearch.
      expect(shouldHideToolFromModel(a2uiTool, appState())).toBe(true)

      // Gate augments activeSkills with the transcript-derived set → tool visible,
      // so the model calls it directly (no redundant ToolSearch).
      const augmented = appState({
        activeSkills: deriveActivatedSkillsFromMessages([toolSearchCall], resolve),
      })
      expect(shouldHideToolFromModel(a2uiTool, augmented)).toBe(false)
    })

    it('augmentedAppStateForDeferral keeps a deferred skill usable after resume — BOTH gates, BOTH triggers', () => {
      // This is what the tool-VISIBILITY gate (serializeToolsForModel) AND the
      // tool-EXECUTION dispatch guard (toolExecution.ts) now both run:
      //   shouldHideToolFromModel(tool, augmentedAppStateForDeferral(context)).
      // On resume appState.activeSkills is empty; the helper recovers the skill
      // from the transcript so neither gate hides/rejects it. The dispatch-guard
      // half is the bug this guards: a direct a2ui_update_data_model call after a
      // reload was rejected ("not active yet"), forcing a re-ToolSearch.
      registerDeferrableSkills([{ name: 'a2ui', defaultDeferred: true }])
      const a2uiTool = { name: 'a2ui_update_data_model', skill: 'a2ui' }
      const tools = [
        { name: 'a2ui_update_data_model', skill: 'a2ui' },
        { name: 'a2ui_create_surface', skill: 'a2ui' },
      ]
      const ctx = (messages: unknown[]) => ({
        readAppState: () =>
          ({ permissionRules: { mode: 'default' }, activeSkills: [] }) as WorkingState,
        messages: messages as Message[],
        options: { tools },
      })
      const toolCall = (toolName: string, args: unknown) =>
        ({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool-call', toolName, args }] },
        }) as unknown as Message

      // Empty appState + empty transcript → hidden (model must activate first).
      expect(
        shouldHideToolFromModel(a2uiTool, augmentedAppStateForDeferral(ctx([]))),
      ).toBe(true)
      // Activated earlier via ToolSearch select: → recovered → usable.
      expect(
        shouldHideToolFromModel(
          a2uiTool,
          augmentedAppStateForDeferral(
            ctx([toolCall('ToolSearch', { query: 'select:a2ui_update_data_model' })]),
          ),
        ),
      ).toBe(false)
      // Activated earlier via Skill('a2ui') → recovered → usable.
      expect(
        shouldHideToolFromModel(
          a2uiTool,
          augmentedAppStateForDeferral(ctx([toolCall('Skill', { skill: 'a2ui' })])),
        ),
      ).toBe(false)
    })
  })
})

// The dispatch guard (toolExecution.ts) rejects a call to a hidden tool with a
// recoverable result that must name a route which REALLY surfaces the tool.
// Driven through runToolUse so the guard's wiring — the owning-unit resolution
// AND the runtime key it resolves against — is pinned, not just the helper.
// Before the fix every rejection read `the "${tool.skill}" skill … call Skill`:
// a group tool (no `tool.skill`) got `the "undefined" skill`, and a sealed tool
// got activation advice that ToolSearch/activateSkills refuse to honour.
describe('dispatch guard message for a hidden tool (runToolUse)', () => {
  const RUNTIME_DEPS = { uuid: () => 'test-uuid' } as QueryRuntimeDeps
  const shellGroup = {
    name: 'shell',
    defaultDeferred: true,
    toolNames: ['Bash', 'PowerShell'] as const,
  }

  function gatedTool(name: string, skill?: string) {
    let called = false
    const tool = declareTool({
      name,
      ...(skill ? { skill } : {}),
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => name,
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
      readsOnly: () => true,
    })
    return { tool, wasCalled: () => called }
  }

  async function callThroughGuard(tool: ToolContract, runtimeConfig?: object): Promise<string> {
    let state: WorkingState = createEmptyAppState()
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: state,
      setAppState: updater => {
        state = updater(state)
      },
    })
    if (runtimeConfig) context.options.runtimeConfig = runtimeConfig as never
    const assistantMessage: ModelReplyRow = {
      type: 'assistant',
      uuid: 'assistant-tc-gate',
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-gate', toolName: tool.name, args: {} }],
      },
    }
    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-gate', toolName: tool.name, args: {} },
      assistantMessage,
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    expect(updates).toHaveLength(1)
    return updates[0]!.message?.toolUseResult as string
  }

  it('a deferred SKILL tool keeps the Skill activation wording', async () => {
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }])
    const { tool, wasCalled } = gatedTool('BrowserClick', 'browser')
    const result = await callThroughGuard(tool)
    expect(wasCalled()).toBe(false)
    expect(result).toBe(
      'Tool "BrowserClick" belongs to the "browser" skill, which is not active yet, ' +
        'so its parameter schema is not loaded. Activate it first — call Skill with ' +
        'skill "browser" (or ToolSearch "select:BrowserClick"), then call ' +
        '"BrowserClick" again.',
    )
  })

  it('a deferred GROUP tool names its group and routes through ToolSearch only', async () => {
    // `chat` defers `shell`: Bash has no `tool.skill`, and a group is not a
    // skill command, so Skill('shell') would fail as an unknown skill.
    registerDeferrableSkills([shellGroup])
    const { tool, wasCalled } = gatedTool('Bash')
    const result = await callThroughGuard(tool)
    expect(wasCalled()).toBe(false)
    expect(result).toBe(
      'Tool "Bash" belongs to the "shell" tool group, which is not active yet, ' +
        'so its parameter schema is not loaded. Load it first — call ToolSearch ' +
        '"select:Bash", then call "Bash" again.',
    )
    expect(result).not.toContain('undefined')
    expect(result).not.toContain('call Skill')
  })

  it('a SEALED group tool says it is unavailable, with no activation hint', async () => {
    // Beta `code` seals `shell` (SuperShell replaces Bash): a model calling
    // Bash by habit must not be told to activate what can never activate.
    registerDeferrableSkills([{ ...shellGroup, sealed: true }])
    const { tool, wasCalled } = gatedTool('Bash')
    const result = await callThroughGuard(tool)
    expect(wasCalled()).toBe(false)
    expect(result).toContain('Tool "Bash" is not available in this session type.')
    expect(result).toContain('do not call it again')
    expect(result).not.toMatch(/call Skill|call ToolSearch|select:|not active yet/)
    expect(result).not.toContain('undefined')
  })

  it('resolves the owner through the CALLING runtime’s registry, not the last-registered sibling’s', async () => {
    const keyA = {}
    const keyB = {}
    registerDeferrableSkills([shellGroup], keyA)
    registerDeferrableSkills([], keyB) // sibling: nothing deferred, owns the keyless slot
    const { tool } = gatedTool('Bash')
    const result = await callThroughGuard(tool, keyA)
    expect(result).toContain('belongs to the "shell" tool group')
    expect(result).toContain('call ToolSearch "select:Bash"')
  })

  it('drops a route the owning units refuse (a sealed co-owner or a sealed skill)', () => {
    // A deferred skill tool that ALSO sits in a sealed group: Skill still
    // surfaces it (shouldHideToolFromModel), but ToolSearch refuses the select.
    registerDeferrableSkills([
      { name: 'browser', defaultDeferred: true },
      { name: 'locked', defaultDeferred: true, toolNames: ['BrowserClick'], sealed: true },
    ])
    const both = hiddenToolCallMessage({ name: 'BrowserClick', skill: 'browser' })
    expect(both).toContain('call Skill with skill "browser", then call "BrowserClick" again.')
    expect(both).not.toContain('select:')
    // A SEALED skill owner is as unavailable as a sealed group.
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true, sealed: true }])
    expect(hiddenToolCallMessage({ name: 'BrowserClick', skill: 'browser' })).toContain(
      'is not available in this session type.',
    )
  })
})
