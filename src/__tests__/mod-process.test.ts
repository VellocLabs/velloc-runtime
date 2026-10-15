/**
 * `$.process.run` (F-25) — `hostModProcess` over a fake host
 * command runner, and the noun through a real `ModRuntime`: the argv quoted
 * into one shell command with its cwd, stdin / env / timeout forwarded and
 * the timeout capped, the output cut at the limit, the PowerShell fallback
 * when the host has no bash, bad arguments refused by name, a guard hooking
 * `process.run`, a host without a shell refusing the noun.
 */
import { spawnSync } from 'node:child_process'
import { HostToolError } from '../browser/bridge/hostToolError'
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import {
  PROCESS_DEFAULT_TIMEOUT_MS,
  PROCESS_MAX_TIMEOUT_MS,
  PROCESS_OUTPUT_LIMIT,
  ARGV_ENV_PREFIX,
  CWD_ENV,
  hostModProcess,
  processRunInput,
  shellInvocationOf,
  type HostCommandRunner,
} from '../mods/modProcess'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

function fakeHost(answer: (args: Parameters<HostCommandRunner>[0]) => { output: string; exitCode: number } | Error = () => ({ output: 'ok\n', exitCode: 0 })) {
  const calls: Array<Parameters<HostCommandRunner>[0]> = []
  const run: HostCommandRunner = async args => {
    calls.push(args)
    const result = answer(args)
    if (result instanceof Error) throw result
    return result
  }
  return { run, calls }
}

/** Whether `shell` runs here (the test machine's own). */
function hasShell(shell: string, probe: string[]): boolean {
  const ran = spawnSync(shell, probe, { encoding: 'utf8' })
  return ran.status === 0
}
const HAS_BASH = hasShell('bash', ['-c', 'exit 0'])
const HAS_POWERSHELL = process.platform === 'win32' && hasShell('powershell', ['-NoProfile', '-Command', 'exit 0'])

/** Words no quoting may change: a Windows path with a trailing `\`, `\\`
 *  pairs, both quotes, `$`, a glob, a newline, an empty word. */
const HARD_WORDS = [
  'C:\\Users\\me\\temp\\nexus\\',
  // A `\\` pair (a JS source holding a JSON path): MSYS bash halved it.
  'open("E:\\\\temp\\\\x")',
  'pair\\\\end',
  'a "quoted" word',
  "it's",
  '$HOME and `x`',
  '*',
  'two\nlines',
  '',
]

