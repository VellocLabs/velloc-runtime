// SuperShell's command executor (toolkit/builtin/superShellRunner.ts): pure helpers; the host wrappers under a REAL
// bash (skipped without a native bash); `SuperShellInvocation` against fakes, with the real `runNestedTool` gate.

import { spawnSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolContract } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { SubAgentController, SubAgentSnapshot } from '../team/subAgentController'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const { preHookMock, postHookMock } = vi.hoisted(() => ({
  preHookMock: vi.fn(async () => ({ blocked: false, message: '' })),
  postHookMock: vi.fn(async () => ''),
}))


import {
  buildBackgroundWrapper,
  buildForegroundWrapper,
  MAX_CAPTURE_BYTES,
  NO_TIMEOUT_CAP_SENTINEL_MS,
  parseLaunchedTaskId,
  posixQuote,
  stateOnlyCommandHint,
  STEP_RECORD_TAIL_CHARS,
  SuperShellInvocation,
  takeCompleteLines,
  toBashPath,
  type ShellErrorData,
  type ShellOpResponse,
} from '../toolkit/builtin/superShellRunner'
import { SHELL_NO_TIMEOUT_CAP_SENTINEL_MS } from '../toolkit/builtin/host/shellArgs'
import {
  HOST_DISPLAY_COMMAND,
  HOST_RESULT_ACKNOWLEDGED,
  HOST_SUPER_SHELL_TASK_ID,
} from '../toolkit/run/backgroundShellSink'
import {
  createShellHelpers,
  ShellRunFailure,
  type BackgroundHandle,
  type BashResult,
} from '../browser/runJs/shellHelpers'

beforeEach(() => {
  preHookMock.mockReset()
  preHookMock.mockResolvedValue({ blocked: false, message: '' })
  postHookMock.mockReset()
  postHookMock.mockResolvedValue('')
})

// ── 1. pure helpers ─────────────────────────────────────────────────────────

describe('superShellRunner — pure helpers', () => {
  it('pins the no-timeout-cap sentinel to the hosted Bash tool value', () => {
    expect(NO_TIMEOUT_CAP_SENTINEL_MS).toBe(SHELL_NO_TIMEOUT_CAP_SENTINEL_MS)
  })

  it('posixQuote makes every character literal, including single quotes', () => {
    expect(posixQuote("it's $HOME && `x`")).toBe(`'it'\\''s $HOME && \`x\`'`)
  })

  it('flags a lone cd / export / unset, and nothing that does work in the same command', () => {
    for (const lone of ['cd nexus_web', 'cd "a b"', 'export NODE_ENV=test', 'export A=1 B=2;', 'unset FOO']) {
      expect(stateOnlyCommandHint(lone), lone).not.toBeNull()
    }
    for (const real of [
      'cd nexus_web && git status',
      'export FOO=bar; some-command',
      'NODE_ENV=test npx vitest run',
      'git status',
      'export PATH="$PATH:/x"', // not a simple form — not flagged, and not claimed to be
    ]) {
      expect(stateOnlyCommandHint(real), real).toBeNull()
    }
  })

  it('parseLaunchedTaskId reads the background-shell ack and rejects anything else', () => {
    expect(parseLaunchedTaskId(JSON.stringify({ task_id: 'b1', status: 'running' }))).toBe('b1')
    expect(parseLaunchedTaskId(JSON.stringify({ output: 'x', exit_code: 0 }))).toBeNull()
    expect(parseLaunchedTaskId('not json')).toBeNull()
  })

  it('parseLaunchedTaskId still reads the ack when a PostToolUse hook note follows the JSON', () => {
    // runNestedTool appends the hook's note after the serialized result; the
    // command has started, so its task id must still be tracked.
    const ack = JSON.stringify({ task_id: 'b7', status: 'running' }, null, 2)
    expect(parseLaunchedTaskId(`${ack}\nPostToolUse hook: remember to push tags`)).toBe('b7')
    expect(parseLaunchedTaskId('note\nmore note')).toBeNull()
  })

  it('takeCompleteLines hands out only newline-terminated lines, unless the writer ended or one line fills a read', () => {
    const bytes = (s: string) => new TextEncoder().encode(s)
    expect(takeCompleteLines(bytes('a\r\nb\nparti'), false, 100)).toEqual({ lines: ['a', 'b'], consumed: 5 })
    expect(takeCompleteLines(bytes('parti'), false, 100)).toEqual({ lines: [], consumed: 0 })
    expect(takeCompleteLines(bytes('partial'), true, 100)).toEqual({ lines: ['partial'], consumed: 7 })
    expect(takeCompleteLines('xxxx', false, 4)).toEqual({ lines: ['xxxx'], consumed: 4 })
    // A multi-byte character is never split: the newline byte cannot occur inside one.
    expect(takeCompleteLines(bytes('héllo\nwör'), false, 100)).toEqual({ lines: ['héllo'], consumed: 7 })
  })

  it('toBashPath rewrites only Windows paths; a POSIX backslash is a file-name character', () => {
    expect(toBashPath('C:\\Users\\me\\proj')).toBe('C:/Users/me/proj')
    expect(toBashPath('\\\\server\\share\\x')).toBe('//server/share/x')
    expect(toBashPath('/tmp/odd\\name')).toBe('/tmp/odd\\name')
  })
})

