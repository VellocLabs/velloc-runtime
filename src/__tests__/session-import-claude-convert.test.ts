import { describe, expect, it } from 'vitest'

import {
  convert,
  deriveTaskId,
  IMPORTED_TEMPLATE_TYPE,
} from '../sessionImport/sources/claude-code/convert'
import { ImportConvertError } from '../sessionImport/protocol'
import { CUSTOM_TITLE_TYPE } from '../runtime/VercelModelConstants'

// The converter's output is the native Velloc layout: sanitized transcript
// entries (canonical `tool-call` / `tool-result` parts, lazy tool payloads
// split into sidecars), a `meta.json` stamped with the import time, and the
// source's own session id. These tests pin the mapping table documented in
// F-8.

const UUID = '3f2a6c1e-9b4d-4e8a-8c1d-0a1b2c3d4e5f'
const PATH = `C:\\Users\\me\\.claude\\projects\\D--project-app\\${UUID}.jsonl`
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0)
const CWD = 'D:\\project\\app'

type Rec = Record<string, unknown>

function stamp(rec: Rec): Rec {
  return {
    sessionId: UUID,
    cwd: CWD,
    version: '2.1.0',
    gitBranch: 'main',
    userType: 'external',
    timestamp: '2026-08-01T10:00:00.000Z',
    ...rec,
  }
}

const user = (uuid: string, parentUuid: string | null, text: string, extra: Rec = {}) =>
  stamp({
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  })

const assistant = (uuid: string, parentUuid: string | null, content: unknown[], extra: Rec = {}) =>
  stamp({
    type: 'assistant',
    uuid,
    parentUuid,
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      content,
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    },
    ...extra,
  })

const toolResult = (uuid: string, parentUuid: string, results: Rec[], extra: Rec = {}) =>
  stamp({
    type: 'user',
    uuid,
    parentUuid,
    message: { role: 'user', content: results },
    ...extra,
  })