describe('the shell command', () => {
  it('carries each word and the cwd in the environment: the command line holds none of them', () => {
    const bash = shellInvocationOf(['git', 'status', '--short'], '/work/p', 'bash')
    expect(bash).toEqual({
      command: `cd "$${CWD_ENV}" && set -- "$${ARGV_ENV_PREFIX}0" "$${ARGV_ENV_PREFIX}1" "$${ARGV_ENV_PREFIX}2" && unset ${ARGV_ENV_PREFIX}0 ${ARGV_ENV_PREFIX}1 ${ARGV_ENV_PREFIX}2 ${CWD_ENV} && exec "$@"`,
      env: { [`${ARGV_ENV_PREFIX}0`]: 'git', [`${ARGV_ENV_PREFIX}1`]: 'status', [`${ARGV_ENV_PREFIX}2`]: '--short', [CWD_ENV]: '/work/p' },
    })
    expect(shellInvocationOf(['ls'], undefined, 'bash').command).toBe(`set -- "$${ARGV_ENV_PREFIX}0" && unset ${ARGV_ENV_PREFIX}0 && exec "$@"`)
    const pwsh = shellInvocationOf(['git', 'status'], 'C:\\work', 'powershell')
    expect(pwsh.command).toBe(
      `try { Set-Location -LiteralPath $env:${CWD_ENV} -ErrorAction Stop } ` +
        'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }; ' +
        `$velloc_argv = @($env:${ARGV_ENV_PREFIX}0, $env:${ARGV_ENV_PREFIX}1); ` +
        `Remove-Item Env:${ARGV_ENV_PREFIX}0, Env:${ARGV_ENV_PREFIX}1, Env:${CWD_ENV}; ` +
        '$velloc_rest = @($velloc_argv | Select-Object -Skip 1); $global:LASTEXITCODE = $null; ' +
        '& $velloc_argv[0] @velloc_rest; $velloc_ok = $?; ' +
        'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; if ($velloc_ok) { exit 0 }; exit 1',
    )
    expect(pwsh.env[CWD_ENV]).toBe('C:\\work')
    for (const word of HARD_WORDS) {
      expect(shellInvocationOf(['node', word], undefined, 'bash').command).not.toContain(word || '\u0000')
    }
  })

  // The real shells, as a host runs them: the command line through
  // CreateProcess (node's own quoting is the MSVCRT one the host uses), the
  // words through the environment. A quoted command line lost every `\\`
  // pair to MSYS bash here.
  it.skipIf(!HAS_BASH)('bash hands the child every word as it was, and clears the variables', () => {
    const argv = [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), leaked: Object.keys(process.env).filter(k => k.startsWith("VELLOC_MOD_")) }))', ...HARD_WORDS]
    const { command, env } = shellInvocationOf(argv, undefined, 'bash')
    const ran = spawnSync('bash', ['-c', command], { env: { ...process.env, ...env }, encoding: 'utf8' })
    expect(ran.status, ran.stderr).toBe(0)
    expect(JSON.parse(ran.stdout)).toEqual({ argv: HARD_WORDS, leaked: [] })
  })

  it.skipIf(!HAS_BASH)("bash runs in the cwd and answers the child's exit code", () => {
    const cwd = process.cwd()
    const { command, env } = shellInvocationOf([process.execPath, '-e', 'process.stdout.write(process.cwd()); process.exit(7)'], cwd, 'bash')
    const ran = spawnSync('bash', ['-c', command], { env: { ...process.env, ...env }, encoding: 'utf8' })
    expect(ran.status).toBe(7)
    expect(ran.stdout.toLowerCase().replace(/\\/g, '/')).toBe(cwd.toLowerCase().replace(/\\/g, '/'))
  })

  it.skipIf(!HAS_POWERSHELL)('PowerShell runs the child with the words it was given', () => {
    // Windows PowerShell 5.1 passes a native argument with an embedded `"`
    // unescaped (its own bug): the fallback's words here avoid it.
    const words = ['C:\\Users\\me\\temp\\nexus\\x', "it's", '$HOME', 'a b']
    const argv = [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exit(3)', ...words]
    const { command, env } = shellInvocationOf(argv, process.cwd(), 'powershell')
    const ran = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    })
    expect(ran.status, ran.stderr).toBe(3)
    expect(JSON.parse(ran.stdout)).toEqual(words)
  })

  it.skipIf(!HAS_POWERSHELL)('PowerShell fails as bash does: a program not found, a cmdlet that failed, a folder it cannot enter', () => {
    const powershell = (argv: string[], cwd?: string) => {
      const { command, env } = shellInvocationOf(argv, cwd, 'powershell')
      return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
      })
    }
    expect(powershell(['velloc-no-such-program-x1']).status).not.toBe(0)
    expect(powershell(['Get-Item', 'C:\\velloc-no-such-file-x1']).status).not.toBe(0)
    expect(powershell(['Get-Location']).status).toBe(0)
    const marker = 'velloc-ran-in-missing-folder'
    const ran = powershell([process.execPath, '-e', `process.stdout.write('${marker}')`], 'C:\\velloc-no-such-folder-x1')
    expect(ran.status).not.toBe(0)
    expect(ran.stdout).not.toContain(marker)
  })

  it('the event input: argv checked, init checked and copied', () => {
    expect(processRunInput([['git', 'status']])).toEqual({ argv: ['git', 'status'] })
    expect(processRunInput([['ls'], { cwd: '/x', env: { A: '1' }, stdin: 'in', timeoutMs: 5 }])).toEqual({
      argv: ['ls'],
      init: { cwd: '/x', env: { A: '1' }, stdin: 'in', timeoutMs: 5 },
    })
    expect(() => processRunInput([[]])).toThrow(TypeError)
    expect(() => processRunInput(['ls'])).toThrow(TypeError)
    expect(() => processRunInput([['ls'], { env: { 'bad name': 'x' } }])).toThrow(TypeError)
    expect(() => processRunInput([['ls'], { timeoutMs: -1 }])).toThrow(TypeError)
  })
})