// ── 2. the wrappers under a real bash ───────────────────────────────────────

function nativeBash(): boolean {
  const probe = spawnSync('bash', ['-c', 'uname -sr'], { encoding: 'utf-8' })
  if (probe.status !== 0) return false
  const uname = probe.stdout.trim()
  if (process.platform === 'win32') return /^(MINGW|MSYS|CYGWIN)/i.test(uname)
  return !/microsoft/i.test(uname)
}

const HAS_BASH = nativeBash()

function runBash(script: string): number {
  return spawnSync('bash', ['-c', script], { encoding: 'utf-8' }).status ?? -1
}

function readIf(path: string): string | undefined {
  try {
    return nodeFs.readFileSync(path, 'utf-8')
  } catch {
    return undefined
  }
}

describe.skipIf(!HAS_BASH)('superShellRunner — wrappers under a real bash', () => {
  function setup() {
    const root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'supershell-')))
    const stepDir = nodePath.join(root, 'step')
    nodeFs.mkdirSync(stepDir)
    const work = nodePath.join(root, 'work')
    nodeFs.mkdirSync(work)
    return { root, stepDir, work }
  }

  it('records the real exit code and separates stdout from stderr', () => {
    const { stepDir, work } = setup()
    const status = runBash(
      buildForegroundWrapper({ command: 'echo out; echo err >&2; exit 3', stepDir, cwd: work, hasStdin: false }),
    )
    expect(readIf(nodePath.join(stepDir, 'ec'))).toBe('3')
    expect(readIf(nodePath.join(stepDir, 'out'))).toBe('out\n')
    expect(readIf(nodePath.join(stepDir, 'err'))).toBe('err\n')
    // The host's own exit code is the command's too (outer pipefail), not tee's.
    expect(status).toBe(3)
  })

  it('runs in the given cwd, keeps quotes literal, and does not leak pipefail', () => {
    const { stepDir, work } = setup()
    runBash(
      buildForegroundWrapper({
        command: `printf '%s|' "$(basename "$PWD")"; printf %s 'it'"'"'s'; false | true`,
        stepDir,
        cwd: work,
        hasStdin: false,
      }),
    )
    expect(readIf(nodePath.join(stepDir, 'out'))).toBe("work|it's")
    // `false | true` exits 0 under default bash semantics: exitCode is the
    // status of the command string, not of every program in it.
    expect(readIf(nodePath.join(stepDir, 'ec'))).toBe('0')
  })

  it('a cd inside a command does not escape it — the next wrapper starts in its own cwd', () => {
    const { stepDir, work } = setup()
    nodeFs.mkdirSync(nodePath.join(work, 'sub'))
    runBash(buildForegroundWrapper({ command: 'cd sub; export SS_T=x', stepDir, cwd: work, hasStdin: false }))
    const second = nodePath.join(stepDir, '..', 'step2')
    nodeFs.mkdirSync(second)
    runBash(
      buildForegroundWrapper({
        command: 'printf "%s|%s" "$(basename "$PWD")" "${SS_T:-unset}"',
        stepDir: second,
        cwd: work,
        hasStdin: false,
      }),
    )
    expect(readIf(nodePath.join(second, 'out'))).toBe('work|unset')
  })

  it('feeds stdin from the step file, and records an exit from inside the command', () => {
    const { stepDir, work } = setup()
    nodeFs.writeFileSync(nodePath.join(stepDir, 'in'), 'line1\nline2\n')
    runBash(buildForegroundWrapper({ command: 'cat; exit 7', stepDir, cwd: work, hasStdin: true }))
    expect(readIf(nodePath.join(stepDir, 'out'))).toBe('line1\nline2\n')
    expect(readIf(nodePath.join(stepDir, 'ec'))).toBe('7')
  })

  it('flags a working directory that does not exist, without running the command', () => {
    const { stepDir, root } = setup()
    runBash(
      buildForegroundWrapper({ command: 'echo never', stepDir, cwd: nodePath.join(root, 'gone'), hasStdin: false }),
    )
    expect(readIf(nodePath.join(stepDir, 'cwderr'))).toBe('x')
    expect(readIf(nodePath.join(stepDir, 'out'))).toBe('')
  })

  it('the background wrapper logs merged stdout+stderr in order and keeps the exit code', () => {
    const { root, work } = setup()
    const logPath = nodePath.join(root, 'bg.log')
    const status = runBash(
      buildBackgroundWrapper({ command: 'echo one; echo two >&2; echo three; exit 5', cwd: work, logPath }),
    )
    expect(readIf(logPath)).toBe('one\ntwo\nthree\n')
    expect(status).toBe(5)
  })
})

// ── 3. the invocation against fakes ─────────────────────────────────────────

function memoryFs(files: Map<string, string>, opts: { readRange?: boolean } = {}): RuntimeFs {
  const fs = {
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    }),
    readFile: vi.fn(async (path: string) => {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    }),
    stat: vi.fn(async (path: string) => {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return { size: new TextEncoder().encode(v).length, isDirectory: () => false, isFile: () => true, mtimeMs: 0 }
    }),
    unlink: vi.fn(async (path: string) => {
      files.delete(path)
    }),
  } as Record<string, unknown>
  if (opts.readRange) {
    fs.readRange = vi.fn(async (path: string, { offset, length }: { offset: number; length: number }) => {
      const bytes = new TextEncoder().encode(files.get(path) ?? '')
      const buffer = bytes.slice(offset, offset + length)
      return { buffer, bytesRead: buffer.length }
    })
  }
  return fs as unknown as RuntimeFs
}

