// SuperShellTool — the model-facing tool around the runJs `shell` mode.
//
// `runJs` is mocked so a test plays the worker: it invokes `onShellCall` the way
// a script's `bash()` would, then resolves or rejects like the broker (and
// rejects on its abort signal, as the real broker does). The executor underneath
// (superShellRunner.ts) is REAL, over a fake Bash tool, a fake task controller
// and an in-memory filesystem; the task sink is a recorder; the hook boundary is
// mocked as in exec-tool.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolContract } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { SubAgentController, SubAgentSnapshot } from '../team/subAgentController'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const { runJsMock, isAvailableMock, preHookMock, postHookMock } = vi.hoisted(() => ({
  runJsMock: vi.fn(),
  isAvailableMock: vi.fn(() => true),
  preHookMock: vi.fn(async () => ({ blocked: false, message: '' })),
  postHookMock: vi.fn(async () => ''),
}))

vi.mock('../browser/runJs/RunJsBroker', async importOriginal => ({
  ...(await importOriginal<typeof import('../browser/runJs/RunJsBroker')>()),
  isRunJsAvailable: () => isAvailableMock(),
  runJs: (opts: unknown) => runJsMock(opts),
}))

import { RunJsFailure, type RunJsRunOptions } from '../browser/runJs/RunJsBroker'
import { setSubAgentController } from '../team/subAgentController'
import {
  setSuperShellTaskSink,
  type SuperShellTaskFinish,
  type SuperShellTaskStart,
} from '../backgroundTasks/superShellTaskSink'
import { HOST_SUPER_SHELL_TASK_ID } from '../toolkit/run/backgroundShellSink'
import { _resetBashCwdInterceptorForTests } from '../toolkit/builtin/glic/bashCwdInterceptor'
import {
  CONSOLE_MAX_CHARS,
  findSuperShellToolCallId,
  formatProgress,
  formatSteps,
  RETURN_VALUE_MAX_CHARS,
  STEPS_SHOWN_MAX,
  SUPER_SHELL_TOOL_DESCRIPTION,
  SuperShellTool,
  type SuperShellInput,
} from '../toolkit/builtin/superShell'
import type { ForegroundStepRecord, SuperShellInvocation } from '../toolkit/builtin/superShellRunner'
import { expandGroups } from '../toolkit/builtin/toolGroups'
import {
  parseSuperShellBackgroundStepTaskIds,
  parseSuperShellDetachedTaskId,
} from '../browser/worker/recoverSuperShellRows'

/** A foreground step that exited 0 in the default cwd, unless overridden. */
function step(overrides: Partial<ForegroundStepRecord>): ForegroundStepRecord {
  return {
    kind: 'run',
    command: 'true',
    step: 1,
    cwd: '/p',
    durationMs: 5,
    outcome: 'exited',
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    stdoutPath: '/r/1/out',
    stderrPath: '/r/1/err',
    ...overrides,
  }
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

/** A controller whose tasks finish at once, except those a test holds with a
 *  gate; `stop` releases a held task as stopped. */
function fakeController() {
  const gates = new Map<string, { promise: Promise<void>; release: () => void; stopped: boolean }>()
  const hold = (taskId: string) => {
    let release!: () => void
    const promise = new Promise<void>(resolve => (release = resolve))
    gates.set(taskId, { promise, release, stopped: false })
    return () => release()
  }
  const controller: SubAgentController = {
    getSnapshot: vi.fn(() => snapshot({ status: 'running' })),
    waitForCompletion: vi.fn(async (taskId: string, _ms: number, signal?: AbortSignal) => {
      const gate = gates.get(taskId)
      if (gate) {
        await Promise.race([
          gate.promise,
          new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true })),
        ])
        if (signal?.aborted) gate.stopped = true
        if (gate.stopped) return snapshot({ status: 'stopped', exitCode: null })
      }
      return snapshot()
    }),
    stop: vi.fn((taskId: string) => {
      const gate = gates.get(taskId)
      if (gate) {
        gate.stopped = true
        gate.release()
      }
      return { status: 'stopped' as const }
    }),
    resume: () => ({ ok: false, reason: 'not_found' }),
    list: () => [],
    acknowledgeResult: vi.fn(),
  }
  return { controller, hold }
}

function memoryFs(files: Map<string, string>): RuntimeFs {
  return {
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, data: string) => void files.set(path, data)),
    readFile: vi.fn(async (path: string) => {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    }),
    stat: vi.fn(async (path: string) => {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return { size: v.length, isDirectory: () => false, isFile: () => true, mtimeMs: 0 }
    }),
    unlink: vi.fn(async (path: string) => void files.delete(path)),
  } as unknown as RuntimeFs
}

type Run = { ec: string; out?: string; err?: string }

/** A fake Bash tool that "runs" each wrapper by writing capture files into the
 *  step directory named in it, taking outcomes from `runs` in order. */
