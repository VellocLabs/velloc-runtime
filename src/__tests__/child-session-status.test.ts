/**
 * A child session's published status (F-36): the activity and turn ending the
 * sessions summary carries, the acknowledgement the start card reads, the
 * session link, and the one status the card, the chip and the row derive.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionActivityOf, turnEndingOf } from '../browser/worker/sessionActivity'
import { SessionFeedPublisher, type FeedSessionView, type SessionFeedHost } from '../browser/worker/SessionFeedPublisher'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import type { AgentSessionPhase } from '../browser/worker/AgentTurnState'
import type { NexusSessionsSummaryPayload } from '../browser/bridge/protocol/ui'
import { sessionsEventFor, type ConnectionInfo } from '../browser/runtimeHub'
import { buildSessionSummaryFromMetadata, type BrowserSessionSummary } from '../sessions/sessionStore'
import {
  childSessionNotStartedAckText,
  childSessionRegisteredText,
  parseChildSessionAck,
} from '../sessions/childSessionSpec'
import { sessionIdOfLink, sessionLinkHref, sessionLinkMarkdown } from '../sessions/sessionLink'
import {
  activityAge,
  childSessionStatus,
  childStatusLine,
  firstSentence,
  folderName,
} from '../browser/webview/childSessionStatus'
import {
  publishSessionStatuses,
  resetSessionStatusesForTests,
  sessionStatusOf,
  type SessionStatusEntry,
} from '../browser/webview/sessionStatusStore'
import { sessionActivityFromSummary, sessionStatusEntries } from '../browser/webview/sessionStatusEntries'
import { createTranslate } from '../browser/webview/i18n'
import type { SessionListItem } from '../browser/webview/SessionRows'

const t = createTranslate('en')

afterEach(() => {
  vi.useRealTimers()
  resetSessionStatusesForTests()
})

const IDLE: AgentSessionPhase = { kind: 'idle' }
const tools = (...names: string[]): AgentSessionPhase => ({
  kind: 'running',
  sub: { type: 'tools', tools: names.map(name => ({ name, kind: 'local' })) },
})

describe('sessionActivityOf / turnEndingOf', () => {
  it('names the top in-flight tool, a retry, or the reply; nothing when idle', () => {
    expect(sessionActivityOf(IDLE)).toBeUndefined()
    expect(sessionActivityOf({ kind: 'running', sub: { type: 'streaming' } })).toEqual({ kind: 'responding' })
    expect(sessionActivityOf(tools('Read', 'Grep'))).toEqual({ kind: 'tool', tool: 'Grep' })
    expect(sessionActivityOf(tools())).toEqual({ kind: 'responding' })
    expect(
      sessionActivityOf({ kind: 'running', sub: { type: 'retry', attempt: 1, maxRetries: 3, deadlineMs: 0 } } as AgentSessionPhase),
    ).toEqual({ kind: 'retrying' })
  })

  it('maps the stored terminal reason to finished, stopped or failed; a halt or nothing is no ending', () => {
    expect(turnEndingOf('completed')).toBe('finished')
    expect(turnEndingOf('max_turns')).toBe('finished')
    expect(turnEndingOf('stop_hook_prevented')).toBe('finished')
    expect(turnEndingOf('aborted_streaming')).toBe('stopped')
    expect(turnEndingOf('api_error')).toBe('failed')
    expect(turnEndingOf('prompt_too_long')).toBe('failed')
    expect(turnEndingOf('max_failures')).toBe('failed')
    expect(turnEndingOf('awaiting_user_interaction')).toBeUndefined()
    expect(turnEndingOf('next_turn')).toBeUndefined()
    expect(turnEndingOf(undefined)).toBeUndefined()
  })
})

function feedRig(entries: Map<string, FeedSessionView>, fs: Map<string, BrowserSessionSummary> = new Map()) {
  const posted: NexusSessionsSummaryPayload[] = []
  const host: SessionFeedHost = {
    getSessionEntry: id => entries.get(id),
    sessionEntries: () => entries.entries(),
    getSubscribersFor: () => [],
    getListSubscribers: () => [{ postMessage: (m: { payload: NexusSessionsSummaryPayload }) => posted.push(m.payload) }],
    isViewed: () => false,
    notifyTurnEnd: () => {},
    getFsSummaries: () => ({ keys: () => fs.keys(), peek: id => fs.get(id) }),
    routineTasks: () => [],
    recoveredRunJsRows: () => new Map<string, never[]>().entries(),
    recoveredBashRows: () => new Map<string, never[]>().entries(),
    recoveredSuperShellRows: () => new Map<string, never[]>().entries(),
  }
  return { feed: new SessionFeedPublisher(new TaskRegistry(), host), posted }
}

function live(phase: { current: AgentSessionPhase }, lastTerminalReason?: string): FeedSessionView {
  return {
    worker: { getPhase: () => phase.current as never },
    model: null,
    counters: { tool: 0, toolFail: 0, mcp: 0, mcpFail: 0 },
    needsAnswer: false,
    ...(lastTerminalReason ? { lastTerminalReason } : {}),
  }
}

describe('the sessions summary carries activity and ending', () => {
  it('a live row has its activity while running and its ending once settled; a disk row its stored ending', () => {
    const phase = { current: tools('Bash') }
    const entries = new Map([['child', live(phase, 'completed')]])
    const fs = new Map([['old', { sessionId: 'old', updatedAt: 1, messageCount: 2, firstPrompt: 'x', previewText: 'y', lastTerminalReason: 'aborted_streaming' } as BrowserSessionSummary]])
    const { feed } = feedRig(entries, fs)
    const rows = Object.fromEntries(feed.buildSummaryPayload().sessions.map(r => [r.sessionId, r]))
    expect(rows.child).toMatchObject({ running: true, activity: { kind: 'tool', tool: 'Bash' }, ending: 'finished' })
    expect(rows.old).toMatchObject({ running: false, ending: 'stopped' })
    expect(rows.old!.activity).toBeUndefined()
    phase.current = IDLE
    const settled = feed.buildSummaryPayload().sessions.find(r => r.sessionId === 'child')!
    expect(settled.activity).toBeUndefined()
    expect(settled.ending).toBe('finished')
  })

  it('a change of activity alone is broadcast, not deduplicated as equal', () => {
    vi.useFakeTimers()
    const phase = { current: tools('Read') }
    const { feed, posted } = feedRig(new Map([['child', live(phase)]]))
    feed.scheduleSummary()
    vi.advanceTimersByTime(200)
    phase.current = tools('Edit')
    feed.scheduleSummary()
    vi.advanceTimersByTime(200)
    feed.scheduleSummary()
    vi.advanceTimersByTime(200)
    expect(posted.map(p => p.sessions[0]!.activity)).toEqual([
      { kind: 'tool', tool: 'Read' },
      { kind: 'tool', tool: 'Edit' },
    ])
  })

  it('the persisted summary keeps the stored terminal reason', () => {
    const summary = buildSessionSummaryFromMetadata('s', 1, { firstPrompt: 'go', lastTerminalReason: 'api_error' } as never)
    expect(summary?.lastTerminalReason).toBe('api_error')
    expect(buildSessionSummaryFromMetadata('s', 1, { firstPrompt: 'go' } as never)?.lastTerminalReason).toBeUndefined()
  })

  it('a connection scoped to some sessions sees only their activity', () => {
    const narrow: ConnectionInfo = { connectionId: 'n', clientId: 'n', kind: 'mobile', scope: { mode: 'control', sessions: ['s1'] }, transport: 'websocket', connectedAt: 0 }
    const payload = {
      payload: {
        sessions: [
          { sessionId: 's1', running: true, activity: { kind: 'tool', tool: 'Read' }, tool: 0, toolFail: 0, mcp: 0, mcpFail: 0 },
          { sessionId: 's2', running: false, ending: 'failed', tool: 0, toolFail: 0, mcp: 0, mcpFail: 0 },
        ],
      },
    }
    const seen = sessionsEventFor(narrow, 'session.summary', payload) as { payload: { sessions: unknown[] } }
    expect(seen.payload.sessions).toEqual([payload.payload.sessions[0]])
  })
})

describe('the start acknowledgement and the session link', () => {
  it('reads back what the runtime said: the session, its name, fresh or fork, shared or not', () => {
    const shared = childSessionRegisteredText({ sessionId: 'c-1', name: 'login-fix', title: 'Fix [the] login', from: 'fresh', sharedCheckout: true, cwd: 'D:/repo' })
    expect(parseChildSessionAck(shared)).toEqual({ sessionId: 'c-1', name: 'login-fix', from: 'fresh', sharedCheckout: true, startFailed: false })
    const fork = childSessionRegisteredText({ sessionId: 'c-2', name: 'fork-1', title: 'Try it', from: 'fork', sharedCheckout: false })
    expect(parseChildSessionAck(fork)).toEqual({ sessionId: 'c-2', name: 'fork-1', from: 'fork', sharedCheckout: false, startFailed: false })
    const failed = childSessionNotStartedAckText({ sessionId: 'c-3', name: 'wt', reason: 'branch exists' })
    expect(parseChildSessionAck(failed)).toMatchObject({ sessionId: 'c-3', name: 'wt', startFailed: true })
    expect(parseChildSessionAck(`Started proposal task_ab12cd34. ${fork}`)).toMatchObject({ sessionId: 'c-2', name: 'fork-1', from: 'fork' })
    expect(parseChildSessionAck('Refused: title is required.')).toBeNull()
    expect(parseChildSessionAck('')).toBeNull()
  })

  it('the acknowledgement hands the model the link to write, one link even with brackets in the title', () => {
    const text = childSessionRegisteredText({ sessionId: 'c-1', name: 'n', title: 'Fix [the] login', from: 'fresh', sharedCheckout: false })
    expect(text).toContain('[Fix the login](#session/c-1)')
    expect(sessionLinkMarkdown('', 'c-9')).toBe('[c-9](#session/c-9)')
  })

  it('a link names a session only with a session-shaped id', () => {
    expect(sessionLinkHref('abc-1')).toBe('#session/abc-1')
    expect(sessionIdOfLink('#session/abc-1')).toBe('abc-1')
    expect(sessionIdOfLink('#session/../etc')).toBeNull()
    expect(sessionIdOfLink('#session/')).toBeNull()
    expect(sessionIdOfLink('#session/a b')).toBeNull()
    expect(sessionIdOfLink('https://example.com/#session/abc')).toBeNull()
    expect(sessionIdOfLink(undefined)).toBeNull()
  })
})

const entry = (fields: Partial<SessionStatusEntry>): SessionStatusEntry => ({ sessionId: 'c', title: 'T', ...fields })

describe('childSessionStatus', () => {
  it('orders: not listed, did not start, starting, archived, waiting, running, ending, idle', () => {
    expect(childSessionStatus(undefined).state).toBe('unknown')
    expect(childSessionStatus(entry({ startFailed: 'no git', starting: true, running: true }))).toEqual({ state: 'startFailed', reason: 'no git' })
    expect(childSessionStatus(entry({ starting: true, running: true })).state).toBe('starting')
    expect(childSessionStatus(entry({ archived: true, running: true })).state).toBe('archived')
    expect(childSessionStatus(entry({ needsAnswer: true, running: true })).state).toBe('waiting')
    expect(childSessionStatus(entry({ running: true, ending: 'finished', activity: { kind: 'tool', tool: 'Read' } }))).toEqual({ state: 'running', activity: { kind: 'tool', tool: 'Read' } })
    expect(childSessionStatus(entry({ ending: 'failed' })).state).toBe('failed')
    expect(childSessionStatus(entry({ ending: 'stopped' })).state).toBe('stopped')
    expect(childSessionStatus(entry({ ending: 'finished', previewText: 'Done. Three files changed.' }))).toEqual({ state: 'finished', lastReply: 'Done.' })
    expect(childSessionStatus(entry({})).state).toBe('idle')
  })

  it('the status line says what is happening, with the activity or the reason', () => {
    expect(childStatusLine({ state: 'running', activity: { kind: 'tool', tool: 'Read' } }, t)).toBe('Using Read')
    expect(childStatusLine({ state: 'running', activity: { kind: 'responding' } }, t)).toBe('Writing a reply')
    expect(childStatusLine({ state: 'running' }, t)).toBe('Running')
    expect(childStatusLine({ state: 'startFailed', reason: 'no git' }, t)).toBe('Did not start: no git')
    expect(childStatusLine({ state: 'waiting' }, t)).toBe('Waiting for you')
  })

  it('first sentence, age and folder name', () => {
    expect(firstSentence('  One.\nTwo.')).toBe('One.')
    expect(firstSentence('No end')).toBe('No end')
    expect(firstSentence('')).toBeUndefined()
    expect(firstSentence('x'.repeat(200))!.length).toBe(140)
    expect(activityAge(0, 30_000, t)).toBe('just now')
    expect(activityAge(0, 180_000, t)).toBe('3 minutes ago')
    expect(folderName('D:\\work\\repo\\')).toBe('repo')
    expect(folderName('/home/me/app')).toBe('app')
    expect(folderName(undefined)).toBeUndefined()
  })
})

describe('the page status index', () => {
  it('keeps an unchanged entry and stays quiet when nothing changed', () => {
    publishSessionStatuses([entry({ sessionId: 'a' }), entry({ sessionId: 'b' })])
    const a = sessionStatusOf('a')
    publishSessionStatuses([entry({ sessionId: 'a' }), entry({ sessionId: 'b', running: true })])
    expect(sessionStatusOf('a')).toBe(a)
    expect(sessionStatusOf('b')?.running).toBe(true)
    publishSessionStatuses([entry({ sessionId: 'a' })])
    expect(sessionStatusOf('b')).toBeUndefined()
  })

  it('folds the summary facts into the list entries, keeping the map when they are unchanged', () => {
    const empty = new Map()
    const rows = [{ sessionId: 'a', activity: { kind: 'tool' as const, tool: 'Read' } }, { sessionId: 'b' }]
    const facts = sessionActivityFromSummary(empty, rows)
    expect([...facts.keys()]).toEqual(['a'])
    expect(sessionActivityFromSummary(facts, rows)).toBe(facts)
    expect(sessionActivityFromSummary(facts, [{ sessionId: 'a', activity: { kind: 'tool', tool: 'Edit' } }])).not.toBe(facts)
    const items = [{ sessionId: 'a', title: 'A', previewText: '', updatedAt: 5, running: true, parentSessionId: 'p', lineageKind: 'side_session' }] as SessionListItem[]
    expect(sessionStatusEntries(items, facts)).toEqual([
      { sessionId: 'a', title: 'A', parentSessionId: 'p', lineageKind: 'side_session', running: true, updatedAt: 5, activity: { kind: 'tool', tool: 'Read' } },
    ])
    // An archived row carries the flag, so a card or chip for it reads Archived.
    const archived = sessionStatusEntries([{ sessionId: 'z', title: 'Z', previewText: '', updatedAt: 1, archived: true }], empty)
    expect(archived[0]).toMatchObject({ sessionId: 'z', archived: true })
    expect(childSessionStatus(archived[0]).state).toBe('archived')
  })
})
