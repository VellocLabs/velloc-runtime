import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ArchiveSessionTool,
  DescribeSessionTool,
  DetachSessionTool,
  ListSessionsTool,
  ReadSessionEventsTool,
  SESSION_FAMILY_TOOLS,
  SESSION_FAMILY_TOOL_NAMES,
  StopSessionTool,
  UnarchiveSessionTool,
  sessionMessageReceipt,
} from '../toolkit/builtin/sessionFamilyTools'
import { MailTool } from '../toolkit/builtin/teamTools'
import {
  setSessionDirectory,
  type DeliveryReceipt,
  type SessionDirectory,
} from '../sessions/sessionDirectory'
import { setTeamMessenger } from '../team/teamMessenger'
import { setTemplateChannelForTest } from '../prompting/templateCatalog'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { getBrowserTools, getToolsForHostManifest } from '../toolkit/toolRegistry'
import { TOOL_GROUPS } from '../toolkit/builtin/toolGroups'
import type { BrowserHostManifest } from '../browser/bridge/protocol/manifest'

// The session-family tools (F-36) over a stub directory: the caller gate, the
// argument checks, the texts, and SendMessage's route to a session recipient.

const PARENT = { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [] } } as never
const ALLOW = async () => ({ behavior: 'allow' as const })

function ctx(overrides: Record<string, unknown> = {}, sessionId = 'caller-1'): ToolCallContext {
  const base = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId,
    cwd: '/repo',
    projectRoot: '/repo',
  })
  Object.assign(base.options, { templateType: 'code', ...overrides })
  return base
}

function stubDirectory(overrides: Partial<SessionDirectory> = {}): SessionDirectory & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return value
    }
  return {
    calls,
    list: record('list', [{ sessionId: 'c1', title: 'Parser', archived: false, running: false, name: 'parser', startedBy: 'caller-1' }]),
    describe: record('describe', { ok: true as const, session: { sessionId: 'c1', archived: false, running: false, waitingForUser: false, effectiveParentId: 'caller-1', detached: false } }),
    readEvents: record('readEvents', { ok: true as const, events: [{ uuid: 'u1', type: 'user', text: 'hi' }], hasMore: false }),
    resolves: () => true,
    send: record('send', { messageId: 'msg_1', state: 'delivered' as const, to: { sessionId: 'c1', name: 'parser' } }),
    stop: record('stop', { ok: true as const, result: 'interrupted' as const }),
    clear: record('clear', { ok: true as const }),
    setArchived: record('setArchived', { ok: true as const, changed: true }),
    detach: record('detach', { ok: true as const, changed: true }),
    ...overrides,
  }
}

beforeEach(() => setTemplateChannelForTest('beta'))
afterEach(() => {
  setTemplateChannelForTest(null)
  setSessionDirectory(null)
  setTeamMessenger(null)
})

describe('the gate', () => {
  it('refuses the stable channel, a chat session, a nested caller; errors without a directory', async () => {
    setSessionDirectory(stubDirectory())
    setTemplateChannelForTest('stable')
    expect(await ListSessionsTool.call({}, ctx(), ALLOW, PARENT)).toMatchObject({ data: /^Refused: .*release channel/ })
    setTemplateChannelForTest('beta')
    expect(await ListSessionsTool.call({}, ctx({ templateType: 'chat' }), ALLOW, PARENT)).toMatchObject({ data: /^Refused: .*"chat"/ })
    expect(await ListSessionsTool.call({}, ctx({ teammateName: 'ada' }), ALLOW, PARENT)).toMatchObject({ data: /^Refused: .*teammate/ })
    expect(await ListSessionsTool.call({}, ctx({}, 'subagent-9'), ALLOW, PARENT)).toMatchObject({ data: /^Refused: / })
    setSessionDirectory(null)
    expect(await ListSessionsTool.call({}, ctx(), ALLOW, PARENT)).toMatchObject({ isError: true, data: /unavailable/ })
  })

  it('applies to every tool of the group', async () => {
    setSessionDirectory(stubDirectory())
    setTemplateChannelForTest('stable')
    for (const tool of SESSION_FAMILY_TOOLS) {
      const out = await tool.call({ sessionId: 'c1' }, ctx(), ALLOW, PARENT)
      expect(out.data).toMatch(/^Refused: /)
    }
  })
})

