/**
 * The worker's background-shell registry: every `local_bash` task is a persistent host child started with
 * `shell.spawn({persist})`, observed through `shell.persistentList` + its log file, stopped with
 * `shell.persistentKill`, and found again after a worker restart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BackgroundShellCoordinator,
  parseBackgroundShellLogPath,
  SHELL_LOG_SETTLE_MS,
  SHELL_OUTPUT_TAIL_BYTES,
  type BackgroundShellBridge,
  type BackgroundShellDeliveryResult,
  type BackgroundShellRunState,
  type PersistentShellSpawnSpec,
} from '../browser/worker/BackgroundShellCoordinator'
import {
  BackgroundShellHostBridge,
  type BackgroundShellHostBridgeHost,
} from '../browser/worker/BackgroundShellHostBridge'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { NativePrimitiveError } from '../browser/bridge/nativePrimitives'
import type { BridgeShellPersistentRecord } from '../browser/bridge/browserBridgeProtocol'
import {
  heldShellMutationProbeCount,
  holdShellMutationProbe,
  resetHeldShellMutationProbes,
} from '../sessions/fileSnapshots/shellMutationProbe'

const TASK = 'b1234abcd'
const LOG = `C:/Users/me/.velloc/projects/p/sess-1/tasks/${TASK}.output`

/** A scripted host: persistent records by id and log contents by path. */
function fakeHost() {
  const records = new Map<string, BridgeShellPersistentRecord>()
  const logs = new Map<string, string>()
  const calls: string[] = []
  const bridge: BackgroundShellBridge & {
    spawnPersistent: ReturnType<typeof vi.fn>
    killPersistent: ReturnType<typeof vi.fn>
  } = {
    hasTransport: () => true,
    supportsPersistentShells: () => true,
    spawnPersistent: vi.fn(async (spec: PersistentShellSpawnSpec) => {
      calls.push(`spawn:${spec.shell}`)
      const id = `persist-${records.size + 1}`
      records.set(id, {
        id,
        command: `${spec.shell} -c ${spec.command}`,
        logPath: spec.logPath,
        startedMs: Date.now(),
        running: true,
      })
      return { persistentId: id }
    }),
    listPersistent: async () => {
      calls.push('list')
      return { ok: true, shells: Array.from(records.values()) }
    },
    killPersistent: vi.fn(async (id: string) => {
      calls.push(`kill:${id}`)
      const rec = records.get(id)
      if (!rec) return { found: false, wasRunning: false }
      const wasRunning = rec.running
      if (wasRunning) {
        records.set(id, { ...rec, running: false, killed: true, timedOut: false, exitCode: -1, endedMs: 0 })
      }
      return { found: true, wasRunning }
    }),
    readLogTail: async (path: string, maxBytes: number, sinceSize?: number) => {
      calls.push('read')
      const text = logs.get(path) ?? ''
      if (text.length === sinceSize) return { ok: true, size: text.length }
      return {
        ok: true,
        size: text.length,
        text: text.slice(Math.max(0, text.length - maxBytes)),
        truncated: text.length > maxBytes,
      }
    },
  }
  const exit = (id: string, fields: Partial<BridgeShellPersistentRecord>) => {
    const rec = records.get(id)!
    records.set(id, { ...rec, running: false, killed: false, timedOut: false, endedMs: 0, ...fields })
  }
  return { bridge, records, logs, calls, exit }
}

function harness(host = fakeHost()) {
  const registry = new TaskRegistry()
  const delivered: BackgroundShellDeliveryResult[] = []
  const coordinator = new BackgroundShellCoordinator(registry, host.bridge, {
    scheduleSummary: () => {},
    deliverResult: (_parent, result) => delivered.push(result),
    dropPendingResult: () => false,
    getOutputPath: (_p, _t, provided) => provided ?? null,
    evictFinishedOverCap: () => {},
  })
  const live = (id: string) =>
    registry.getLiveByType(id, 'local_bash') as BackgroundShellRunState | undefined
  const finished = (id: string) =>
    registry.getFinishedByType(id, 'local_bash') as
      | { status: string; summary: string; taskId: string }
      | undefined
  return { ...host, registry, coordinator, delivered, live, finished }
}

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

