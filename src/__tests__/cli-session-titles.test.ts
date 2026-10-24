/**
 * A CLI session's title follows its terminal title (F-34): which terminal
 * titles make a session title, the settle-then-write rule, and the terminal
 * service handing a CLI terminal's titles — and only a CLI's — to the store.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliTitleFollower, cliSessionTitle, CLI_TITLE_MAX_CHARS } from '../terminal/cliTitles'
import { TerminalService, type CliConversationRecord } from '../terminal/TerminalService'
import { fakePtyHost, settle } from './_helpers/fakePtyHost'

afterEach(() => {
  vi.useRealTimers()
})

describe('cliSessionTitle', () => {
  it('drops a leading status glyph and keeps the text', () => {
    expect(cliSessionTitle('✳ Fix the login form', 'codex')).toBe('Fix the login form')
    expect(cliSessionTitle('⠋ Running tests', 'codex')).toBe('Running tests')
    expect(cliSessionTitle('  ✻  Review  ', 'codex')).toBe('Review')
    expect(cliSessionTitle('🚀\uFE0F Ship it', 'codex')).toBe('Ship it')
  })

  it('ignores the executable\u2019s own name or path, and a title of glyphs only', () => {
    expect(cliSessionTitle('codex', 'codex')).toBeNull()
    expect(cliSessionTitle('Codex', 'codex')).toBeNull()
    expect(cliSessionTitle('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd', 'codex')).toBeNull()
    expect(cliSessionTitle('/usr/local/bin/codex', 'codex')).toBeNull()
    expect(cliSessionTitle('⠋ ', 'codex')).toBeNull()
    expect(cliSessionTitle('', 'codex')).toBeNull()
  })

  it('keeps a title that only mentions the CLI, and cuts a long one', () => {
    expect(cliSessionTitle('codex: refactor api', 'codex')).toBe('codex: refactor api')
    expect(cliSessionTitle('x'.repeat(500), 'codex')).toHaveLength(CLI_TITLE_MAX_CHARS)
  })
})

describe('CliTitleFollower', () => {
  it('writes a title once it held still, skips passing ones, and never rewrites the same text', async () => {
    vi.useFakeTimers()
    const writes: Array<[string, string]> = []
    const follower = new CliTitleFollower(async (sessionId, title) => {
      writes.push([sessionId, title])
    }, 1000)
    follower.observe('s1', 'codex', '⠋ Fix login')
    vi.advanceTimersByTime(500)
    follower.observe('s1', 'codex', '⠙ Fix login and tests')
    vi.advanceTimersByTime(999)
    expect(writes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(writes).toEqual([['s1', 'Fix login and tests']])
    // Spinner frames of the same text are not a change.
    follower.observe('s1', 'codex', '⠹ Fix login and tests')
    follower.observe('s1', 'codex', '✳ Fix login and tests')
    vi.advanceTimersByTime(5000)
    expect(writes).toHaveLength(1)
    // The executable's name in between does not cancel a pending title.
    follower.observe('s1', 'codex', 'Next task')
    follower.observe('s1', 'codex', 'codex')
    vi.advanceTimersByTime(1000)
    expect(writes.at(-1)).toEqual(['s1', 'Next task'])
  })

  it('forget drops the pending write; dispose drops every one', () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => {})
    const follower = new CliTitleFollower(write, 1000)
    follower.observe('s1', 'codex', 'One')
    follower.observe('s2', 'codex', 'Two')
    follower.forget('s1')
    vi.advanceTimersByTime(1000)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('s2', 'Two')
    follower.observe('s2', 'codex', 'Three')
    follower.dispose()
    vi.advanceTimersByTime(1000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('a failed write is retried by the next title with that text', async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => {
      throw new Error('disk')
    })
    const follower = new CliTitleFollower(write, 10)
    follower.observe('s1', 'codex', 'Same')
    vi.advanceTimersByTime(10)
    await vi.runAllTimersAsync()
    follower.observe('s1', 'codex', 'Same')
    vi.advanceTimersByTime(10)
    expect(write).toHaveBeenCalledTimes(2)
  })
})

describe('TerminalService following a CLI\u2019s title', () => {
  function rig() {
    const fake = fakePtyHost()
    const recorded: Record<string, CliConversationRecord> = {}
    const titles: Array<[string, string]> = []
    let n = 0
    const service = new TerminalService({
      host: () => fake.host(),
      createRequestId: () => `r-${++n}`,
      sessionCwd: () => '/proj',
      coalesceWindowMs: 1,
      cliTitleSettleMs: 1,
      probeClis: async () => ['codex'],
      cliConversations: {
        read: async sessionId => recorded[sessionId],
        record: async (sessionId, record) => {
          recorded[sessionId] = record
        },
        retitle: async (sessionId, title) => {
          titles.push([sessionId, title])
        },
      },
    })
    return { ...fake, service, titles }
  }
  const wait = () => new Promise(resolve => setTimeout(resolve, 20))

  it('a CLI terminal\u2019s OSC title becomes its session\u2019s title; a shell terminal\u2019s does not', async () => {
    const r = rig()
    r.service.refreshHost()
    await settle()
    await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    await settle()
    r.output(r.spawned[0]!, '\u001b]0;codex\u0007')
    r.output(r.spawned[0]!, '\u001b]2;⠋ Refactor the api\u0007')
    r.output(r.spawned[1]!, '\u001b]2;npm run dev\u0007')
    await wait()
    expect(r.titles).toEqual([['c1', 'Refactor the api']])
  })

  it('closing the session drops a title that has not settled', async () => {
    const r = rig()
    r.service.refreshHost()
    await settle()
    await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await settle()
    r.output(r.spawned[0]!, '\u001b]2;Pending\u0007')
    r.service.closeForSession('c1')
    await wait()
    expect(r.titles).toEqual([])
  })
})
