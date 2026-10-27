/**
 * A CLI session reads its CLI's own logs (F-34): the Codex conversation a
 * start created is found and recorded, so a restart and Continue resume it;
 * and a new conversation of a CLI that sets no terminal title takes the
 * title its log gives. A terminal title, once followed, wins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeRequest } from '../browser/bridge/browserBridgeProtocol'
import { sourceRoot } from '../browser/bridge/adapter/sessionImportBridgeAdapter'
import type { ImportSessionLiteRow } from '../sessionImport/protocol'
import { CLI_AGENT_IDS } from '../terminal/cliAgents'
import {
  CLI_LOG_HEAD_BYTES,
  CliLogFollower,
  cliLogDayFolders,
  cliLogSource,
  comparablePath,
  createBridgeCliLogReader,
  startedConversations,
  type CliLogReader,
  type FoundConversation,
} from '../terminal/cliLogs'
import { CliTypedLines, lineMatchesPromptTitle } from '../terminal/cliTypedLines'
import { TerminalService, type CliConversationRecord, type CliConversationStore } from '../terminal/TerminalService'
import { projectFolderKey } from '../utils/conversationStoragePaths'
import { fakePtyHost, ok, fail, PTY_MANIFEST, routeOf, settle } from './_helpers/fakePtyHost'

const OTHER_CLI = CLI_AGENT_IDS.find(id => id !== 'codex')!
const ID_A = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const ID_B = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'
const ID_C = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d'
const START = Date.parse('2026-10-23T10:00:00Z')

afterEach(() => {
  vi.useRealTimers()
})

function row(sessionId: string, projectPath: string | null, createdAt: string | null): ImportSessionLiteRow {
  return {
    source: 'codex',
    path: `/logs/rollout-x-${sessionId}.jsonl`,
    sessionId,
    title: null,
    projectPath,
    createdAt,
    mtimeMs: 0,
    size: 1,
    importable: true,
  }
}

describe('finding the conversation a start created', () => {
  it('compares folders in one spelling', () => {
    expect(comparablePath('D:\\Work\\Api\\')).toBe('d:/work/api')
    expect(comparablePath('\\\\?\\D:\\Work\\Api')).toBe('d:/work/api')
    expect(comparablePath('/home/me/Api/')).toBe('/home/me/Api')
  })

  it('searches the day folders around the start', () => {
    const folders = cliLogDayFolders(START, START + 60_000)
    expect(folders).toHaveLength(3)
    expect(folders.every(folder => /^\d{4}\/\d{2}\/\d{2}$/.test(folder))).toBe(true)
  })

  it('lists the logs of that folder created since the start, earliest first, skipping taken ones', () => {
    const rows = [
      row(ID_A, 'D:\\work\\api', '2026-10-23T09:00:00Z'),
      row(ID_B, 'D:\\work\\other', '2026-10-23T10:00:05Z'),
      row(ID_C, 'd:/work/api/', '2026-10-23T10:00:09Z'),
      row(ID_B.replace('5c', '5e'), 'D:\\work\\api', '2026-10-23T10:00:20Z'),
    ]
    const where = { cwd: 'D:\\work\\api', startedAt: START, taken: new Set<string>() }
    expect(startedConversations(rows, where).map(found => found.id)).toEqual([ID_C, ID_B.replace('5c', '5e')])
    expect(startedConversations(rows, { ...where, taken: new Set([ID_C]) }).map(found => found.id)).toEqual([
      ID_B.replace('5c', '5e'),
    ])
    expect(startedConversations([row(ID_A, null, '2026-10-23T10:00:01Z')], where)).toEqual([])
  })
})

/** A host with `shell.env` whose `fs` answers from `files` (paths compared with `/`). */
function logHost(files: Record<string, { text: string; mtimeMs: number }>) {
  const norm = (path: string) => path.replace(/\\/g, '/')
  const table = new Map(Object.entries(files).map(([path, file]) => [norm(path), file]))
  const fake = fakePtyHost({
    answer: (request: BrowserBridgeRequest) => {
      const payload = request.payload as { path?: string; offset?: number; length?: number }
      switch (routeOf(request)) {
        case 'shell.env':
          return ok({ values: { PATH: '', USERPROFILE: 'C:\\Users\\me', HOME: null, APPDATA: null } })
        case 'fs.readdirTree': {
          const dir = `${norm(payload.path!)}/`
          const entries = [...table.entries()]
            .filter(([path]) => path.startsWith(dir) && !path.slice(dir.length).includes('/'))
            .map(([path, file]) => ({
              path: path.slice(dir.length),
              isDirectory: false,
              size: file.text.length,
              mtimeMs: file.mtimeMs,
            }))
          return entries.length > 0 ? ok({ entries }) : fail('NOT_FOUND')
        }
        case 'fs.readRange': {
          const file = table.get(norm(payload.path!))
          if (!file) return fail('NOT_FOUND')
          const offset = payload.offset ?? 0
          const data = new TextEncoder().encode(file.text).slice(offset, offset + payload.length!)
          return ok({ data, bytesRead: data.byteLength })
        }
        default:
          return undefined
      }
    },
  })
  const manifest = { ...PTY_MANIFEST!, primitives: [...PTY_MANIFEST!.primitives!, 'shell.env'] }
  return { ...fake, host: () => fake.host(manifest) }
}

