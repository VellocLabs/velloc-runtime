/**
 * `/compact` and the compaction hooks (F-3 8-3-2): the manual path runs the
 * same `PreCompact` / `PostCompact` / `SessionStart(compact)` sequence as the
 * automatic one, with trigger `manual` — and a blocking `PreCompact` calls
 * the command off with the transcript untouched.
 */
import { describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type { WorkingState, Message } from '../runtime/RuntimeTypes'
import type { UserInputPipeline } from '../runtime/interfaces/UserInputPipeline'
import type { LifecycleEventName } from '../lifecycleHooks/hookTypes'
import { attachInProcessHook } from '../lifecycleHooks/sessionScopedHooks'
import { buildHookInput } from '../lifecycleHooks/hookInput'
import { runCompactionStartHooks } from '../lifecycleHooks/compactionHooks'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  DefaultRuntimeConfig,
  MemoryConversationStore,
  NoopPlatformCapabilities,
  NoopPromptContextProvider,
  NoopSystemInitEmitter,
  createEmptyAppState,
  createMemoryFileStateCache,
} from '../runtime/testing/noopAdapters'
import { MSG_TYPE_ASSISTANT, ROLE_ASSISTANT } from '../runtime/VercelModelConstants'

const SESSION = 'session-compact-hooks'

/** `/compact <instructions>` becomes the compact action; anything else a query. */
function compactPipeline(runtimeConfig: DefaultRuntimeConfig): UserInputPipeline {
  return {
    async processUserInput(params) {
      const text = String(params.input)
      const row = {
        type: 'user',
        uuid: params.uuid ?? runtimeConfig.createUUID(),
        message: { role: 'user', content: text },
        isMeta: false,
      } as Message
      if (!text.startsWith('/compact')) return { messages: [row], shouldQuery: true, resultText: text }
      const instructions = text.slice('/compact'.length).trim()
      return {
        messages: [row],
        shouldQuery: false,
        resultText: text,
        action: 'compact',
        ...(instructions ? { compactInstructions: instructions } : {}),
      }
    },
  }
}

type ClassicCall = { event: string; e: Record<string, unknown> }

function world(options: { classic?: boolean; sessionCompact?: (input: { trigger: string }) => Promise<unknown> } = {}) {
  const runtimeConfig = new DefaultRuntimeConfig()
  let appState: WorkingState = createEmptyAppState()
  const writeAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }
  const summarized: Array<string | undefined> = []
  const forceCompact = async (params: { messages: Message[]; foldGuidance?: string }) => {
    summarized.push(params.foldGuidance)
    return {
      boundaryMarker: { type: 'system', uuid: 'b1', subtype: 'compact_boundary', message: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 10 } } as Message,
      summaryMessages: [{ type: 'user', uuid: 'sum1', isMeta: true, message: { role: 'user', content: 'SUMMARY' } } as Message],
    }
  }
  const classicCalls: ClassicCall[] = []
  const sessionCompacts: string[] = []
  const mods = {
    ready: Promise.resolve(),
    promptSubmit: async (text: string) => ({ entered: true, text, context: [] }),
    ...(options.classic
      ? {
          hasClassicHooks: (event: string) => event === 'PreCompact' || event === 'PostCompact',
          classic: async (event: string, e: Record<string, unknown>, core: () => Promise<unknown>) => {
            classicCalls.push({ event, e })
            await core()
            return { settled: false }
          },
        }
      : {}),
    ...(options.sessionCompact
      ? {
          sessionCompact: async (input: { trigger: string }, core: { run: (e: unknown) => Promise<unknown> }) => {
            sessionCompacts.push(input.trigger)
            const answer = await options.sessionCompact!(input)
            return answer ?? core.run(input)
          },
        }
      : {}),
  }
  const engine = new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: () => appState,
    writeAppState,
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: new NoopPlatformCapabilities(),
    queryRuntimeDeps: assembleTurnDependencies(runtimeConfig, {
      callModel: async function* () {
        yield {
          type: MSG_TYPE_ASSISTANT,
          uuid: runtimeConfig.createUUID(),
          message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'ok' }] },
        } as Message
      } as never,
      forceCompact,
    } as never),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: new MemoryConversationStore(SESSION),
    userInputPipeline: compactPipeline(runtimeConfig),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
    mods: mods as never,
  })
  /** Register an in-process hook; returns how many times it ran. */
  const hook = (event: LifecycleEventName, matcher: string, pass: boolean, reason = '') => {
    const ran = { count: 0 }
    attachInProcessHook(writeAppState, SESSION, event, matcher, () => {
      ran.count += 1
      return pass
    }, reason)
    return ran
  }
  return { engine, hook, summarized, classicCalls, sessionCompacts }
}

