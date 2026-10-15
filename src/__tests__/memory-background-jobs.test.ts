import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { RuntimeFs, RuntimeFsStat } from '../utils/fs/runtimeFs'
import { installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'
import * as forkedAgentModule from '../agents/forkedRun'
import * as runLock from '../memory/consolidate/runLock'
import {
  registerMemoryExtractor,
  resetMemoryExtractionForTests,
  runMemoryExtraction,
  takeSavedMemoryPaths,
  type MemoryExtractionContext,
} from '../memory/extract/extractionRunner'
import {
  registerMemoryConsolidator,
  resetMemoryConsolidationForTests,
  runMemoryConsolidation,
} from '../memory/consolidate/consolidationRunner'
import { getConversationTranscriptPath } from '../utils/conversationStoragePaths'

function rc(): RuntimeConfig {
  return {
    getEnv: () => undefined,
    flagOn: () => false,
    now: () => 0,
    createUUID: () => 'fresh-uuid',
    createTimestamp: () => '2026-01-01T00:00:00.000Z',
    getMaxStructuredOutputRetries: () => 5,
  }
}

function context(
  messages: Message[],
  runtimeConfig: RuntimeConfig,
  memorySettings: Record<string, unknown>,
): MemoryExtractionContext {
  const toolUseContext = {
    options: {
      cwd: '/w',
      sessionId: 'current',
      mainLoopModel: 'm',
      tools: [],
      runtimeConfig,
      memorySettings,
    },
    abortController: new AbortController(),
    messages,
  } as unknown as ToolCallContext
  return { messages, systemPrompt: 's', userContext: {}, systemContext: {}, toolUseContext }
}

const user = (uuid: string) =>
  ({ type: 'user', uuid, message: { role: 'user', content: 'hi' } }) as unknown as Message
const assistant = (uuid: string, content: unknown) =>
  ({ type: 'assistant', uuid, message: { role: 'assistant', content } }) as unknown as Message
const writeCall = (path: string) => ({
  type: 'tool-call',
  toolCallId: 't',
  toolName: 'Write',
  args: { file_path: path, content: 'x' },
})

let fork: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetMemoryExtractionForTests()
  resetMemoryConsolidationForTests()
  fork = vi.spyOn(forkedAgentModule, 'launchFork')
  fork.mockReset()
  fork.mockResolvedValue({ messages: [], agentId: 'a' })
})

afterEach(() => {
  vi.restoreAllMocks()
  resetProcessFs()
})

describe('memory extraction', () => {
  const ON = { autoExtractEnabled: true }

  function promptOf(call: number): string {
    const arg = fork.mock.calls[call]![0] as { openingRows: { message: { content: string } }[] }
    return arg.openingRows[0]!.message.content
  }

  it('counts every message again when the previous cursor is no longer present', async () => {
    const config = rc()
    registerMemoryExtractor({ runtimeConfig: config })
    await runMemoryExtraction(context([user('u1'), user('u2')], config, ON))
    expect(promptOf(0)).toContain('the last ~2 messages')
    // The earlier messages were compacted away: u2 (the cursor) is gone.
    await runMemoryExtraction(context([user('c1'), user('c2'), user('c3')], config, ON))
    expect(promptOf(1)).toContain('the last ~3 messages')
  })

  it('counts only the messages after the cursor when it is still present', async () => {
    const config = rc()
    registerMemoryExtractor({ runtimeConfig: config })
    await runMemoryExtraction(context([user('u1'), user('u2')], config, ON))
    await runMemoryExtraction(context([user('u1'), user('u2'), user('u3')], config, ON))
    expect(promptOf(1)).toContain('the last ~1 messages')
  })

  it('skips the fork when the turn already wrote into memory via a tool-call block', async () => {
    const config = rc()
    const logEvent = vi.fn()
    registerMemoryExtractor({ runtimeConfig: config, logEvent })
    await runMemoryExtraction(
      context([user('u1'), assistant('a1', [writeCall('/W/.VELLOC/memory/x.md')])], config, ON),
    )
    expect(fork).not.toHaveBeenCalled()
    expect(logEvent).toHaveBeenCalledWith('nexus_extract_memories_skipped_direct_write', {
      message_count: 2,
    })
  })

  it('accumulates saved topic files across runs until they are taken', async () => {
    const config = rc()
    registerMemoryExtractor({ runtimeConfig: config })
    fork.mockResolvedValueOnce({ messages: [assistant('f1', [writeCall('/m/a.md')])], agentId: 'a' })
    fork.mockResolvedValueOnce({
      messages: [assistant('f2', [writeCall('/m/b.md'), writeCall('/m/a.md')])],
      agentId: 'b',
    })
    await runMemoryExtraction(context([user('u1')], config, ON))
    await runMemoryExtraction(context([user('u1'), user('u2')], config, ON))
    expect(takeSavedMemoryPaths(undefined)).toEqual(['/m/a.md', '/m/b.md'])
    expect(takeSavedMemoryPaths(config)).toBeNull()
  })
})