function rollout(id: string, cwd: string, at: string, prompt: string): string {
  const user = (text: string) =>
    JSON.stringify({
      timestamp: at,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })
  return [
    JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id, timestamp: at, cwd } }),
    user('<environment_context>cwd</environment_context>'),
    user(prompt),
  ].join('\n')
}

describe('the bridge log reader', () => {
  const home = 'C:\\Users\\me'
  const day = (at: number) => cliLogDayFolders(at, at)[1]!

  it('finds a Codex conversation in the start day folder and titles it by its first prompt', async () => {
    const dir = `${sourceRoot(home, cliLogSource('codex'))}/${day(START)}`
    const fake = logHost({
      [`${dir}/rollout-2026-10-23T10-00-03-${ID_A}.jsonl`]: {
        text: rollout(ID_A, 'D:\\work\\api', '2026-10-23T10:00:03Z', 'Fix the login bug'),
        mtimeMs: START + 3_000,
      },
      [`${dir}/rollout-2026-10-23T08-00-00-${ID_B}.jsonl`]: {
        text: rollout(ID_B, 'D:\\work\\api', '2026-10-23T08:00:00Z', 'Older'),
        mtimeMs: START - 3_600_000,
      },
    })
    let n = 0
    const reader = createBridgeCliLogReader(fake.host, () => `r-${++n}`, () => START + 10_000)
    const [found, ...more] = await reader.findConversations('codex', {
      cwd: 'D:\\work\\api',
      startedAt: START,
      taken: new Set(),
    })
    expect(found?.id).toBe(ID_A)
    expect(found?.prompt).toBe('Fix the login bug')
    expect(more).toEqual([])
    expect(await reader.title('codex', { cwd: 'D:\\work\\api', id: ID_A, log: found!.log })).toBe(
      'Fix the login bug',
    )
    // The older log is listed but never read: it predates the start.
    const reads = fake.requests.filter(r => routeOf(r) === 'fs.readRange').map(r => (r.payload as { path: string }).path)
    expect(reads.some(path => path.includes(ID_B))).toBe(false)
  })

  it("reads the other CLI's log from its project folder by the recorded id", async () => {
    const path = `${sourceRoot(home, cliLogSource(OTHER_CLI))}/${projectFolderKey('D:\\work\\api')}/${ID_C}.jsonl`
    const fake = logHost({
      [path]: {
        text: JSON.stringify({ type: 'user', message: { role: 'user', content: 'Explain the build' }, cwd: 'D:\\work\\api' }),
        mtimeMs: START,
      },
    })
    const reader = createBridgeCliLogReader(fake.host, () => 'r')
    expect(await reader.title(OTHER_CLI, { cwd: 'D:\\work\\api\\', id: ID_C, log: null })).toBe('Explain the build')
    expect(await reader.findConversations(OTHER_CLI, { cwd: 'D:\\work\\api', startedAt: START, taken: new Set() })).toEqual([])
  })

  it('finds a log whose opening record is longer than the head, with its first prompt', async () => {
    const dir = `${sourceRoot(home, cliLogSource('codex'))}/${day(START)}`
    const at = '2026-10-23T10:00:03Z'
    const opening = JSON.stringify({
      timestamp: at,
      type: 'session_meta',
      payload: { id: ID_A, timestamp: at, cwd: 'D:\\work\\api', instructions: 'x'.repeat(CLI_LOG_HEAD_BYTES + 10_000) },
    })
    const rest = rollout(ID_A, 'D:\\work\\api', at, 'Fix the login bug').split('\n').slice(1)
    const fake = logHost({
      [`${dir}/rollout-2026-10-23T10-00-03-${ID_A}.jsonl`]: { text: [opening, ...rest].join('\n'), mtimeMs: START + 3_000 },
    })
    const reader = createBridgeCliLogReader(fake.host, () => 'r', () => START + 10_000)
    const found = await reader.findConversations('codex', { cwd: 'D:\\work\\api', startedAt: START, taken: new Set() })
    expect(found.map(f => [f.id, f.prompt])).toEqual([[ID_A, 'Fix the login bug']])
  })

  it('a later look reads again only a log of the folder still without its first prompt that changed', async () => {
    const dir = `${sourceRoot(home, cliLogSource('codex'))}/${day(START)}`
    const at = '2026-10-23T10:00:03Z'
    const name = (id: string) => `${dir}/rollout-2026-10-23T10-00-03-${id}.jsonl`
    const unprompted = rollout(ID_C, 'D:\\work\\api', at, 'Write the docs').split('\n').slice(0, 2).join('\n')
    const files = {
      [name(ID_A)]: { text: rollout(ID_A, 'D:\\work\\api', at, 'Fix the login bug'), mtimeMs: START + 3_000 },
      [name(ID_B)]: { text: rollout(ID_B, 'D:\\work\\web', at, 'Elsewhere'), mtimeMs: START + 3_000 },
      [name(ID_C)]: { text: unprompted, mtimeMs: START + 3_000 },
    }
    const fake = logHost(files)
    const reads = () => fake.requests.filter(r => routeOf(r) === 'fs.readRange').map(r => (r.payload as { path: string }).path)
    const reader = createBridgeCliLogReader(fake.host, () => 'r', () => START + 10_000)
    const where = { cwd: 'D:\\work\\api', startedAt: START, taken: new Set<string>() }
    expect((await reader.findConversations('codex', where)).map(f => [f.id, f.prompt])).toEqual([
      [ID_A, 'Fix the login bug'],
      [ID_C, null],
    ])
    const first = reads().length
    expect(first).toBe(3)
    await reader.findConversations('codex', where)
    expect(reads().length).toBe(first)
    // Each log changes; only the one of this folder still without its first prompt is read again.
    files[name(ID_A)]!.mtimeMs += 1_000
    files[name(ID_B)]!.mtimeMs += 1_000
    Object.assign(files[name(ID_C)]!, { text: rollout(ID_C, 'D:\\work\\api', at, 'Write the docs'), mtimeMs: START + 4_000 })
    const again = await reader.findConversations('codex', where)
    expect(again.map(f => [f.id, f.prompt])).toEqual([
      [ID_A, 'Fix the login bug'],
      [ID_C, 'Write the docs'],
    ])
    expect(reads().slice(first).filter(path => !path.includes(ID_C))).toEqual([])
  })

  it('a log a session already took is not read', async () => {
    const dir = `${sourceRoot(home, cliLogSource('codex'))}/${day(START)}`
    const fake = logHost({
      [`${dir}/rollout-2026-10-23T10-00-03-${ID_A}.jsonl`]: {
        text: rollout(ID_A, 'D:\\work\\api', '2026-10-23T10:00:03Z', 'Fix the login bug'),
        mtimeMs: START + 3_000,
      },
    })
    const reader = createBridgeCliLogReader(fake.host, () => 'r', () => START + 10_000)
    expect(
      await reader.findConversations('codex', { cwd: 'D:\\work\\api', startedAt: START, taken: new Set([ID_A]) }),
    ).toEqual([])
    expect(fake.requests.some(r => routeOf(r) === 'fs.readRange')).toBe(false)
  })

  it('reads nothing on a host without shell.env', async () => {
    const fake = fakePtyHost()
    const reader = createBridgeCliLogReader(() => fake.host(), () => 'r')
    expect(await reader.findConversations('codex', { cwd: 'D:\\x', startedAt: START, taken: new Set() })).toEqual([])
    expect(fake.requests.some(r => routeOf(r).startsWith('fs.read'))).toBe(false)
  })
})