afterEach(() => {
  vi.useRealTimers()
})

describe('BackgroundShellCoordinator.spawn — the start', () => {
  it('runs Bash under git-bash on a Windows host and sh elsewhere', async () => {
    const h = harness()
    await h.coordinator.spawn({ tool: 'Bash', command: 'ls', cwd: 'C:\\repo', logPath: LOG })
    await h.coordinator.spawn({ tool: 'Bash', command: 'ls', cwd: '/home/me/repo', logPath: LOG })
    expect(h.bridge.spawnPersistent.mock.calls.map(c => (c[0] as PersistentShellSpawnSpec).shell))
      .toEqual(['bash', 'sh'])
    expect(h.bridge.spawnPersistent.mock.calls[0]![0]).toMatchObject({
      command: 'ls',
      cwd: 'C:\\repo',
      logPath: LOG,
    })
  })

  it('falls back from pwsh to Windows PowerShell only when pwsh cannot be resolved', async () => {
    const h = harness()
    h.bridge.spawnPersistent.mockRejectedValueOnce(
      new NativePrimitiveError('BINARY_NOT_FOUND', 'pwsh not found'),
    )
    const { shellId } = await h.coordinator.spawn({
      tool: 'PowerShell', command: 'dir', cwd: 'C:\\repo', logPath: LOG,
    })
    expect(shellId).toBe('persist-1')
    expect(h.bridge.spawnPersistent.mock.calls.map(c => (c[0] as PersistentShellSpawnSpec).shell))
      .toEqual(['pwsh', 'powershell'])

    h.bridge.spawnPersistent.mockRejectedValueOnce(
      new NativePrimitiveError('INVALID_CWD', 'cwd does not exist'),
    )
    await expect(
      h.coordinator.spawn({ tool: 'PowerShell', command: 'dir', cwd: 'C:\\nope', logPath: LOG }),
    ).rejects.toThrow('INVALID_CWD: cwd does not exist')
    // No fallback for a refusal that is not a missing binary.
    expect(h.bridge.spawnPersistent).toHaveBeenCalledTimes(3)
  })
})

