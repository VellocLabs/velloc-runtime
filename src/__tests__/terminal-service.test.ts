/**
 * TerminalService over a fake host port (F-31): a terminal's life from create
 * to close, the decoded and coalesced output, the capped scrollback, the title
 * sequences, the exit and restart transitions, and the per-session close.
 */
import { describe, expect, it } from 'vitest'
import type { BrowserBridgeRequest } from '../browser/bridge/browserBridgeProtocol'
import { TitleSequenceScanner } from '../terminal/titleScanner'
import { TerminalService, type TerminalHost, type TerminalServiceEvent } from '../terminal/TerminalService'
import { renderSnapshot } from './_helpers/renderTerminalSnapshot'
import { fail, fakePtyHost, ok, routeOf, settle, type FakePtyHostOptions } from './_helpers/fakePtyHost'

type RigOptions = FakePtyHostOptions & {
  manifest?: TerminalHost['manifest']
  sessions?: Record<string, string>
  historyLines?: number
  coalesceWindowMs?: number
}

function rig(options: RigOptions = {}) {
  const fake = fakePtyHost(options)
  let current: TerminalHost = fake.host(options.manifest === undefined ? undefined : options.manifest)
  const sessions = options.sessions ?? { s1: '/proj/s1', s2: '/proj/s2' }
  let n = 0
  let ids = 0
  const events: TerminalServiceEvent[] = []
  const service = new TerminalService({
    host: () => current,
    createRequestId: () => `r-${++n}`,
    sessionCwd: id => sessions[id],
    coalesceWindowMs: options.coalesceWindowMs ?? 1,
    historyLines: options.historyLines,
    newId: () => `${++ids}`,
  })
  service.subscribe(event => events.push(event))
  const setHost = (host: TerminalHost) => {
    current = host
  }
  const outputs = (id: string) => events.filter(e => e.kind === 'output' && e.id === id).map(e => (e as { data: string }).data)
  const states = (id: string) => events.filter(e => e.kind === 'state' && e.id === id).map(e => (e as { state: unknown }).state)
  const titles = (id: string) => events.filter(e => e.kind === 'title' && e.id === id).map(e => (e as { title: string }).title)
  return { ...fake, service, events, setHost, outputs, states, titles }
}

/** A service whose host has been read: shells known. */
async function ready(options: RigOptions = {}) {
  const r = rig(options)
  r.service.refreshHost()
  await settle()
  return r
}

const codeOf = (error: unknown) => (error as { code?: string }).code

describe('TerminalService availability', () => {
  it('is unavailable without a host, or without shell.spawn.pty, and reads the shells once a host is there', async () => {
    const r = rig({ manifest: null })
    expect(r.service.available).toBe(false)
    expect(r.service.list()).toEqual({ available: false, shells: [], terminals: [] })
    await expect(r.service.create({ sessionId: 's1', cols: 80, rows: 24 })).rejects.toSatisfy(
      e => codeOf(e) === 'host_unavailable',
    )

    r.setHost(r.host({ capabilities: ['fs', 'shell'], primitives: ['shell.spawn.argv'] }))
    r.service.refreshHost()
    await settle()
    expect(r.service.available).toBe(false)

    r.setHost(r.host())
    r.service.refreshHost()
    await settle()
    expect(r.service.available).toBe(true)
    expect(r.service.list().shells.map(s => s.id)).toEqual(['pwsh', 'powershell', 'cmd', 'bash'])
    expect(r.events.filter(e => e.kind === 'list').length).toBeGreaterThanOrEqual(2)
    expect(r.requests.map(routeOf)).toEqual(['exec.listShells', 'fs.systemInfo'])
  })

  it('a host without PowerShell or bash on another platform offers what it has', async () => {
    const r = await ready({ shells: { bash: true, powershell: false }, platform: 'linux' })
    expect(r.service.list().shells.map(s => s.id)).toEqual(['bash'])
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    expect(r.service.list().terminals[0]).toMatchObject({ id, shell: 'bash' })
    expect(r.shellRequests('spawn')[0]!.payload).toMatchObject({ file: 'bash', args: ['--login', '-i'] })
  })
})