describe('CliLogFollower', () => {
  const log = (id: string, path: string): FoundConversation => ({ id, log: path, at: START + 1_000, prompt: null })

  function fakeReader(found: Array<FoundConversation | null>, title: string | null = 'From the log') {
    return {
      findConversations: vi.fn<CliLogReader['findConversations']>(async () => {
        const next = found.shift()
        return next ? [next] : []
      }),
      title: vi.fn<CliLogReader['title']>(async () => title),
    }
  }

  it('looks on a schedule until the conversation is found, then records it and titles it once', async () => {
    vi.useFakeTimers()
    const reader = fakeReader([null, log(ID_A, '/l/a.jsonl')])
    const found = vi.fn(async () => {})
    const retitle = vi.fn(async () => {})
    const follower = new CliLogFollower({ reader, found, retitle, hasTerminalTitle: () => false, retryMs: [10, 20, 40] })
    follower.start('s1', { cli: 'codex', cwd: '/w', startedAt: START, id: null, fresh: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(found).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20)
    expect(found).toHaveBeenCalledWith('s1', ID_A, false)
    expect(reader.title).toHaveBeenCalledWith('codex', { cwd: '/w', id: ID_A, log: '/l/a.jsonl' })
    expect(retitle).toHaveBeenCalledWith('s1', 'From the log')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reader.findConversations).toHaveBeenCalledTimes(2)
  })

  it('a poke looks at once; a followed terminal title means no log title', async () => {
    const reader = fakeReader([log(ID_A, '/l/a.jsonl')])
    const retitle = vi.fn(async () => {})
    const follower = new CliLogFollower({
      reader,
      found: async () => {},
      retitle,
      hasTerminalTitle: () => true,
      retryMs: [60_000],
    })
    follower.start('s1', { cli: 'codex', cwd: '/w', startedAt: START, id: null, fresh: true })
    follower.poke('s1')
    await settle()
    expect(reader.findConversations).toHaveBeenCalledTimes(1)
    expect(reader.title).not.toHaveBeenCalled()
    expect(retitle).not.toHaveBeenCalled()
    follower.dispose()
  })

  it('a continued conversation with a known id needs nothing; a found id is never handed to a second session', async () => {
    const reader = fakeReader([log(ID_A, '/l/a'), log(ID_A, '/l/a')])
    const found = vi.fn(async () => {})
    const follower = new CliLogFollower({ reader, found, hasTerminalTitle: () => false, retryMs: [60_000] })
    follower.start('known', { cli: 'codex', cwd: '/w', startedAt: START, id: ID_B, fresh: false })
    follower.poke('known')
    follower.start('s1', { cli: 'codex', cwd: '/w', startedAt: START, id: null, fresh: true })
    follower.start('s2', { cli: 'codex', cwd: '/w', startedAt: START, id: null, fresh: true })
    follower.poke('s1')
    await settle()
    follower.poke('s2')
    await settle()
    expect(found.mock.calls).toEqual([['s1', ID_A, false]])
    expect(reader.findConversations.mock.calls[1]![1].taken.has(ID_A)).toBe(true)
    follower.dispose()
  })

  describe('one session waiting in its folder', () => {
    // A conversation started in the same folder outside Velloc, just after the session.
    const outside: FoundConversation = { id: ID_A, log: '/l/a', at: START + 3_000, prompt: 'Summarize the repo' }

    function lone(listed: FoundConversation[], recorded?: () => Promise<Iterable<string>>) {
      const found = vi.fn(async () => {})
      const reader = {
        findConversations: vi.fn<CliLogReader['findConversations']>(async (_cli, where) =>
          listed.filter(l => !where.taken.has(l.id)),
        ),
        title: async () => null,
      }
      const follower = new CliLogFollower({
        reader,
        found,
        hasTerminalTitle: () => false,
        retryMs: [60_000],
        ...(recorded ? { recorded } : {}),
      })
      follower.start('s1', { cli: 'codex', cwd: '/w', startedAt: START, id: null, fresh: false })
      return { found, follower, reader }
    }

    it('after submitting a prompt it takes only the log of that prompt, confirmed', async () => {
      const own: FoundConversation = { id: ID_B, log: '/l/b', at: START + 6_000, prompt: 'Fix the login bug' }
      const { found, follower } = lone([outside, own])
      follower.typed('s1', 'Fix the login bug\r', START + 5_000)
      follower.poke('s1')
      await settle()
      expect(found.mock.calls).toEqual([['s1', ID_B, true]])
      follower.dispose()
    })

    it('after submitting a prompt it leaves a log of another prompt alone', async () => {
      const { found, follower } = lone([outside])
      follower.typed('s1', 'Fix the login bug\r', START + 5_000)
      follower.poke('s1')
      await settle()
      expect(found).not.toHaveBeenCalled()
      follower.dispose()
    })

    it('with nothing submitted it takes the earliest log, unconfirmed', async () => {
      const { found, follower } = lone([outside])
      follower.poke('s1')
      await settle()
      expect(found.mock.calls).toEqual([['s1', ID_A, false]])
      follower.dispose()
    })

    it('never takes a conversation a session already recorded; the recorded ids are read once', async () => {
      const recorded = vi.fn(async () => [ID_A])
      const later: FoundConversation = { id: ID_B, log: '/l/b', at: START + 4_000, prompt: null }
      const { found, follower } = lone([outside, later], recorded)
      follower.poke('s1')
      await settle()
      expect(found.mock.calls).toEqual([['s1', ID_B, false]])
      follower.start('s2', { cli: 'codex', cwd: '/w', startedAt: START, id: null, fresh: false })
      follower.poke('s2')
      await settle()
      expect(found).toHaveBeenCalledTimes(1)
      expect(recorded).toHaveBeenCalledTimes(1)
      follower.dispose()
    })

    it('settle waits for the look in progress, then looks once more', async () => {
      const gates: Array<() => void> = []
      let listed: FoundConversation[] = []
      const reader = {
        findConversations: vi.fn<CliLogReader['findConversations']>(async () => {
          const now = listed
          await new Promise<void>(resolve => gates.push(resolve))
          return now
        }),
        title: async () => null,
      }
      const found = vi.fn(async () => {})
      const follower = new CliLogFollower({ reader, found, hasTerminalTitle: () => false, retryMs: [60_000] })
      follower.start('s1', { cli: 'codex', cwd: '/w', startedAt: START, id: null, fresh: false })
      follower.poke('s1')
      await settle()
      listed = [log(ID_A, '/l/a')]
      let done = false
      const settled = follower.settle('s1').then(() => {
        done = true
      })
      gates.shift()!()
      await settle()
      expect(found).not.toHaveBeenCalled()
      expect(done).toBe(false)
      gates.shift()!()
      await settled
      expect(found.mock.calls).toEqual([['s1', ID_A, false]])
      follower.dispose()
    })
  })

  describe('two sessions waiting in one folder', () => {
    // A is started first and prompted second; B's log appears first.
    const logA: FoundConversation = { id: ID_A, log: '/l/a', at: START + 30_000, prompt: 'Write the docs' }
    const logB: FoundConversation = { id: ID_B, log: '/l/b', at: START + 20_000, prompt: 'Fix the flaky test' }

    function pair(listed: () => FoundConversation[]) {
      const found = vi.fn(async () => {})
      const reader = {
        findConversations: vi.fn<CliLogReader['findConversations']>(async (_cli, where) =>
          listed().filter(l => !where.taken.has(l.id)),
        ),
        title: async () => null,
      }
      const follower = new CliLogFollower({ reader, found, hasTerminalTitle: () => false, retryMs: [60_000] })
      follower.start('a', { cli: 'codex', cwd: 'D:\\work\\api', startedAt: START, id: null, fresh: false })
      follower.start('b', { cli: 'codex', cwd: 'd:/work/api/', startedAt: START + 5_000, id: null, fresh: false })
      return { found, follower }
    }

    it('each takes the log of the prompt it submitted, whichever looks first', async () => {
      let listed = [logB]
      const { found, follower } = pair(() => listed)
      follower.typed('b', 'Fix the fl', START + 19_000)
      follower.typed('b', 'aky test\r', START + 19_500)
      follower.poke('a')
      await settle()
      expect(found.mock.calls).toEqual([['b', ID_B, true]])
      follower.typed('a', '\u001b[200~Write the\ndocs\u001b[201~\r', START + 29_000)
      listed = [logB, logA]
      follower.poke('a')
      await settle()
      expect(found.mock.calls).toEqual([
        ['b', ID_B, true],
        ['a', ID_A, true],
      ])
      follower.dispose()
    })

    it('without a matching prompt, the session whose last submit came nearest before the log takes it', async () => {
      const unnamed = { ...logB, prompt: null }
      const { found, follower } = pair(() => [unnamed])
      follower.typed('a', 'y\r', START + 2_000)
      follower.typed('b', 'something\r', START + 19_000)
      follower.poke('a')
      await settle()
      expect(found.mock.calls).toEqual([['b', ID_B, false]])
      follower.dispose()
    })

    it('with nothing submitted to tell them apart, the session looking takes the earliest log', async () => {
      const { found, follower } = pair(() => [logB])
      follower.poke('a')
      await settle()
      expect(found.mock.calls).toEqual([['a', ID_B, false]])
      follower.dispose()
    })
  })
})