describe('argument checks', () => {
  it('require a session id where one is needed, and whole-number limits', async () => {
    expect(await DescribeSessionTool.checkInput!({}, ctx())).toMatchObject({ result: false, errorCode: 1 })
    expect(await StopSessionTool.checkInput!({ sessionId: 'self' }, ctx())).toMatchObject({ result: false, errorCode: 2 })
    expect(await StopSessionTool.checkInput!({ sessionId: 'c1', clear: 'yes' as never }, ctx())).toMatchObject({ result: false, errorCode: 3 })
    expect(await StopSessionTool.checkInput!({ sessionId: 'c1', clear: true }, ctx())).toEqual({ result: true })
    expect(await DetachSessionTool.checkInput!({ sessionId: 'self' }, ctx())).toEqual({ result: true })
    expect(await ListSessionsTool.checkInput!({ limit: 2.5 }, ctx())).toMatchObject({ result: false })
    expect(await ListSessionsTool.checkInput!({ linked: 'yes' as never }, ctx())).toMatchObject({ result: false })
    expect(await ReadSessionEventsTool.checkInput!({ sessionId: 'c1', beforeUuid: '' }, ctx())).toMatchObject({ result: false, errorCode: 3 })
    expect(await ReadSessionEventsTool.checkInput!({ sessionId: 'c1', limit: 10, beforeUuid: 'u' }, ctx())).toEqual({ result: true })
  })
})

describe('the tools over the directory', () => {
  it('ListSessions passes the query through and renders rows as JSON', async () => {
    const dir = stubDirectory()
    setSessionDirectory(dir)
    const out = await ListSessionsTool.call({ linked: true, includeArchived: true, limit: 5 }, ctx(), ALLOW, PARENT)
    expect(dir.calls[0]).toEqual(['list', { callerSessionId: 'caller-1', linked: true, includeArchived: true, limit: 5 }])
    expect(JSON.parse(out.data)).toEqual([{ sessionId: 'c1', title: 'Parser', archived: false, running: false, name: 'parser', startedBy: 'caller-1' }])
    setSessionDirectory(stubDirectory({ list: async () => [] }))
    expect(await ListSessionsTool.call({ linked: true }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /family/ })
  })

  it('DescribeSession and ReadSessionEvents render the record and the page; a refusal names its code', async () => {
    const dir = stubDirectory()
    setSessionDirectory(dir)
    const described = await DescribeSessionTool.call({ sessionId: ' c1 ' }, ctx(), ALLOW, PARENT)
    expect(dir.calls[0]).toEqual(['describe', 'caller-1', 'c1'])
    expect(JSON.parse(described.data)).toMatchObject({ sessionId: 'c1', effectiveParentId: 'caller-1', detached: false })
    const events = await ReadSessionEventsTool.call({ sessionId: 'c1', limit: 3, beforeUuid: 'u9' }, ctx(), ALLOW, PARENT)
    expect(dir.calls[1]).toEqual(['readEvents', 'caller-1', 'c1', { limit: 3, beforeUuid: 'u9' }])
    expect(JSON.parse(events.data)).toEqual({ events: [{ uuid: 'u1', type: 'user', text: 'hi' }], hasMore: false })
    setSessionDirectory(stubDirectory({ readEvents: async () => ({ ok: false, code: 'unreachable', reason: 'not family.' }) }))
    const refused = await ReadSessionEventsTool.call({ sessionId: 'x' }, ctx(), ALLOW, PARENT)
    expect(refused).toEqual({ data: 'Refused (unreachable): not family.' })
  })

  it('StopSession says what happened: interrupted, idle, starting, or refused on a human gate', async () => {
    setSessionDirectory(stubDirectory())
    expect(await StopSessionTool.call({ sessionId: 'c1' }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /interrupted/ })
    setSessionDirectory(stubDirectory({ stop: async () => ({ ok: true, result: 'idle' }) }))
    expect(await StopSessionTool.call({ sessionId: 'c1' }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /no turn in flight/ })
    setSessionDirectory(stubDirectory({ stop: async () => ({ ok: true, result: 'starting' }) }))
    expect(await StopSessionTool.call({ sessionId: 'c1' }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /still starting/ })
    setSessionDirectory(stubDirectory({ stop: async () => ({ ok: false, code: 'waiting_user', reason: 'the user is asked.' }) }))
    expect(await StopSessionTool.call({ sessionId: 'c1' }, ctx(), ALLOW, PARENT)).toEqual({ data: 'Refused (waiting_user): the user is asked.' })
  })

  it('StopSession with clear starts the conversation over instead of stopping, and says what the next message needs', async () => {
    const dir = stubDirectory()
    setSessionDirectory(dir)
    const out = await StopSessionTool.call({ sessionId: 'c1', clear: true }, ctx(), ALLOW, PARENT)
    expect(out.data).toMatch(/conversation is starting over/)
    expect(out.data).toMatch(/complete brief/)
    expect(await StopSessionTool.call({ sessionId: 'c1', clear: false }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /interrupted/ })
    expect(dir.calls).toEqual([
      ['clear', 'caller-1', 'c1'],
      ['stop', 'caller-1', 'c1'],
    ])
    setSessionDirectory(stubDirectory({ clear: async () => ({ ok: false, code: 'running', reason: 'stop it first.' }) }))
    expect(await StopSessionTool.call({ sessionId: 'c1', clear: true }, ctx(), ALLOW, PARENT)).toEqual({ data: 'Refused (running): stop it first.' })
  })

  it('ArchiveSession / UnarchiveSession / DetachSession report changed, unchanged and refusals', async () => {
    const dir = stubDirectory()
    setSessionDirectory(dir)
    expect(await ArchiveSessionTool.call({ sessionId: 'c1' }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /is archived.*not;/s })
    expect(await UnarchiveSessionTool.call({ sessionId: 'c1' }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /back in the active list/ })
    expect(await DetachSessionTool.call({ sessionId: 'self' }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /^This session is detached/ })
    expect(dir.calls).toEqual([
      ['setArchived', 'caller-1', 'c1', true],
      ['setArchived', 'caller-1', 'c1', false],
      ['detach', 'caller-1', 'self'],
    ])
    setSessionDirectory(stubDirectory({ setArchived: async () => ({ ok: true, changed: false }), detach: async () => ({ ok: false, code: 'user_fork', reason: 'theirs.' }) }))
    expect(await ArchiveSessionTool.call({ sessionId: 'c1' }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /already archived/ })
    expect(await UnarchiveSessionTool.call({ sessionId: 'c1' }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /was not archived/ })
    expect(await DetachSessionTool.call({ sessionId: 'c1' }, ctx(), ALLOW, PARENT)).toEqual({ data: 'Refused (user_fork): theirs.' })
  })
})

