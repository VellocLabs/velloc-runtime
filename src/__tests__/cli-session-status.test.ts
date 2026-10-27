/**
 * A CLI session's status (F-34): its CLI is working while the glyph ahead of
 * the terminal title keeps changing (a spinner), and that drives the row's
 * existing `running` indicator; a still glyph, no glyph, or a stopped CLI is
 * idle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliActivityClock, CliBusyTracker, cliTitleGlyph } from '../terminal/cliTitles'
import { TerminalService, type CliConversationRecord, type TerminalServiceEvent } from '../terminal/TerminalService'
import { SessionFeedPublisher, type FeedSessionView, type SessionFeedHost } from '../browser/worker/SessionFeedPublisher'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { fakePtyHost, settle } from './_helpers/fakePtyHost'

afterEach(() => {
  vi.useRealTimers()
})

describe('cliTitleGlyph', () => {
  it('is the status mark ahead of the text, or empty', () => {
    expect(cliTitleGlyph('⠋ Running tests')).toBe('⠋')
    expect(cliTitleGlyph('✳ Fix login')).toBe('✳')
    expect(cliTitleGlyph('🚀️ Ship')).toBe('🚀️')
    expect(cliTitleGlyph('Plain title')).toBe('')
  })
})

describe('CliBusyTracker', () => {
  it('a changing glyph is working until it holds still; the first and a repeated glyph are not', () => {
    vi.useFakeTimers()
    const flips: Array<[string, boolean]> = []
    const tracker = new CliBusyTracker((sessionId, busy) => flips.push([sessionId, busy]), 2000)
    tracker.observe('s1', '✳ Ready')
    tracker.observe('s1', '✳ Ready')
    expect(tracker.isBusy('s1')).toBe(false)
    tracker.observe('s1', '⠋ Working')
    tracker.observe('s1', '⠙ Working')
    tracker.observe('s1', '⠹ Working')
    expect(tracker.isBusy('s1')).toBe(true)
    expect(flips).toEqual([['s1', true]])
    vi.advanceTimersByTime(1999)
    expect(tracker.isBusy('s1')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(tracker.isBusy('s1')).toBe(false)
    expect(flips).toEqual([['s1', true], ['s1', false]])
    // A title without a glyph says nothing about work.
    tracker.observe('s1', 'Plain title')
    tracker.observe('s1', 'Other title')
    expect(tracker.isBusy('s1')).toBe(false)
    tracker.observe('s1', '✳ Back')
    expect(tracker.isBusy('s1')).toBe(false)
    expect(flips).toHaveLength(2)
  })

  it('end makes a working CLI idle at once and forgets its glyph', () => {
    vi.useFakeTimers()
    const flips: Array<[string, boolean]> = []
    const tracker = new CliBusyTracker((sessionId, busy) => flips.push([sessionId, busy]), 2000)
    tracker.observe('s1', '⠋ a')
    tracker.observe('s1', '⠙ a')
    tracker.end('s1')
    expect(tracker.isBusy('s1')).toBe(false)
    expect(flips).toEqual([['s1', true], ['s1', false]])
    // The next start's first glyph is a first sight again.
    tracker.observe('s1', '⠹ a')
    expect(tracker.isBusy('s1')).toBe(false)
    tracker.end('s2')
    expect(flips).toHaveLength(2)
  })
})

describe('TerminalService reporting a CLI at work', () => {
  function rig() {
    const fake = fakePtyHost()
    const recorded: Record<string, CliConversationRecord> = {}
    const events: TerminalServiceEvent[] = []
    let n = 0
    const service = new TerminalService({
      host: () => fake.host(),
      createRequestId: () => `r-${++n}`,
      sessionCwd: () => '/proj',
      coalesceWindowMs: 1,
      cliBusyHoldMs: 30,
      probeClis: async () => ['codex'],
      cliConversations: {
        read: async sessionId => recorded[sessionId],
        record: async (sessionId, record) => {
          recorded[sessionId] = record
        },
      },
    })
    service.subscribe(event => {
      if (event.kind === 'cliBusy') events.push(event)
    })
    return { ...fake, service, events }
  }
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  it('a spinner makes the session busy, a still glyph idle again; a shell’s spinner does not count', async () => {
    const r = rig()
    r.service.refreshHost()
    await settle()
    await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    await settle()
    r.output(r.spawned[1]!, '\u001b]2;⠋ npm\u0007\u001b]2;⠙ npm\u0007')
    r.output(r.spawned[0]!, '\u001b]2;⠋ Working\u0007')
    r.output(r.spawned[0]!, '\u001b]2;⠙ Working\u0007')
    await settle()
    expect(r.service.cliBusy('c1')).toBe(true)
    expect(r.service.cliBusy('s1')).toBe(false)
    await wait(60)
    expect(r.service.cliBusy('c1')).toBe(false)
    expect(r.events).toEqual([
      { kind: 'cliBusy', sessionId: 'c1', busy: true },
      { kind: 'cliBusy', sessionId: 'c1', busy: false },
    ])
  })

  it('a CLI that exits mid-spin is idle at once', async () => {
    const r = rig()
    r.service.refreshHost()
    await settle()
    await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await settle()
    r.output(r.spawned[0]!, '\u001b]2;⠋ a\u0007')
    r.output(r.spawned[0]!, '\u001b]2;⠙ a\u0007')
    await settle()
    expect(r.service.cliBusy('c1')).toBe(true)
    r.exit(r.spawned[0]!, 0)
    await settle()
    expect(r.service.cliBusy('c1')).toBe(false)
  })
})

describe('a working CLI as session activity', () => {
  it('touches when work starts, every interval while it lasts, and when it stops', () => {
    vi.useFakeTimers()
    const touched: string[] = []
    const clock = new CliActivityClock(sessionId => touched.push(sessionId), 1_000)
    clock.busy('c1', true)
    expect(touched).toEqual(['c1'])
    clock.busy('c1', true)
    vi.advanceTimersByTime(2_500)
    expect(touched).toEqual(['c1', 'c1', 'c1'])
    clock.busy('c1', false)
    clock.busy('c1', false)
    vi.advanceTimersByTime(5_000)
    expect(touched).toEqual(['c1', 'c1', 'c1', 'c1'])
    clock.busy('c2', true)
    clock.dispose()
    vi.advanceTimersByTime(5_000)
    expect(touched).toEqual(['c1', 'c1', 'c1', 'c1', 'c2'])
  })

  it('the terminal service moves a CLI session forward while its CLI works, not a shell session', async () => {
    const fake = fakePtyHost()
    const touches: Array<[string, number]> = []
    let clock = 1_000
    const service = new TerminalService({
      host: () => fake.host(),
      createRequestId: () => `r-${clock}`,
      sessionCwd: () => '/proj',
      coalesceWindowMs: 1,
      cliBusyHoldMs: 30,
      cliActivityIntervalMs: 20,
      now: () => clock,
      probeClis: async () => ['codex'],
      cliConversations: {
        read: async () => undefined,
        record: async () => {},
        touch: async (sessionId, at) => {
          touches.push([sessionId, at])
        },
      },
    })
    service.refreshHost()
    await settle()
    await service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await service.create({ sessionId: 's1', cols: 80, rows: 24 })
    await settle()
    fake.output(fake.spawned[1]!, ']2;◐ npm]2;◑ npm')
    fake.output(fake.spawned[0]!, ']0;✳ Review')
    fake.output(fake.spawned[0]!, ']0;◐ Review')
    await settle()
    expect(touches).toEqual([['c1', 1_000]])
    clock = 2_000
    fake.output(fake.spawned[0]!, ']0;◑ Review')
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(touches.length).toBeGreaterThanOrEqual(2)
    expect(touches.at(-1)).toEqual(['c1', 2_000])
    clock = 3_000
    fake.exit(fake.spawned[0]!, 0)
    await settle()
    expect(touches.at(-1)).toEqual(['c1', 3_000])
    expect(touches.every(([sessionId]) => sessionId === 'c1')).toBe(true)
    const count = touches.length
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(touches.length).toBe(count)
    service.dispose()
  })

  it('closing a working CLI’s terminal, as a session delete does, writes no activity', async () => {
    const fake = fakePtyHost()
    const touches: string[] = []
    const service = new TerminalService({
      host: () => fake.host(),
      createRequestId: () => 'r',
      sessionCwd: () => '/proj',
      coalesceWindowMs: 1,
      cliBusyHoldMs: 1_000,
      cliActivityIntervalMs: 20,
      probeClis: async () => ['codex'],
      cliConversations: {
        read: async () => undefined,
        record: async () => {},
        touch: async sessionId => {
          touches.push(sessionId)
        },
      },
    })
    service.refreshHost()
    await settle()
    await service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await settle()
    fake.output(fake.spawned[0]!, '\u001b]0;✳ Review\u0007')
    fake.output(fake.spawned[0]!, '\u001b]0;◐ Review\u0007')
    await settle()
    expect(service.cliBusy('c1')).toBe(true)
    expect(touches).toEqual(['c1'])
    service.closeForSession('c1')
    expect(service.cliBusy('c1')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(touches).toEqual(['c1'])
    service.dispose()
  })
})

describe('focus reports and a CLI', () => {
  const written = (fake: ReturnType<typeof fakePtyHost>, streamId: string): string =>
    fake
      .shellRequests('writeStdin')
      .map(request => request.payload as { streamId: string; data?: Uint8Array; dataBase64?: string })
      .filter(payload => payload.streamId === streamId)
      .map(payload =>
        payload.data !== undefined
          ? new TextDecoder().decode(payload.data)
          : atob(payload.dataBase64 ?? ''),
      )
      .join('')

  it('a CLI never hears focus in or out, so its title keeps reporting its work; a shell still does', async () => {
    const fake = fakePtyHost()
    const service = new TerminalService({
      host: () => fake.host(),
      createRequestId: () => 'r',
      sessionCwd: () => '/proj',
      coalesceWindowMs: 1,
      probeClis: async () => ['codex'],
      cliConversations: { read: async () => undefined, record: async () => {} },
    })
    service.refreshHost()
    await settle()
    const cli = await service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    const shell = await service.create({ sessionId: 's1', cols: 80, rows: 24 })
    await settle()
    await service.write(cli, '\u001b[O')
    await service.write(cli, 'ls\r\u001b[I')
    await service.write(cli, '\u001b[A')
    await service.write(shell, '\u001b[O')
    expect(written(fake, fake.spawned[0]!)).toBe('ls\r\u001b[A')
    expect(written(fake, fake.spawned[1]!)).toBe('\u001b[O')
    expect(fake.shellRequests('writeStdin')).toHaveLength(3)
    service.dispose()
  })
})

describe('the session summary', () => {
  it('a CLI session reads as running while its CLI works, live or disk-resident', () => {
    const busy = new Set(['c1', 'c2'])
    const entry: FeedSessionView = {
      worker: { getPhase: () => ({ kind: 'idle' }) as never },
      model: null,
      counters: { tool: 0, toolFail: 0, mcp: 0, mcpFail: 0 },
      needsAnswer: false,
    }
    const fs = new Map([['c2', undefined], ['c3', undefined]])
    const host: SessionFeedHost = {
      getSessionEntry: () => entry,
      sessionEntries: () => new Map([['c1', entry], ['a1', entry]]).entries(),
      getSubscribersFor: () => [],
      getListSubscribers: () => [],
      isViewed: () => false,
      notifyTurnEnd: () => {},
      getFsSummaries: () => ({ keys: () => fs.keys(), peek: () => undefined }),
      routineTasks: () => [],
      recoveredRunJsRows: () => new Map<string, never[]>().entries(),
      recoveredBashRows: () => new Map<string, never[]>().entries(),
      recoveredSuperShellRows: () => new Map<string, never[]>().entries(),
      isCliBusy: sessionId => busy.has(sessionId),
    }
    const rows = new SessionFeedPublisher(new TaskRegistry(), host).buildSummaryPayload().sessions
    expect(Object.fromEntries(rows.map(row => [row.sessionId, row.running]))).toEqual({
      a1: false,
      c1: true,
      c2: true,
      c3: false,
    })
  })
})