describe('TerminalService create', () => {
  it('spawns the default shell under a pseudoconsole in the session folder and reports running', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cols: 120, rows: 40 })
    expect(id).toBe('term_1')
    expect(r.shellRequests('spawn')[0]!.payload).toEqual({
      file: 'pwsh',
      args: ['-NoLogo'],
      cwd: '/proj/s1',
      pty: { cols: 120, rows: 40 },
    })
    expect(r.service.list().terminals).toEqual([
      { id, sessionId: 's1', shell: 'pwsh', title: 'pwsh', state: { kind: 'running' } },
    ])
    expect(r.states(id)).toEqual([{ kind: 'running' }])
    expect(await r.service.snapshot(id)).toEqual({ cols: 120, rows: 40, title: 'pwsh', state: { kind: 'running' }, scrollback: '' })
  })

  it('refuses an unknown session, an unknown shell and a size outside the bounds', async () => {
    const r = await ready()
    await expect(r.service.create({ sessionId: 'nope', cols: 80, rows: 24 })).rejects.toSatisfy(e => codeOf(e) === 'not_found')
    await expect(r.service.create({ sessionId: 's1', shell: 'fish', cols: 80, rows: 24 })).rejects.toSatisfy(
      e => codeOf(e) === 'bad_payload',
    )
    await expect(r.service.create({ sessionId: 's1', cols: 0, rows: 24 })).rejects.toSatisfy(e => codeOf(e) === 'bad_payload')
    await expect(r.service.create({ sessionId: 's1', cols: 80, rows: 1001 })).rejects.toSatisfy(e => codeOf(e) === 'bad_payload')
    expect(r.shellRequests('spawn')).toHaveLength(0)
    expect(r.service.list().terminals).toEqual([])
  })

  it('a spawn the host refuses leaves a failed terminal that can be restarted', async () => {
    let refuse = true
    const r = await ready({
      answer: request => (refuse && routeOf(request) === 'shell.spawn' ? fail('SPAWN_FAILED', 'no console') : undefined),
    })
    const id = await r.service.create({ sessionId: 's1', shell: 'cmd', cols: 80, rows: 24 })
    expect(r.service.list().terminals[0]!.state).toEqual({ kind: 'failed', message: expect.stringContaining('no console') })
    refuse = false
    await r.service.restart(id)
    expect(r.service.list().terminals[0]!.state).toEqual({ kind: 'running' })
  })

  it('restart after an exit starts from an empty scrollback', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', shell: 'cmd', cols: 80, rows: 24 })
    r.output(r.spawned[0]!, 'old output')
    r.exit(r.spawned[0]!, 0)
    expect(await renderSnapshot(await r.service.snapshot(id))).toEqual(['old output'])
    await r.service.restart(id)
    expect(r.service.list().terminals[0]!.state).toEqual({ kind: 'running' })
    expect(await renderSnapshot(await r.service.snapshot(id))).toEqual([])
    r.output(r.spawned[1]!, 'new')
    r.exit(r.spawned[1]!, 0)
    expect(await renderSnapshot(await r.service.snapshot(id))).toEqual(['new'])
  })

  it('pwsh the host cannot resolve falls back to Windows PowerShell', async () => {
    const r = await ready({
      answer: request =>
        routeOf(request) === 'shell.spawn' && (request.payload as { file: string }).file === 'pwsh'
          ? fail('BINARY_NOT_FOUND', 'pwsh')
          : undefined,
    })
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    expect(r.shellRequests('spawn').map(req => (req.payload as { file: string }).file)).toEqual(['pwsh', 'powershell'])
    expect(r.service.list().terminals[0]).toMatchObject({ id, shell: 'powershell', title: 'powershell', state: { kind: 'running' } })
  })

  it('closed while the host was still starting it: the child is killed as soon as it exists', async () => {
    let release!: () => void
    const r = await ready({
      answer: request =>
        routeOf(request) === 'shell.spawn'
          ? new Promise(resolve => {
              release = () => resolve(ok({ streamId: 'late' }))
            })
          : undefined,
    })
    const creating = r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    await settle(0)
    expect(r.service.list().terminals[0]!.state).toEqual({ kind: 'starting' })
    r.service.close('term_1')
    expect(r.service.has('term_1')).toBe(false)
    release()
    await creating
    await settle(0)
    expect(r.shellRequests('streamKill').map(req => (req.payload as { streamId: string }).streamId)).toEqual(['late'])
    expect(r.service.list().terminals).toEqual([])
  })
})