async function submit(engine: ConversationEngine, prompt: string, uuid: string): Promise<unknown[]> {
  const yielded: unknown[] = []
  for await (const message of engine.submitTurn(prompt as never, { uuid } as never)) yielded.push(message)
  return yielded
}

function systemTexts(messages: unknown[]): string[] {
  return messages
    .filter(m => (m as { type?: string }).type === 'system')
    .map(m => (m as { message?: unknown }).message)
    .filter((m): m is string => typeof m === 'string')
}

function hasBoundary(rows: readonly Message[]): boolean {
  return rows.some(m => (m as { subtype?: string }).subtype === 'compact_boundary')
}

function contentOf(row: Message): unknown {
  return (row as { message?: { content?: unknown } }).message?.content
}

describe('/compact — PreCompact (8-3-2)', () => {
  it('a blocking PreCompact hook matching `manual` calls the compaction off: no summary, no boundary, a note with the reason', async () => {
    const { engine, hook, summarized, sessionCompacts } = world({ sessionCompact: async () => undefined })
    const ran = hook('PreCompact', 'manual', false, 'not in this repo')
    await submit(engine, 'hello', 'u1')
    const before = engine.transcriptRows().map(m => m.uuid)
    const yielded = await submit(engine, '/compact keep the plan', 'u2')
    expect(ran.count).toBe(1)
    expect(summarized).toEqual([])
    // The extension point is not raised for a compaction a hook called off.
    expect(sessionCompacts).toEqual([])
    expect(systemTexts(yielded)).toEqual(['Compaction blocked by a hook — not in this repo. The transcript is unchanged.'])
    const after = engine.transcriptRows()
    expect(hasBoundary(after)).toBe(false)
    // Everything that was there stays, plus the typed command and the note.
    expect(after.slice(0, before.length).map(m => m.uuid)).toEqual(before)
    expect(after.length).toBe(before.length + 2)
  })

  it('a blocking hook that gives no reason gets the note without one', async () => {
    const { engine, hook, summarized } = world()
    hook('PreCompact', 'manual', false, '')
    await submit(engine, 'hello', 'u1')
    const yielded = await submit(engine, '/compact', 'u2')
    expect(summarized).toEqual([])
    expect(systemTexts(yielded)).toEqual(['Compaction blocked by a hook. The transcript is unchanged.'])
  })

  it('a hook matching `auto` does not run for `/compact`; one with no matcher does', async () => {
    const { engine, hook, summarized } = world()
    const auto = hook('PreCompact', 'auto', false, 'auto only')
    const any = hook('PreCompact', '', true)
    await submit(engine, 'hello', 'u1')
    await submit(engine, '/compact', 'u2')
    expect(auto.count).toBe(0)
    expect(any.count).toBe(1)
    expect(summarized).toEqual([undefined])
    expect(hasBoundary(engine.transcriptRows())).toBe(true)
  })

  it('the hooks read trigger `manual` and the typed instructions, `null` when there are none', async () => {
    const { engine, classicCalls } = world({ classic: true })
    await submit(engine, 'hello', 'u1')
    await submit(engine, '/compact keep the plan', 'u2')
    await submit(engine, 'more', 'u3')
    await submit(engine, '/compact', 'u4')
    const pre = classicCalls.filter(c => c.event === 'PreCompact').map(c => c.e)
    expect(pre.map(e => [e['trigger'], e['custom_instructions']])).toEqual([
      ['manual', 'keep the plan'],
      ['manual', null],
    ])
    expect(pre[0]!['hook_event_name']).toBe('PreCompact')
    expect(pre[0]!['session_id']).toBe(SESSION)
  })

  it('an extension skip still works on `/compact` once the hooks let it through', async () => {
    const { engine, hook, summarized } = world({ sessionCompact: async () => ({ skip: 'not now' }) })
    const ran = hook('PreCompact', 'manual', true)
    await submit(engine, 'hello', 'u1')
    const yielded = await submit(engine, '/compact', 'u2')
    expect(ran.count).toBe(1)
    expect(summarized).toEqual([])
    expect(systemTexts(yielded)).toEqual(['Compaction skipped by a plugin — not now. The transcript is unchanged.'])
  })
})

