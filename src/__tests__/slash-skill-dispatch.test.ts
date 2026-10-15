import { afterEach, describe, expect, it } from 'vitest'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import { processUserInput } from '../input/submitUserInput'
import { addStockSkill, __resetBundledSkillsForTests, __resetFeatureRegistryForTests } from '../skillLibrary/builtinSkills'

// processUserInput needs a BrowserHostBridge typed reference but the
// slash-skill dispatch path never reaches into it (only `/tabs`, `/context`,
// and `/status` use the bridge). A bare object cast is enough for these
// tests and keeps the scaffolding small.
function stubHostBridge(): BrowserHostBridge {
  return {} as unknown as BrowserHostBridge
}

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
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId,
    commands,
  })
}

type SlashMessage = {
  type: string
  message: { content: string | Array<{ text: string }> }
  isMeta?: boolean
}

// Slash commands now lead with a visible (non-meta) user echo of the typed
// command, followed by the command's own output. The meta user message
// carrying the expanded skill body is the second element.
function extractMetaUserText(messages: ReadonlyArray<unknown>): string {
  const meta = (messages as SlashMessage[]).find(
    m => m.type === 'user' && m.isMeta === true,
  )
  expect(meta).toBeDefined()
  const content = meta!.message.content
  return typeof content === 'string' ? content : content[0]!.text
}

// The first message is always the visible user echo of the typed command.
function expectUserEcho(messages: ReadonlyArray<unknown>, input: string): void {
  const first = messages[0] as SlashMessage
  expect(first.type).toBe('user')
  expect(first.isMeta).not.toBe(true)
  const content = first.message.content
  const text = typeof content === 'string' ? content : content[0]!.text
  expect(text).toBe(input)
}

afterEach(() => {
  __resetBundledSkillsForTests()
  __resetFeatureRegistryForTests()
})