describe('hostModProcess', () => {
  it("runs the argv in the session's cwd by default, forwards stdin, env and the timeout (capped), and answers the exit code", async () => {
    const host = fakeHost(() => ({ output: 'M a.txt\n', exitCode: 1 }))
    const process = hostModProcess(host.run, { cwd: '/work/project' })
    expect(await process.run(['git', 'status', '--short'], {})).toEqual({ exitCode: 1, stdout: 'M a.txt\n', stderr: '' })
    await process.run(['cat'], { cwd: '/elsewhere', stdin: 'hello', env: { LANG: 'C' }, timeoutMs: PROCESS_MAX_TIMEOUT_MS * 5 })
    const first = shellInvocationOf(['git', 'status', '--short'], '/work/project', 'bash')
    const second = shellInvocationOf(['cat'], '/elsewhere', 'bash')
    expect(host.calls).toEqual([
      { command: first.command, shell: 'bash', stdin: '', env: first.env, timeoutMs: PROCESS_DEFAULT_TIMEOUT_MS, cwd: '/work/project' },
      { command: second.command, shell: 'bash', stdin: 'hello', env: { LANG: 'C', ...second.env }, timeoutMs: PROCESS_MAX_TIMEOUT_MS, cwd: '/work/project' },
    ])
  })

  it("names the start folder to the host, so the host needs no cwd of its own for the session", async () => {
    const host = fakeHost(() => ({ output: '', exitCode: 0 }))
    await hostModProcess(host.run, { cwd: 'D:\\work\\project' }).run(['gh', 'api'], { cwd: 'sub' })
    expect(host.calls.map(c => c.cwd)).toEqual(['D:\\work\\project'])
  })

  it('without a session folder: an absolute init.cwd is the start folder; otherwise refused before the host is asked', async () => {
    const host = fakeHost(() => ({ output: 'ok', exitCode: 0 }))
    const process = hostModProcess(host.run, { cwd: '' })
    expect(await process.run(['ls'], { cwd: '/elsewhere' })).toMatchObject({ stdout: 'ok' })
    expect(host.calls.map(c => c.cwd)).toEqual(['/elsewhere'])
    await expect(process.run(['ls'], {})).rejects.toThrow('$.process.run: this session has no working folder; pass an absolute cwd')
    await expect(process.run(['ls'], { cwd: 'relative' })).rejects.toThrow(/no working folder/)
    expect(host.calls).toHaveLength(1)
  })

  it('falls back to PowerShell when the host has no bash; any other rejection is the call\'s', async () => {
    const noBash = fakeHost(args => (args.shell === 'bash' ? new Error('BINARY_NOT_FOUND: bash') : { output: 'pwsh ok', exitCode: 0 }))
    const process = hostModProcess(noBash.run, { cwd: '/work' })
    expect(await process.run(['git', 'status'], {})).toMatchObject({ stdout: 'pwsh ok' })
    expect(noBash.calls.map(c => c.shell)).toEqual(['bash', 'powershell'])
    // The host may name the missing shell only in the error's params.
    const coded = fakeHost(args =>
      args.shell === 'bash'
        ? new HostToolError('hook_exec_failed', 'the shell could not start', { service_code: 'BINARY_NOT_FOUND' })
        : { output: 'pwsh ok', exitCode: 0 },
    )
    expect(await hostModProcess(coded.run, { cwd: '/work' }).run(['git', 'status'], {})).toMatchObject({ stdout: 'pwsh ok' })
    const broken = fakeHost(() => new Error('the command did not finish within 30000ms'))
    await expect(hostModProcess(broken.run, { cwd: '/work' }).run(['sleep', '99'], {})).rejects.toThrow(/did not finish/)
    expect(broken.calls).toHaveLength(1)
  })

  it('cuts the output at the limit and says so', async () => {
    const big = fakeHost(() => ({ output: 'x'.repeat(PROCESS_OUTPUT_LIMIT + 10), exitCode: 0 }))
    const result = await hostModProcess(big.run, { cwd: '/w' }).run(['yes'], {})
    expect(result.stdout).toHaveLength(PROCESS_OUTPUT_LIMIT)
    expect(result.isStdoutTruncated).toBe(true)
  })
})

describe('$.process.run through the runtime', () => {
  let uniq = 0
  function world(modules: Record<string, string>, host: Partial<ModNounHost> = {}) {
    const reports: string[] = []
    const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
    const runtime = new ModRuntime({
      modules: refs,
      readModule: async path => `${modules[path.split('/')[2]!]}\n// load ${++uniq}`,
      openWorker: async (): Promise<ModWorkerHandle> => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
        const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
          settle = resolve
        })
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      session: { id: () => 's', cwd: () => '/work/project', ...host },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)
    return { runtime, reports }
  }

  it("a mod runs a command and reads its exit code and output; another plugin's process.run hook denies a command by its argv; bad arguments are refused by name", async () => {
    const host = fakeHost(args => ({ output: `ran: ${Object.values(args.env).join(' ')}`, exitCode: 0 }))
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('process.run', ($, e, next) => e.argv[0] === 'rm' ? { deny: 'GUARD: no rm' } : next(e));
          }
        `,
        runner: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const ok = await $.process.run(['git', 'status'], { cwd: '/repo' });
              const denied = await $.process.run(['rm', '-rf', '/']).catch(err => err.message);
              const bad = await $.process.run('ls').catch(err => err.name + ': ' + err.message);
              await $.ui.log(JSON.stringify({ ok, denied, bad }));
              return next(e);
            });
          }
        `,
      },
      { process: hostModProcess(host.run, { cwd: '/work/project' }) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('runner: {'))!
    expect(JSON.parse(line.slice('runner: '.length))).toEqual({
      ok: { exitCode: 0, stdout: 'ran: git status /repo', stderr: '' },
      denied: 'GUARD: no rm',
      bad: 'TypeError: $.process.run(argv, init): argv must be a non-empty list of strings',
    })
    expect(host.calls).toHaveLength(1)
  })

  it('a host without a shell refuses the noun by name', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(await $.process.run(['ls']).catch(err => err.name + ': ' + err.message));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['probe: NotSupportedError: $.process is not available: this session cannot run commands'])
  })
})