describe('BackgroundShellCoordinator — observing a persistent child', () => {
  it('reads output from the log, finalizes on the recorded exit, and delivers once', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'make', cwd: '/r', logPath: LOG })
    h.coordinator.register({ shellId, taskId: TASK, command: 'make', spawnerSessionId: 'sess-1', outputFilePath: LOG })
    h.logs.set(LOG, 'compiling\n')
    await tick()
    expect(h.live(shellId)?.output).toBe('compiling\n')

    h.logs.set(LOG, 'compiling\nlinked\n')
    h.exit(shellId, { exitCode: 0, durationMs: 5 })
    await tick(250)
    expect(h.live(shellId)).toBeUndefined()
    expect(h.finished(shellId)).toMatchObject({ status: 'success', taskId: TASK })
    expect(h.finished(shellId)!.summary).toContain('linked')
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toMatchObject({ taskId: TASK, status: 'success', outputFilePath: LOG })
  })

  it('a non-zero exit is an error; a killed child is stopped and never delivered', async () => {
    const h = harness()
    const a = await h.coordinator.spawn({ tool: 'Bash', command: 'false', cwd: '/r', logPath: LOG })
    const b = await h.coordinator.spawn({ tool: 'Bash', command: 'sleep 9', cwd: '/r', logPath: `${LOG}2` })
    h.coordinator.register({ shellId: a.shellId, command: 'false', spawnerSessionId: 'P', outputFilePath: LOG })
    h.coordinator.register({ shellId: b.shellId, command: 'sleep 9', spawnerSessionId: 'P', outputFilePath: `${LOG}2` })
    h.exit(a.shellId, { exitCode: 2 })
    h.exit(b.shellId, { exitCode: -1, killed: true })
    await tick(250)
    expect(h.finished(a.shellId)?.status).toBe('error')
    expect(h.finished(a.shellId)?.summary).toContain('Command exited with code 2.')
    expect(h.finished(b.shellId)?.status).toBe('stopped')
    expect(h.delivered.map(d => d.shellId)).toEqual([a.shellId])
  })

  it('marks a log longer than the tail it keeps, so a partial view is not misread', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'build', cwd: '/r', logPath: LOG })
    h.coordinator.register({ shellId, command: 'build', spawnerSessionId: 'P', outputFilePath: LOG })
    h.logs.set(LOG, 'x'.repeat(SHELL_OUTPUT_TAIL_BYTES) + 'BUILD OK')
    h.exit(shellId, { exitCode: 0 })
    await tick(250)
    const summary = h.finished(shellId)!.summary
    expect(summary.startsWith('[earlier output omitted]\n')).toBe(true)
    expect(summary).toContain('BUILD OK')
  })

  it('waits for the log to settle when the exit was recorded a moment ago', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'echo', cwd: '/r', logPath: LOG })
    h.logs.set(LOG, 'first\n')
    h.exit(shellId, { exitCode: 0, endedMs: Date.now() })
    // The host's last append lands after the exit was recorded.
    setTimeout(() => h.logs.set(LOG, 'first\nlast\n'), SHELL_LOG_SETTLE_MS / 2)
    h.coordinator.register({ shellId, command: 'echo', spawnerSessionId: 'P', outputFilePath: LOG })
    await tick(SHELL_LOG_SETTLE_MS + 150)
    expect(h.finished(shellId)!.summary).toContain('last')
  })

  it('never writes the output file: the log is the host\'s', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'x', cwd: '/r', logPath: LOG })
    h.coordinator.register({ shellId, command: 'x', spawnerSessionId: 'P', outputFilePath: LOG })
    h.exit(shellId, { exitCode: 0 })
    await tick(250)
    // The bridge seam has no write at all; the calls are spawn, list, read only.
    expect(new Set(h.calls.map(c => c.split(':')[0]))).toEqual(new Set(['spawn', 'list', 'read']))
  })

  it('kills a child at its deadline and reports a timeout (an error, delivered)', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'sleep 99', cwd: '/r', logPath: LOG })
    h.coordinator.register({
      shellId, command: 'sleep 99', spawnerSessionId: 'P', outputFilePath: LOG, killAfterMs: 60,
    })
    await tick(350)
    expect(h.bridge.killPersistent).toHaveBeenCalledWith(shellId)
    expect(h.finished(shellId)?.status).toBe('error')
    expect(h.finished(shellId)?.summary).toContain('Command timed out.')
    // No exit code: the terminated job's code is not the command's (the
    // foreground result shows -1).
    expect(h.coordinator.getSnapshot(shellId)?.exitCode).toBeUndefined()
    expect(h.delivered).toHaveLength(1)
  })
})