describe('/compact — after the summary (8-3-2)', () => {
  it('PostCompact runs with trigger `manual` and the summary; SessionStart runs with source `compact`', async () => {
    const { engine, hook, classicCalls } = world({ classic: true })
    const post = hook('PostCompact', 'manual', true)
    const postAuto = hook('PostCompact', 'auto', true)
    const start = hook('SessionStart', 'compact', true)
    await submit(engine, 'hello', 'u1')
    await submit(engine, '/compact', 'u2')
    expect(post.count).toBe(1)
    expect(postAuto.count).toBe(0)
    expect(start.count).toBe(1)
    const e = classicCalls.find(c => c.event === 'PostCompact')!.e
    expect([e['trigger'], e['compact_summary']]).toEqual(['manual', 'SUMMARY'])
  })

  it('a blocking PostCompact cannot undo the compaction; its reasons follow the summary as a meta row', async () => {
    const { engine, hook } = world()
    hook('PostCompact', 'manual', false, 'check the summary')
    await submit(engine, 'hello', 'u1')
    await submit(engine, '/compact', 'u2')
    const rows = engine.transcriptRows()
    const at = rows.findIndex(m => m.uuid === 'sum1')
    expect(hasBoundary(rows)).toBe(true)
    expect(at).toBeGreaterThan(-1)
    const next = rows[at + 1]!
    expect(contentOf(next)).toBe('[PostCompact hook]: check the summary')
    expect((next as { isMeta?: boolean }).isMeta).toBe(true)
  })
})

describe('compaction hooks — the automatic trigger', () => {
  function callContext(writeAppState: (u: (p: WorkingState) => WorkingState) => void, read: () => WorkingState) {
    return {
      options: { sessionId: SESSION, cwd: '/workspace', projectRoot: '/workspace' },
      readAppState: read,
      writeAppState,
      cancelSource: new AbortController(),
    } as unknown as ToolCallContext
  }

  it('selects hooks matching `auto`, not `manual`, and a blocking one stops the pass with its reason', async () => {
    let appState = createEmptyAppState()
    const write = (u: (p: WorkingState) => WorkingState) => {
      appState = u(appState)
    }
    let manualRan = 0
    attachInProcessHook(write, SESSION, 'PreCompact', 'manual', () => {
      manualRan += 1
      return false
    }, 'manual only')
    const context = callContext(write, () => appState)
    expect(await runCompactionStartHooks(context, 'auto')).toEqual({ proceed: true })
    attachInProcessHook(write, SESSION, 'PreCompact', 'auto', () => false, 'no auto here')
    expect(await runCompactionStartHooks(context, 'auto')).toEqual({ proceed: false, reasons: ['no auto here'] })
    expect(manualRan).toBe(0)
  })

  it('the hook stdin carries trigger, custom_instructions and compact_summary', () => {
    const base = { sessionId: SESSION, cwd: '/w' }
    expect(buildHookInput({ ...base, event: 'PreCompact', toolName: 'auto' })).toMatchObject({
      trigger: 'auto',
      custom_instructions: null,
    })
    expect(buildHookInput({ ...base, event: 'PreCompact', toolName: 'manual', foldGuidance: 'focus' })).toMatchObject({
      trigger: 'manual',
      custom_instructions: 'focus',
    })
    expect(buildHookInput({ ...base, event: 'PostCompact', toolName: 'manual', compactSummary: 'S' })).toMatchObject({
      trigger: 'manual',
      compact_summary: 'S',
    })
  })
})
