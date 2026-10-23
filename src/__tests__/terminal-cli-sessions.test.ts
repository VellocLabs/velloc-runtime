/**
 * CLI sessions in the terminal service (F-34): which CLIs the host has, found
 * by file lookups only; how a CLI terminal starts, continues and restarts its
 * conversation; and the argv and metadata shapes the start depends on.
 */
import { describe, expect, it } from 'vitest'
import {
  cliAgentArgv,
  cliAgentsFound,
  cliCandidatePaths,
  isConversationId,
  parseCliConversation,
  probeCliAgents,
  type CliAgentId,
} from '../terminal/cliAgents'
import {
  TerminalService,
  type CliConversationRecord,
  type TerminalHost,
} from '../terminal/TerminalService'
import { parseLauncherCatalog } from '../prompting/templateParsing'
import { fail, fakePtyHost, ok, PTY_MANIFEST, routeOf, settle, type FakePtyHostOptions } from './_helpers/fakePtyHost'

const CONVERSATION = '0b7f3c2e-9a41-4d6b-8f0e-5c2d1a3b4e6f'
const codeOf = (error: unknown) => (error as { code?: string }).code

function rig(options: FakePtyHostOptions & { clis?: CliAgentId[]; recorded?: Record<string, CliConversationRecord> } = {}) {
  const fake = fakePtyHost(options)
  const recorded: Record<string, CliConversationRecord> = { ...options.recorded }
  const writes: Array<[string, CliConversationRecord]> = []
  let probes = 0
  let n = 0
  let ids = 0
  const service = new TerminalService({
    host: () => fake.host(),
    createRequestId: () => `r-${++n}`,
    sessionCwd: id => ({ s1: '/proj/s1' })[id],
    coalesceWindowMs: 1,
    newId: () => `${++ids}`,
    probeClis: async () => {
      probes += 1
      return options.clis ?? ['claude', 'codex']
    },
    cliConversations: {
      read: async sessionId => recorded[sessionId],
      record: async (sessionId, record) => {
        writes.push([sessionId, record])
        recorded[sessionId] = record
      },
    },
  })
  return { ...fake, service, recorded, writes, probes: () => probes }
}

async function ready(options: Parameters<typeof rig>[0] = {}) {
  const r = rig(options)
  r.service.refreshHost()
  await settle()
  return r
}

describe('CLI argv', () => {
  it('claude starts a named conversation or resumes it; codex starts bare or resumes', () => {
    expect(cliAgentArgv('claude', { id: CONVERSATION, resume: false })).toEqual({
      file: 'claude',
      args: ['--session-id', CONVERSATION],
    })
    expect(cliAgentArgv('claude', { id: CONVERSATION, resume: true })).toEqual({
      file: 'claude',
      args: ['--resume', CONVERSATION],
    })
    expect(cliAgentArgv('codex', null)).toEqual({ file: 'codex', args: [] })
    expect(cliAgentArgv('codex', { id: CONVERSATION, resume: true })).toEqual({
      file: 'codex',
      args: ['resume', CONVERSATION],
    })
  })

  it('refuses anything but a UUID as the conversation id', () => {
    for (const id of ['--dangerously-skip', 'x; rm -rf /', '', `${CONVERSATION} --flag`]) {
      expect(() => cliAgentArgv('claude', { id, resume: true })).toThrow()
    }
  })

  it('a conversation id is five hex groups of 8-4-4-4-12, either case', () => {
    expect(isConversationId(CONVERSATION)).toBe(true)
    expect(isConversationId(CONVERSATION.toUpperCase())).toBe(true)
    expect(isConversationId(globalThis.crypto.randomUUID())).toBe(true)
    for (const id of [
      '0b7f3c2e9a414d6b8f0e5c2d1a3b4e6f',
      '0b7f3c2e-9a41-4d6b-8f0e-5c2d1a3b4e6',
      '0b7f3c2e-9a41-4d6b-8f0e-5c2d1a3b4e6f0',
      '0b7f3c2e-9a41-4d6b-8f0e-5c2d1a3b-4e6f',
      '0b7f3c2g-9a41-4d6b-8f0e-5c2d1a3b4e6f',
      '0b7f3c2e-9a41-4d6b-8f0e--c2d1a3b4e6f',
      42,
      null,
    ]) {
      expect(isConversationId(id)).toBe(false)
    }
  })
})

