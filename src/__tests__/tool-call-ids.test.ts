import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport, HostedToolDefinition } from '../browser/bridge/browserBridgeProtocol'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { runTurnLoop } from '../engine/turnInterpreter'
import { shareRouteCall } from '../models/drivers/providerRouteCall'
import { modelCallIdOf, noteReplyCallId, REPLY_CALL_IDS_MAX, replyCallIdOf } from '../models/usage/modelCallIds'
import type { FileOpRow, RequestLogRow } from '../models/usage/requestLogStore'
import { withRequestLog } from '../models/usage/requestLogTransport'
import type { Message } from '../runtime/RuntimeTypes'
import { createEmptyAppState, createNoopToolUseContext, DefaultRuntimeConfig, NoopPlatformCapabilities } from '../runtime/testing/noopAdapters'
import { fileActivityIdle, recordFileBatch, recordFileRead } from '../toolkit/builtin/host/fileActivity'
import { runToolBatch } from '../toolkit/run/toolBatchRunner'
import { declareTool } from '../toolkit/toolContract'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow } from '../runtime/RuntimeTypes'
import { buildHostTools } from '../toolkit/builtin/host/hostTools'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ToolContractList } from '../toolkit/toolContract'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const logged = vi.hoisted(() => ({ sends: [] as RequestLogRow[], files: [] as FileOpRow[] }))
vi.mock('../models/usage/requestLogWriter', async importOriginal => ({
  ...(await importOriginal<typeof import('../models/usage/requestLogWriter')>()),
  attachRequestLogBridge: () => {},
  recordRequest: (row: RequestLogRow) => {
    logged.sends.push(row)
  },
  recordFileOps: (rows: readonly FileOpRow[]) => {
    logged.files.push(...rows)
  },
}))

beforeEach(() => {
  logged.sends.length = 0
  logged.files.length = 0
})

/** A host transport whose every model stream answers with one text reply; it keeps each payload it was sent. */
function scriptedHost() {
  const payloads: Array<{ action: string; payload: object }> = []
  const transport = {
    servesModelRoutes: true,
    request: async (request: { route: { action: string }; payload: object }) => {
      payloads.push({ action: request.route.action, payload: request.payload })
      if (request.route.action === 'streamStart') return { ok: true, result: { streamId: 'stream-1' } }
      if (request.route.action === 'streamRead') {
        return {
          ok: true,
          result: {
            done: true,
            status: 'ok',
            chunks: [
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'hi' } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            ],
          },
        }
      }
      return { ok: true, result: {} }
    },
  }
  return { transport, payloads }
}

async function oneTurn(transport: object): Promise<Message[]> {
  const runtimeConfig = new DefaultRuntimeConfig()
  const deps = assembleTurnDependencies(runtimeConfig, {}, { bridgeTransport: transport as never, runtimeConfig })
  const callContext = createNoopToolUseContext({
    tools: [] as unknown as ToolContractList,
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  const messages: Message[] = []
  for await (const message of runTurnLoop({
    messages: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } } as Message],
    baseInstructions: 'test',
    userAmbient: {},
    systemAmbient: {},
    decidePermission: async () => ({ behavior: 'allow' as const }),
    callContext,
    turnCaller: 'test',
    deps,
  })) {
    messages.push(message as Message)
  }
  return messages
}