describe('BackgroundShellCoordinator — deadlines, evicted records and adoption races', () => {
  it('a child that exited on its own just before its deadline is reported as it exited, not timed out', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'quick', cwd: '/r', logPath: LOG })
    h.coordinator.register({ shellId, command: 'quick', spawnerSessionId: 'P', outputFilePath: LOG, killAfterMs: 60 })
    await tick(30)
    // Exits with 0, and no poll sees it before the deadline's kill answers
    // wasRunning=false.
    h.exit(shellId, { exitCode: 0 })
    await tick(350)
    expect(h.bridge.killPersistent).toHaveBeenCalledWith(shellId)
    expect(h.finished(shellId)?.status).toBe('success')
    expect(h.finished(shellId)?.summary).not.toContain('timed out')
    expect(h.coordinator.getSnapshot(shellId)?.exitCode).toBe(0)
  })

  it('observations that ask while a list is in flight share it', async () => {
    const h = harness()
    const a = await h.coordinator.spawn({ tool: 'Bash', command: 'a', cwd: '/r', logPath: LOG })
    const b = await h.coordinator.spawn({ tool: 'Bash', command: 'b', cwd: '/r', logPath: `${LOG}2` })
    // A host that answers only when told to, so the two first polls overlap.
    const list = h.bridge.listPersistent.bind(h.bridge)
    let answer!: () => void
    const answered = new Promise<void>(resolve => { answer = resolve })
    h.bridge.listPersistent = async () => {
      await answered
      return list()
    }
    h.calls.length = 0
    h.coordinator.register({ shellId: a.shellId, command: 'a', spawnerSessionId: 'P', outputFilePath: LOG })
    h.coordinator.register({ shellId: b.shellId, command: 'b', spawnerSessionId: 'P', outputFilePath: `${LOG}2` })
    await tick(20)
    answer()
    await tick(5)
    expect(h.calls.filter(call => call === 'list')).toHaveLength(1)
    h.coordinator.finalizeForTest(a.shellId, 'stopped', 'cleanup')
    h.coordinator.finalizeForTest(b.shellId, 'stopped', 'cleanup')
  })

  it('a deadline kill the host could not carry out is tried again', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'sleep 99', cwd: '/r', logPath: LOG })
    h.bridge.killPersistent.mockResolvedValueOnce(null)
    h.coordinator.register({ shellId, command: 'sleep 99', spawnerSessionId: 'P', outputFilePath: LOG, killAfterMs: 20 })
    await tick(1400)
    expect(h.bridge.killPersistent).toHaveBeenCalledTimes(2)
    expect(h.finished(shellId)?.summary).toContain('Command timed out.')
  })

  it('an end some list saw is kept when the host evicts the record before this child\'s own poll', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'build', cwd: '/r', logPath: LOG })
    h.coordinator.register({ shellId, command: 'build', spawnerSessionId: 'P', outputFilePath: LOG })
    await tick(30)
    h.exit(shellId, { exitCode: 0 })
    // Another observation's list (here: an adoption pass) sees the end...
    await h.coordinator.adoptRunning()
    // ...then the host drops the record (its 64-record cap).
    h.records.delete(shellId)
    await tick(350)
    expect(h.finished(shellId)?.status).toBe('success')
  })

  it('a child adopted between its spawn and its register takes the launcher\'s deadline and delivery', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'sleep 99', cwd: '/r', logPath: LOG })
    // A port swap re-runs adoption while the launcher is still between calls.
    await expect(h.coordinator.adoptRunning()).resolves.toBe(1)
    h.coordinator.register({
      shellId, taskId: TASK, command: 'sleep 99', spawnerSessionId: 'sess-1', outputFilePath: LOG, killAfterMs: 60,
    })
    await tick(350)
    expect(h.bridge.killPersistent).toHaveBeenCalledWith(shellId)
    expect(h.finished(shellId)?.summary).toContain('Command timed out.')
    expect(h.delivered).toHaveLength(1)
  })
})

describe('BackgroundShellCoordinator — the shell write capture of a background command', () => {
  const heldProbe = () => ({ tracked: ['/r/out.txt'], settle: vi.fn(async () => {}) })

  it('settles the probe held for the task once the command has ended', async () => {
    resetHeldShellMutationProbes()
    const h = harness()
    const probe = heldProbe()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'echo x > out.txt', cwd: '/r', logPath: LOG })
    holdShellMutationProbe(TASK, probe, 'sess-1')
    h.coordinator.register({ shellId, taskId: TASK, command: 'echo x > out.txt', spawnerSessionId: 'sess-1', outputFilePath: LOG })
    await tick()
    expect(probe.settle).not.toHaveBeenCalled()
    h.exit(shellId, { exitCode: 0, durationMs: 5 })
    await tick(250)
    expect(h.finished(shellId)?.status).toBe('success')
    expect(probe.settle).toHaveBeenCalledTimes(1)
    expect(heldShellMutationProbeCount()).toBe(0)
  })

  it('lets go of a closed session’s probes, and only that session’s', async () => {
    resetHeldShellMutationProbes()
    const h = harness()
    const mine = heldProbe()
    const other = heldProbe()
    holdShellMutationProbe('bmine0001', mine, 'sess-1')
    holdShellMutationProbe('bother001', other, 'sess-2')
    h.coordinator.stopChildren('sess-1')
    expect(heldShellMutationProbeCount()).toBe(1)
    expect(mine.settle).not.toHaveBeenCalled()
    resetHeldShellMutationProbes()
  })
})