describe('processUserInput — slash skill dispatch', () => {
  const runtimeConfig = new BrowserRuntimeConfig()

  it('does not append or substitute args in a dynamic body', async () => {
    addStockSkill({
      name: 'dynamic-demo',
      description: 'Dynamic demo',
      dynamicContent: async args => `Prompt: ${args}; Example: $ARGUMENTS`,
    })
    const context = makeContext([makeSkill({ name: 'dynamic-demo', content: 'unused' })])
    const result = await processUserInput(
      { input: '/dynamic-demo focus', context },
      { hostBridge: stubHostBridge(), runtimeConfig },
    )
    const text = extractMetaUserText(result.messages)
    expect(text).toContain('Prompt: focus; Example: $ARGUMENTS')
    expect(text).not.toContain('ARGUMENTS: focus')
  })

  it('expands a user-typed /skill into a meta user message with substituted args', async () => {
    const skill = makeSkill({
      content:
        'Hello, $name! Workdir: ${CLAUDE_SKILL_DIR}/scripts. Session: ${CLAUDE_SESSION_ID}.',
    })
    const context = makeContext([skill], 'sess-xyz')

    const result = await processUserInput(
      {
        input: '/demo "Ada Lovelace"',
        context,
      },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
      },
    )

    expect(result.shouldQuery).toBe(true)
    expect(result.messages).toHaveLength(2)
    expectUserEcho(result.messages, '/demo "Ada Lovelace"')
    const text = extractMetaUserText(result.messages)
    // Loading-metadata tags (formatSkillInvocationMessage).
    expect(text).toContain('<command-name>/demo</command-name>')
    expect(text).toContain('<command-message>demo</command-message>')
    expect(text).toContain('<command-args>"Ada Lovelace"</command-args>')
    expect(text).toContain('Base directory for this skill: /skills/demo')
    expect(text).toContain('Hello, Ada Lovelace!')
    expect(text).toContain('Workdir: /skills/demo/scripts')
    expect(text).toContain('Session: sess-xyz.')
  })

  it('passes the skill frontmatter model through ProcessUserInputResult', async () => {
    const skill = makeSkill({ model: 'claude-opus-4-7' })
    const context = makeContext([skill])

    const result = await processUserInput(
      {
        input: '/demo Ada',
        context,
      },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
      },
    )

    expect(result.model).toBe('claude-opus-4-7')
  })

  it('treats model: inherit as no override (omits result.model)', async () => {
    const skill = makeSkill({ model: 'inherit' })
    const context = makeContext([skill])

    const result = await processUserInput(
      {
        input: '/demo Ada',
        context,
      },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
      },
    )

    expect(result.model).toBeUndefined()
  })

  it('passes permittedTools through when the skill declares them', async () => {
    const skill = makeSkill({ permittedTools: ['Read', 'Write'] })
    const context = makeContext([skill])

    const result = await processUserInput(
      {
        input: '/demo Ada',
        context,
      },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
      },
    )

    expect(result.permittedTools).toEqual(['Read', 'Write'])
  })

  it('records the invoked skill on discoveredSkillNames so compaction keeps it', async () => {
    const skill = makeSkill()
    const context = makeContext([skill])

    await processUserInput(
      {
        input: '/demo Ada',
        context,
      },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
      },
    )

    expect(context.skillsFound?.has('demo')).toBe(true)
  })

  it('blocks dispatch when the skill opts out via userCallable: false', async () => {
    const skill = makeSkill({ userCallable: false })
    const context = makeContext([skill])

    const result = await processUserInput(
      {
        input: '/demo',
        context,
      },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
      },
    )

    expect(result.shouldQuery).toBe(false)
    // A VISIBLE, localized system message — not an isMeta user turn, which
    // the transcript view filters out (the user would have seen nothing).
    const system = (result.messages as SlashMessage[]).find(m => m.type === 'system') as
      | (SlashMessage & { i18nContent?: Array<{ key?: string }> })
      | undefined
    expect(system).toBeDefined()
    expect(system!.i18nContent?.map(part => part.key)).toEqual([
      'slash.out.skillNotUserInvocable',
    ])
    expect((result.messages as SlashMessage[]).some(m => m.type === 'user' && m.isMeta)).toBe(
      false,
    )
    // The skill body must not leak into the message.
    expect(JSON.stringify(system)).not.toContain('Hello,')
  })

  it('still rejects truly unknown commands with the built-in help text', async () => {
    const context = makeContext([])

    const result = await processUserInput(
      {
        input: '/nope',
        context,
      },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
      },
    )

    expect(result.shouldQuery).toBe(false)
    expectUserEcho(result.messages, '/nope')
    const system = result.messages.find(
      (m): m is { type: string; message: string } =>
        (m as { type?: string }).type === 'system',
    )
    expect(system).toBeDefined()
    expect(system!.message).toContain('Unknown browser slash command: /nope')
  })

  it('does not shadow a built-in slash command with a same-named skill', async () => {
    // A user-authored skill called `help` must not override the built-in
    // `/help` handler. The built-in switch wins because the skill lookup
    // only runs when `supportedSlashCommands.includes(command)` is false.
    const skill = makeSkill({
      name: 'help',
      content: 'This skill should never be expanded.',
    })
    const context = makeContext([skill])

    const result = await processUserInput(
      {
        input: '/help',
        context,
      },
      {
        hostBridge: stubHostBridge(),
        runtimeConfig,
      },
    )

    // Built-in `/help` returns a system message; the skill branch would
    // return a meta user message — verifying a system message follows the
    // user echo confirms the built-in path won.
    expectUserEcho(result.messages, '/help')
    const hasSystem = result.messages.some(
      m => (m as { type?: string }).type === 'system',
    )
    const hasMetaUser = result.messages.some(
      m =>
        (m as { type?: string }).type === 'user' &&
        (m as { isMeta?: boolean }).isMeta === true,
    )
    expect(hasSystem).toBe(true)
    expect(hasMetaUser).toBe(false)
  })
})