function fakeBash(files: Map<string, string>, runs: Run[] = []) {
  const dispatched: Record<string, unknown>[] = []
  const tool = {
    name: 'Bash',
    readsOnly: () => false,
    async selfVerdict() {
      return { behavior: 'allow' as const }
    },
    async call(input: Record<string, unknown>) {
      dispatched.push(input)
      const command = String(input.command)
      const dir = /^__ss_d='([^']+)'/.exec(command)?.[1]
      if (dir) {
        const run = runs[dispatched.length - 1] ?? { ec: '0' }
        files.set(`${dir}/ec`, run.ec)
        files.set(`${dir}/out`, run.out ?? '')
        files.set(`${dir}/err`, run.err ?? '')
      }
      return { data: { task_id: `b${dispatched.length}`, status: 'running' } }
    },
  } as unknown as ToolContract
  return { tool, dispatched }
}

function makeContext(tools: ToolContract[], files: Map<string, string>, extra: Record<string, unknown> = {}): ToolCallContext {
  return {
    options: {
      tools,
      cwd: '/proj',
      projectRoot: '/proj',
      sessionId: 's1',
      fsOperations: memoryFs(files),
      ...extra,
    },
    cancelSource: new AbortController(),
    toolRunSeams: { nested: { preHooks: (...a: unknown[]) => preHookMock(...(a as [])), postHooks: (...a: unknown[]) => postHookMock(...(a as [])) } } as never,
    readAppState: () => ({
      permissionRules: {
        mode: 'default',
        extraWorkspaceRoots: new Map(),
      },
    }),
  } as unknown as ToolCallContext
}

const canUseTool = vi.fn() as unknown as PermissionDecider
const invokingRow = {} as Message

type CallFn = (
  input: Record<string, unknown>,
  context: ToolCallContext,
  canUseTool: PermissionDecider,
  invokingRow: Message,
) => Promise<{ data: string; isError?: boolean }>
const callTool = SuperShellTool.call as unknown as CallFn

/** Play the worker: run `script` against the broker options, then settle. Like
 *  the real broker, abort rejects the run. */
function worker(script: (opts: RunJsRunOptions) => Promise<string | null>) {
  runJsMock.mockImplementation(
    (opts: RunJsRunOptions) =>
      new Promise((resolve, reject) => {
        const onAbort = () => reject(new RunJsFailure('run_js was interrupted.', []))
        if (opts.signal?.aborted) return onAbort()
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        script(opts).then(result => resolve({ result, logs: [] }), reject)
      }),
  )
}

async function run(opts: RunJsRunOptions, command: string, options: Record<string, unknown> = {}) {
  return (await opts.onShellCall!('run', { command, options })) as { result?: Record<string, unknown>; error?: Record<string, unknown> }
}

type Sink = { started: SuperShellTaskStart[]; finished: SuperShellTaskFinish[] }
let sink: Sink
let ctl: ReturnType<typeof fakeController>

beforeEach(() => {
  runJsMock.mockReset()
  isAvailableMock.mockReturnValue(true)
  preHookMock.mockResolvedValue({ blocked: false, message: '' })
  postHookMock.mockResolvedValue('')
  ctl = fakeController()
  setSubAgentController(ctl.controller)
  sink = { started: [], finished: [] }
  let seq = 0
  setSuperShellTaskSink({
    started: start => {
      sink.started.push(start)
      return `s${++seq}`
    },
    finished: finish => void sink.finished.push(finish),
  })
})

afterEach(() => {
  setSubAgentController(null)
  setSuperShellTaskSink(null)
  _resetBashCwdInterceptorForTests()
})