function snapshot(overrides: Partial<SubAgentSnapshot> = {}): SubAgentSnapshot {
  return {
    sessionId: 'b1',
    status: 'success',
    description: 'x',
    taskType: 'local_bash',
    output: '',
    exitCode: 0,
    startedAt: 0,
    ...overrides,
  }
}

function fakeController(overrides: Partial<SubAgentController> = {}): SubAgentController {
  return {
    getSnapshot: vi.fn(() => snapshot()),
    waitForCompletion: vi.fn(async () => snapshot()),
    stop: vi.fn(() => ({ status: 'stopped' as const })),
    resume: () => ({ ok: false, reason: 'not_found' }),
    list: () => [],
    acknowledgeResult: vi.fn(),
    ...overrides,
  }
}

type StepFiles = Record<string, string>

/** A fake Bash tool: records every dispatched input and, like the real host,
 *  "runs" the command by writing the step's capture files. */
function fakeBash(files: Map<string, string>, perStep: (index: number) => StepFiles) {
  const dispatched: Record<string | symbol, unknown>[] = []
  const tool = {
    name: 'Bash',
    readsOnly: () => false,
    async selfVerdict() {
      return { behavior: 'allow' as const }
    },
    async call(input: Record<string | symbol, unknown>) {
      dispatched.push(input)
      const index = dispatched.length
      for (const [name, value] of Object.entries(perStep(index))) {
        files.set(`/runs/r1/${index}/${name}`, value)
      }
      return { data: { task_id: `b${index}`, status: 'running' } }
    },
  } as unknown as ToolContract
  return { tool, dispatched }
}

function makeInvocation(params: {
  tools: ToolContract[]
  files: Map<string, string>
  controller?: SubAgentController
  appState?: Record<string, unknown>
  readRange?: boolean
  /** The slot's mods, as the tool path sees them. */
  mods?: unknown
}) {
  const stop = new AbortController()
  const context = {
    options: {
      tools: params.tools,
      cwd: '/proj',
      sessionId: 's1',
      ...(params.mods ? { mods: params.mods } : {}),
    },
    cancelSource: new AbortController(),
    toolRunSeams: { nested: { preHooks: (...a: unknown[]) => preHookMock(...(a as [])), postHooks: (...a: unknown[]) => postHookMock(...(a as [])) } } as never,
    readAppState: () => ({
      permissionRules: {
        mode: 'default',
        extraWorkspaceRoots: new Map(),
        ...params.appState,
      },
    }),
  } as unknown as ToolCallContext
  const controller = params.controller ?? fakeController()
  const invocation = new SuperShellInvocation({
    context,
    canUseTool: vi.fn() as unknown as PermissionDecider,
    invokingRow: {} as Message,
    controller,
    fs: memoryFs(params.files, { readRange: params.readRange }),
    defaultCwd: '/proj',
    runDir: '/runs/r1',
    signal: stop.signal,
  })
  return { invocation, controller, stop }
}

function expectError(res: ShellOpResponse): ShellErrorData {
  expect('error' in res, JSON.stringify(res)).toBe(true)
  return (res as { error: ShellErrorData }).error
}

function expectResult(res: ShellOpResponse): Record<string, unknown> {
  expect('result' in res, JSON.stringify(res)).toBe(true)
  return (res as { result: Record<string, unknown> }).result
}

