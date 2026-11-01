import { describe, expect, it, vi } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { processUserInput, type TakeChildReports } from '../input/submitUserInput'
import { renderAttachmentMessage } from '../messages/renderAttachments'
import type { ContextRow, UserRow } from '../runtime/RuntimeTypes'

// A parent's queued child reports reach its model once, at the start of the
// next turn it takes from a person or a continuation; a slash command never
// takes them, and a continuation with nothing left to read does not run
// (F-36).

const runtimeConfig = new BrowserRuntimeConfig()

function makeContext() {
  return createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'parent',
    cwd: '/w',
    commands: [],
  })
}

function run(input: string, take: TakeChildReports, origin?: UserRow['origin']) {
  return processUserInput(
    { input, context: makeContext(), noContextScan: true, ...(origin ? { origin, isMeta: true } : {}) },
    {
      hostBridge: {} as unknown as BrowserHostBridge,
      runtimeConfig,
      supportedSlashCommands: ['rename'],
      takeChildReports: take,
    },
  )
}

describe('child reports at the start of a turn', () => {
  it('a person\'s turn reads the block before its own words', async () => {
    const take = vi.fn<TakeChildReports>(async () => 'REPORT BLOCK')
    const out = await run('what next?', take)
    expect(take).toHaveBeenCalledWith({ autoContinuation: false })
    expect(out.shouldQuery).toBe(true)
    const [context, user] = out.messages as [ContextRow, UserRow]
    expect(context.attachment).toEqual({ type: 'child_reports', text: 'REPORT BLOCK' })
    expect(user.message.content).toBe('what next?')
  })

  it('Q02: a slash command does not take the reports', async () => {
    const take = vi.fn<TakeChildReports>(async () => 'REPORT BLOCK')
    const out = await run('/rename my-work', take)
    expect(out.shouldQuery).toBe(false)
    expect(take).not.toHaveBeenCalled()
  })

  it('a continuation carries its origin and the block', async () => {
    const take = vi.fn<TakeChildReports>(async () => 'REPORT BLOCK')
    const out = await run('continue', take, 'auto_continuation')
    expect(take).toHaveBeenCalledWith({ autoContinuation: true })
    expect(out.shouldQuery).toBe(true)
    const user = out.messages.at(-1) as UserRow
    expect(user.origin).toBe('auto_continuation')
    expect(out.messages.some(m => (m as ContextRow).attachment?.type === 'child_reports')).toBe(true)
  })

  it('a continuation that finds nothing left does not run', async () => {
    const out = await run('continue', async () => null, 'auto_continuation')
    expect(out).toEqual({ messages: [], shouldQuery: false })
  })

  it('a person\'s turn with nothing queued adds nothing, and a failing take does not block it', async () => {
    const quiet = await run('hello', async () => null)
    expect(quiet.messages).toHaveLength(1)
    const failing = await run('hello', async () => {
      throw new Error('store gone')
    })
    expect(failing.messages).toHaveLength(1)
    expect(failing.shouldQuery).toBe(true)
  })

  it('the model reads the block as a system reminder', () => {
    const rows = renderAttachmentMessage({
      type: 'attachment',
      uuid: 'u',
      timestamp: 't',
      attachment: { type: 'child_reports', text: 'REPORT BLOCK' },
    } as ContextRow)
    expect(rows).toHaveLength(1)
    expect((rows[0] as UserRow).message.content).toBe('<system-reminder>\nREPORT BLOCK\n</system-reminder>')
  })
})
