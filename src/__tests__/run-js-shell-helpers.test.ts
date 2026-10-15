import { describe, expect, it, vi } from 'vitest'
import {
  createShellHelpers,
  ERROR_TAIL_MAX_CHARS,
  oneLineCommand,
  ShellRunFailure,
  type BackgroundHandle,
  type BashResult,
} from '../browser/runJs/shellHelpers'

// SuperShell's worker-side `bash()` — the contract the model writes against.
// The broker round-trip is faked with a recording callShell that answers with
// the `{ result } | { error }` records the host sends.

function helpers(reply: (op: string, payload: Record<string, unknown>) => unknown) {
  const callShell = vi.fn(async (op: string, payload: Record<string, unknown>) => reply(op, payload))
  return { bash: createShellHelpers(callShell as never).bash, callShell }
}

const ok = (result: Record<string, unknown>) => ({ result })
const fail = (error: Record<string, unknown>) => ({
  error: { exitCode: null, stdout: '', stderr: '', truncated: false, ...error },
})

describe('bash() — results', () => {
  it('resolves { stdout, stderr, exitCode, truncated } and forwards cwd/stdin/timeout', async () => {
    const { bash, callShell } = helpers(() => ok({ stdout: 'hi\n', stderr: '', exitCode: 0, truncated: false }))
    const r = (await bash('echo hi', { cwd: 'nexus_web', stdin: 'in', timeout: 5_000 })) as BashResult
    expect(r).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0, truncated: false })
    expect(callShell).toHaveBeenCalledWith('run', {
      command: 'echo hi',
      options: { cwd: 'nexus_web', stdin: 'in', timeoutMs: 5_000 },
    })
  })

  it('carries truncated: true through to the script', async () => {
    const { bash } = helpers(() => ok({ stdout: 'tail', stderr: '', exitCode: 0, truncated: true }))
    expect(((await bash('ninja')) as BashResult).truncated).toBe(true)
  })

  it('a non-zero exit throws ShellRunFailure kind `failed` with the real exit code and a tail', async () => {
    const { bash } = helpers(() => ok({ stdout: 'building\n', stderr: 'error TS2304: x\n', exitCode: 2, truncated: false }))
    const err = (await bash('npx tsc --noEmit').catch(e => e)) as ShellRunFailure
    expect(err).toBeInstanceOf(ShellRunFailure)
    expect(err).toMatchObject({ name: 'ShellError', kind: 'failed', exitCode: 2, stdout: 'building\n', truncated: false })
    expect(err.message).toBe('Command failed (exit 2): npx tsc --noEmit\nerror TS2304: x')
  })

  it('nothrow resolves a non-zero exit instead of throwing', async () => {
    const { bash } = helpers(() => ok({ stdout: '', stderr: '', exitCode: 1, truncated: false }))
    await expect(bash('grep missing file', { nothrow: true })).resolves.toMatchObject({ exitCode: 1 })
  })

  it('timeout / cancelled / denied / start_failed / invalid ALWAYS throw — nothrow does not apply', async () => {
    for (const kind of ['cancelled', 'denied', 'start_failed', 'invalid']) {
      const { bash } = helpers(() => fail({ kind, message: `${kind} happened`, stdout: 'partial' }))
      const err = (await bash('x', { nothrow: true }).catch(e => e)) as ShellRunFailure
      expect(err, kind).toBeInstanceOf(ShellRunFailure)
      expect(err).toMatchObject({ kind, exitCode: null, stdout: 'partial', message: `${kind} happened` })
    }
    // A timeout's message also quotes where the command had got to — the result
    // carries no command output, so for an uncaught one this is all there is.
    const { bash } = helpers(() => fail({ kind: 'timeout', message: 'Command timed out after 5s: ninja', stdout: 'partial' }))
    const err = (await bash('ninja', { nothrow: true }).catch(e => e)) as ShellRunFailure
    expect(err).toMatchObject({ kind: 'timeout', stdout: 'partial', message: 'Command timed out after 5s: ninja\npartial' })
  })

  it('an error message is bounded: the tail by characters as well as lines, the command to one short line', async () => {
    // One 50 000-character line (minified output): the message keeps its end.
    const minified = 'x'.repeat(50_000) + 'END'
    const oneLine = helpers(() => ok({ stdout: minified, stderr: '', exitCode: 1, truncated: false }))
    const err = (await oneLine.bash('node build.js').catch(e => e)) as ShellRunFailure
    expect(err.message).toBe(`Command failed (exit 1): node build.js\n...${minified.slice(-ERROR_TAIL_MAX_CHARS)}`)
    expect(err.stdout).toBe(minified)
    // Several long lines: a line the cap cuts into is dropped whole.
    const lines = Array.from({ length: 5 }, (_, i) => `${i}${'y'.repeat(799)}`).join('\n')
    const many = helpers(() => ok({ stdout: lines, stderr: '', exitCode: 1, truncated: false }))
    const tail = ((await many.bash('make').catch(e => e)) as ShellRunFailure).message.split('\n').slice(1)
    expect(tail.map(l => l[0])).toEqual(['3', '4'])
    // A long, multi-line command is named on one line, shortened.
    const script = `python -c '\n${'print(1)\n'.repeat(100)}'`
    const long = helpers(() => ok({ stdout: '', stderr: '', exitCode: 2, truncated: false }))
    const head = ((await long.bash(script).catch(e => e)) as ShellRunFailure).message
    expect(head).toBe(`Command failed (exit 2): ${oneLineCommand(script)}`)
    expect(oneLineCommand(script)).toHaveLength(160)
    expect(oneLineCommand(script).endsWith('...')).toBe(true)
  })

  it('error messages quote output without terminal escapes; the error keeps the bytes', async () => {
    const colored = '\x1b[31mFAIL\x1b[39m src/a.test.ts\n'
    const failed = helpers(() => ok({ stdout: colored, stderr: '\x1b[0m', exitCode: 1, truncated: false }))
    const err = (await failed.bash('npx vitest run').catch(e => e)) as ShellRunFailure
    expect(err.message).toBe('Command failed (exit 1): npx vitest run\nFAIL src/a.test.ts')
    expect(err.stdout).toBe(colored)
    const timedOut = helpers(() => fail({ kind: 'timeout', message: 'Command timed out after 5s: x', stderr: '\x1b[2mwaiting\x1b[22m' }))
    expect(((await timedOut.bash('x').catch(e => e)) as ShellRunFailure).message).toBe('Command timed out after 5s: x\nwaiting')
  })

  it('rejects bad arguments before any round-trip', async () => {
    const { bash, callShell } = helpers(() => ok({}))
    await expect(bash('')).rejects.toThrow(TypeError)
    await expect(bash('ls', { timeout: -1 })).rejects.toThrow(/timeout/)
    await expect(bash('ls', { stdin: 3 as never })).rejects.toThrow(/stdin/)
    await expect(bash('ls', { cwd: '' })).rejects.toThrow(/cwd/)
    expect(callShell).not.toHaveBeenCalled()
  })
})

