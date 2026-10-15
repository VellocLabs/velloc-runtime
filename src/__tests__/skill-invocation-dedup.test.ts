import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import { SkillRunTool } from '../toolkit/builtin/skill'
import { __resetInvokedSkillsStoreForTests } from '../skillLibrary/invokedSkillsStore'
import {
  __resetSkillInvocationLogForTests,
  getSkillInvocationEventsForAgent,
} from '../skillLibrary/skillInvocationLog'

// Force the shell-expansion step to be an identity function so bodies are
// deterministic, and to throw on a sentinel so we can exercise the `failed`
// event path. Scoped to this file only.
vi.mock('../skillLibrary/inlineShellExpansion', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../skillLibrary/inlineShellExpansion')>()
  return {
    ...actual,
    expandSkillBodyShell: vi.fn(async (body: string) => {
      if (body.includes('__THROW__')) throw new Error('shell boom')
      return body
    }),
  }
})

const PARENT_MESSAGE = {
  type: 'assistant',
  uuid: 'a1',
  message: { role: 'assistant', content: [] },
} as never
const ALLOW = async () => ({ behavior: 'allow' as const })

function makeSkill(
  over: Partial<ChromiumPromptCommand> = {},
): ChromiumPromptCommand {
  return {
    type: 'prompt',
    name: 'demo',
    description: 'd',
    content: 'BODY $name',
    path: '/s/demo/SKILL.md',
    loadedFrom: 'skills',
    source: 'project',
    baseDir: '/s/demo',
    argNames: ['name'],
    ...over,
  } as ChromiumPromptCommand
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

function injectedText(out: { extraRows?: unknown[] }): string {
  const m = (out.extraRows ?? [])[0] as {
    message: { content: string | Array<{ text: string }> }
  }
  const c = m.message.content
  return typeof c === 'string' ? c : c[0]!.text
}

describe('SkillRunTool — no re-entry dedup + event log', () => {
  beforeEach(() => {
    __resetInvokedSkillsStoreForTests()
    __resetSkillInvocationLogForTests()
  })

  it('first invocation injects the full body and logs `loaded`', async () => {
    const ctx = makeContext([makeSkill()])
    const out = await SkillRunTool.call(
      { skill: 'demo', args: 'Ada' },
      ctx,
      ALLOW,
      PARENT_MESSAGE,
    )
    expect(out.data).toBe('Launching skill: demo')
    expect(injectedText(out)).toContain('BODY Ada')
    const events = getSkillInvocationEventsForAgent('sess-1', null)
    expect(events.map(e => e.status)).toEqual(['loaded'])
    expect(events[0]!.detailId).toMatch(/^skill:/)
    expect(events[0]!.size).toBeGreaterThan(0)
  })

  it('re-invoking with identical content injects the FULL body again and logs `loaded`', async () => {
    const ctx = makeContext([makeSkill()])
    await SkillRunTool.call({ skill: 'demo', args: 'Ada' }, ctx, ALLOW, PARENT_MESSAGE)
    const dup = await SkillRunTool.call(
      { skill: 'demo', args: 'Ada' },
      ctx,
      ALLOW,
      PARENT_MESSAGE,
    )
    // No dedup — the same "Launching" result and the same full body.
    expect(dup.data).toBe('Launching skill: demo')
    expect(injectedText(dup)).toContain('BODY Ada')
    // Newest-first: both invocations are `loaded`, each with its own sidecar.
    const events = getSkillInvocationEventsForAgent('sess-1', null)
    expect(events.map(e => e.status)).toEqual(['loaded', 'loaded'])
    expect(events[0]!.detailId).not.toBe(events[1]!.detailId)
  })

  it('changing the args re-injects the full body and logs `loaded` again', async () => {
    const ctx = makeContext([makeSkill()])
    await SkillRunTool.call({ skill: 'demo', args: 'Ada' }, ctx, ALLOW, PARENT_MESSAGE)
    const out = await SkillRunTool.call(
      { skill: 'demo', args: 'Grace' },
      ctx,
      ALLOW,
      PARENT_MESSAGE,
    )
    expect(injectedText(out)).toContain('BODY Grace')
    expect(
      getSkillInvocationEventsForAgent('sess-1', null).map(e => e.status),
    ).toEqual(['loaded', 'loaded'])
  })

  it('a third identical invocation still injects the full body (no threshold)', async () => {
    const ctx = makeContext([makeSkill()])
    await SkillRunTool.call({ skill: 'demo', args: 'Ada' }, ctx, ALLOW, PARENT_MESSAGE)
    await SkillRunTool.call({ skill: 'demo', args: 'Ada' }, ctx, ALLOW, PARENT_MESSAGE)
    const out = await SkillRunTool.call(
      { skill: 'demo', args: 'Ada' },
      ctx,
      ALLOW,
      PARENT_MESSAGE,
    )
    expect(injectedText(out)).toContain('BODY Ada')
    expect(
      getSkillInvocationEventsForAgent('sess-1', null).map(e => e.status),
    ).toEqual(['loaded', 'loaded', 'loaded'])
  })

  it('logs `failed` (and rethrows) when body expansion throws', async () => {
    const ctx = makeContext([makeSkill({ content: '__THROW__' })])
    await expect(
      SkillRunTool.call({ skill: 'demo' }, ctx, ALLOW, PARENT_MESSAGE),
    ).rejects.toThrow('shell boom')
    const events = getSkillInvocationEventsForAgent('sess-1', null)
    expect(events.map(e => e.status)).toEqual(['failed'])
    expect(events[0]!.error).toContain('shell boom')
    expect(events[0]!.detailId).toBeUndefined()
  })
})
