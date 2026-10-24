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
  CliLogFollower,
  cliLogDayFolders,
  cliLogSource,
  comparablePath,
  createBridgeCliLogReader,
  pickStartedConversation,
  type CliLogReader,
} from '../terminal/cliLogs'
import { TerminalService, type CliConversationRecord } from '../terminal/TerminalService'
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

  it('takes the earliest log of that folder created since the start, skipping taken ones', () => {
    const rows = [
      row(ID_A, 'D:\\work\\api', '2026-10-23T09:00:00Z'),
      row(ID_B, 'D:\\work\\other', '2026-10-23T10:00:05Z'),
      row(ID_C, 'd:/work/api/', '2026-10-23T10:00:09Z'),
      row(ID_B.replace('5c', '5e'), 'D:\\work\\api', '2026-10-23T10:00:20Z'),
    ]
    const where = { cwd: 'D:\\work\\api', startedAt: START, taken: new Set<string>() }
    expect(pickStartedConversation(rows, where)?.id).toBe(ID_C)
    expect(pickStartedConversation(rows, { ...where, taken: new Set([ID_C]) })?.id).toBe(
      ID_B.replace('5c', '5e'),
    )
    expect(pickStartedConversation([row(ID_A, null, '2026-10-23T10:00:01Z')], where)).toBeNull()
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
          const data = new TextEncoder().encode(file.text).slice(0, payload.length)
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
    const found = await reader.findConversation('codex', {
      cwd: 'D:\\work\\api',
      startedAt: START,
      taken: new Set(),
    })
    expect(found?.id).toBe(ID_A)
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
    expect(await reader.findConversation(OTHER_CLI, { cwd: 'D:\\work\\api', startedAt: START, taken: new Set() })).toBeNull()
  })

  it('reads nothing on a host without shell.env', async () => {
    const fake = fakePtyHost()
    const reader = createBridgeCliLogReader(() => fake.host(), () => 'r')
    expect(await reader.findConversation('codex', { cwd: 'D:\\x', startedAt: START, taken: new Set() })).toBeNull()
    expect(fake.requests.some(r => routeOf(r).startsWith('fs.read'))).toBe(false)
  })
})

describe('CliLogFollower', () => {
  function fakeReader(found: Array<{ id: string; log: string } | null>, title: string | null = 'From the log') {
    return {
      findConversation: vi.fn<CliLogReader['findConversation']>(async () => found.shift() ?? null),
      title: vi.fn<CliLogReader['title']>(async () => title),
    }
  }

  it('looks on a schedule until the conversation is found, then records it and titles it once', async () => {
    vi.useFakeTimers()
    const reader = fakeReader([null, { id: ID_A, log: '/l/a.jsonl' }])
    const found = vi.fn(async () => {})
    const retitle = vi.fn(async () => {})
    const follower = new CliLogFollower({ reader, found, retitle, hasTerminalTitle: () => false, retryMs: [10, 20, 40] })
    follower.start('s1', { cli: 'codex', cwd: '/w', startedAt: START, id: null, fresh: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(found).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20)
    expect(found).toHaveBeenCalledWith('s1', ID_A)
    expect(reader.title).toHaveBeenCalledWith('codex', { cwd: '/w', id: ID_A, log: '/l/a.jsonl' })
    expect(retitle).toHaveBeenCalledWith('s1', 'From the log')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reader.findConversation).toHaveBeenCalledTimes(2)
  })

  it('a poke looks at once; a followed terminal title means no log title', async () => {
    const reader = fakeReader([{ id: ID_A, log: '/l/a.jsonl' }])
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
    expect(reader.findConversation).toHaveBeenCalledTimes(1)
    expect(reader.title).not.toHaveBeenCalled()
    expect(retitle).not.toHaveBeenCalled()
    follower.dispose()
  })

  it('a continued conversation with a known id needs nothing; a found id is never handed to a second session', async () => {
    const reader = fakeReader([{ id: ID_A, log: '/l/a' }, { id: ID_A, log: '/l/a' }])
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
    expect(found.mock.calls).toEqual([['s1', ID_A]])
    expect(reader.findConversation.mock.calls[1]![1].taken.has(ID_A)).toBe(true)
    follower.dispose()
  })
})

describe('TerminalService and the CLI logs', () => {
  function rig(reader: CliLogReader) {
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
      },
    })
    return { ...fake, service, recorded, titles }
  }

  it('a Codex start that exits records the conversation its log names; the restart resumes it', async () => {
    const reader: CliLogReader = {
      findConversation: async () => ({ id: ID_A, log: '/l/a.jsonl' }),
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

  it('a CLI that sets its own terminal title keeps it; the log title is not used', async () => {
    const title = vi.fn(async () => 'From the log')
    const r = rig({ findConversation: async () => ({ id: ID_A, log: '/l/a' }), title })
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
})