describe("the model call's id on sends and file rows", () => {
  it('gives every send of one call one call id, numbered by hop, and another call another id', async () => {
    const served = {
      request: async (request: { route: { action: string } }) =>
        request.route.action === 'streamStart'
          ? { ok: true, result: { streamId: `s${Math.random()}` } }
          : { ok: true, result: { done: true, status: 'done', chunks: [] } },
    }
    const log = withRequestLog(served as unknown as BrowserBridgeTransport, { request: vi.fn() } as unknown as BrowserBridgeTransport)
    const sendOn = async (payload: object) => {
      const opened = (await log.request({ id: 'r', route: { capability: 'model', action: 'streamStart' }, payload } as never)) as {
        result: { streamId: string }
      }
      await log.request({ id: 'r', route: { capability: 'model', action: 'streamRead' }, payload: { streamId: opened.result.streamId } } as never)
    }
    const payload = { providerId: 'acme', model: 'm', requestContext: { sessionId: 's1', purpose: 'turn', querySource: 'sdk' } }
    const copy = { ...payload }
    const other = { ...payload }
    await sendOn(payload)
    await sendOn(payload)
    shareRouteCall(copy, payload)
    await sendOn(copy)
    await sendOn(other)
    const id = modelCallIdOf(payload)
    expect(logged.sends.map(row => [row.callId, row.hop])).toEqual([
      [id, 1],
      [id, 2],
      [id, 3],
      [modelCallIdOf(other), 1],
    ])
    expect(modelCallIdOf(other)).not.toBe(id)
    expect(JSON.stringify(payload)).not.toContain(String(id))
  })

  it('numbers only the sends that left: a refused blocking call takes no hop', async () => {
    const replies = [
      { ok: false, error: { code: 'provider_error', message: 'no driver' } },
      { ok: true, result: { message: { role: 'assistant', content: [] } } },
    ]
    const log = withRequestLog({ request: async () => replies.shift() } as unknown as BrowserBridgeTransport, { request: vi.fn() } as unknown as BrowserBridgeTransport)
    const payload = { providerId: 'acme', model: 'm' }
    for (let i = 0; i < 2; i += 1) await log.request({ id: 'r', route: { capability: 'model', action: 'call' }, payload } as never)
    expect(logged.sends.map(row => [row.callId, row.hop])).toEqual([[modelCallIdOf(payload), 1]])
  })

  it("knows a reply row by the call that answered it, and never puts the id in the request", async () => {
    const { transport, payloads } = scriptedHost()
    const messages = await oneTurn(transport)
    const reply = messages.find(message => message.type === 'assistant')!
    const started = payloads.find(entry => entry.action === 'streamStart')!
    expect(replyCallIdOf(reply)).toBe(modelCallIdOf(started.payload))
    expect(JSON.stringify(started.payload)).not.toContain(String(replyCallIdOf(reply)))
  })

  it("gives a Read's row the call id of the reply that asked for it, and none for a reply it never received", async () => {
    const { transport, payloads } = scriptedHost()
    const reply = (await oneTurn(transport)).find(message => message.type === 'assistant')!
    const [read] = buildHostTools([{ name: 'Read', description: 'd', parameters: { type: 'object', properties: {} } } as unknown as HostedToolDefinition])
    const fs = {
      stat: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      readFile: async () => '',
    } as unknown as RuntimeFs
    const context = {
      options: { cwd: '/p', projectRoot: '/p', sessionId: 's1', mainLoopModel: 'm', mainLoopProviderId: 'p', fsOperations: fs },
      readFileState: new Map(),
      platformCapabilities: { browser: { callTool: async () => '     1\tx' } },
    } as unknown as ToolCallContext
    const call = read!.call as (input: unknown, context: ToolCallContext, can: unknown, parent: unknown) => Promise<unknown>
    await call({ file_path: '/p/a.ts' }, context, undefined, reply)
    await call({ file_path: '/p/b.ts' }, context, undefined, { uuid: 'never-received' })
    await fileActivityIdle()
    const started = payloads.find(entry => entry.action === 'streamStart')!
    expect(logged.files.map(row => [row.path, row.callId])).toEqual([
      ['/p/a.ts', modelCallIdOf(started.payload)],
      ['/p/b.ts', undefined],
    ])
  })

  it("gives a commit's batch the call id of its reply", async () => {
    noteReplyCallId('reply-9', 99)
    const fs = { stat: async () => Promise.reject(new Error('ENOENT')) } as unknown as RuntimeFs
    const context = { options: { cwd: '/p', sessionId: 's1', fsOperations: fs } } as unknown as ToolCallContext
    recordFileBatch(
      context,
      [
        { filePath: '/p/a', facts: { tool: 'SuperEdit', op: 'write', outcome: 'ok' } },
        { filePath: '/p/b', facts: { tool: 'SuperEdit', op: 'remove', outcome: 'ok' } },
      ],
      { uuid: 'reply-9' },
    )
    await fileActivityIdle()
    expect(logged.files.map(row => row.callId)).toEqual([99, 99])
  })

  it('gives each call of one parallel batch the id of its own reply, when the calls came from different replies', async () => {
    noteReplyCallId('reply-a', 101)
    noteReplyCallId('reply-b', 202)
    let bothStarted!: () => void
    const started = new Promise<void>(resolve => (bothStarted = resolve))
    let running = 0
    const tool = declareTool({
      name: 'Peek',
      argsSchema: { type: 'object' as const, properties: { path: { type: 'string' } } },
      description: async () => 'peeks',
      call: async (input: { path: string }, context: ToolCallContext, _can: unknown, parent: unknown) => {
        running += 1
        if (running === 2) bothStarted()
        await started
        recordFileRead(context, input.path, {}, undefined, 'x', parent)
        return { data: 'ok' }
      },
      parallelSafe: () => true,
      readsOnly: () => true,
    })
    const context = createNoopToolUseContext({
      tools: [tool] as unknown as ToolContractList,
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      sessionId: 's1',
    })
    ;(context.options as { fsOperations?: RuntimeFs }).fsOperations = {
      stat: async () => Promise.reject(new Error('ENOENT')),
    } as unknown as RuntimeFs
    context.markCallsInFlight = () => {}
    const replyWith = (uuid: string, toolCallId: string, path: string): ModelReplyRow =>
      ({
        type: 'assistant',
        uuid,
        message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'Peek', args: { path } }] },
      }) as ModelReplyRow
    const calls = [
      { type: 'tool-call' as const, toolCallId: 't-a', toolName: 'Peek', args: { path: '/p/a' } },
      { type: 'tool-call' as const, toolCallId: 't-b', toolName: 'Peek', args: { path: '/p/b' } },
    ]
    const replies = [replyWith('reply-a', 't-a', '/p/a'), replyWith('reply-b', 't-b', '/p/b')]
    let n = 0
    const deps = { uuid: () => `u${(n += 1)}` } as QueryRuntimeDeps
    for await (const _ of runToolBatch(calls, replies, async () => ({ behavior: 'allow' as const }), context, deps)) {
      // drained
    }
    await fileActivityIdle()
    expect(running).toBe(2)
    expect(logged.files.map(row => [row.path, row.callId]).sort()).toEqual([
      ['/p/a', 101],
      ['/p/b', 202],
    ])
  })

  it('forgets the oldest reply past its limit', () => {
    noteReplyCallId('first', 1)
    for (let i = 0; i < REPLY_CALL_IDS_MAX; i += 1) noteReplyCallId(`r${i}`, i)
    expect(replyCallIdOf({ uuid: 'first' })).toBeUndefined()
    expect(replyCallIdOf({ uuid: `r${REPLY_CALL_IDS_MAX - 1}` })).toBe(REPLY_CALL_IDS_MAX - 1)
  })
})