function bytes(records: Rec[], extraLines: string[] = []): ArrayBuffer {
  const text = [...records.map(r => JSON.stringify(r)), ...extraLines].join('\n') + '\n'
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

function run(records: Rec[], extraLines: string[] = []) {
  return convert({ path: PATH, bytes: bytes(records, extraLines), now: NOW })
}

function messagesOf(result: ReturnType<typeof convert>) {
  return result.entries.filter(e => (e as { type: string }).type !== CUSTOM_TITLE_TYPE) as Array<Rec>
}

describe('convert — identity, meta, and project binding', () => {
  it('keeps the source session id, stamps updatedAt with the import time, binds the cwd as a code session', () => {
    const result = run([
      user('u1', null, 'Fix the flaky login test'),
      assistant('a1', 'u1', [{ type: 'text', text: 'Sure.' }]),
    ])
    expect(result.sessionId).toBe(UUID)
    expect(result.meta.sessionId).toBe(UUID)
    expect(result.meta.updatedAt).toBe(NOW)
    expect(result.meta.metadata).toMatchObject({
      templateType: IMPORTED_TEMPLATE_TYPE,
      projectRoot: CWD,
      firstPrompt: 'Fix the flaky login test',
      messageCount: 2,
      leafUuid: 'a1',
      importedFrom: { source: 'claude-code', path: PATH, importedAt: NOW },
    })
    expect(result.projectRoot).toBe(CWD)
    // No title record in the source → the converter pins the same fallback
    // title the import dialog row showed (firstPrompt), matching parseLite's
    // resolveLiteTitle precedence so the post-import title matches the row.
    expect(result.meta.customTitle).toBe('Fix the flaky login test')
    expect(result.entries.some(e => (e as { type: string }).type === CUSTOM_TITLE_TYPE)).toBe(true)
    const msgs = messagesOf(result)
    expect(msgs.map(m => m.sessionId)).toEqual([UUID, UUID])
    expect(msgs.map(m => m.parentUuid)).toEqual([null, 'u1'])
    expect(msgs.map(m => m.timestamp)).toEqual([
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:00:00.000Z',
    ])
  })

  it('folds customTitle → aiTitle → lastPrompt → summary → firstPrompt into the title, in that order (the same order parseLite uses)', () => {
    const base = [user('u1', null, 'p'), assistant('a1', 'u1', [{ type: 'text', text: 'r' }])]
    // No title record at all → the firstPrompt fallback ('p'), so the imported
    // session bears the same fallback title the dialog row showed.
    expect(run([...base]).meta.customTitle).toBe('p')
    // summary beats firstPrompt.
    const withSummary = run([...base, { type: 'summary', summary: 'Sum', leafUuid: 'a1' }])
    expect(withSummary.meta.customTitle).toBe('Sum')
    // lastPrompt beats summary (the gap this change closes — the lite tail read
    // ranks the re-appended `last-prompt` record above `summary`).
    const withLastPrompt = run([
      ...base,
      { type: 'summary', summary: 'Sum' },
      { type: 'last-prompt', sessionId: UUID, lastPrompt: 'Last' },
    ])
    expect(withLastPrompt.meta.customTitle).toBe('Last')
    // aiTitle beats lastPrompt.
    const withAi = run([
      ...base,
      { type: 'last-prompt', lastPrompt: 'Last' },
      { type: 'summary', summary: 'Sum' },
      { type: 'ai-title', sessionId: UUID, aiTitle: 'AI' },
    ])
    expect(withAi.meta.customTitle).toBe('AI')
    // customTitle beats everything.
    const withCustom = run([...base, { type: 'ai-title', aiTitle: 'AI' }, { type: 'custom-title', customTitle: 'Mine' }])
    expect(withCustom.meta.customTitle).toBe('Mine')
    expect(withCustom.meta.customTitleAt).toBe(NOW)
    const titleEntry = withCustom.entries.find(e => (e as { type: string }).type === CUSTOM_TITLE_TYPE) as Rec
    expect(titleEntry).toMatchObject({ sessionId: UUID, customTitle: 'Mine', updatedAt: NOW })
  })

  it('carries the last permission mode record', () => {
    const result = run([
      user('u1', null, 'p'),
      { type: 'mode', mode: 'plan' },
      { type: 'mode', mode: 'acceptEdits' },
    ])
    expect(result.meta.metadata.permissionMode).toBe('acceptEdits')
  })
})

describe('convert — record filtering and field stripping', () => {
  it('drops bookkeeping records, sidechain lines and provenance fields; keeps attachments and flags', () => {
    const result = run(
      [
        user('u1', null, 'p', { isMeta: true }),
        { type: 'progress', uuid: 'pg', parentUuid: 'u1', data: {} },
        { type: 'file-history-snapshot', messageId: 'u1', snapshot: {} },
        { type: 'attachment', uuid: 'at1', parentUuid: 'u1', attachment: { type: 'file', filename: 'a.ts' }, cwd: CWD, sessionId: UUID, timestamp: 't' },
        user('s1', 'at1', 'sub-agent chatter', { isSidechain: true, agentId: 'agent-1' }),
        assistant('a1', 'at1', [{ type: 'text', text: 'r' }]),
        { type: 'system', subtype: 'api_error', uuid: 'sys1', parentUuid: 'a1', content: 'boom', level: 'error' },
      ],
      ['not json at all', ''],
    )
    const msgs = messagesOf(result)
    expect(msgs.map(m => m.uuid)).toEqual(['u1', 'at1', 'a1'])
    expect(msgs[0]).toMatchObject({ type: 'user', isMeta: true })
    expect(msgs[1]).toMatchObject({ type: 'attachment', attachment: { type: 'file', filename: 'a.ts' } })
    for (const m of msgs) {
      for (const field of ['cwd', 'gitBranch', 'version', 'userType', 'isSidechain', 'requestId', 'agentId']) {
        expect(m).not.toHaveProperty(field)
      }
    }
    // The sidechain line carried an agentId, so it became a sub-agent rather
    // than being dropped.
    expect(result.stats).toMatchObject({
      skippedLines: 1,
      droppedRecords: 3,
      droppedSidechain: 0,
      messages: 3,
      subAgents: 1,
    })
  })

  it('maps a compact boundary onto the system message shape and keeps the compact summary', () => {
    const result = run([
      user('u1', null, 'old'),
      { type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: 'u1', compactMetadata: { trigger: 'manual', preTokens: 1234 }, content: 'Conversation compacted', timestamp: 't' },
      user('u2', 'cb', 'summary text', { isCompactSummary: true }),
      assistant('a2', 'u2', [{ type: 'text', text: 'after' }]),
    ])
    const msgs = messagesOf(result)
    // The chain is the post-compact one: boundary → summary → reply.
    expect(msgs.map(m => m.uuid)).toEqual(['cb', 'u2', 'a2'])
    expect(msgs[0]).toMatchObject({
      type: 'system',
      subtype: 'compact_boundary',
      message: 'Conversation compacted',
      compactMetadata: { trigger: 'manual', preTokens: 1234 },
    })
    expect(msgs[0]).not.toHaveProperty('logicalParentUuid')
    expect(msgs[1]).toMatchObject({ isCompactSummary: true })
  })
})

describe('convert — chain selection', () => {
  it('imports the latest leaf → root chain, not abandoned branches', () => {
    const result = run([
      user('u1', null, 'first'),
      assistant('a1', 'u1', [{ type: 'text', text: 'r1' }]),
      user('u2-old', 'a1', 'old branch'),
      assistant('a2-old', 'u2-old', [{ type: 'text', text: 'old reply' }]),
      user('u2', 'a1', 'new branch'),
      assistant('a2', 'u2', [{ type: 'text', text: 'new reply' }]),
    ])
    expect(messagesOf(result).map(m => m.uuid)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('falls back to file order when a parent is missing from the file', () => {
    const result = run([
      user('u1', 'gone', 'first'),
      assistant('a1', 'u1', [{ type: 'text', text: 'r1' }]),
    ])
    expect(messagesOf(result).map(m => m.uuid)).toEqual(['u1', 'a1'])
  })
})

describe('convert — tool payloads', () => {
  const toolTurn = () => [
    user('u1', null, 'read it'),
    assistant('a1', 'u1', [
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'D:\\a.ts' } },
    ]),
    toolResult('u2', 'a1', [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' },
    ], { toolUseResult: { type: 'text', file: { filePath: 'D:\\a.ts', content: 'file body' } } }),
    assistant('a2', 'u2', [{ type: 'text', text: 'Done.' }]),
  ]

  it('renames tool_use/tool_result to the canonical parts and splits the payloads into sidecars', () => {
    const result = run(toolTurn())
    const msgs = messagesOf(result)
    const a1 = msgs[1]!.message as { content: Rec[] }
    expect(a1.content[1]).toMatchObject({ type: 'tool-call', toolCallId: 'toolu_1', toolName: 'Read' })
    // Persisted line carries only the slim preview, never the full args.
    expect(a1.content[1]).not.toHaveProperty('input')
    expect((a1.content[1] as Rec).args).toEqual({ file_path: 'D:\\a.ts' })

    const u2 = msgs[2]!
    expect(u2).toMatchObject({
      type: 'user',
      sourceToolAssistantUUID: 'a1',
      toolCallDetailRef: { toolCallId: 'toolu_1', toolName: 'Read' },
      toolUseResult: '',
    })
    expect(u2).not.toHaveProperty('toolCallDetail')
    const u2Content = (u2.message as { content: Rec[] }).content
    expect(u2Content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'toolu_1' })
    expect(u2Content[0]!.result).toBeUndefined()

    expect(result.toolDetails).toHaveLength(1)
    expect(result.toolDetails[0]).toMatchObject({
      toolCallId: 'toolu_1',
      toolName: 'Read',
      args: { file_path: 'D:\\a.ts' },
      result: 'file body',
    })
  })

  it('splits a parallel tool_result line into one message per result, chained in order', () => {
    const result = run([
      user('u1', null, 'do two things'),
      assistant('a1', 'u1', [
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'a' } },
        { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'b' } },
      ]),
      toolResult('u2', 'a1', [
        { type: 'tool_result', tool_use_id: 't1', content: 'hits a' },
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'hits b' }], is_error: true },
      ]),
    ])
    const msgs = messagesOf(result)
    expect(msgs.map(m => m.uuid)).toEqual(['u1', 'a1', 'u2', 'u2-r1'])
    expect(msgs.map(m => m.parentUuid)).toEqual([null, 'u1', 'a1', 'u2'])
    expect(msgs[3]).toMatchObject({ toolCallDetailRef: { toolCallId: 't2' } })
    const byId = Object.fromEntries(result.toolDetails.map(d => [d.toolCallId, d]))
    expect(byId.t1).toMatchObject({ result: 'hits a' })
    expect(byId.t2).toMatchObject({ isError: true, result: [{ type: 'text', text: 'hits b' }] })
  })

  it('keeps non-result sibling blocks on a tool-result line as an extra message', () => {
    // A source user turn can carry a tool_result plus sibling text (a
    // `<system-reminder>` the CLI appends). The per-result split must not drop
    // those siblings — they become one extra trailing user message.
    const result = run([
      user('u1', null, 'go'),
      assistant('a1', 'u1', [
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'a' } },
      ]),
      toolResult('u2', 'a1', [
        { type: 'tool_result', tool_use_id: 't1', content: 'hits a' },
        { type: 'text', text: '<system-reminder>be careful</system-reminder>' },
      ]),
    ])
    const msgs = messagesOf(result)
    expect(msgs.map(m => m.uuid)).toEqual(['u1', 'a1', 'u2', 'u2-others'])
    // The tool-result row carries only the tool result (Grep is lazy → result
    // redacted), never the sibling text.
    const resultRow = msgs[2]!
    const resultContent = (resultRow.message as { content: Rec[] }).content
    expect(resultContent).toHaveLength(1)
    expect(resultContent[0]).toMatchObject({ type: 'tool-result', toolCallId: 't1' })
    // The sibling text survives as the trailing user message.
    const others = msgs[3]!
    expect(others).toMatchObject({ type: 'user', parentUuid: 'u2' })
    expect((others.message as { content: Rec[] }).content).toEqual([
      { type: 'text', text: '<system-reminder>be careful</system-reminder>' },
    ])
  })

  it('keeps inline-tier tool args on the line and emits no sidecar for them', () => {
    const result = run([
      user('u1', null, 'plan'),
      assistant('a1', 'u1', [
        { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending' }] } },
      ]),
      toolResult('u2', 'a1', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    ])
    const a1 = messagesOf(result)[1]!.message as { content: Rec[] }
    expect((a1.content[0] as Rec).args).toEqual({ todos: [{ content: 'x', status: 'pending' }] })
    expect(result.toolDetails).toHaveLength(0)
    expect(messagesOf(result)[2]).not.toHaveProperty('toolCallDetailRef')
  })
})