describe('BackgroundShellCoordinator.stop — shell.persistentKill', () => {
  it('kills, confirms the exit, and records the run stopped with its output', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'serve', cwd: '/r', logPath: LOG })
    h.coordinator.register({ shellId, command: 'serve', spawnerSessionId: 'P', outputFilePath: LOG })
    h.logs.set(LOG, 'listening\n')
    await expect(h.coordinator.stop(shellId)).resolves.toBe('stopped')
    expect(h.bridge.killPersistent).toHaveBeenCalledWith(shellId)
    expect(h.finished(shellId)).toMatchObject({ status: 'stopped' })
    expect(h.finished(shellId)!.summary).toContain('listening')
    expect(h.delivered).toHaveLength(0)
  })

  it('a failed kill leaves the row running (stop_failed)', async () => {
    const h = harness()
    const { shellId } = await h.coordinator.spawn({ tool: 'Bash', command: 'serve', cwd: '/r', logPath: LOG })
    h.coordinator.register({ shellId, command: 'serve', spawnerSessionId: 'P', outputFilePath: LOG })
    h.bridge.killPersistent.mockResolvedValueOnce(null)
    await expect(h.coordinator.stop(shellId)).resolves.toBe('stop_failed')
    expect(h.live(shellId)).toBeDefined()
    h.coordinator.finalizeForTest(shellId, 'stopped', 'cleanup')
  })
})

describe('BackgroundShellCoordinator.adoptRunning — after a worker restart', () => {
  function seededHost() {
    const host = fakeHost()
    const add = (rec: Partial<BridgeShellPersistentRecord> & { id: string }) =>
      host.records.set(rec.id, {
        command: 'bash -c npm run dev',
        logPath: LOG,
        startedMs: 1000,
        running: true,
        ...rec,
      })
    return { host, add }
  }

  it('re-adopts a still-running child of a session task dir as a live row, acknowledged', async () => {
    const { host, add } = seededHost()
    add({ id: 'persist-a' })
    const h = harness(host)
    await expect(h.coordinator.adoptRunning()).resolves.toBe(1)
    const run = h.live('persist-a')!
    expect(run).toMatchObject({
      taskId: TASK,
      spawnerSessionId: 'sess-1',
      command: 'npm run dev',
      outputFilePath: LOG,
      startedAt: 1000,
    })
    expect(h.registry.resolveNative(TASK)).toBe('persist-a')
    // Its exit is observed and recorded, but it is not delivered: the old
    // worker's delivery state is unknown and the parent may not be loaded.
    host.exit('persist-a', { exitCode: 0 })
    await tick(250)
    expect(h.finished('persist-a')?.status).toBe('success')
    expect(h.delivered).toHaveLength(0)
  })

  it('leaves alone ended children, foreign logs, known ids and released children', async () => {
    const { host, add } = seededHost()
    add({ id: 'ended', running: false, exitCode: 0 })
    add({ id: 'foreign', logPath: 'C:/tmp/mod-log.txt' })
    add({ id: 'not-a-shell-task', logPath: 'C:/x/sess-1/tasks/a123.output' })
    add({ id: 'known', logPath: 'C:/x/sess-1/tasks/bknown01.output' })
    add({ id: 'released', logPath: 'C:/x/sess-2/tasks/breleas01.output' })
    const h = harness(host)
    h.coordinator.register({ shellId: 'known', taskId: 'bknown01', command: 'x', spawnerSessionId: 'sess-1' })
    h.coordinator.register({ shellId: 'released', taskId: 'breleas01', command: 'x', spawnerSessionId: 'sess-2' })
    h.coordinator.stopChildren('sess-2')
    // The kill is best-effort: the child may well still be running.
    add({ id: 'released', logPath: 'C:/x/sess-2/tasks/breleas01.output' })
    await expect(h.coordinator.adoptRunning()).resolves.toBe(0)
    expect(h.live('ended')).toBeUndefined()
    expect(h.live('foreign')).toBeUndefined()
    expect(h.live('released')).toBeUndefined()
    h.coordinator.finalizeForTest('known', 'stopped', 'cleanup')
  })

  it('parses both separators and only local_bash task ids', () => {
    expect(parseBackgroundShellLogPath('C:\\p\\sess-9\\tasks\\babc12345.output'))
      .toEqual({ spawnerSessionId: 'sess-9', taskId: 'babc12345' })
    expect(parseBackgroundShellLogPath('/home/me/.velloc/projects/p/s/tasks/bq1w2e3r4.output'))
      .toEqual({ spawnerSessionId: 's', taskId: 'bq1w2e3r4' })
    expect(parseBackgroundShellLogPath('/p/s/tasks/aagent123.output')).toBeNull()
    expect(parseBackgroundShellLogPath('/p/s/other/b12345678.output')).toBeNull()
  })
})