describe('CLI detection', () => {
  it('looks in every PATH dir, then ~/.local/bin and npm\u2019s global dir, for .exe and .cmd on Windows', () => {
    const paths = cliCandidatePaths('codex', {
      platform: 'win32',
      path: 'C:\\Tools;"C:\\Quoted Dir\\";;',
      home: 'C:\\Users\\me',
      appData: 'C:\\Users\\me\\AppData\\Roaming',
    })
    expect(paths).toEqual([
      'C:\\Tools\\codex.exe',
      'C:\\Tools\\codex.cmd',
      'C:\\Quoted Dir\\codex.exe',
      'C:\\Quoted Dir\\codex.cmd',
      'C:\\Users\\me\\.local\\bin\\codex.exe',
      'C:\\Users\\me\\.local\\bin\\codex.cmd',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.exe',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
    ])
  })

  it('on POSIX takes the bare name and no npm dir', () => {
    expect(cliCandidatePaths('codex', { platform: 'linux', path: '/usr/bin:/opt/x/', home: '/home/me', appData: null })).toEqual([
      '/usr/bin/codex',
      '/opt/x/codex',
      '/home/me/.local/bin/codex',
    ])
  })

  it('reports a CLI when any candidate is a file, in table order', () => {
    const env = { platform: 'win32', path: 'C:\\a', home: 'C:\\h', appData: 'C:\\d' }
    expect(cliAgentsFound(env, path => path === 'C:\\d\\npm\\codex.cmd')).toEqual(['codex'])
    expect(cliAgentsFound(env, path => path.endsWith('.exe'))).toEqual(['claude', 'codex'])
    expect(cliAgentsFound(env, () => false)).toEqual([])
  })

  it('probes with one env read and one stat batch, never a spawn', async () => {
    const fake = fakePtyHost({
      answer: request => {
        if (routeOf(request) === 'shell.env') {
          return ok({ values: { PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\me', HOME: null, APPDATA: 'C:\\R' } })
        }
        if (routeOf(request) === 'fs.statBatch') {
          const { paths } = request.payload as { paths: string[] }
          return ok(paths.map(path => ({ path, stat: path === 'C:\\Users\\me\\.local\\bin\\codex.exe' ? { isFile: true } : null })))
        }
        return undefined
      },
    })
    const manifest = { ...PTY_MANIFEST!, primitives: [...PTY_MANIFEST!.primitives!, 'shell.env'] }
    let n = 0
    const found = await probeCliAgents(fake.host(manifest), () => `r-${++n}`)
    expect(found).toEqual(['codex'])
    const routes = fake.requests.map(routeOf)
    expect(routes.filter(route => route === 'fs.statBatch')).toHaveLength(1)
    expect(routes.filter(route => route === 'shell.env')).toHaveLength(1)
    expect(routes.some(route => route.startsWith('shell.spawn'))).toBe(false)
  })

  it('a host without shell.env reports none and asks nothing', async () => {
    const fake = fakePtyHost()
    expect(await probeCliAgents(fake.host(), () => 'r')).toEqual([])
    expect(fake.requests).toHaveLength(0)
  })
})

describe('TerminalService CLI list', () => {
  it('publishes the CLIs the probe found beside the shells', async () => {
    const r = await ready({ clis: ['codex'] })
    expect(r.service.list().clis).toEqual(['codex'])
  })

  it('a rescan while one runs shares it', async () => {
    const r = await ready()
    const before = r.probes()
    await Promise.all([r.service.rescanClis(), r.service.rescanClis()])
    expect(r.probes()).toBe(before + 1)
  })
})

describe('TerminalService CLI terminals', () => {
  it('a new claude conversation gets a runtime-minted id, recorded before the start, in the session folder', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cli: { id: 'claude', start: 'new' }, cols: 100, rows: 30 })
    expect(r.writes).toHaveLength(1)
    const [sessionId, record] = r.writes[0]!
    expect(sessionId).toBe('s1')
    expect(record.cli).toBe('claude')
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.shellRequests('spawn')[0]!.payload).toEqual({
      file: 'claude',
      args: ['--session-id', record.id],
      cwd: '/proj/s1',
      pty: { cols: 100, rows: 30 },
    })
    expect(r.service.list().terminals).toEqual([
      { id, sessionId: 's1', shell: 'claude', cli: 'claude', title: 'claude', state: { kind: 'running' } },
    ])
  })

  it('a new codex conversation starts bare and records that its id is not known yet', async () => {
    const r = await ready()
    await r.service.create({ sessionId: 's1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 })
    expect(r.writes).toEqual([['s1', { cli: 'codex', id: null }]])
    expect(r.shellRequests('spawn')[0]!.payload).toMatchObject({ file: 'codex', args: [] })
  })

  it('continue resumes the recorded conversation and writes nothing', async () => {
    const r = await ready({ recorded: { s1: { cli: 'claude', id: CONVERSATION } } })
    await r.service.create({ sessionId: 's1', cli: { id: 'claude', start: 'continue' }, cols: 80, rows: 24 })
    expect(r.writes).toEqual([])
    expect(r.shellRequests('spawn')[0]!.payload).toMatchObject({ file: 'claude', args: ['--resume', CONVERSATION] })
  })

  it('continue with nothing recorded, another CLI\u2019s record, or an unknown id is refused before any start', async () => {
    const cases: Array<Record<string, CliConversationRecord>> = [
      {},
      { s1: { cli: 'codex', id: CONVERSATION } },
      { s1: { cli: 'claude', id: null } },
    ]
    for (const recorded of cases) {
      const r = await ready({ recorded })
      await expect(
        r.service.create({ sessionId: 's1', cli: { id: 'claude', start: 'continue' }, cols: 80, rows: 24 }),
      ).rejects.toSatisfy(e => codeOf(e) === 'bad_payload')
      expect(r.shellRequests('spawn')).toHaveLength(0)
    }
  })

  it('a CLI the probe did not find still starts: the conversation is recorded first and the host decides', async () => {
    // The session is kept when its CLI is gone (F-34), so the record comes
    // before the host's refusal; the terminal then shows the failure.
    const r = await ready({
      clis: [],
      answer: request => (routeOf(request) === 'shell.spawn' ? fail('BINARY_NOT_FOUND') : undefined),
    })
    const id = await r.service.create({ sessionId: 's1', cli: { id: 'claude', start: 'new' }, cols: 80, rows: 24 })
    expect(r.writes.map(([sessionId, record]) => [sessionId, record.cli])).toEqual([['s1', 'claude']])
    expect(r.shellRequests('spawn')).toHaveLength(1)
    expect(r.service.list().terminals.find(row => row.id === id)?.state).toMatchObject({ kind: 'failed' })
  })

  it('refuses an unknown CLI, a shell together with a CLI, and a runtime with no conversation store', async () => {
    const r = await ready()
    await expect(
      r.service.create({ sessionId: 's1', cli: { id: 'vim', start: 'new' }, cols: 80, rows: 24 }),
    ).rejects.toSatisfy(e => codeOf(e) === 'bad_payload')
    await expect(
      r.service.create({ sessionId: 's1', shell: 'pwsh', cli: { id: 'claude', start: 'new' }, cols: 80, rows: 24 }),
    ).rejects.toSatisfy(e => codeOf(e) === 'bad_payload')
    const bare = new TerminalService({
      host: (): TerminalHost => r.host(),
      createRequestId: () => 'r',
      sessionCwd: () => '/proj/s1',
    })
    await expect(
      bare.create({ sessionId: 's1', cli: { id: 'claude', start: 'new' }, cols: 80, rows: 24 }),
    ).rejects.toSatisfy(e => codeOf(e) === 'host_unavailable')
    expect(r.shellRequests('spawn')).toHaveLength(0)
  })

  it('a restart after the CLI exits continues the conversation it started', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cli: { id: 'claude', start: 'new' }, cols: 80, rows: 24 })
    const minted = r.writes[0]![1].id!
    r.exit(r.spawned[0]!, 0)
    await settle()
    await r.service.restart(id)
    expect(r.shellRequests('spawn')[1]!.payload).toMatchObject({ file: 'claude', args: ['--resume', minted] })
  })
})

describe('stored CLI conversation', () => {
  it('accepts a known CLI with a UUID or a null id, and nothing else', () => {
    expect(parseCliConversation({ cli: 'claude', id: CONVERSATION })).toEqual({ cli: 'claude', id: CONVERSATION })
    expect(parseCliConversation({ cli: 'codex', id: null })).toEqual({ cli: 'codex', id: null })
    for (const value of [undefined, null, 'claude', { cli: 'vim', id: null }, { cli: 'claude', id: '--x' }, { cli: 'claude' }]) {
      expect(parseCliConversation(value)).toBeUndefined()
    }
  })
})

describe('launcher catalog kind', () => {
  it('reads kind: terminal with its cli, and ignores a cli on an agent type', () => {
    const catalog = parseLauncherCatalog(
      '---\ntypes:\n  - type: cli-x\n    kind: terminal\n    cli: codex\n  - type: y\n    cli: codex\n  - type: z\n    kind: other\n---\n',
    )
    expect(catalog).toEqual([
      expect.objectContaining({ type: 'cli-x', kind: 'terminal', cli: 'codex' }),
      expect.not.objectContaining({ cli: expect.anything() }),
      expect.not.objectContaining({ kind: expect.anything() }),
    ])
  })
})