describe('SuperShellTool — contract', () => {
  it('is the `supershell` group and describes the bash() contract', () => {
    expect([...expandGroups(['supershell'])]).toEqual(['SuperShell'])
    for (const needle of [
      'bash(',
      'nothrow',
      'truncated',
      "kind 'timeout' | 'cancelled' | 'denied' | 'start_failed' | 'invalid' — ALWAYS",
      'background: true',
      'waitFor',
      'finally',
      'Nothing carries between calls',
      'waitSec',
      'TaskOutput',
      // Orchestration: batch what code can decide, return control for judgment.
      'Batch related steps in one script',
      'not one SuperShell call per command',
      'Return control when the next step needs your judgment',
      'instead of starting the command with `cd dir &&`',
      // Output: the script returns it; the result reports execution, capped.
      'Command output goes to your script, not into the result',
      'Return what the next decision needs',
      'A script that completes normally needs no return value',
      "every command's complete output is kept, by step number",
      '40,000 characters',
    ]) {
      expect(SUPER_SHELL_TOOL_DESCRIPTION, needle).toContain(needle)
    }
    expect(SuperShellTool.argsSchema?.required).toEqual(['code', 'inputs'])
  })

  it('validateInput requires code and a plain-object inputs', async () => {
    const validate = SuperShellTool.checkInput!.bind(SuperShellTool) as (i: unknown) => Promise<{ result: boolean }>
    expect((await validate({ code: '', inputs: {} })).result).toBe(false)
    expect((await validate({ code: 'x', inputs: [] })).result).toBe(false)
    expect((await validate({ code: 'x', inputs: {}, waitSec: 'soon' })).result).toBe(false)
    expect((await validate({ code: 'return 1', inputs: {} })).result).toBe(true)
  })

  it('formatSteps says so when the script ran no commands', () => {
    expect(formatSteps([], '/p')).toBe('No commands were run.')
  })

  it('formatSteps carries a rounded-up second into the minute (never `1m60s` / `60.0s`)', () => {
    const line = (durationMs: number) =>
      formatSteps([step({ durationMs })], '/p').split('\n')[1]
    expect(line(119_600)).toBe('✓ true  exit 0  2m0s  #1')
    expect(line(59_960)).toBe('✓ true  exit 0  1m0s  #1')
    expect(line(61_400)).toBe('✓ true  exit 0  1m1s  #1')
    expect(line(12_340)).toBe('✓ true  exit 0  12.3s  #1')
  })

  it('formatSteps records execution only: no command output, succeeded or failed', () => {
    const text = formatSteps(
      [
        step({ command: 'git status --short', stdout: ' M a.ts\n', stderr: 'warning: CRLF\n' }),
        step({ command: 'npx tsc', exitCode: 2, stdout: 'src/a.ts: error TS2304\n' }),
        step({ command: 'git log -1', stdout: 'x'.repeat(100), truncated: true }),
      ],
      '/p',
    )
    expect(text).toBe(
      [
        'Steps: 1 of 3 did not exit 0',
        '✓ git status --short  exit 0  5ms  #1',
        '✗ npx tsc  exit 2  5ms  #1',
        '    full output: /r/1/out (stdout), /r/1/err (stderr)',
        '✓ git log -1  exit 0  5ms  #1',
        '    full output: /r/1/out (stdout), /r/1/err (stderr)',
        '    (the script saw only the last 8 MB of this output; the log files are complete)',
      ].join('\n'),
    )
  })

  it('formatSteps heading: the shared directory once, and every command that did not exit 0', () => {
    const wt = '/p/.velloc/worktrees/fix'
    const shared = formatSteps(
      [
        step({ command: 'git diff --check', cwd: wt }),
        { kind: 'background', command: 'npx vite', cwd: wt, taskId: 'b2', logPath: '/r/2/out' },
        step({ command: 'npx vitest run', cwd: wt, outcome: 'timeout', exitCode: null }),
        { kind: 'notRun', command: 'npx tsc', reason: 'the invocation was stopped' },
      ],
      '/p',
    )
    expect(shared).toBe(
      [
        `Steps: all in ${wt}; 2 of 3 did not exit 0`,
        '✓ git diff --check  exit 0  5ms  #1',
        '▶ npx vite  background task b2',
        '    output log: /r/2/out',
        '✗ npx vitest run  timeout  5ms  #1',
        '    full output: /r/1/out (stdout), /r/1/err (stderr)',
        '✗ npx tsc  not run: the invocation was stopped',
      ].join('\n'),
    )
    // The same directory written two ways (the gates resolve it, the default is
    // the live cwd as written) is the default, not a directory to name.
    expect(
      formatSteps([step({ command: 'pwd', cwd: 'D:\\work\\repo' })], 'D:/Work/repo/'),
    ).toBe('Steps:\n✓ pwd  exit 0  5ms  #1')
    // Mixed directories: each step away from the default says where it ran.
    expect(formatSteps([step({ command: 'pwd' }), step({ command: 'ls', cwd: wt })], '/p')).toBe(
      `Steps:\n✓ pwd  exit 0  5ms  #1\n✓ ls  exit 0  5ms  (in ${wt})  #1`,
    )
  })

  it('formatSteps ends with where every command\'s complete output is kept, by step number', () => {
    const text = formatSteps(
      [step({ command: 'git status --short', step: 1 }), step({ command: 'npx tsc', step: 2 })],
      '/p',
      { runDir: '/runs/r1' },
    )
    expect(text).toBe(
      [
        'Steps:',
        '✓ git status --short  exit 0  5ms  #1',
        '✓ npx tsc  exit 0  5ms  #2',
        "Every command's complete output: /runs/r1/<#>/out (stdout) and err (stderr), where <#> is its step number.",
      ].join('\n'),
    )
    // No foreground step, no pointer.
    expect(formatSteps([{ kind: 'notRun', command: 'cd x', reason: 'r' }], '/p', { runDir: '/runs/r1' })).not.toContain(
      'complete output',
    )
  })

  it('formatSteps lists the first and last steps of a long run; the heading still counts them all', () => {
    const steps = Array.from({ length: STEPS_SHOWN_MAX + 1 }, (_, i) =>
      step({ command: `echo ${i + 1}`, step: i + 1, exitCode: i === 30 ? 1 : 0 }),
    )
    const lines = formatSteps(steps, '/p', { omittedNote: ' (the whole record is in /runs/r1/steps.txt)' }).split('\n')
    expect(lines[0]).toBe(`Steps: 1 of ${STEPS_SHOWN_MAX + 1} did not exit 0`)
    expect(lines).toContain('✓ echo 25  exit 0  5ms  #25')
    expect(lines.some(l => l.startsWith('✓ echo 26 '))).toBe(false)
    expect(lines).toContain(`… ${STEPS_SHOWN_MAX + 1 - 50} more steps not shown (the whole record is in /runs/r1/steps.txt) …`)
    expect(lines.some(l => l.startsWith('✗ echo 31 '))).toBe(false)
    expect(lines.at(-1)).toBe(`✓ echo ${STEPS_SHOWN_MAX + 1}  exit 0  5ms  #${STEPS_SHOWN_MAX + 1}`)
    expect(formatSteps(steps, '/p', { showAll: true })).toContain('✗ echo 31  exit 1  5ms  #31')
  })

  it('progress counts finished commands only, and lists at most 20 running ones', () => {
    const invocation = {
      steps: [step({ command: 'npx tsc', exitCode: 2 })],
      runningCommands: Array.from({ length: 25 }, (_, i) => `job ${i + 1}`),
      defaultCwd: '/p',
      runDir: '/runs/r1',
    }
    const text = formatProgress(invocation as unknown as SuperShellInvocation)
    expect(text).toMatch(/^Steps: 1 of 1 did not exit 0$/m)
    expect(text).toContain('  ▶ job 20\n  ▶ … and 5 more')
    expect(text).not.toContain('job 21')
  })

  it('progress with a command running and none finished does not claim no commands were run', () => {
    const invocation = { steps: [], runningCommands: ['npx vitest run'], defaultCwd: '/p' }
    expect(formatProgress(invocation as unknown as SuperShellInvocation)).toBe(
      'No command has finished yet.\n\nRunning now:\n  ▶ npx vitest run',
    )
  })
})

