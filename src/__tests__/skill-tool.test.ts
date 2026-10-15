import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import { SkillRunTool } from '../toolkit/builtin/skill'
import { transientHooksFor } from '../lifecycleHooks/sessionScopedHooks'
import { addStockSkill, __resetBundledSkillsForTests, __resetFeatureRegistryForTests } from '../skillLibrary/builtinSkills'
import {
  __resetInvokedSkillsStoreForTests,
  skillsUsedBy,
} from '../skillLibrary/invokedSkillsStore'

// Stub the forked-skill runner so the `context: 'fork'` branch resolves
// deterministically without a real sub-agent / cache-safe params. No inline
// (non-fork) test in this file reaches runSkillInFork, so the mock is
// inert for them.
vi.mock('../skillLibrary/executeForkedSkill', () => ({
  runSkillInFork: vi.fn(async () => ({
    text: 'fork result',
    agentId: 'fork-agent-1',
  })),
}))

const PARENT_MESSAGE = {
  type: 'assistant',
  uuid: 'assistant-1',
  message: { role: 'assistant', content: [] },
} as never

const ALLOW = async () => ({ behavior: 'allow' as const })

function makeSkill(overrides: Partial<ChromiumPromptCommand> = {}): ChromiumPromptCommand {
  return {
    type: 'prompt',
    name: 'demo',
    description: 'A demo skill',
    content: 'Hello, $name!',
    path: '/skills/demo/SKILL.md',
    loadedFrom: 'skills',
    source: 'project',
    baseDir: '/skills/demo',
    argNames: ['name'],
    ...overrides,
  }
}

function makeContext(commands: ChromiumPromptCommand[], sessionId = 'sess-1') {
  return createNoopToolUseContext({
    tools: [SkillRunTool],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId,
    commands,
  })
}

afterEach(() => {
  __resetBundledSkillsForTests()
  __resetFeatureRegistryForTests()
})

