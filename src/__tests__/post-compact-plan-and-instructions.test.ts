import { afterEach, describe, expect, it } from 'vitest'
import type { Message, QueryTerminal } from '../runtime/RuntimeTypes'
import { SYSTEM_SUBTYPE_COMPACT_BOUNDARY } from '../runtime/VercelModelConstants'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { collectPostCompactPlanRows } from '../messages/contextAttachments'
import { installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

// After a compaction the model must still have (a) the session's plan — and,
// while plan mode is on, the full plan-mode rules, since the short reminder
// points at text the boundary cut off — and (b) the instruction files as they
// are on disk now, not as the turn found them when it started.

afterEach(() => resetProcessFs())

function userRow(text: string): Message {
  return { type: 'user', uuid: `user-${text}`, message: { role: 'user', content: text } } as Message
}

function assistantRow(text: string): Message {
  return {
    type: 'assistant',
    uuid: `assistant-${text}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as Message
}

async function drain<T>(generator: AsyncGenerator<T, QueryTerminal, unknown>): Promise<QueryTerminal> {
  while (true) {
    const next = await generator.next()
    if (next.done) return next.value
  }
}

function contextIn(
  mode: 'plan' | 'default',
  attachmentState?: ReturnType<typeof createEmptyAppState>['attachmentState'],
) {
  const appState = createEmptyAppState()
  appState.permissionRules = { ...appState.permissionRules, mode }
  if (attachmentState) appState.attachmentState = attachmentState
  return createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState: () => {},
    cwd: '/workspace',
    sessionId: 'post-compact-plan',
  })
}

function planOnDisk(body: string | null): void {
  installProcessFs({
    readFile: async () => {
      if (body === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return body
    },
    stat: async () => {
      if (body === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isFile: () => true, isDirectory: () => false, size: body.length, mtimeMs: 1 }
    },
  } as never)
}

function attachmentOf(row: Message): { type?: string; reminderType?: string; planExists?: boolean } | undefined {
  return (row as { attachment?: { type?: string; reminderType?: string; planExists?: boolean } }).attachment
}

function textOf(row: Message): string {
  const content = (row as { message?: { content?: unknown } }).message?.content
  return typeof content === 'string' ? content : ''
}

describe('post-compact plan rows', () => {
  it('in plan mode, re-sends the full plan-mode reminder and then the plan contents', async () => {
    planOnDisk('# Draft plan\n1. PLAN_STEP_ALPHA')
    const ctx = contextIn('plan')
    const rows = await collectPostCompactPlanRows(ctx, new DefaultRuntimeConfig())
    expect(rows).toHaveLength(2)
    expect(attachmentOf(rows[0]!)).toMatchObject({ type: 'plan_mode', reminderType: 'full', planExists: true })
    expect(textOf(rows[1]!)).toContain('PLAN_STEP_ALPHA')
    expect((rows[1] as { isMeta?: boolean }).isMeta).toBe(true)
    // The next step's reminder stays the short one: the full one just went out.
    expect(ctx.readAppState().attachmentState?.lastPermissionMode).toBe('plan')
  })

  it('plan mode entered again since the last reminder: the re-entry notice comes first', async () => {
    planOnDisk('# Earlier plan\n1. PLAN_STEP_GAMMA')
    const ctx = contextIn('plan', { lastPermissionMode: 'default', hasExitedPlanModeInSession: true })
    const rows = await collectPostCompactPlanRows(ctx, new DefaultRuntimeConfig())
    expect(rows.map(row => attachmentOf(row)?.type)).toEqual(['plan_mode_reentry', 'plan_mode', undefined])
    expect(textOf(rows[2]!)).toContain('PLAN_STEP_GAMMA')
    expect(ctx.readAppState().attachmentState).toMatchObject({
      lastPermissionMode: 'plan',
      hasExitedPlanModeInSession: false,
    })
  })

  it('in plan mode with no plan written yet, re-sends only the full reminder', async () => {
    planOnDisk(null)
    const rows = await collectPostCompactPlanRows(contextIn('plan'), new DefaultRuntimeConfig())
    expect(rows).toHaveLength(1)
    expect(attachmentOf(rows[0]!)).toMatchObject({ type: 'plan_mode', reminderType: 'full', planExists: false })
  })

  it('outside plan mode, an approved plan being executed comes back as its contents only', async () => {
    planOnDisk('# Approved plan\n1. PLAN_STEP_BETA')
    const rows = await collectPostCompactPlanRows(contextIn('default'), new DefaultRuntimeConfig())
    expect(rows).toHaveLength(1)
    expect(attachmentOf(rows[0]!)).toBeUndefined()
    expect(textOf(rows[0]!)).toContain('PLAN_STEP_BETA')
  })

  it('without a plan and outside plan mode, adds nothing', async () => {
    planOnDisk(null)
    expect(await collectPostCompactPlanRows(contextIn('default'), new DefaultRuntimeConfig())).toEqual([])
    expect(await collectPostCompactPlanRows(undefined, new DefaultRuntimeConfig())).toEqual([])
  })
})

describe('post-compact instruction files', () => {
  const compactOnce = () => {
    let compacted = false
    return async () => {
      if (compacted) return {}
      compacted = true
      return {
        compactionResult: {
          boundaryMarker: {
            type: 'system',
            subtype: SYSTEM_SUBTYPE_COMPACT_BOUNDARY,
            uuid: 'boundary-1',
            message: 'Conversation compacted',
            compactMetadata: { trigger: 'auto', preTokens: 4000 },
          } as Message,
          summaryMessages: [
            { type: 'user', uuid: 'summary-1', isMeta: true, message: { role: 'user', content: 'summary' } } as Message,
          ],
        },
      }
    }
  }

  async function runCompactingTurn(
    renderPromptAfterCompaction?: (messages: readonly Message[]) => Promise<{
      defaultSystemPrompt: string[]
      userContext: Record<string, string>
      systemContext: Record<string, string>
    }>,
  ) {
    planOnDisk(null)
    const seen: Array<{ userContext: Record<string, string>; system: unknown; messages: Array<string | undefined> }> = []
    const deps = assembleTurnDependencies(new DefaultRuntimeConfig(), {
      autocompact: compactOnce(),
      callModel: async function* (params) {
        seen.push({
          userContext: params.userContext,
          system: params.baseInstructions,
          messages: params.messages.map(m => m.uuid),
        })
        yield assistantRow('done')
      },
    })
    await drain(
      runTurnLoop({
        messages: [userRow('long task')],
        baseInstructions: ['base prompt'],
        userAmbient: { instructionText: 'INSTRUCTIONS_AS_THE_TURN_FOUND_THEM' },
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: contextIn('default'),
        turnCaller: 'test',
        deps,
        ...(renderPromptAfterCompaction ? { renderPromptAfterCompaction } : {}),
      }),
    )
    return seen
  }

  it('the request after a compaction carries the instruction files read again, not the turn-start copy', async () => {
    const renderedOver: Array<Array<string | undefined>> = []
    const seen = await runCompactingTurn(async messages => {
      renderedOver.push(messages.map(m => m.uuid))
      return {
        defaultSystemPrompt: ['base prompt'],
        userContext: { instructionText: 'INSTRUCTIONS_AS_EDITED_ON_DISK' },
        systemContext: {},
      }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.messages).toEqual(['boundary-1', 'summary-1'])
    expect(seen[0]!.userContext.instructionText).toBe('INSTRUCTIONS_AS_EDITED_ON_DISK')
    // Rendered over what the boundary left, not the pre-compact history.
    expect(renderedOver).toEqual([['boundary-1', 'summary-1']])
  })

  it('a failed render keeps the prompt the turn started with', async () => {
    const seen = await runCompactingTurn(async () => {
      throw new Error('disk gone')
    })
    expect(seen[0]!.userContext.instructionText).toBe('INSTRUCTIONS_AS_THE_TURN_FOUND_THEM')
  })
})