describe('SuperShellTool — refusals', () => {
  it('refuses in an untrusted-provider session without running anything', async () => {
    const files = new Map<string, string>()
    const res = await callTool({ code: 'x', inputs: {} }, makeContext([fakeBash(files).tool], files, { untrustedReadRoot: '/proj' }), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(runJsMock).not.toHaveBeenCalled()
  })

  it('refuses when the session has no Bash tool', async () => {
    const res = await callTool({ code: 'x', inputs: {} }, makeContext([], new Map()), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/Bash tool/)
  })
})

describe('SuperShellTool — inline runs', () => {
  it('finishes inline: result first, each step listed, task finished without delivery', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, [{ ec: '0', out: ' M a.ts\n' }, { ec: '2', out: 'src/a.ts: error TS2304\n' }])
    worker(async opts => {
      expect(opts.mode).toBe('shell')
      const status = await run(opts, 'git status --short')
      const tsc = await run(opts, 'npx tsc --noEmit')
      return JSON.stringify({ changed: (status.result!.stdout as string).trim(), tsc: tsc.result!.exitCode })
    })
    const res = await callTool({ code: '…', inputs: {}, description: 'Check' }, makeContext([tool], files), canUseTool, invokingRow)
    expect(res.isError).toBeUndefined()
    expect(res.data).toContain('{"changed":"M a.ts","tsc":2}')
    expect(res.data).toMatch(/✓ git status --short {2}exit 0/)
    expect(res.data).toMatch(/✗ npx tsc --noEmit {2}exit 2/)
    // The commands' output reached the script, which returned what it needed;
    // the result does not quote it again.
    expect(res.data).not.toContain('error TS2304')
    expect(res.data).toMatch(/^Steps: 1 of 2 did not exit 0$/m)
    expect(sink.started).toHaveLength(1)
    expect(sink.started[0]).toMatchObject({ description: 'Check', spawnerSessionId: 's1' })
    expect(sink.finished).toMatchObject([{ taskId: 's1', status: 'success', deliver: false }])
  })

  it('a return value or console past its cap is cut with a marker, the full text saved in the run directory', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    const big = `${'r'.repeat(RETURN_VALUE_MAX_CHARS)}RETURN_TAIL`
    const chatty = `${'c'.repeat(CONSOLE_MAX_CHARS)}CONSOLE_TAIL`
    runJsMock.mockImplementation(async () => ({ result: big, logs: [{ level: 'log', text: chatty }] }))
    const res = await callTool({ code: '…', inputs: {} }, makeContext([tool], files), canUseTool, invokingRow)
    const saved = (name: string) => [...files.entries()].find(([path]) => path.endsWith(`/${name}`))
    expect(saved('result.txt')?.[1]).toBe(big)
    expect(saved('console.txt')?.[1]).toBe(`[log] ${chatty}`)
    expect(res.data).not.toContain('RETURN_TAIL')
    expect(res.data).not.toContain('CONSOLE_TAIL')
    expect(res.data).toContain(
      `[cut at ${RETURN_VALUE_MAX_CHARS} of ${big.length} characters; the full return value is in ${saved('result.txt')![0]}]`,
    )
    expect(res.data).toContain(`the full console output is in ${saved('console.txt')![0]}]`)
    expect(res.data.length).toBeLessThan(RETURN_VALUE_MAX_CHARS + CONSOLE_MAX_CHARS + 1_000)
  })

  it('a script error past the cap is cut the same way', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    const huge = `${'e'.repeat(RETURN_VALUE_MAX_CHARS)}ERROR_TAIL`
    runJsMock.mockImplementation(async () => {
      throw new RunJsFailure(huge, [])
    })
    const res = await callTool({ code: '…', inputs: {} }, makeContext([tool], files), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/^SuperShell error: e+\n\[cut at 40000 of 40010 characters; the full error message is in .*error\.txt\]/)
    expect([...files.values()]).toContain(huge)
  })

  it('a save that fails says so and names no file', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    const context = makeContext([tool], files)
    const fs = context.options.fsOperations as unknown as { writeFile: ReturnType<typeof vi.fn> }
    fs.writeFile.mockImplementation(async (path: string, data: string) => {
      if (path.endsWith('result.txt')) throw new Error('ENOSPC: no space left on device')
      files.set(path, data)
    })
    runJsMock.mockImplementation(async () => ({ result: 'r'.repeat(RETURN_VALUE_MAX_CHARS + 5), logs: [] }))
    const res = await callTool({ code: '…', inputs: {} }, context, canUseTool, invokingRow)
    expect(res.data).toContain(
      `[cut at ${RETURN_VALUE_MAX_CHARS} of ${RETURN_VALUE_MAX_CHARS + 5} characters; saving the full return value failed: ENOSPC: no space left on device]`,
    )
    expect(res.data).not.toContain('result.txt')
  })

  it('completing without a return value is a plain success: the record, no command output', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, [{ ec: '0', out: 'SECRET_STDOUT\n', err: 'SECRET_STDERR\n' }])
    worker(async opts => {
      await run(opts, 'git diff --check')
      return null
    })
    const res = await callTool({ code: '…', inputs: {} }, makeContext([tool], files), canUseTool, invokingRow)
    expect(res.isError).toBeUndefined()
    expect(res.data).toMatch(/^\(no return value\)\n\nSteps:\n✓ git diff --check {2}exit 0 {2}\S+ {2}#1\nEvery command's complete output: /)
    expect(res.data).not.toContain('SECRET_STD')
    expect(sink.finished).toMatchObject([{ status: 'success' }])
  })

  it('a long run saves its whole record and the result lists its ends', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    worker(async opts => {
      for (let i = 1; i <= STEPS_SHOWN_MAX + 5; i++) await run(opts, `echo ${i}`)
      return 'done'
    })
    const res = await callTool({ code: '…', inputs: {} }, makeContext([tool], files), canUseTool, invokingRow)
    const [recordPath, record] = [...files.entries()].find(([path]) => path.endsWith('/steps.txt'))!
    expect(record).toContain('✓ echo 40  exit 0')
    expect(record).not.toContain('more steps not shown')
    expect(res.data).not.toContain('✓ echo 40  exit 0')
    expect(res.data).toContain(`… 15 more steps not shown (the whole record is in ${recordPath}) …`)
  })

  it('a script that returns while a command still runs is NOT a success: the command is cancelled', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    ctl.hold('b1')
    worker(async opts => {
      void opts.onShellCall!('run', { command: 'npx vitest run', options: {} }) // forgot await
      await vi.waitFor(() => expect(ctl.controller.waitForCompletion).toHaveBeenCalled())
      return '{"passed":true}'
    })
    const res = await callTool({ code: '…', inputs: {} }, makeContext([tool], files), canUseTool, invokingRow)
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/^SuperShell did not complete/)
    expect(res.data).toContain('npx vitest run')
    expect(res.data).toContain('{"passed":true}')
    expect(ctl.controller.stop).toHaveBeenCalledWith('b1')
    expect(sink.finished).toMatchObject([{ status: 'error', deliver: false }])
  })

  it('a turn interrupt while inline stops the script and rejects the call', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    ctl.hold('b1')
    const context = makeContext([tool], files)
    worker(async opts => {
      await run(opts, 'npm run build')
      return 'unreachable'
    })
    const call = callTool({ code: '…', inputs: {}, waitSec: 60 }, context, canUseTool, invokingRow)
    await vi.waitFor(() => expect(ctl.controller.waitForCompletion).toHaveBeenCalled())
    context.cancelSource!.abort()
    await expect(call).rejects.toThrow(/interrupted/)
    await vi.waitFor(() => expect(sink.finished).toMatchObject([{ status: 'stopped', deliver: false }]))
  })

  it('a Stop from the drawer while inline reports what ran instead of rejecting the call', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    ctl.hold('b1')
    const context = makeContext([tool], files)
    worker(async opts => {
      await run(opts, 'npm run build')
      return 'unreachable'
    })
    const call = callTool({ code: '…', inputs: {}, waitSec: 60 }, context, canUseTool, invokingRow)
    await vi.waitFor(() => expect(ctl.controller.waitForCompletion).toHaveBeenCalled())
    // The drawer / TaskStop path: the task's own stop, not the turn's interrupt.
    sink.started[0]!.stop()
    const res = await call
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/SuperShell was stopped/)
    expect(res.data).toMatch(/npm run build/)
    expect(context.cancelSource!.signal.aborted).toBe(false)
  })

  it('progress before any command has started says so, rather than "no commands were run"', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    worker(async () => {
      await gate
      return 'late'
    })
    const res = await callTool({ code: '…', inputs: {}, waitSec: 1 }, makeContext([tool], files), canUseTool, invokingRow)
    expect(res.data).toContain('Progress so far:\nNo command has started yet.')
    release()
    await vi.waitFor(() => expect(sink.finished).toHaveLength(1))
  })

  it('without task tracking (no sink) the run stays inline', async () => {
    setSuperShellTaskSink(null)
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, [{ ec: '0', out: 'ok\n' }])
    worker(async opts => ((await run(opts, 'echo ok')).result!.stdout as string).trim())
    const res = await callTool({ code: '…', inputs: {}, waitSec: 1 }, makeContext([tool], files), canUseTool, invokingRow)
    expect(res.data).toMatch(/^ok/)
  })
})