describe('SuperShellInvocation — foreground steps', () => {
  it('gates the model command WITH the cwd it runs in, dispatches the wrapper for that same cwd', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({ ec: '0', out: ' M a.ts\n', err: 'warning\n' }))
    const { invocation, controller } = makeInvocation({ tools: [tool], files })
    const res = await invocation.handle('run', { command: 'git status --short', options: { cwd: 'nexus_web' } })

    expect((preHookMock.mock.calls[0] as unknown[])[1]).toEqual({
      command: 'git status --short',
      cwd: '/proj/nexus_web',
      run_in_background: true,
    })
    const sent = dispatched[0]!
    expect(sent.cwd).toBe('/proj/nexus_web')
    expect(sent.command).toContain(`cd '/proj/nexus_web'`)
    expect(sent.command).toContain(`eval 'git status --short'`)
    expect(sent[HOST_DISPLAY_COMMAND]).toBe('git status --short')
    // Registered already acknowledged: its completion can never be delivered.
    expect(sent[HOST_RESULT_ACKNOWLEDGED]).toBe(true)
    expect(sent.timeout).toBe(NO_TIMEOUT_CAP_SENTINEL_MS)

    expect(expectResult(res)).toEqual({ stdout: ' M a.ts\n', stderr: 'warning\n', exitCode: 0, truncated: false })
    expect(controller.acknowledgeResult).toHaveBeenCalledWith('b1')
    expect([...files.keys()].sort()).toEqual(['/runs/r1/1/err', '/runs/r1/1/out'])
    expect(invocation.steps[0]).toMatchObject({ kind: 'run', outcome: 'exited', exitCode: 0, cwd: '/proj/nexus_web' })
  })

  it('once the task is registered, every step carries the invocation’s task id to its shell task', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({ ec: '0', out: '', err: '' }))
    const { invocation } = makeInvocation({ tools: [tool], files })
    // No task (a host without task tracking): the step is an ordinary shell.
    await invocation.handle('run', { command: 'git status', options: {} })
    expect(dispatched[0]![HOST_SUPER_SHELL_TASK_ID]).toBeUndefined()

    invocation.setOwnerTaskId('h1abc')
    await invocation.handle('run', { command: 'npx tsc --noEmit', options: {} })
    await invocation.handle('run', { command: 'npx vite', options: { background: true } })
    expect(dispatched[1]![HOST_SUPER_SHELL_TASK_ID]).toBe('h1abc')
    expect(dispatched[2]![HOST_SUPER_SHELL_TASK_ID]).toBe('h1abc')
    // The gates and hooks never see it: it rides only the host-bound input.
    for (const call of preHookMock.mock.calls) {
      expect(Object.getOwnPropertySymbols((call as unknown[])[1] as object)).toEqual([])
    }
  })

  it('acknowledges a step BEFORE it finishes, so an idle parent never gets its task-notification', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ ec: '0', out: '', err: '' }))
    const order: string[] = []
    const controller = fakeController({
      acknowledgeResult: vi.fn(() => void order.push('ack')),
      waitForCompletion: vi.fn(async () => {
        order.push('finished')
        return snapshot()
      }),
    })
    const { invocation } = makeInvocation({ tools: [tool], files, controller })
    await invocation.handle('run', { command: 'sleep 8', options: {} })
    expect(order[0]).toBe('ack')
    expect(order.indexOf('ack')).toBeLessThan(order.indexOf('finished'))
  })

  it('a timeout counts from the launch: a slow permission gate does not use it up (nor durationMs)', async () => {
    const files = new Map<string, string>()
    const { tool: inner, dispatched } = fakeBash(files, () => ({ ec: '0', out: 'done\n', err: '' }))
    // The self-gate stands in for a permission prompt the user answers after 150 ms.
    const tool = {
      ...inner,
      async selfVerdict() {
        await new Promise(resolve => setTimeout(resolve, 150))
        return { behavior: 'allow' as const }
      },
    } as unknown as ToolContract
    const RUN_MS = 20
    let launchedAt = 0
    let stopped = false
    const controller = fakeController({
      // Like the real controller: resolves at completion, or `running` at the wait's own limit.
      waitForCompletion: vi.fn(async (_id: string, ms: number) => {
        launchedAt ||= Date.now()
        const left = launchedAt + RUN_MS - Date.now()
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, left))))
        if (stopped) return snapshot({ status: 'stopped', exitCode: null })
        return Date.now() - launchedAt >= RUN_MS ? snapshot() : snapshot({ status: 'running' })
      }),
      stop: vi.fn(() => {
        stopped = true
        return { status: 'stopped' as const }
      }),
    })
    const { invocation } = makeInvocation({ tools: [tool], files, controller })
    const res = await invocation.handle('run', { command: 'make', options: { timeoutMs: 100 } })

    expect(dispatched).toHaveLength(1)
    expect(controller.stop).not.toHaveBeenCalled()
    expect(expectResult(res)).toMatchObject({ exitCode: 0, stdout: 'done\n' })
    const step = invocation.steps[0] as { outcome: string; durationMs: number }
    expect(step.outcome).toBe('exited')
    expect(step.durationMs).toBeLessThan(140)
  })

  it('a cwd changed by the gates moves the wrapper and the host together', async () => {
    const files = new Map<string, string>()
    const { tool: inner, dispatched } = fakeBash(files, () => ({ ec: '0', out: '', err: '' }))
    const tool = {
      ...inner,
      async selfVerdict(input: Record<string, unknown>) {
        return { behavior: 'allow' as const, updatedInput: { ...input, cwd: '/sandbox/copy' } }
      },
    } as unknown as ToolContract
    const { invocation } = makeInvocation({ tools: [tool], files })
    await invocation.handle('run', { command: 'make', options: { cwd: 'sub' } })

    const sent = dispatched[0]!
    expect(sent.cwd).toBe('/sandbox/copy')
    expect(sent.command).toContain(`cd '/sandbox/copy'`)
    expect(sent.command).not.toContain('/proj/sub')
    expect(invocation.steps[0]).toMatchObject({ kind: 'run', cwd: '/sandbox/copy' })

    // Background steps too.
    await invocation.handle('run', { command: 'server', options: { background: true } })
    expect(dispatched[1]!.cwd).toBe('/sandbox/copy')
    expect(dispatched[1]!.command).toContain(`cd '/sandbox/copy'`)
    expect(dispatched[1]![HOST_RESULT_ACKNOWLEDGED]).toBeUndefined()
  })

  it('a step record keeps only the tail of its output; the script still gets the whole capture', async () => {
    const files = new Map<string, string>()
    const big = 'x'.repeat(200_000) + 'END\n'
    const { tool } = fakeBash(files, () => ({ ec: '1', out: big, err: big }))
    const { invocation } = makeInvocation({ tools: [tool], files })
    const result = expectResult(await invocation.handle('run', { command: 'make', options: {} }))
    expect(result.stdout).toBe(big)
    const step = invocation.steps[0] as { stdout: string; stderr: string }
    expect(step.stdout.length).toBe(STEP_RECORD_TAIL_CHARS)
    expect(step.stderr.length).toBe(STEP_RECORD_TAIL_CHARS)
    expect(step.stdout.endsWith('END\n')).toBe(true)
  })

  it('every step starts in the default cwd — nothing carries from a previous step', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({ ec: '0', out: '', err: '' }))
    const { invocation } = makeInvocation({ tools: [tool], files })
    await invocation.handle('run', { command: 'cd sub && make', options: {} })
    await invocation.handle('run', { command: 'git status', options: {} })
    expect(dispatched[1]!.command).toContain(`cd '/proj'`)
    expect(dispatched[1]!.cwd).toBe('/proj')
  })

  it('a non-zero exit is a normal result (the worker decides whether to throw)', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ ec: '2', out: 'src/a.ts: error TS2304\n', err: '' }))
    const { invocation } = makeInvocation({ tools: [tool], files })
    const res = await invocation.handle('run', { command: 'npx tsc --noEmit', options: {} })
    expect(expectResult(res)).toMatchObject({ exitCode: 2, truncated: false })
  })

  it('a lone cd is refused as invalid without dispatching anything', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({}))
    const { invocation } = makeInvocation({ tools: [tool], files })
    const err = expectError(await invocation.handle('run', { command: 'cd nexus_web', options: {} }))
    expect(err.kind).toBe('invalid')
    expect(err.message).toMatch(/\{ cwd \}/)
    expect(dispatched).toHaveLength(0)
    expect(invocation.steps[0]).toMatchObject({ kind: 'notRun' })
  })

  it('a deny rule is `denied`: nothing dispatched, exitCode null', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({}))
    const { invocation } = makeInvocation({ tools: [tool], files, appState: { denyRuleBook: { session: ['Bash'] } } })
    const err = expectError(await invocation.handle('run', { command: 'rm -rf x', options: {} }))
    expect(err).toMatchObject({ kind: 'denied', exitCode: null })
    expect(dispatched).toHaveLength(0)
  })

  it('a mod tool.call hook sees the step as a Bash call: its deny refuses it, nothing dispatched', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({}))
    const seen: unknown[] = []
    const mods = {
      ready: Promise.resolve(),
      hasToolCallHooks: () => true,
      toolCall: async (e: unknown) => {
        seen.push(e)
        return { settled: true, result: { deny: 'NO_PUSH' } }
      },
    }
    const { invocation } = makeInvocation({ tools: [tool], files, mods })
    const err = expectError(await invocation.handle('run', { command: 'git push', options: {} }))
    expect(err).toMatchObject({ kind: 'denied', exitCode: null })
    expect(err.message).toContain('NO_PUSH')
    expect(seen[0]).toMatchObject({ tool: 'Bash', command: 'git push' })
    expect(dispatched).toHaveLength(0)
    expect(invocation.steps[0]).toMatchObject({ kind: 'notRun', command: 'git push', reason: 'NO_PUSH' })
  })

  it('a hook answering the step with its own result: no command ran, so the step is not run, the answer its reason', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({}))
    const mods = {
      ready: Promise.resolve(),
      hasToolCallHooks: () => true,
      toolCall: async () => ({ settled: true, result: { result: 'CACHED_OUTPUT' } }),
    }
    const { invocation } = makeInvocation({ tools: [tool], files, mods })
    const err = expectError(await invocation.handle('run', { command: 'npm test', options: {} }))
    expect(err.kind).toBe('denied')
    expect(err.message).toContain('a plugin hook answered it: CACHED_OUTPUT')
    expect(dispatched).toHaveLength(0)
    expect(invocation.steps[0]).toMatchObject({ kind: 'notRun', reason: 'CACHED_OUTPUT' })
  })

  it('a Bash call that rejects with a plain Error still lists the command in the step record', async () => {
    const files = new Map<string, string>()
    const tool = {
      name: 'Bash',
      readsOnly: () => false,
      async selfVerdict() {
        return { behavior: 'allow' as const }
      },
      async call() {
        throw new Error('transport disposed')
      },
    } as unknown as ToolContract
    const { invocation } = makeInvocation({ tools: [tool], files })
    const res = await invocation.handle('run', { command: 'npm test', options: {} }).catch(err => err)
    expect(res).toBeDefined()
    expect(invocation.steps).toMatchObject([
      { kind: 'run', command: 'npm test', step: 1, outcome: 'start_failed', stderr: 'transport disposed' },
    ])
  })

  it('a BACKGROUND step that fails to start still lists the command in the step record', async () => {
    // A script that swallows the throw (`try { await bash(..., { background:
    // true }) } catch {}`) otherwise leaves no trace the command was attempted.
    const files = new Map<string, string>()
    const tool = {
      name: 'Bash',
      readsOnly: () => false,
      async selfVerdict() {
        return { behavior: 'allow' as const }
      },
      async call() {
        throw new Error('transport disposed')
      },
    } as unknown as ToolContract
    const { invocation } = makeInvocation({ tools: [tool], files })
    await invocation
      .handle('run', { command: 'npm run dev', options: { background: true } })
      .catch(err => err)
    expect(invocation.steps).toMatchObject([
      { kind: 'notRun', command: 'npm run dev', reason: 'transport disposed' },
    ])
  })

  it('a missing working directory is `start_failed`', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ ec: '1', cwderr: 'x', out: '', err: '' }))
    const { invocation } = makeInvocation({ tools: [tool], files })
    const err = expectError(await invocation.handle('run', { command: 'ls', options: { cwd: '/gone' } }))
    expect(err).toMatchObject({ kind: 'start_failed', exitCode: null })
    expect(err.message).toContain('/gone')
  })

  it('a timeout stops the task and is `timeout` with exitCode null and the partial output', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ out: 'partial', err: '' }))
    let stopped = false
    const controller = fakeController({
      waitForCompletion: vi.fn(async () =>
        snapshot(stopped ? { status: 'stopped', exitCode: null } : { status: 'running' }),
      ),
      stop: vi.fn(() => {
        stopped = true
        return { status: 'stopped' as const }
      }),
    })
    const { invocation } = makeInvocation({ tools: [tool], files, controller })
    const err = expectError(await invocation.handle('run', { command: 'sleep 100', options: { timeoutMs: 1 } }))
    expect(controller.stop).toHaveBeenCalledWith('b1')
    expect(err).toMatchObject({ kind: 'timeout', exitCode: null, stdout: 'partial' })
  })

  it('a task stopped from outside (TaskStop) is `cancelled`', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ out: '', err: '' }))
    const controller = fakeController({ waitForCompletion: vi.fn(async () => snapshot({ status: 'stopped', exitCode: null })) })
    const { invocation } = makeInvocation({ tools: [tool], files, controller })
    const err = expectError(await invocation.handle('run', { command: 'npm run dev', options: {} }))
    expect(err).toMatchObject({ kind: 'cancelled', exitCode: null })
  })

  it('output past the capture cap is the tail, and `truncated` is set on the result', async () => {
    const files = new Map<string, string>()
    const big = 'a'.repeat(MAX_CAPTURE_BYTES) + 'VERDICT\n'
    const { tool } = fakeBash(files, () => ({ ec: '0', out: big, err: '' }))
    const { invocation } = makeInvocation({ tools: [tool], files, readRange: true })
    const result = expectResult(await invocation.handle('run', { command: 'ninja', options: {} }))
    expect(result.truncated).toBe(true)
    expect((result.stdout as string).endsWith('VERDICT\n')).toBe(true)
    expect((result.stdout as string).length).toBe(MAX_CAPTURE_BYTES)
  })

  it('writes stdin to the step file before dispatch', async () => {
    const files = new Map<string, string>()
    const seenIn: Array<string | undefined> = []
    const { tool } = fakeBash(files, () => {
      seenIn.push(files.get('/runs/r1/1/in'))
      return { ec: '0', out: '', err: '' }
    })
    const { invocation } = makeInvocation({ tools: [tool], files })
    await invocation.handle('run', { command: 'cat', options: { stdin: 'payload' } })
    expect(seenIn).toEqual(['payload'])
  })
})