describe('convert — sub-agents', () => {
  const AGENT_ID = 'a1b2c3d4e5f60718'
  const agentTurn = (toolName = 'Agent') => [
    user('u1', null, 'delegate it'),
    assistant('a1', 'u1', [
      { type: 'tool_use', id: 'toolu_agent', name: toolName, input: { description: 'Explore the repo', prompt: 'Find the parser', subagent_type: 'Explore' } },
    ]),
    toolResult('u2', 'a1', [
      { type: 'tool_result', tool_use_id: 'toolu_agent', content: [{ type: 'text', text: 'The parser is in convert.ts' }] },
    ], { toolUseResult: { agentId: AGENT_ID, status: 'completed', content: [{ type: 'text', text: 'The parser is in convert.ts' }], totalToolUseCount: 2 } }),
    assistant('a2', 'u2', [{ type: 'text', text: 'Thanks.' }]),
  ]
  const sidechainLine = (uuid: string, parentUuid: string | null, role: 'user' | 'assistant', text: string, extra: Rec = {}) =>
    stamp({
      type: role,
      uuid,
      parentUuid,
      isSidechain: true,
      agentId: AGENT_ID,
      message: { role, content: [{ type: 'text', text }] },
      ...extra,
    })
  const subagentFile = (): ArrayBuffer =>
    bytes([
      sidechainLine('s1', null, 'user', 'Find the parser', { timestamp: '2026-08-01T10:05:00.000Z' }),
      sidechainLine('s2', 's1', 'assistant', 'Looking…', { timestamp: '2026-08-01T10:06:00.000Z' }),
      sidechainLine('s3', 's2', 'assistant', 'Found it in convert.ts', { timestamp: '2026-08-01T10:07:00.000Z' }),
    ])

  it('imports a separate sub-agent file as a background sub-agent session and links the parent Agent result to it', () => {
    const result = convert({
      path: PATH,
      bytes: bytes(agentTurn()),
      now: NOW,
      subagents: [{ agentId: AGENT_ID, path: `${PATH}-sub`, bytes: subagentFile(), meta: { agentType: 'Explore', description: 'From sidecar' } }],
    })
    expect(result.subAgents).toHaveLength(1)
    const sub = result.subAgents[0]!
    expect(sub).toMatchObject({ agentId: AGENT_ID, sessionId: `subagent-${AGENT_ID}` })
    expect(sub.taskId).toMatch(/^a[0-9a-z]{8}$/)
    expect(sub.meta.sessionId).toBe(`subagent-${AGENT_ID}`)
    expect(sub.meta.customTitle).toBe('Explore the repo')
    expect(sub.meta.metadata).toMatchObject({
      templateType: 'agent',
      projectRoot: CWD,
      lastTerminalReason: 'completed',
      importedFrom: { source: 'claude-code', spawnerSessionId: UUID },
    })
    expect(sub.entries.filter(e => (e as { type: string }).type !== CUSTOM_TITLE_TYPE).map(e => (e as Rec).uuid)).toEqual(['s1', 's2', 's3'])
    expect(sub.task).toMatchObject({
      schemaVersion: 1,
      taskId: sub.taskId,
      sessionId: `subagent-${AGENT_ID}`,
      agentId: AGENT_ID,
      spawnerSessionId: UUID,
      description: 'Explore the repo',
      agentType: 'Explore',
      status: 'success',
      summary: 'The parser is in convert.ts',
      prompt: 'Find the parser',
      startedAt: Date.parse('2026-08-01T10:05:00.000Z'),
      finishedAt: Date.parse('2026-08-01T10:07:00.000Z'),
      depth: 1,
      projectRoot: CWD,
    })
    // The converter does NOT bake the task-id ack: the bundle carries the
    // parent toolCallId, and the WRITE path stamps `(task id …)` only once the
    // sub-agent lands (agentTaskAck / sessionImportBridgeAdapter). Agent is an
    // INLINE-tier tool (no sidecar; args + result stay on the line), so convert
    // leaves the plain result on the persisted tool-result part.
    expect(sub.parentToolCallId).toBe('toolu_agent')
    expect(result.toolDetails.find(d => d.toolCallId === 'toolu_agent')).toBeUndefined()
    const resultRow = messagesOf(result).find(m => m.uuid === 'u2')!
    const part = (resultRow.message as { content: Rec[] }).content[0]!
    const text = (part.result as Array<{ text: string }>).map(b => b.text).join('')
    expect(text).toBe('The parser is in convert.ts')
    expect(resultRow.toolUseResult).toBe('The parser is in convert.ts')
    expect(result.stats.subAgents).toBe(1)
  })

  it('groups legacy inline sidechain lines by agentId into a sub-agent, keeping them out of the main chain', () => {
    const result = convert({
      path: PATH,
      bytes: bytes([
        ...agentTurn('Task'),
        sidechainLine('s1', 'a1', 'user', 'Find the parser'),
        sidechainLine('s2', 's1', 'assistant', 'Found it'),
        stamp({ type: 'user', uuid: 'orphan', parentUuid: 'a1', isSidechain: true, message: { role: 'user', content: 'no agent id' } }),
      ]),
      now: NOW,
    })
    expect(messagesOf(result).map(m => m.uuid)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(result.subAgents).toHaveLength(1)
    expect(result.subAgents[0]!.entries.filter(e => (e as { type: string }).type !== CUSTOM_TITLE_TYPE)).toHaveLength(2)
    expect(result.stats.droppedSidechain).toBe(1)
    // The CLI's older `Task` name is the same tool.
    const a1 = messagesOf(result)[1]!.message as { content: Rec[] }
    expect(a1.content[0]).toMatchObject({ type: 'tool-call', toolName: 'Agent' })
    expect(a1.content[0]!.args).toEqual({ description: 'Explore the repo', prompt: 'Find the parser', subagent_type: 'Explore' })
  })

  it('leaves the Agent result untouched when no transcript exists for its agent', () => {
    const result = convert({ path: PATH, bytes: bytes(agentTurn()), now: NOW })
    expect(result.subAgents).toEqual([])
    const resultRow = messagesOf(result).find(m => m.uuid === 'u2')!
    const part = (resultRow.message as { content: Rec[] }).content[0]!
    expect(part.result).toEqual([{ type: 'text', text: 'The parser is in convert.ts' }])
  })

  it('derives a stable task id per agent', () => {
    const a = convert({ path: PATH, bytes: bytes(agentTurn()), now: NOW, subagents: [{ agentId: AGENT_ID, path: 'x', bytes: subagentFile() }] })
    const b = convert({ path: PATH, bytes: bytes(agentTurn()), now: NOW + 1, subagents: [{ agentId: AGENT_ID, path: 'x', bytes: subagentFile() }] })
    expect(a.subAgents[0]!.taskId).toBe(b.subAgents[0]!.taskId)
  })

  it('splits interleaved legacy inline sidechains into one bundle per agentId, each linked to its own Agent call', () => {
    const AGENT_A = 'aaaa0000aaaa0000'
    const AGENT_B = 'bbbb1111bbbb1111'
    // Two Agent calls, and sidechain lines for both agents interleaved
    // line-by-line — the grouping must key on agentId, not proximity.
    const result = convert({
      path: PATH,
      bytes: bytes([
        user('u1', null, 'do both'),
        assistant('a1', 'u1', [
          { type: 'tool_use', id: 'call_a', name: 'Agent', input: { description: 'Task A', prompt: 'Prompt A', subagent_type: 'Explore' } },
        ]),
        toolResult('u2', 'a1', [
          { type: 'tool_result', tool_use_id: 'call_a', content: [{ type: 'text', text: 'A summary' }] },
        ], { toolUseResult: { agentId: AGENT_A, status: 'completed' } }),
        assistant('a2', 'u2', [
          { type: 'tool_use', id: 'call_b', name: 'Agent', input: { description: 'Task B', prompt: 'Prompt B', subagent_type: 'Plan' } },
        ]),
        toolResult('u3', 'a2', [
          { type: 'tool_result', tool_use_id: 'call_b', content: [{ type: 'text', text: 'B summary' }] },
        ], { toolUseResult: { agentId: AGENT_B, status: 'completed' } }),
        assistant('a3', 'u3', [{ type: 'text', text: 'Done both.' }]),
        sidechainLine('sa1', null, 'user', 'find A', { agentId: AGENT_A }),
        sidechainLine('sb1', null, 'user', 'find B', { agentId: AGENT_B }),
        sidechainLine('sa2', 'sa1', 'assistant', 'A: found', { agentId: AGENT_A }),
        sidechainLine('sb2', 'sb1', 'assistant', 'B: found', { agentId: AGENT_B }),
      ]),
      now: NOW,
    })
    // The main chain keeps none of the sidechain lines.
    expect(messagesOf(result).map(m => m.uuid)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    // One bundle per agent, each holding only its own lines in order.
    expect(result.subAgents.map(b => b.agentId).sort()).toEqual([AGENT_A, AGENT_B])
    const chainUuids = (agentId: string) =>
      result.subAgents
        .find(b => b.agentId === agentId)!
        .entries.filter(e => (e as { type: string }).type !== CUSTOM_TITLE_TYPE)
        .map(e => (e as Rec).uuid)
    expect(chainUuids(AGENT_A)).toEqual(['sa1', 'sa2'])
    expect(chainUuids(AGENT_B)).toEqual(['sb1', 'sb2'])
    // Each bundle links to its OWN parent Agent call by `parentToolCallId` —
    // keyed on agentId, so interleaving cannot cross the links. The converter
    // does NOT bake the `(task id …)` ack; the WRITE path stamps it per landed
    // sub-agent (session-import-bridge-adapter's interleaved round-trip test),
    // so at the converter level each parent result stays ack-free.
    const bundleOf = (agentId: string) => result.subAgents.find(b => b.agentId === agentId)!
    expect(bundleOf(AGENT_A).parentToolCallId).toBe('call_a')
    expect(bundleOf(AGENT_B).parentToolCallId).toBe('call_b')
    const ackOf = (uuid: string) => {
      const row = messagesOf(result).find(m => m.uuid === uuid)!
      const part = (row.message as { content: Rec[] }).content[0]!
      return (part.result as Array<{ text: string }>).map(b => b.text).join('')
    }
    expect(ackOf('u2')).toBe('A summary')
    expect(ackOf('u3')).toBe('B summary')
    expect(JSON.stringify(result.entries)).not.toContain('(task id')
    expect(result.stats).toMatchObject({ subAgents: 2, droppedSidechain: 0 })
  })

  it('gives an unlinked sub-agent a default title and adds no parent ack', () => {
    // A sidechain group whose agentId no Agent call in the parent references:
    // it still imports as its own bundle, just without a link's metadata.
    const ORPHAN_AGENT = 'c0ffee00c0ffee00'
    const result = convert({
      path: PATH,
      bytes: bytes([
        user('u1', null, 'hello'),
        assistant('a1', 'u1', [{ type: 'text', text: 'hi' }]),
        sidechainLine('s1', null, 'user', 'sub prompt', { agentId: ORPHAN_AGENT }),
        sidechainLine('s2', 's1', 'assistant', 'sub result', { agentId: ORPHAN_AGENT }),
      ]),
      now: NOW,
    })
    expect(result.subAgents).toHaveLength(1)
    const sub = result.subAgents[0]!
    expect(sub).toMatchObject({ agentId: ORPHAN_AGENT, sessionId: `subagent-${ORPHAN_AGENT}`, taskId: deriveTaskId(ORPHAN_AGENT) })
    // No parent Agent call → the fallback description on both the session title
    // and the task seed.
    expect(sub.meta.customTitle).toBe(`Sub-agent ${ORPHAN_AGENT}`)
    expect(sub.task).toMatchObject({
      sessionId: `subagent-${ORPHAN_AGENT}`,
      agentId: ORPHAN_AGENT,
      spawnerSessionId: UUID,
      description: `Sub-agent ${ORPHAN_AGENT}`,
      status: 'success',
      // Summary falls back to the sub-agent's own last assistant turn.
      summary: 'sub result',
      depth: 1,
      projectRoot: CWD,
    })
    // No link → no prompt and no agentType on the task seed.
    expect(sub.task).not.toHaveProperty('prompt')
    expect(sub.task).not.toHaveProperty('agentType')
    // The parent transcript carries no task-id ack — there is no linked result.
    expect(JSON.stringify(result.entries)).not.toContain('(task id')
    expect(result.stats).toMatchObject({ subAgents: 1, droppedSidechain: 0 })
  })
})

describe('convert — errors', () => {
  it('rejects an empty file, a file with no cwd, and a path without a session id', () => {
    expect(() => run([])).toThrow(ImportConvertError)
    expect(() => run([{ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'x' } }])).toThrowError(
      expect.objectContaining({ code: 'no_project_root' }),
    )
    expect(() =>
      convert({ path: '/x/notes.jsonl', bytes: bytes([{ type: 'user', uuid: 'u1', parentUuid: null, cwd: CWD, message: { role: 'user', content: 'x' } }]), now: NOW }),
    ).toThrowError(expect.objectContaining({ code: 'no_session_id' }))
  })
})