describe('SuperShellTool — its identity in the Background Tasks drawer', () => {
  /** The assistant message that issued the call(s), in the persisted shape. */
  function issuing(...calls: Array<{ id: string; input: Record<string, unknown> }>): Message {
    return {
      message: {
        content: calls.map(c => ({ type: 'tool_use', id: c.id, name: 'SuperShell', input: c.input })),
      },
    } as unknown as Message
  }

  it('registers its tool call id, and every step it runs carries its task id to the step’s shell task', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files)
    worker(async opts => {
      await run(opts, 'git status --short')
      await run(opts, 'npx vite --port 5177', { background: true })
      return 'ok'
    })
    const input = { code: '…', inputs: {}, description: 'Check' }
    const res = await callTool(input, makeContext([tool], files), canUseTool, issuing({ id: 'toolu_ss', input }))
    expect(res.isError).toBeUndefined()
    expect(sink.started).toMatchObject([{ toolCallId: 'toolu_ss', description: 'Check' }])
    // Foreground and background steps alike: the drawer lists them under this
    // invocation (task `s1`), not under Shell.
    expect(dispatched).toHaveLength(2)
    expect(
      dispatched.map(step => (step as Record<symbol, unknown>)[HOST_SUPER_SHELL_TASK_ID]),
    ).toEqual(['s1', 's1'])
  })

  it('without task tracking there is no task id to carry', async () => {
    setSuperShellTaskSink(null)
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files, [{ ec: '0', out: 'ok\n' }])
    worker(async opts => ((await run(opts, 'echo ok')).result!.stdout as string).trim())
    const input = { code: '…', inputs: {} }
    await callTool(input, makeContext([tool], files), canUseTool, issuing({ id: 'toolu_x', input }))
    expect((dispatched[0] as Record<symbol, unknown>)[HOST_SUPER_SHELL_TASK_ID]).toBeUndefined()
  })

  it('resolves the id by args when one message issues several SuperShell calls, and gives none it cannot match', () => {
    const code = 'return inputs.v'
    // Strict-mode calls send unset optionals as explicit nulls — on both sides.
    const inputA = { code, inputs: { v: 'a' }, description: null, timeoutSec: null, waitSec: null } as unknown as SuperShellInput
    const inputB = { code, inputs: { v: 'b' }, description: null, timeoutSec: null, waitSec: null } as unknown as SuperShellInput
    const both = issuing({ id: 'toolu_A', input: inputA }, { id: 'toolu_B', input: inputB })
    // Identical code and scalars — only `inputs` tells the two calls apart.
    expect(findSuperShellToolCallId(both, inputB)).toBe('toolu_B')
    expect(findSuperShellToolCallId(both, inputA)).toBe('toolu_A')
    // The same script issued twice: each invocation gets its own call id.
    const twice = issuing({ id: 'toolu_T1', input: inputA }, { id: 'toolu_T2', input: inputA })
    expect(findSuperShellToolCallId(twice, inputA)).toBe('toolu_T1')
    expect(findSuperShellToolCallId(twice, inputA)).toBe('toolu_T2')
    expect(findSuperShellToolCallId(twice, inputA)).toBe('')
    // A hook rewrote the input: no guess that could give two runs one row.
    expect(findSuperShellToolCallId(both, { ...inputA, code: 'rewritten' })).toBe('')
    // A lone call is taken directly, even when its input was rewritten.
    expect(findSuperShellToolCallId(issuing({ id: 'toolu_1', input: inputA }), { code: 'rewritten' })).toBe('toolu_1')
    // Not an assistant message, or no SuperShell call in it.
    expect(findSuperShellToolCallId({} as Message, inputA)).toBe('')
    expect(
      findSuperShellToolCallId(
        { message: { content: [{ type: 'tool_use', id: 'toolu_e', name: 'SuperEdit', input: inputA }] } } as unknown as Message,
        inputA,
      ),
    ).toBe('')
  })
})