describe('TerminalService output', () => {
  it('decodes UTF-8 split across host chunks and coalesces chunks into one delivery', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    const [stream] = r.spawned
    r.output(stream!, new Uint8Array([0x41, 0xe2, 0x82]))
    r.output(stream!, new Uint8Array([0xac, 0x42]))
    expect(r.outputs(id)).toEqual([])
    await settle()
    expect(r.outputs(id)).toEqual(['A€B'])
    expect(await renderSnapshot(await r.service.snapshot(id))).toEqual(['A€B'])
  })

  it('a snapshot taken as output is delivered holds that output and none delivered after it', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    const taken: ReturnType<TerminalService['snapshot']>[] = []
    r.service.subscribe(event => {
      if (event.kind === 'output') taken.push(r.service.snapshot(id))
    })
    r.output(r.spawned[0]!, 'one ')
    await settle()
    r.output(r.spawned[0]!, 'two')
    await settle()
    expect(r.outputs(id)).toEqual(['one ', 'two'])
    const seen = await Promise.all(taken.map(async snapshot => renderSnapshot(await snapshot)))
    expect(seen).toEqual([['one '], ['one two']])
  })

  it('keeps at most historyLines lines above the screen, dropping the oldest first', async () => {
    const r = await ready({ historyLines: 2 })
    const id = await r.service.create({ sessionId: 's1', cols: 20, rows: 3 })
    r.output(r.spawned[0]!, Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\r\n'))
    await settle()
    expect(await renderSnapshot(await r.service.snapshot(id))).toEqual(['line 4', 'line 5', 'line 6', 'line 7', 'line 8'])
  })

  it('a line drawn once and never redrawn survives any amount of redrawing around it', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cols: 40, rows: 6 })
    const [stream] = r.spawned
    r.output(stream!, 'history 1\r\nhistory 2\r\n\x1b[6;1Hfooter')
    await settle()
    // Each frame rewrites row 3 only, as a console that sends changed cells does.
    const frame = (n: number) => `\x1b[3;1H\x1b[2Kframe ${n} ${'x'.repeat(28)}\x1b[6;7H`
    for (let chunk = 0; chunk < 40; chunk++) {
      r.output(stream!, Array.from({ length: 500 }, (_, i) => frame(chunk * 500 + i)).join(''))
      await settle()
    }
    const lines = await renderSnapshot(await r.service.snapshot(id))
    expect(lines[0]).toBe('history 1')
    expect(lines[1]).toBe('history 2')
    expect(lines[2]).toMatch(/^frame 19999 x+$/)
    expect(lines[5]).toBe('footer')
  })

  it('takes the title from OSC 0 / OSC 2, even split across chunks, else the shell id', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    const [stream] = r.spawned
    r.output(stream!, '\x1b]2;My ')
    r.output(stream!, 'Title\x07prompt> ')
    await settle()
    expect(r.titles(id)).toEqual(['My Title'])
    expect(r.service.list().terminals[0]!.title).toBe('My Title')
    r.output(stream!, '\x1b]0;Other\x1b\\')
    await settle()
    expect((await r.service.snapshot(id))!.title).toBe('Other')
  })

  it('writes keystrokes as UTF-8 to the child and nothing once it has exited', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    await r.service.write(id, 'é\r')
    const [write] = r.shellRequests('writeStdin')
    expect(write!.payload).toMatchObject({ streamId: r.spawned[0] })
    expect(Array.from((write!.payload as { data: Uint8Array }).data)).toEqual([0xc3, 0xa9, 0x0d])
    r.exit(r.spawned[0]!, 0)
    await r.service.write(id, 'x')
    expect(r.shellRequests('writeStdin')).toHaveLength(1)
    await expect(r.service.write('term_9', 'x')).rejects.toSatisfy(e => codeOf(e) === 'not_found')
  })

  it('a write the host fails is host_unavailable', async () => {
    const r = await ready({ answer: request => (routeOf(request) === 'shell.writeStdin' ? fail('PORT_GONE') : undefined) })
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    await expect(r.service.write(id, 'x')).rejects.toSatisfy(e => codeOf(e) === 'host_unavailable')
  })
})