describe('SkillRunTool', () => {
  it('declares the canonical tool surface', () => {
    expect(SkillRunTool.name).toBe('Skill')
  })

  describe('validateInput', () => {
    it('rejects an empty skill name', async () => {
      const result = await SkillRunTool.checkInput?.({}, makeContext([]))
      expect(result).toMatchObject({ result: false, errorCode: 1 })
    })

    it('rejects whitespace-only skill names', async () => {
      const result = await SkillRunTool.checkInput?.(
        { skill: '   ' },
        makeContext([makeSkill()]),
      )
      expect(result).toMatchObject({
        result: false,
        errorCode: 1,
        message: expect.stringContaining('Invalid skill format'),
      })
    })

    it('rejects skill names containing embedded slashes', async () => {
      const result = await SkillRunTool.checkInput?.(
        { skill: 'demo/extra' },
        makeContext([makeSkill()]),
      )
      expect(result).toMatchObject({ result: false, errorCode: 1 })
    })

    it('rejects an unknown skill', async () => {
      const result = await SkillRunTool.checkInput?.(
        { skill: 'missing' },
        makeContext([makeSkill()]),
      )
      expect(result).toMatchObject({ result: false, errorCode: 2 })
    })

    it('accepts a leading slash for compatibility', async () => {
      const result = await SkillRunTool.checkInput?.(
        { skill: '/demo' },
        makeContext([makeSkill()]),
      )
      expect(result).toEqual({ result: true })
    })

    it('trims whitespace around the skill name', async () => {
      const result = await SkillRunTool.checkInput?.(
        { skill: '  demo  ' },
        makeContext([makeSkill()]),
      )
      expect(result).toEqual({ result: true })
    })

    it('refuses skills with hiddenFromModel', async () => {
      const result = await SkillRunTool.checkInput?.(
        { skill: 'demo' },
        makeContext([makeSkill({ hiddenFromModel: true })]),
      )
      expect(result).toMatchObject({ result: false, errorCode: 3 })
    })
  })

  describe('call', () => {
    it('does not append or substitute args in a dynamic body', async () => {
      addStockSkill({
        name: 'dynamic-demo',
        description: 'Dynamic demo',
        dynamicContent: async args => `Prompt: ${args}; Example: $ARGUMENTS`,
      })
      const context = makeContext([makeSkill({ name: 'dynamic-demo', content: 'unused' })])
      const out = await SkillRunTool.call(
        { skill: 'dynamic-demo', args: 'focus' },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      const text = extractInjectedText(out.extraRows ?? [])
      expect(text).toContain('Prompt: focus; Example: $ARGUMENTS')
      expect(text).not.toContain('ARGUMENTS: focus')
    })

    function extractInjectedText(messages: unknown[]): string {
      const first = messages[0] as { message: { content: string | Array<{ text: string }> } }
      const content = first.message.content
      if (typeof content === 'string') {
        return content
      }
      return content[0]!.text
    }

    it('injects body with base-directory header, arg substitution, and session id', async () => {
      const commands = [
        makeSkill({
          content: 'Hello, $name! Workdir: ${CLAUDE_SKILL_DIR}/scripts. Session: ${CLAUDE_SESSION_ID}.',
        }),
      ]
      const context = makeContext(commands, 'sess-xyz')
      const out = await SkillRunTool.call(
        { skill: 'demo', args: '"Ada Lovelace"' },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      const text = extractInjectedText(out.extraRows ?? [])
      // Loading-metadata tags (formatSkillInvocationMessage).
      expect(text).toContain('<command-name>/demo</command-name>')
      expect(text).toContain('<command-message>demo</command-message>')
      expect(text).toContain('<command-args>"Ada Lovelace"</command-args>')
      expect(text).toContain('Base directory for this skill: /skills/demo')
      expect(text).toContain('Hello, Ada Lovelace!')
      expect(text).toContain('Workdir: /skills/demo/scripts')
      expect(text).toContain('Session: sess-xyz.')
    })

    it('normalizes Windows backslashes in the substituted skill dir', async () => {
      const commands = [
        makeSkill({
          baseDir: 'D:\\skills\\demo',
          content: 'Path: ${CLAUDE_SKILL_DIR}/bin/run',
        }),
      ]
      const context = makeContext(commands)
      const out = await SkillRunTool.call(
        { skill: 'demo' },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      const text = extractInjectedText(out.extraRows ?? [])
      expect(text).toContain('Base directory for this skill: D:/skills/demo')
      expect(text).toContain('Path: D:/skills/demo/bin/run')
    })

    it('appends ARGUMENTS suffix when the body has no placeholders', async () => {
      const commands = [
        makeSkill({
          content: 'Run the regression suite.',
          argNames: undefined,
        }),
      ]
      const context = makeContext(commands)
      const out = await SkillRunTool.call(
        { skill: 'demo', args: '--fast' },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      const text = extractInjectedText(out.extraRows ?? [])
      expect(text).toContain('Run the regression suite.')
      expect(text).toContain('ARGUMENTS: --fast')
    })

    it('records the invoked skill on discoveredSkillNames', async () => {
      const commands = [makeSkill({ content: 'No args here.' })]
      const context = makeContext(commands)
      const discovered = new Set<string>()
      context.skillsFound = discovered
      const out = await SkillRunTool.call(
        { skill: 'demo' },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      out.contextPatch?.(context)
      expect(discovered.has('demo')).toBe(true)
    })

    it('overrides mainLoopModel when the skill declares a model', async () => {
      const commands = [
        makeSkill({ content: 'No args here.', model: 'claude-opus-4-7' }),
      ]
      const context = makeContext(commands)
      const out = await SkillRunTool.call(
        { skill: 'demo' },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      const modified = out.contextPatch?.(context)
      expect(modified?.options.mainLoopModel).toBe('claude-opus-4-7')
      // Original context untouched.
      expect(context.options.mainLoopModel).toBe('browser-test')
    })

    it('treats model: inherit as a no-op override', async () => {
      const commands = [
        makeSkill({ content: 'No args here.', model: 'inherit' }),
      ]
      const context = makeContext(commands)
      const out = await SkillRunTool.call(
        { skill: 'demo' },
        context,
        ALLOW,
        PARENT_MESSAGE,
      )
      const modified = out.contextPatch?.(context)
      expect(modified?.options.mainLoopModel).toBe('browser-test')
    })

    it('registers the skill frontmatter hooks into the session store on invoke', async () => {
      const commands = [
        makeSkill({
          content: 'No args here.',
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'echo hi' }],
              },
            ],
          },
        }),
      ]
      const context = makeContext(commands, 'sess-hook')
      await SkillRunTool.call({ skill: 'demo' }, context, ALLOW, PARENT_MESSAGE)

      const pre = transientHooksFor(context.readAppState(), 'sess-hook').get(
        'PreToolUse',
      )
      expect(pre?.[0]?.matcher).toBe('Bash')
      expect(pre?.[0]?.skillRoot).toBe('/skills/demo')
      expect(pre?.[0]?.hooks[0]).toMatchObject({
        type: 'command',
        command: 'echo hi',
      })
    })

    it('does not touch the session store for a skill without hooks', async () => {
      const context = makeContext([makeSkill({ content: 'No hooks.' })], 'sess-nohook')
      await SkillRunTool.call({ skill: 'demo' }, context, ALLOW, PARENT_MESSAGE)
      expect(transientHooksFor(context.readAppState(), 'sess-nohook').size).toBe(0)
    })
  })

  // Regression: a `context: 'fork'` skill must NOT record its body in the main
  // session's invoked-skills store. The whole point of forking is to keep the
  // body out of the main conversation; recording it would re-inject the body
  // at the next autocompact (createInvokedSkillsAttachmentPayload), defeating
  // the fork. noteSkillUse therefore runs only on the inline path, AFTER
  // the fork early-return.
  describe('forked skills are not recorded in the main invoked-skills store', () => {
    it('a context:fork skill body is NOT stored; an inline skill IS', async () => {
      __resetInvokedSkillsStoreForTests()

      // Fork path: runSkillInFork (mocked) returns, so SkillRunTool returns the
      // fork text and never records the body in the main store.
      const forkCtx = makeContext(
        [makeSkill({ name: 'forky', content: 'fork body', context: 'fork' })],
        'sess-fork',
      )
      const forkOut = await SkillRunTool.call(
        { skill: 'forky' },
        forkCtx,
        ALLOW,
        PARENT_MESSAGE,
      )
      expect(forkOut.data).toBe('fork result')
      expect(skillsUsedBy('sess-fork', null).size).toBe(0)

      // Inline control: same shape without `context: 'fork'` records normally.
      const inlineCtx = makeContext(
        [makeSkill({ name: 'inliney', content: 'inline body' })],
        'sess-inline',
      )
      await SkillRunTool.call({ skill: 'inliney' }, inlineCtx, ALLOW, PARENT_MESSAGE)
      expect(skillsUsedBy('sess-inline', null).size).toBe(1)
    })
  })
})