describe('SuperShellTool — continuing in the background', () => {
  it('a detached run delivers the same capped result the inline path would', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    const release = ctl.hold('b1')
    worker(async opts => {
      await run(opts, 'npm run build')
      return `${'r'.repeat(RETURN_VALUE_MAX_CHARS)}DETACHED_TAIL`
    })
    const res = await callTool({ code: '…', inputs: {}, waitSec: 1 }, makeContext([tool], files), canUseTool, invokingRow)
    expect(res.data).toMatch(/continues in the background with ID: s1/)
    release()
    await vi.waitFor(() => expect(sink.finished).toHaveLength(1))
    const delivered = sink.finished[0]!.resultText
    expect(delivered).not.toContain('DETACHED_TAIL')
    expect(delivered).toMatch(/\[cut at 40000 of 40013 characters; the full return value is in .*result\.txt\]/)
    expect(sink.finished[0]).toMatchObject({ status: 'success', deliver: true })
  })

  it('A outlasts the wait → task id returned → A finishes → B runs exactly once → result delivered', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files)
    const releaseA = ctl.hold('b1')
    const context = makeContext([tool], files)
    worker(async opts => {
      await run(opts, 'ninja -C out/Default browser_tests')
      await run(opts, 'out/Default/browser_tests')
      return JSON.stringify({ done: true })
    })

    const res = await callTool({ code: '…', inputs: {}, waitSec: 1 }, context, canUseTool, invokingRow)
    expect(res.isError).toBeUndefined()
    expect(res.data).toMatch(/^SuperShell is still running after 1s and continues in the background with ID: s1\./)
    expect(res.data).toContain('▶ ninja -C out/Default browser_tests')
    expect(sink.finished).toEqual([])
    expect(dispatched).toHaveLength(1)

    // Progress is readable while it runs (what TaskOutput shows).
    expect(sink.started[0]!.progress()).toContain('ninja -C out/Default browser_tests')

    // The turn ends; a later interrupt of THAT turn's signal must not stop it.
    context.cancelSource!.abort()

    releaseA()
    await vi.waitFor(() => expect(sink.finished).toHaveLength(1))
    expect(dispatched).toHaveLength(2)
    expect(String(dispatched[1]!.command)).toContain("eval 'out/Default/browser_tests'")
    expect(sink.finished[0]).toMatchObject({ taskId: 's1', status: 'success', deliver: true })
    expect(sink.finished[0]!.resultText).toContain('{"done":true}')
  })

  it('TaskStop after detach stops the script, its running command, and its background processes', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files)
    ctl.hold('b2')
    worker(async opts => {
      await run(opts, 'npx vite --port 5177', { background: true })
      await run(opts, 'npx playwright test')
      return 'unreachable'
    })
    const res = await callTool({ code: '…', inputs: {}, waitSec: 1 }, makeContext([tool], files), canUseTool, invokingRow)
    expect(res.data).toMatch(/continues in the background with ID: s1/)

    sink.started[0]!.stop()
    await vi.waitFor(() => expect(sink.finished).toHaveLength(1))
    expect(sink.finished[0]).toMatchObject({ status: 'stopped' })
    expect(ctl.controller.stop).toHaveBeenCalledWith('b1') // the background server
    expect(ctl.controller.stop).toHaveBeenCalledWith('b2') // the running command
    expect(dispatched).toHaveLength(2)
  })

  it('disposing the runtime scope under a detached run stops it: script, running command, background processes', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files)
    ctl.hold('b2')
    const scope = new AbortController()
    let third: { error?: Record<string, unknown> } | undefined
    worker(async opts => {
      await run(opts, 'npx vite --port 5177', { background: true })
      await run(opts, 'npx playwright test').catch(() => undefined)
      third = await run(opts, 'echo after')
      return 'unreachable'
    })
    const context = makeContext([tool], files, { runtimeScopeSignal: scope.signal })
    const res = await callTool({ code: '…', inputs: {}, waitSec: 1 }, context, canUseTool, invokingRow)
    expect(res.data).toMatch(/continues in the background with ID: s1/)

    // Reinit / session close / sub-agent reaped: the scope's permission queue
    // and transport are gone for good.
    scope.abort('reinitialize')
    await vi.waitFor(() => expect(sink.finished).toHaveLength(1))
    expect(sink.finished[0]).toMatchObject({ status: 'stopped', deliver: true })
    expect(sink.finished[0]!.resultText).toContain('closed or reloaded')
    expect(ctl.controller.stop).toHaveBeenCalledWith('b1') // the background server
    expect(ctl.controller.stop).toHaveBeenCalledWith('b2') // the running command
    expect(dispatched).toHaveLength(2) // nothing more was launched through the dead scope
    expect(third === undefined || third.error?.kind === 'cancelled').toBe(true)
  })

  it('a scope already disposed refuses to start', async () => {
    const files = new Map<string, string>()
    const scope = new AbortController()
    scope.abort()
    const res = await callTool(
      { code: 'x', inputs: {} },
      makeContext([fakeBash(files).tool], files, { runtimeScopeSignal: scope.signal }),
      canUseTool,
      invokingRow,
    )
    expect(res.isError).toBe(true)
    expect(runJsMock).not.toHaveBeenCalled()
    expect(sink.started).toHaveLength(0)
  })

  it.each([
    ['a worker-hosted background sub-agent', { sessionId: 'subagent-abc' }, {}],
    ['a headless routine run', { isHeadless: true }, {}],
    ['an in-process fork', {}, { agentId: 'fork-1' }],
  ])('in %s it never detaches: the call waits for the script to finish', async (_label, options, top) => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files, [{ ec: '0', out: 'built\n' }])
    const releaseA = ctl.hold('b1')
    const context = Object.assign(makeContext([tool], files, options), top)
    worker(async opts => ((await run(opts, 'make')).result!.stdout as string).trim())
    const call = callTool({ code: '…', inputs: {}, waitSec: 1 }, context, canUseTool, invokingRow)
    // Past the 1 s wait, the call is still pending instead of returning a task id.
    await new Promise(resolve => setTimeout(resolve, 1_300))
    expect(sink.finished).toEqual([])
    releaseA()
    const res = await call
    expect(res.data).toMatch(/^built/)
    expect(res.data).not.toContain('continues in the background')
    expect(sink.finished).toMatchObject([{ status: 'success', deliver: false }])
  })

  it('a command whose permission answer arrives after the stop never starts', async () => {
    const files = new Map<string, string>()
    const { tool, dispatched } = fakeBash(files)
    let answerHook!: () => void
    preHookMock.mockImplementation(
      () => new Promise(resolve => (answerHook = () => resolve({ blocked: false, message: '' }))),
    )
    let second: { error?: Record<string, unknown> } | undefined
    worker(async opts => {
      second = await run(opts, 'git push')
      return 'after'
    })
    const res = await callTool({ code: '…', inputs: {}, waitSec: 1 }, makeContext([tool], files), canUseTool, invokingRow)
    expect(res.data).toMatch(/continues in the background/)
    sink.started[0]!.stop()
    answerHook()
    await vi.waitFor(() => expect(sink.finished).toHaveLength(1))
    expect(dispatched).toHaveLength(0)
    expect(second === undefined || second.error?.kind === 'cancelled').toBe(true)
  })
})