describe('SuperShellInvocation — lifecycle', () => {
  it('finish() cancels a still-running foreground command, reports it, and refuses new ones', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ out: '', err: '' }))
    let stopped = false
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const controller = fakeController({
      waitForCompletion: vi.fn(async () => {
        if (!stopped) await gate
        return snapshot(stopped ? { status: 'stopped', exitCode: null } : {})
      }),
      stop: vi.fn(() => {
        stopped = true
        release()
        return { status: 'stopped' as const }
      }),
    })
    const { invocation } = makeInvocation({ tools: [tool], files, controller })
    // The script "forgot" to await this one.
    const floating = invocation.handle('run', { command: 'npx vitest run', options: {} })
    await vi.waitFor(() => expect(controller.waitForCompletion).toHaveBeenCalled())

    const cancelled = await invocation.finish()
    expect(cancelled).toEqual(['npx vitest run'])
    expect(controller.stop).toHaveBeenCalledWith('b1')
    expect(expectError(await floating)).toMatchObject({ kind: 'cancelled' })
    expect(invocation.steps[0]).toMatchObject({ kind: 'run', outcome: 'cancelled' })

    const late = expectError(await invocation.handle('run', { command: 'echo late', options: {} }))
    expect(late.kind).toBe('cancelled')
  })

  it('a command still starting (e.g. awaiting a permission answer) already counts as running', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ ec: '0', out: '', err: '' }))
    let answer!: () => void
    preHookMock.mockImplementation(
      () => new Promise(resolve => (answer = () => resolve({ blocked: false, message: '' }))),
    )
    const { invocation } = makeInvocation({ tools: [tool], files })
    const pending = invocation.handle('run', { command: 'git push', options: {} })
    await vi.waitFor(() => expect(preHookMock).toHaveBeenCalled())
    expect(invocation.runningCommands).toEqual(['git push'])
    answer()
    await pending
    expect(invocation.runningCommands).toEqual([])
  })

  it('finish() with nothing running cancels nothing', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ ec: '0', out: '', err: '' }))
    const { invocation } = makeInvocation({ tools: [tool], files })
    await invocation.handle('run', { command: 'echo ok', options: {} })
    expect(await invocation.finish()).toEqual([])
  })

  it('an aborted invocation refuses to start commands', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({}))
    const { invocation, stop } = makeInvocation({ tools: [tool], files })
    stop.abort()
    expect(expectError(await invocation.handle('run', { command: 'echo x', options: {} })).kind).toBe('cancelled')
    expect(dispatched).toHaveLength(0)
  })

  it('stop() also stops the background processes the script started; finish() leaves them running', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({}))
    const a = makeInvocation({ tools: [tool], files })
    await a.invocation.handle('run', { command: 'npx vite', options: { background: true } })
    await a.invocation.finish()
    expect(a.controller.stop).not.toHaveBeenCalled()

    const files2 = new Map<string, string>()
    const { tool: tool2 } = fakeBash(files2, () => ({}))
    const b = makeInvocation({ tools: [tool2], files: files2 })
    await b.invocation.handle('run', { command: 'npx vite', options: { background: true } })
    await b.invocation.stop()
    expect(b.controller.stop).toHaveBeenCalledWith('b1')
  })

  it('finish() does not wait on a command parked in its gates: it counts it as not completed and never starts it', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({ ec: '0' }))
    let answer!: () => void
    preHookMock.mockImplementation(
      () => new Promise(resolve => (answer = () => resolve({ blocked: false, message: '' }))),
    )
    const { invocation } = makeInvocation({ tools: [tool], files })
    // The script "forgot" to await a command that is still awaiting its answer.
    const floating = invocation.handle('run', { command: 'git push', options: {} })
    await vi.waitFor(() => expect(preHookMock).toHaveBeenCalled())

    expect(await invocation.finish()).toEqual(['git push'])
    expect(expectError(await floating).kind).toBe('cancelled')
    expect(invocation.steps).toEqual([expect.objectContaining({ kind: 'notRun', command: 'git push' })])

    answer()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(dispatched).toHaveLength(0)
    expect(invocation.steps).toHaveLength(1)
  })

  it('finish() counts a command the script never awaited even before its step directory exists', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({ ec: '0' }))
    const { invocation } = makeInvocation({ tools: [tool], files })
    const floating = invocation.handle('run', { command: 'npm test', options: {} })
    expect(await invocation.finish()).toEqual(['npm test'])
    expect(expectError(await floating).kind).toBe('cancelled')
    expect(dispatched).toHaveLength(0)
  })

  it('stop() stops a background process whose host spawn was still under way', async () => {
    const files = new Map<string, string>()
    const { tool: inner } = fakeBash(files, () => ({}))
    let spawn!: () => void
    const spawning = new Promise<void>(resolve => (spawn = resolve))
    let entered = false
    const tool = {
      ...inner,
      async call(input: Record<string | symbol, unknown>) {
        entered = true
        await spawning
        return (inner as unknown as { call: (i: unknown) => Promise<unknown> }).call(input)
      },
    } as unknown as ToolContract
    const { invocation, controller, stop } = makeInvocation({ tools: [tool], files })
    const floating = invocation.handle('run', { command: 'npm run dev', options: { background: true } })
    await vi.waitFor(() => expect(entered).toBe(true))

    stop.abort()
    const stopping = invocation.stop()
    spawn()
    await stopping
    expect(controller.stop).toHaveBeenCalledWith('b1')
    expect(expectError(await floating).kind).toBe('cancelled')
  })
})