describe('SendMessage to a session', () => {
  const noMember = { deliver: () => ({ ok: false, reason: 'no member "x" in team "y"' }), shutdownMember: () => ({ ok: true }) }

  it('routes a recipient no team knows to the directory and answers with the receipt tail', async () => {
    setTeamMessenger(noMember)
    const dir = stubDirectory()
    setSessionDirectory(dir)
    const out = await MailTool.call({ to: 'parent', message: 'done with the parser' }, ctx(), ALLOW, PARENT)
    expect(dir.calls).toEqual([['send', 'caller-1', 'parent', 'done with the parser']])
    expect(out.data).toMatch(/^Message sent to "parser" \(session c1\); it starts a turn on it now\. \(delivery: delivered; message_id: msg_1\)$/)
    expect((out as { isError?: boolean }).isError).toBeUndefined()
  })

  it('a queued and a kept message are not errors; a refused one is, with its reason code', async () => {
    setTeamMessenger(noMember)
    const receipts: Record<string, DeliveryReceipt> = {
      queued: { messageId: 'msg_2', state: 'queued', to: { sessionId: 'c1', title: 'Parser' } },
      kept: { messageId: 'msg_3', state: 'undelivered', reasonCode: 'no_turn', reason: 'no runtime now.', to: { sessionId: 'c2' } },
      archived: { messageId: 'msg_4', state: 'undelivered', reasonCode: 'archived', reason: 'it is archived.', to: { sessionId: 'a' } },
      self: { messageId: 'msg_5', state: 'undelivered', reasonCode: 'self', reason: 'not yourself.' },
    }
    for (const [key, receipt] of Object.entries(receipts)) {
      setSessionDirectory(stubDirectory({ send: async () => receipt }))
      const out = await MailTool.call({ to: key, message: 'hi' }, ctx(), ALLOW, PARENT)
      expect(out.data.endsWith(`message_id: ${receipt.messageId})`)).toBe(true)
      if (key === 'queued') expect(out).toMatchObject({ data: /^Message sent to "Parser" \(session c1\); the session is working or halted.*\(delivery: queued; message_id: msg_2\)$/ })
      if (key === 'kept') {
        expect(out.data).toMatch(/^Message kept for session c2: no runtime now\. It may still be picked up; do not resend it\. \(delivery: undelivered; reason_code: no_turn; message_id: msg_3\)$/)
        expect((out as { isError?: boolean }).isError).toBeUndefined()
      }
      if (key === 'archived' || key === 'self') {
        expect(out).toMatchObject({ isError: true, data: /^Message not delivered: .*\(delivery: undelivered; reason_code: (archived|self); message_id: msg_[45]\)$/ })
      }
    }
  })

  it('a session recipient is offered only where the session tools are: a stable lead, a chat session, a teammate and a sub-agent keep the team failure and never reach the directory', async () => {
    setTeamMessenger(noMember)
    const dir = stubDirectory()
    setSessionDirectory(dir)
    const teamFailure = { isError: true, data: 'Message not delivered: no member "x" in team "y".' }
    setTemplateChannelForTest('stable')
    expect(await MailTool.call({ to: 'parent', message: 'hi' }, ctx(), ALLOW, PARENT)).toMatchObject(teamFailure)
    setTemplateChannelForTest('beta')
    expect(await MailTool.call({ to: 'parent', message: 'hi' }, ctx({ templateType: 'chat' }), ALLOW, PARENT)).toMatchObject(teamFailure)
    expect(await MailTool.call({ to: 'parent', message: 'hi' }, ctx({ teammateName: 'ada', teamName: 'team-1' }, 'teammate-7'), ALLOW, PARENT)).toMatchObject(teamFailure)
    expect(await MailTool.call({ to: 'c1', message: 'hi' }, ctx({}, 'subagent-9'), ALLOW, PARENT)).toMatchObject(teamFailure)
    expect(dir.calls).toEqual([])
    // The same call from a beta code session reaches the directory.
    expect(await MailTool.call({ to: 'parent', message: 'hi' }, ctx(), ALLOW, PARENT)).toMatchObject({ data: /delivery: delivered/ })
    expect(dir.calls).toEqual([['send', 'caller-1', 'parent', 'hi']])
  })

  it('a recipient neither a team nor the directory knows keeps the team failure text', async () => {
    setTeamMessenger(noMember)
    setSessionDirectory(stubDirectory({ send: async () => ({ messageId: 'msg_9', state: 'undelivered', reasonCode: 'unknown', reason: 'nobody.' }) }))
    const out = await MailTool.call({ to: 'nobody', message: 'hi' }, ctx(), ALLOW, PARENT)
    expect(out).toMatchObject({ isError: true, data: 'Message not delivered: no member "x" in team "y".' })
  })

  it('a teammate the team knows is delivered by the team path, untouched', async () => {
    setTeamMessenger({ deliver: () => ({ ok: true }), shutdownMember: () => ({ ok: true }) })
    const dir = stubDirectory()
    setSessionDirectory(dir)
    const out = await MailTool.call({ to: 'ada', message: 'hi' }, ctx(), ALLOW, PARENT)
    expect(dir.calls).toEqual([])
    expect(out.data).toMatch(/^Message sent to "ada" in team/)
  })

  it('the receipt text covers every state', () => {
    expect(sessionMessageReceipt({ messageId: 'm', state: 'sending' }, 'x').data).toBe('Message to "x" is on its way. (delivery: sending; message_id: m)')
    expect(sessionMessageReceipt({ messageId: 'm', state: 'undelivered' }, 'x')).toEqual({ data: 'Message not delivered: refused. (delivery: undelivered; message_id: m)', isError: true })
  })
})

describe('registration', () => {
  it('the tools form the sessions group and reach both tool pools under their names', () => {
    expect([...TOOL_GROUPS.sessions]).toEqual([
      'SpawnSession',
      'ProposeSession',
      'WithdrawProposal',
      'HandOffSession',
      ...SESSION_FAMILY_TOOL_NAMES,
      'SendMessage',
    ])
    const manifest = {
      hostedTools: [],
      toolNames: [...SESSION_FAMILY_TOOL_NAMES, 'SendMessage'],
    } as unknown as BrowserHostManifest
    expect(getToolsForHostManifest(manifest).map(t => t.name)).toEqual([...SESSION_FAMILY_TOOL_NAMES, 'SendMessage'])
    const browserNames = new Set(getBrowserTools().map(t => t.name))
    for (const name of SESSION_FAMILY_TOOL_NAMES) expect(browserNames.has(name)).toBe(true)
  })
})
