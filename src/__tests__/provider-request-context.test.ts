import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import { buildModelRequest } from '../engine/turn/modelTransport'
import { performCompaction } from '../context/compaction/autoTrigger'
import {
  buildRequestContext,
  COMPACTION_QUERY_SOURCE,
  KNOWN_QUERY_SOURCES,
  purposeOfQuerySource,
  requestIdentityOf,
} from '../models/drivers/requestContext'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

// ── querySource → purpose ──────────────────────────────────────────────────

describe('purposeOfQuerySource', () => {
  it('maps every caller tag the runtime sends', () => {
    expect(Object.fromEntries(KNOWN_QUERY_SOURCES.map(tag => [tag, purposeOfQuerySource(tag)]))).toEqual({
      sdk: 'turn',
      agent_tool: 'turn',
      compact: 'compaction',
      rename_generate_name: 'title',
      mod_model_complete: 'mod',
      mod_model_fork: 'mod',
      skill_fork: 'fork',
      hook_agent: 'fork',
      extract_memories: 'fork',
      periodic_tidy: 'fork',
      memory_recall: 'other',
      web_fetch_apply: 'other',
      fast_model_call: 'other',
    })
  })

  it('an unknown tag (or an Object.prototype name) is other', () => {
    for (const tag of ['', 'something_new', 'toString', '__proto__']) {
      expect(purposeOfQuerySource(tag), tag).toBe('other')
    }
  })

  it('every literal caller tag in the source is in the table', () => {
    const root = join(process.cwd(), 'src')
    const found = new Set<string>()
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(path)
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const text = readFileSync(path, 'utf8')
          for (const match of text.matchAll(/\b(?:querySource|turnCaller):\s*'([a-z_]+)'/g)) found.add(match[1]!)
        }
      }
    }
    walk(root)
    expect(found.size).toBeGreaterThan(5)
    const unknown = [...found].filter(tag => !KNOWN_QUERY_SOURCES.includes(tag))
    expect(unknown).toEqual([])
  })
})

describe('requestIdentityOf', () => {
  it('the root session: its own id, no agent', () => {
    expect(requestIdentityOf({ sessionId: 's' })).toEqual({ sessionId: 's' })
  })
  it('a sub-agent / fork under the session: the session plus the agent id', () => {
    expect(requestIdentityOf({ sessionId: 's', agentId: 'subagent-1' })).toEqual({ sessionId: 's', agentId: 'subagent-1' })
  })
  it('a teammate (spawned child): the lead is the session, the teammate the agent', () => {
    expect(requestIdentityOf({ sessionId: 'mate', spawnerSessionId: 'lead' })).toEqual({ sessionId: 'lead', agentId: 'mate' })
  })
  it("a teammate's sub-agent: the lead, and the sub-agent's id", () => {
    expect(requestIdentityOf({ sessionId: 'mate', spawnerSessionId: 'lead', agentId: 'subagent-2' }))
      .toEqual({ sessionId: 'lead', agentId: 'subagent-2' })
  })
  it('empty ids are absent', () => {
    expect(requestIdentityOf({ sessionId: '', spawnerSessionId: '', agentId: '' })).toEqual({})
  })
})

// ── every sender sets it ───────────────────────────────────────────────────

function callParams(overrides: {
  querySource: string
  sessionId?: string
  spawnerSessionId?: string
  agentId?: string
}) {
  const callContext = createNoopToolUseContext({
    tools: [] as never,
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  callContext.options = {
    ...callContext.options,
    sessionId: overrides.sessionId ?? 'session-1',
    ...(overrides.spawnerSessionId ? { spawnerSessionId: overrides.spawnerSessionId } : {}),
  }
  if (overrides.agentId) callContext.agentId = overrides.agentId
  return {
    messages: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } } as Message],
    baseInstructions: 'be brief',
    userContext: {},
    systemAmbient: {},
    callContext,
    querySource: overrides.querySource,
    providerId: 'deepseek',
  } as never
}