describe('memory consolidation', () => {
  const NOW = 2_000_000_000_000
  const ENABLED = { memoryMaintenance: 'periodic' }
  const sessions = ['s1', 's2', 's3', 's4', 's5', 'current']

  function fsWithSessions(): RuntimeFs {
    const files = new Map<string, string>()
    const stat = (mtimeMs: number) => ({ mtimeMs, isFile: () => true }) as RuntimeFsStat
    return {
      async readFile(p: string) {
        const v = files.get(p)
        if (v === undefined) throw new Error('ENOENT')
        return v
      },
      async writeFile(p: string, d: string) {
        files.set(p, d)
      },
      async unlink(p: string) {
        files.delete(p)
      },
      async mkdir() {},
      async stat(p: string) {
        if (sessions.some(id => getConversationTranscriptPath('/t', id) === p)) return stat(NOW)
        throw new Error('ENOENT')
      },
    } as unknown as RuntimeFs
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    installProcessFs(fsWithSessions())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function register(logEvent = vi.fn()) {
    const config = rc()
    registerMemoryConsolidator({
      runtimeConfig: config,
      logEvent,
      listSessions: async () => sessions,
      historyFolder: '/t',
    })
    return { config, logEvent }
  }

  it('logs the hours and session counts that triggered the run, excluding the current session', async () => {
    const { config, logEvent } = register()
    await runMemoryConsolidation(context([], config, ENABLED))
    expect(fork).toHaveBeenCalledTimes(1)
    expect(logEvent).toHaveBeenCalledWith('nexus_periodic_tidy_fired', {
      hours_since: Math.round(NOW / 3_600_000),
      sessions_since: 5,
    })
  })

  it('skips silently when the last-run timestamp cannot be read', async () => {
    vi.spyOn(runLock, 'lastTidyStamp').mockRejectedValue(new Error('io'))
    const { config, logEvent } = register()
    await runMemoryConsolidation(context([], config, ENABLED))
    expect(fork).not.toHaveBeenCalled()
    expect(logEvent).not.toHaveBeenCalled()
  })

  it('skips silently when listing sessions fails', async () => {
    const config = rc()
    registerMemoryConsolidator({
      runtimeConfig: config,
      listSessions: async () => {
        throw new Error('backend down')
      },
      historyFolder: '/t',
    })
    await expect(runMemoryConsolidation(context([], config, ENABLED))).resolves.toBeUndefined()
    expect(fork).not.toHaveBeenCalled()
  })

  it('rolls the lock back when recording a successful run fails', async () => {
    vi.spyOn(runLock, 'stampTidyDone').mockRejectedValue(new Error('disk full'))
    const rollback = vi.spyOn(runLock, 'releaseTidyLease')
    const { config, logEvent } = register()
    await runMemoryConsolidation(context([], config, ENABLED))
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(logEvent.mock.calls.some(c => c[0] === 'nexus_periodic_tidy_error')).toBe(true)
  })
})