describe('TerminalService size, exit and restart', () => {
  it('resize records the size, tells listeners and resizes the console', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    await r.service.resize(id, 100, 30)
    expect(r.shellRequests('resize')[0]!.payload).toEqual({ streamId: r.spawned[0], cols: 100, rows: 30 })
    expect(r.events).toContainEqual({ kind: 'resize', id, cols: 100, rows: 30 })
    expect(await r.service.snapshot(id)).toMatchObject({ cols: 100, rows: 30 })
    await expect(r.service.resize(id, 0, 30)).rejects.toSatisfy(e => codeOf(e) === 'bad_payload')
  })

  it('exit flushes pending output first, then reports exited with the code (none for -1)', async () => {
    const r = await ready({ coalesceWindowMs: 10_000 })
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    r.output(r.spawned[0]!, 'bye')
    r.exit(r.spawned[0]!, 3)
    expect(r.outputs(id)).toEqual(['bye'])
    expect(r.events.findIndex(e => e.kind === 'output')).toBeLessThan(
      r.events.findIndex(e => e.kind === 'state' && (e as { state: { kind: string } }).state.kind === 'exited'),
    )
    expect(r.service.list().terminals[0]!.state).toEqual({ kind: 'exited', exitCode: 3 })

    const other = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    r.exit(r.spawned[1]!, -1)
    expect((await r.service.snapshot(other))!.state).toEqual({ kind: 'exited', exitCode: null })
  })

  it('restart runs the same shell again under the same id with a fresh title; a running one is a conflict', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', shell: 'cmd', cols: 80, rows: 24 })
    await expect(r.service.restart(id)).rejects.toSatisfy(e => codeOf(e) === 'conflict')
    r.output(r.spawned[0]!, '\x1b]2;old\x07')
    await settle()
    r.exit(r.spawned[0]!, 1)
    await r.service.restart(id)
    expect(r.shellRequests('spawn')).toHaveLength(2)
    expect(r.shellRequests('spawn')[1]!.payload).toMatchObject({ file: 'cmd', cwd: '/proj/s1' })
    expect(r.service.list().terminals).toEqual([
      { id, sessionId: 's1', shell: 'cmd', title: 'cmd', state: { kind: 'running' } },
    ])
    expect(r.states(id)).toEqual([{ kind: 'running' }, { kind: 'exited', exitCode: 1 }, { kind: 'starting' }, { kind: 'running' }])
    // Output of the second child lands; the first child's stream is no longer heard.
    r.output(r.spawned[1]!, 'new')
    r.output(r.spawned[0]!, 'stale')
    await settle()
    expect(r.outputs(id)).toEqual(['\x1b]2;old\x07', 'new'])
    await expect(r.service.restart('term_9')).rejects.toSatisfy(e => codeOf(e) === 'not_found')
  })
})