describe('buildModelRequest — every callModel sender carries requestContext', () => {
  // The main loop, a sub-agent's loop, a teammate, the title namer, `$.model`
  // (complete and fork), forked runs and the fast side calls all reach the
  // model through `callModel` → `buildModelRequest`; the blocking fallback
  // re-sends the same payload.
  const cases: Array<[string, Parameters<typeof callParams>[0], object]> = [
    ['main loop', { querySource: 'sdk' }, { sessionId: 'session-1', purpose: 'turn', querySource: 'sdk' }],
    ['sub-agent', { querySource: 'agent_tool', agentId: 'subagent-7' },
      { sessionId: 'session-1', agentId: 'subagent-7', purpose: 'turn', querySource: 'agent_tool' }],
    ['teammate', { querySource: 'sdk', sessionId: 'mate', spawnerSessionId: 'lead' },
      { sessionId: 'lead', agentId: 'mate', purpose: 'turn', querySource: 'sdk' }],
    ['title', { querySource: 'rename_generate_name' },
      { sessionId: 'session-1', purpose: 'title', querySource: 'rename_generate_name' }],
    ['$.model complete', { querySource: 'mod_model_complete' },
      { sessionId: 'session-1', purpose: 'mod', querySource: 'mod_model_complete' }],
    ['$.model fork', { querySource: 'mod_model_fork' },
      { sessionId: 'session-1', purpose: 'mod', querySource: 'mod_model_fork' }],
    ['forked skill', { querySource: 'skill_fork', agentId: 'fork-1' },
      { sessionId: 'session-1', agentId: 'fork-1', purpose: 'fork', querySource: 'skill_fork' }],
    ['memory relevance', { querySource: 'memory_recall' },
      { sessionId: 'session-1', purpose: 'other', querySource: 'memory_recall' }],
  ]
  for (const [name, params, expected] of cases) {
    it(name, () => {
      expect(buildModelRequest(callParams(params), []).payload.requestContext).toEqual(expected)
    })
  }

  it('the context is not model-visible: toolUseContext still names no session', () => {
    const payload = buildModelRequest(callParams({ querySource: 'sdk' }), []).payload
    expect(payload.toolUseContext).not.toHaveProperty('sessionId')
  })
})

describe('performCompaction — the summarizer request carries requestContext', () => {
  const capture = () => {
    const payloads: Record<string, unknown>[] = []
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route?: { action?: string }; payload: Record<string, unknown> }) => {
        if (req.route?.action === 'streamRead') {
          return {
            ok: true as const,
            result: {
              chunks: [{ type: 'content_block_delta', delta: { type: 'text_delta', text: '<summary>ok</summary>' } }],
              done: true,
            },
          }
        }
        payloads.push(req.payload)
        return { ok: true as const, result: { streamId: 'stream-1' } }
      },
    } as unknown as Parameters<typeof performCompaction>[0]['bridgeTransport']
    return { payloads, transport }
  }
  let uuid = 0
  const runtimeConfig = {
    createUUID: () => `uuid-${uuid++}`,
    createTimestamp: () => '2026-01-01T00:00:00.000Z',
    getEnv: () => undefined,
  } as unknown as Parameters<typeof performCompaction>[0]['runtimeConfig']
  const messages = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'do a task' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'did it' }] } },
  ] as unknown as Message[]

  it('auto (a sub-agent compacting) and manual (/compact on a teammate)', async () => {
    const auto = capture()
    await performCompaction({
      messages,
      bridgeTransport: auto.transport,
      runtimeConfig,
      mainLoopModel: 'deepseek-v4-flash',
      providerId: 'deepseek',
      trigger: 'auto',
      requester: { sessionId: 'session-1', agentId: 'subagent-3' },
    })
    expect(auto.payloads[0]!.requestContext).toEqual({
      sessionId: 'session-1',
      agentId: 'subagent-3',
      purpose: 'compaction',
      querySource: COMPACTION_QUERY_SOURCE,
    })

    const manual = capture()
    await performCompaction({
      messages,
      bridgeTransport: manual.transport,
      runtimeConfig,
      mainLoopModel: 'deepseek-v4-flash',
      providerId: 'deepseek',
      trigger: 'manual',
      requester: { sessionId: 'mate', spawnerSessionId: 'lead' },
    })
    expect(manual.payloads[0]!.requestContext).toEqual(
      buildRequestContext({ sessionId: 'mate', spawnerSessionId: 'lead' }, 'compact'),
    )
    expect(manual.payloads[0]!.requestContext).toMatchObject({ sessionId: 'lead', agentId: 'mate' })
  })
})