describe('CliTypedLines', () => {
  it('rebuilds submitted lines: erase, clear, escape keys and pasted newlines', () => {
    const typed = new CliTypedLines()
    typed.feed('Fix the bugg\u007f', 1)
    typed.feed('\u001b[D\u001bOA s\r', 2)
    typed.feed('drop me\u0015\u001b[200~two\r\nlines\u001b[201~\r', 3)
    typed.feed('\r   \r', 4)
    expect(typed.lines).toEqual([
      { text: 'Fix the bug s', at: 2 },
      { text: 'two  lines', at: 3 },
    ])
  })

  it('matches a line to the title its prompt gives, whitespace aside and a cut title by its start', () => {
    expect(lineMatchesPromptTitle('two  lines', 'two lines')).toBe(true)
    expect(lineMatchesPromptTitle('!ls -la', '! ls -la')).toBe(true)
    expect(lineMatchesPromptTitle('Fix the flaky test in the parser', 'Fix the flaky…')).toBe(true)
    expect(lineMatchesPromptTitle('Fix the flaky test', 'Fix the flaky')).toBe(false)
    expect(lineMatchesPromptTitle('anything', '…')).toBe(false)
  })
})

describe('TerminalService and the CLI logs', () => {
  function rig(reader: CliLogReader, store: Partial<CliConversationStore> = {}) {
    const fake = fakePtyHost()
    const recorded: Record<string, CliConversationRecord> = {}
    const titles: Array<[string, string]> = []
    let n = 0
    const service = new TerminalService({
      host: () => fake.host(),
      createRequestId: () => `r-${++n}`,
      sessionCwd: () => 'D:\\work\\api',
      coalesceWindowMs: 1,
      cliTitleSettleMs: 5,
      cliLogs: reader,
      cliLogRetryMs: [60_000],
      probeClis: async () => ['codex'],
      cliConversations: {
        read: async sessionId => recorded[sessionId],
        record: async (sessionId, record) => {
          recorded[sessionId] = record
        },
        retitle: async (sessionId, title) => {
          titles.push([sessionId, title])
        },
        ...store,
      },
    })
    return { ...fake, service, recorded, titles }
  }

  it('a Codex start that exits records the conversation its log names; the restart resumes it', async () => {
    const reader: CliLogReader = {
      findConversations: async () => [{ id: ID_A, log: '/l/a.jsonl', at: Date.now(), prompt: null }],
      title: async () => 'Fix the login bug',
    }
    const r = rig(reader)
    r.service.refreshHost()
    await settle()
    const id = await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await settle()
    expect(r.recorded.c1).toEqual({ cli: 'codex', id: null })
    r.exit(r.spawned[0]!, 0)
    await settle(20)
    expect(r.recorded.c1).toEqual({ cli: 'codex', id: ID_A })
    expect(r.titles).toEqual([['c1', 'Fix the login bug']])
    await r.service.restart(id)
    await settle()
    const spawns = r.shellRequests('spawn')
    expect((spawns[1]!.payload as { args: string[] }).args).toEqual(['resume', ID_A])
    r.service.dispose()
  })

  it('a restart after an exit that came before the log was found looks once more and resumes', async () => {
    let written = false
    const r = rig({
      findConversations: async () => (written ? [{ id: ID_A, log: '/l/a.jsonl', at: Date.now(), prompt: null }] : []),
      title: async () => null,
    })
    r.service.refreshHost()
    await settle()
    const id = await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await settle()
    r.exit(r.spawned[0]!, 0)
    await settle(20)
    expect(r.recorded.c1).toEqual({ cli: 'codex', id: null })
    written = true
    await r.service.restart(id)
    await settle()
    expect(r.recorded.c1).toEqual({ cli: 'codex', id: ID_A })
    expect((r.shellRequests('spawn')[1]!.payload as { args: string[] }).args).toEqual(['resume', ID_A])
    r.service.dispose()
  })

  it('New after a run that followed its terminal title lets the new conversation take its log title', async () => {
    const logs: FoundConversation[] = [
      { id: ID_A, log: '/l/a', at: Date.now(), prompt: null },
      { id: ID_B, log: '/l/b', at: Date.now(), prompt: null },
    ]
    const r = rig({
      findConversations: async (_cli, where) => logs.filter(l => !where.taken.has(l.id)),
      title: async (_cli, where) => (where.id === ID_B ? 'Second task' : 'First task'),
    })
    r.service.refreshHost()
    await settle()
    const first = await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await settle()
    r.output(r.spawned[0]!, '\u001b]2;Refactor auth\u0007')
    await settle(20)
    r.exit(r.spawned[0]!, 0)
    await settle(20)
    expect(r.recorded.c1).toEqual({ cli: 'codex', id: ID_A })
    r.service.close(first)
    await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await settle()
    r.exit(r.spawned[1]!, 0)
    await settle(20)
    expect(r.recorded.c1).toEqual({ cli: 'codex', id: ID_B })
    expect(r.titles).toEqual([
      ['c1', 'Refactor auth'],
      ['c1', 'Second task'],
    ])
    r.service.dispose()
  })

  it('a log whose conversation another session recorded is never found for this one', async () => {
    const r = rig(
      {
        findConversations: async (_cli, where) =>
          [ID_A, ID_B]
            .filter(id => !where.taken.has(id))
            .map(id => ({ id, log: `/l/${id}`, at: Date.now(), prompt: null })),
        title: async () => null,
      },
      { recordedIds: async () => [ID_A] },
    )
    r.service.refreshHost()
    await settle()
    await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await settle()
    r.exit(r.spawned[0]!, 0)
    await settle(20)
    expect(r.recorded.c1).toEqual({ cli: 'codex', id: ID_B })
    r.service.dispose()
  })

  it('a CLI that sets its own terminal title keeps it; the log title is not used', async () => {
    const title = vi.fn(async () => 'From the log')
    const r = rig({ findConversations: async () => [{ id: ID_A, log: '/l/a', at: Date.now(), prompt: null }], title })
    r.service.refreshHost()
    await settle()
    await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await settle()
    r.output(r.spawned[0]!, '\u001b]2;Refactor auth\u0007')
    await settle(20)
    r.exit(r.spawned[0]!, 0)
    await settle(20)
    expect(r.titles).toEqual([['c1', 'Refactor auth']])
    expect(title).not.toHaveBeenCalled()
    r.service.dispose()
  })

  it('keystrokes sent to two Codex sessions in one folder tell their logs apart', async () => {
    const logs: FoundConversation[] = []
    const r = rig({ findConversations: async () => logs.slice(), title: async () => null })
    r.service.refreshHost()
    await settle()
    await r.service.create({ sessionId: 'c1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    const second = await r.service.create({ sessionId: 'c2', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    await settle()
    await r.service.write(second, 'Fix the flaky test\r')
    logs.push({ id: ID_B, log: '/l/b', at: Date.now() + 100, prompt: 'Fix the flaky test' })
    r.exit(r.spawned[0]!, 0)
    await settle(20)
    expect(r.recorded.c1).toEqual({ cli: 'codex', id: null })
    r.exit(r.spawned[1]!, 0)
    await settle(20)
    expect(r.recorded.c2).toEqual({ cli: 'codex', id: ID_B, confirmed: true })
    r.service.dispose()
  })
})