describe('TerminalService close', () => {
  it('close kills the child and forgets the terminal', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    r.service.close(id)
    await settle(0)
    expect(r.shellRequests('streamKill')[0]!.payload).toEqual({ streamId: r.spawned[0] })
    expect(r.service.has(id)).toBe(false)
    expect(await r.service.snapshot(id)).toBeUndefined()
    expect(r.events).toContainEqual({ kind: 'closed', id })
    expect(r.service.list().terminals).toEqual([])
    expect(() => r.service.close(id)).toThrow()
  })

  it('closeForSession ends exactly that session’s terminals', async () => {
    const r = await ready()
    const a = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    const b = await r.service.create({ sessionId: 's1', shell: 'cmd', cols: 80, rows: 24 })
    const c = await r.service.create({ sessionId: 's2', cols: 80, rows: 24 })
    r.service.closeForSession('s1')
    await settle(0)
    expect(r.shellRequests('streamKill').map(req => (req.payload as { streamId: string }).streamId).sort()).toEqual(
      [r.spawned[0], r.spawned[1]].sort(),
    )
    expect(r.service.list().terminals.map(t => t.id)).toEqual([c])
    expect([a, b].map(id => r.service.has(id))).toEqual([false, false])
    r.service.closeForSession('never-had-one')
    expect(r.service.list().terminals).toHaveLength(1)
  })

  it('the host port going away ends every running terminal without a code; the rows stay for a restart', async () => {
    const r = await ready()
    const id = await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    r.setHost({ transport: null, manifest: null })
    r.service.hostGone()
    expect(r.service.list()).toEqual({
      available: false,
      shells: [],
      terminals: [{ id, sessionId: 's1', shell: 'pwsh', title: 'pwsh', state: { kind: 'exited', exitCode: null } }],
    })
    // No kill is sent to a port that is gone; a later exit from it is ignored.
    expect(r.shellRequests('streamKill')).toHaveLength(0)
    r.exit(r.spawned[0]!, 0)
    expect(r.states(id).at(-1)).toEqual({ kind: 'exited', exitCode: null })
    await expect(r.service.restart(id)).rejects.toSatisfy(e => codeOf(e) === 'host_unavailable')

    r.setHost(r.host())
    r.service.refreshHost()
    await settle()
    await r.service.restart(id)
    expect((await r.service.snapshot(id))!.state).toEqual({ kind: 'running' })
  })

  it('dispose ends everything and stops listening', async () => {
    const r = await ready()
    await r.service.create({ sessionId: 's1', cols: 80, rows: 24 })
    r.service.dispose()
    await settle(0)
    expect(r.shellRequests('streamKill')).toHaveLength(1)
    expect(r.service.available).toBe(false)
    expect(r.service.list().terminals).toEqual([])
  })
})

describe('the shells probe', () => {
  it('skips exec.listShells on a host that does not serve exec', async () => {
    const r = rig({ manifest: { capabilities: ['fs', 'shell'], primitives: ['shell.spawn.pty'] } })
    r.service.refreshHost()
    await settle()
    expect(r.requests.map(routeOf)).toEqual(['fs.systemInfo'])
    expect(r.service.list().shells.map(s => s.id)).toEqual(['cmd'])
  })

  it('a probe that fails leaves no shells, and a stale probe never overwrites a newer one', async () => {
    let probes = 0
    const slowFirstProbe = (request: BrowserBridgeRequest) =>
      routeOf(request) === 'exec.listShells' && ++probes === 1
        ? new Promise<ReturnType<typeof ok>>(resolve => setTimeout(() => resolve(ok({ bash: true, powershell: false })), 20))
        : undefined
    const r = rig({ answer: slowFirstProbe })
    r.service.refreshHost() // slow probe: would say bash only
    r.service.refreshHost() // fast probe: both bits
    await settle(40)
    expect(r.service.list().shells.map(s => s.id)).toEqual(['pwsh', 'powershell', 'cmd', 'bash'])

    const failing = rig({ answer: () => fail('BOOM') })
    failing.service.refreshHost()
    await settle()
    expect(failing.service.list().shells).toEqual([])
  })
})

describe('TitleSequenceScanner', () => {
  it('finds OSC 0 and 2 with either terminator, ignores other OSCs, and carries a split sequence or a lone ESC', () => {
    const scanner = new TitleSequenceScanner()
    expect(scanner.feed('\x1b]0;first\x07 \x1b]2;second\x1b\\ \x1b]8;;http://x\x07')).toEqual(['first', 'second'])
    expect(scanner.feed('text\x1b')).toEqual([])
    expect(scanner.feed(']2;joined\x07')).toEqual(['joined'])
    expect(scanner.feed('\x1b]2;half')).toEqual([])
    expect(scanner.feed(' done\x07')).toEqual(['half done'])
    expect(scanner.feed('plain')).toEqual([])
  })
})