describe('BackgroundShellHostBridge — the primitives under the registry', () => {
  type Req = { route: { capability: string; action: string }; payload: Record<string, unknown> }
  function bridgeWith(
    answer: (req: Req) => unknown,
    primitives: string[] | null = ['shell.spawn.persist', 'shell.persistentList', 'shell.persistentKill'],
  ) {
    const requests: Req[] = []
    const host: BackgroundShellHostBridgeHost = {
      getTransport: () => ({
        request: async (req: Req) => {
          requests.push(req)
          return answer(req)
        },
      }) as never,
      getManifest: () =>
        primitives ? { capabilities: ['shell', 'fs'], primitives } : null,
      createRequestId: () => 'r',
      getHomeDir: () => null,
      storageRoot: () => null,
      getSessionProjectRoot: () => undefined,
      projectRouteOf: () => undefined,
      getSessionTemplateType: () => undefined,
    }
    return { bridge: new BackgroundShellHostBridge(host), requests }
  }

  it('supports the registry only when the manifest lists every persistent-shell primitive', () => {
    expect(bridgeWith(() => null).bridge.supportsPersistentShells()).toBe(true)
    expect(bridgeWith(() => null, ['shell.spawn.persist', 'shell.persistentList'])
      .bridge.supportsPersistentShells()).toBe(false)
    expect(bridgeWith(() => null, null).bridge.supportsPersistentShells()).toBe(false)
  })

  it('spawns in the shell form with persist.logPath and stdin closed', async () => {
    const { bridge, requests } = bridgeWith(() => ({ ok: true, result: { persistentId: 'persist-9' } }))
    await expect(
      bridge.spawnPersistent({ shell: 'bash', command: 'make', cwd: 'C:\\r', logPath: LOG }),
    ).resolves.toEqual({ persistentId: 'persist-9' })
    expect(requests[0]!.route).toMatchObject({ capability: 'shell', action: 'spawn' })
    expect(requests[0]!.payload).toEqual({
      shell: 'bash',
      command: 'make',
      cwd: 'C:\\r',
      closeStdin: true,
      persist: { logPath: LOG },
    })
  })

  it('reads only the tail, skips an unchanged log, and treats a missing log as empty', async () => {
    const text = 'é'.repeat(10) // 20 bytes of 2-byte characters
    const bytes = new TextEncoder().encode(text)
    let size = bytes.length
    const { bridge, requests } = bridgeWith(req => {
      if (req.route.action === 'stat') {
        return size < 0
          ? { ok: false, error: { code: 'FS_ERROR', message: 'ENOENT: no such file or directory' } }
          : { ok: true, result: { size } }
      }
      const { offset, length } = req.payload as { offset: number; length: number }
      const data = bytes.slice(offset, offset + length)
      return { ok: true, result: { data, bytesRead: data.length } }
    })
    // A cut that lands inside a character drops the broken half.
    const tail = await bridge.readLogTail(LOG, 5)
    expect(tail).toEqual({ ok: true, size: 20, text: 'éé', truncated: true })
    expect(requests.at(-1)!.payload).toMatchObject({ offset: 15, length: 5 })

    const before = requests.length
    await expect(bridge.readLogTail(LOG, 5, 20)).resolves.toEqual({ ok: true, size: 20 })
    expect(requests.length - before).toBe(1) // stat only

    size = -1
    await expect(bridge.readLogTail(LOG, 5)).resolves.toEqual({
      ok: true, size: 0, text: '', truncated: false,
    })
  })

  it('a list the host cannot serve is a terminal failure', async () => {
    const { bridge } = bridgeWith(() => ({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'no persistentList' },
    }))
    await expect(bridge.listPersistent()).resolves.toMatchObject({ ok: false, terminal: true })
  })
})