describe('bash() — background handle', () => {
  const chunk = (lines: string[], offset: number, extra: Record<string, unknown> = {}) =>
    ok({ lines, offset, ended: false, status: 'running', exitCode: null, logPath: '/log/out', ...extra })

  it('returns { taskId, waitFor, stop }; waitFor matches in THIS worker — the pattern never crosses to the host', async () => {
    const pages = [chunk(['VITE v7', 'booting'], 14), chunk(['  READY in 312 ms', 'later'], 40)]
    const { bash, callShell } = helpers(op => {
      if (op === 'run') return ok({ taskId: 'b42' })
      if (op === 'readLines') return pages.shift() ?? chunk([], 40)
      return ok(null as never)
    })
    const h = (await bash('npx vite', { background: true, cwd: 'web' })) as BackgroundHandle
    expect(h.taskId).toBe('b42')
    expect(callShell).toHaveBeenCalledWith('run', { command: 'npx vite', options: { background: true, cwd: 'web' } })

    // `g` would make a reused RegExp skip matches; it is dropped.
    expect(await h.waitFor(/ready in \d+/gi, { timeout: 30_000 })).toBe('  READY in 312 ms')
    const reads = callShell.mock.calls.filter(([op]) => op === 'readLines')
    expect(reads.map(([, p]) => p.offset)).toEqual([0, 14])
    for (const [, payload] of callShell.mock.calls) {
      expect(payload).not.toHaveProperty('pattern')
    }
    expect(callShell.mock.calls.some(([op]) => op === 'waitFor')).toBe(false)

    pages.push(chunk(['  Local: http://x'], 18))
    expect(await h.waitFor('Local:')).toBe('  Local: http://x')

    await h.stop()
    expect(callShell).toHaveBeenCalledWith('stop', { taskId: 'b42' })
  })

  it('a pattern that is neither a RegExp nor a string is ShellRunFailure kind `invalid`, with no round-trip', async () => {
    const { bash, callShell } = helpers(op => (op === 'run' ? ok({ taskId: 'b1' }) : chunk([], 0)))
    const h = (await bash('server', { background: true })) as BackgroundHandle
    callShell.mockClear()
    const err = (await h.waitFor({ source: '(' } as never).catch(e => e)) as ShellRunFailure
    expect(err).toBeInstanceOf(ShellRunFailure)
    expect(err).toMatchObject({ kind: 'invalid', exitCode: null })
    expect(callShell).not.toHaveBeenCalled()
  })

  it('waitFor throws `failed` (with the exit code) when the task ends unmatched, and `timeout` at its deadline', async () => {
    const ended = helpers(op =>
      op === 'run' ? ok({ taskId: 'b1' }) : chunk(['Error: port in use'], 19, { ended: true, status: 'error', exitCode: 1 }),
    )
    const h1 = (await ended.bash('server', { background: true })) as BackgroundHandle
    const failed = (await h1.waitFor('ready').catch(e => e)) as ShellRunFailure
    expect(failed).toMatchObject({ name: 'ShellError', kind: 'failed', exitCode: 1 })
    expect(failed.message).toContain('/log/out')

    const quiet = helpers(op => (op === 'run' ? ok({ taskId: 'b2' }) : chunk([], 0)))
    const h2 = (await quiet.bash('server', { background: true })) as BackgroundHandle
    const timedOut = (await h2.waitFor('ready', { timeout: 1 }).catch(e => e)) as ShellRunFailure
    expect(timedOut).toMatchObject({ name: 'ShellError', kind: 'timeout', exitCode: null })
  })

  it('a host error during waitFor throws ShellRunFailure with its kind', async () => {
    const { bash } = helpers(op => (op === 'run' ? ok({ taskId: 'b1' }) : fail({ kind: 'cancelled', message: 'stopped' })))
    const h = (await bash('server', { background: true })) as BackgroundHandle
    const err = (await h.waitFor('ready').catch(e => e)) as ShellRunFailure
    expect(err).toMatchObject({ name: 'ShellError', kind: 'cancelled' })
  })
})