describe('SuperShellInvocation — background + waitFor', () => {
  /** The script's `bash()` (the real worker-side helpers) wired straight to the
   *  invocation, recording every op that crosses to the SharedWorker. */
  function scriptBash(invocation: SuperShellInvocation) {
    const ops: Array<{ op: string; payload: Record<string, unknown> }> = []
    const { bash } = createShellHelpers(async (op, payload) => {
      ops.push({ op, payload })
      return invocation.handle(op, payload)
    })
    return { bash, ops }
  }

  it('starts an unacknowledged task logging to the step dir, and waitFor sees output printed BEFORE it was called', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, () => ({ out: 'VITE v7\n  ready in 312 ms\n' }))
    const controller = fakeController({ getSnapshot: vi.fn(() => snapshot({ status: 'running' })) })
    const { invocation } = makeInvocation({ tools: [tool], files, controller, readRange: true })
    const { bash } = scriptBash(invocation)
    const srv = (await bash('npx vite --port 5177', { background: true })) as BackgroundHandle
    expect(srv.taskId).toBe('b1')
    expect(dispatched[0]!.command).toContain(`tee '/runs/r1/1/out'`)
    expect(dispatched[0]![HOST_RESULT_ACKNOWLEDGED]).toBeUndefined()
    expect(controller.acknowledgeResult).not.toHaveBeenCalled()

    expect(await srv.waitFor(/ready in \d+/, { timeout: 5_000 })).toBe('  ready in 312 ms')
  })

  it('the pattern is matched in the script worker: no op carries it, and the SharedWorker refuses a `waitFor` op as invalid', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ out: 'ready\n' }))
    const controller = fakeController({ getSnapshot: vi.fn(() => snapshot({ status: 'running' })) })
    const { invocation } = makeInvocation({ tools: [tool], files, controller, readRange: true })
    const { bash, ops } = scriptBash(invocation)
    const srv = (await bash('server', { background: true })) as BackgroundHandle
    expect(await srv.waitFor(/rea(dy)/, { timeout: 5_000 })).toBe('ready')
    expect(ops.map(o => o.op)).toEqual(['run', 'readLines'])
    for (const { payload } of ops) expect(payload).not.toHaveProperty('pattern')

    // The old op, even with a pattern `new RegExp` would throw on, compiles nothing
    // host-side and is `invalid` — not `start_failed`.
    const err = expectError(
      await invocation.handle('waitFor', { taskId: 'b1', pattern: { source: '(', flags: '' }, timeoutMs: 5_000 }),
    )
    expect(err.kind).toBe('invalid')
    // A pattern the script passes wrongly is `invalid` too, before any op.
    const bad = (await srv.waitFor(42 as never).catch(e => e)) as ShellRunFailure
    expect(bad).toBeInstanceOf(ShellRunFailure)
    expect(bad.kind).toBe('invalid')
    expect(ops).toHaveLength(2)
  })

  it('readLines rejects a malformed offset as invalid', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ out: '' }))
    const { invocation } = makeInvocation({ tools: [tool], files })
    await invocation.handle('run', { command: 'server', options: { background: true } })
    expect(expectError(await invocation.handle('readLines', { taskId: 'b1', offset: -1 })).kind).toBe('invalid')
  })

  it('waitFor finds a line far beyond any single read, and follows output that arrives later', async () => {
    const files = new Map<string, string>()
    // Past one 1 MB read: the match sits in the second read.
    const { tool } = fakeBash(files, () => ({ out: 'noise\n'.repeat(200_000) + 'ready\n' }))
    const controller = fakeController({ getSnapshot: vi.fn(() => snapshot({ status: 'running' })) })
    const { invocation } = makeInvocation({ tools: [tool], files, controller, readRange: true })
    const { bash, ops } = scriptBash(invocation)
    const srv = (await bash('server', { background: true })) as BackgroundHandle
    expect(await srv.waitFor('ready', { timeout: 5_000 })).toBe('ready')
    expect(ops.filter(o => o.op === 'readLines').length).toBeGreaterThan(1)

    setTimeout(() => files.set('/runs/r1/1/out', files.get('/runs/r1/1/out')! + 'LATER MARK\n'), 50)
    expect(await srv.waitFor('LATER', { timeout: 5_000 })).toBe('LATER MARK')
  })

  it('waitFor never matches a line still being written; an unterminated last line matches once the task ended', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ out: 'Listening on port 51' }))
    let status: SubAgentSnapshot['status'] = 'running'
    const controller = fakeController({ getSnapshot: vi.fn(() => snapshot({ status })) })
    const { invocation } = makeInvocation({ tools: [tool], files, controller, readRange: true })
    const { bash } = scriptBash(invocation)
    const srv = (await bash('server', { background: true })) as BackgroundHandle

    setTimeout(() => files.set('/runs/r1/1/out', 'Listening on port 51234\n'), 50)
    expect(await srv.waitFor(/port \d+/, { timeout: 5_000 })).toBe('Listening on port 51234')

    files.set('/runs/r1/1/out', 'Listening on port 51234\nshutdown complete')
    status = 'success'
    expect(await srv.waitFor('shutdown', { timeout: 5_000 })).toBe('shutdown complete')
  })

  it('waitFor fails (`failed`, with the exit code) when the task ends before its output matches', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ out: 'Error: port 5177 is in use\n' }))
    const controller = fakeController({ getSnapshot: vi.fn(() => snapshot({ status: 'error', exitCode: 1 })) })
    const { invocation } = makeInvocation({ tools: [tool], files, controller })
    const { bash } = scriptBash(invocation)
    const srv = (await bash('server', { background: true })) as BackgroundHandle
    const err = (await srv.waitFor('ready', { timeout: 5_000 }).catch(e => e)) as ShellRunFailure
    expect(err).toMatchObject({ kind: 'failed', exitCode: 1 })
    expect(err.message).toContain('/runs/r1/1/out')
  })

  it('waitFor times out while the task keeps running; unknown task ids are invalid', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ out: 'starting\n' }))
    const controller = fakeController({ getSnapshot: vi.fn(() => snapshot({ status: 'running' })) })
    const { invocation } = makeInvocation({ tools: [tool], files, controller })
    const { bash } = scriptBash(invocation)
    const srv = (await bash('server', { background: true })) as BackgroundHandle
    expect(((await srv.waitFor('ready', { timeout: 30 }).catch(e => e)) as ShellRunFailure).kind).toBe('timeout')
    expect(expectError(await invocation.handle('stop', { taskId: 'b999' })).kind).toBe('invalid')
    expect(expectError(await invocation.handle('readLines', { taskId: 'b999', offset: 0 })).kind).toBe('invalid')
  })
})

describe('SuperShellInvocation — through the script helpers', () => {
  it('a foreground bash() resolves the capture', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, () => ({ ec: '0', out: 'ok\n', err: '' }))
    const { invocation } = makeInvocation({ tools: [tool], files })
    const { bash } = createShellHelpers((op, payload) => invocation.handle(op, payload))
    expect(((await bash('echo ok')) as BashResult).stdout).toBe('ok\n')
  })
})