// Restart recovery (browser/worker/recoverSuperShellRows.ts) reads a run back
// from the result its call persisted: pinned here against the real text.
describe('SuperShellTool — the result restart recovery reads back', () => {
  it('a detached call names the task id its run continues under; the run’s own result does not', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    const releaseA = ctl.hold('b1')
    worker(async opts => {
      await run(opts, 'npm run build')
      return 'built'
    })
    const res = await callTool({ code: '…', inputs: {}, waitSec: 1 }, makeContext([tool], files), canUseTool, invokingRow)
    expect(parseSuperShellDetachedTaskId(res.data)).toBe('s1')
    releaseA()
    await vi.waitFor(() => expect(sink.finished).toHaveLength(1))
    expect(parseSuperShellDetachedTaskId(sink.finished[0]!.resultText)).toBeNull()
  })

  it('the step list names every background step by its task id', async () => {
    const files = new Map<string, string>()
    const { tool } = fakeBash(files)
    worker(async opts => {
      await run(opts, 'git status --short')
      await run(opts, 'npx vite --port 5177', { background: true })
      await run(opts, 'tail -f server.log', { background: true, cwd: 'logs' })
      return 'ok'
    })
    const res = await callTool({ code: '…', inputs: {} }, makeContext([tool], files), canUseTool, invokingRow)
    expect(parseSuperShellDetachedTaskId(res.data)).toBeNull()
    expect(parseSuperShellBackgroundStepTaskIds(res.data)).toEqual(['b2', 'b3'])
  })
})
