/**
 * `$.process.run` and `$.process.spawn` (F-25): a plugin's command by argv, run
 * through the hosted shell (fixed command line, words in the environment); stdout
 * carries both streams. Timeout 30 s by default, ten minutes at most; 4194304 bytes
 * per stream. Security: no permission prompt; the engine's bounds hold.
 */

import { isAbsoluteRuntimePath } from '../utils/runtimePaths'
import { isShellUnavailableError } from '../lifecycleHooks/hookCommandRunner'

export const PROCESS_DEFAULT_TIMEOUT_MS = 30_000
export const PROCESS_MAX_TIMEOUT_MS = 10 * 60_000
export const PROCESS_OUTPUT_LIMIT = 4_194_304

export type ModProcessRunInit = {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export type ModProcessRunResult = {
  exitCode: number
  stdout: string
  stderr: string
  isStdoutTruncated?: true
  isStderrTruncated?: true
}

/** What `$.process` needs of the session. */
export type ModProcessHost = {
  /** `signal` abandons the call: it rejects with an AbortError and the
   *  command is killed when the host can kill it. */
  run(argv: readonly string[], init: ModProcessRunInit, signal?: AbortSignal): Promise<ModProcessRunResult>
  /** The child as its pieces, started at the first pull. Absent: the host
   *  has no streaming child (a mock host). */
  spawn?(request: ModProcessSpawnRequest): AsyncIterator<ModProcessSpawnChunk, ModProcessSpawnResult>
}

/** The host's one way to run a command: the hosted `Bash` tool with its hook
 *  fields, as `createBashHookCommandRunner` calls it. */
export type HostCommandRunner = (args: {
  command: string
  shell: string
  stdin: string
  env: Record<string, string>
  timeoutMs: number
  /** The absolute folder the shell starts in. */
  cwd?: string
}) => Promise<{ output: string; exitCode: number }>

/** The environment variable that carries `argv[i]` to the shell. */
export const ARGV_ENV_PREFIX = 'VELLOC_MOD_ARG_'
/** The environment variable that carries the child's `cwd`. */
export const CWD_ENV = 'VELLOC_MOD_CWD'

/**
 * How `shell` runs `argv` in `cwd`: a fixed command line with the words in the
 * environment, so no plugin word is on the command line (MSYS bash would halve its
 * backslashes). The exit code is the child's own.
 */
export function shellInvocationOf(
  argv: readonly string[],
  cwd: string | undefined,
  shell: 'bash' | 'powershell',
): { command: string; env: Record<string, string> } {
  const env: Record<string, string> = {}
  const names = argv.map((arg, index) => {
    const name = `${ARGV_ENV_PREFIX}${index}`
    env[name] = arg
    return name
  })
  if (cwd !== undefined) env[CWD_ENV] = cwd
  const all = cwd !== undefined ? [...names, CWD_ENV] : names
  if (shell === 'powershell') {
    // As `cd … &&` and `exec` do: a folder it cannot enter runs nothing, and
    // a command that is not a program (not found, a cmdlet that failed) exits
    // non-zero, where `$LASTEXITCODE` alone would read 0.
    const enter =
      cwd !== undefined
        ? `try { Set-Location -LiteralPath $env:${CWD_ENV} -ErrorAction Stop } ` +
          'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }; '
        : ''
    const words = names.map(name => `$env:${name}`).join(', ')
    const clear = all.map(name => `Env:${name}`).join(', ')
    return {
      command:
        `${enter}$velloc_argv = @(${words}); Remove-Item ${clear}; ` +
        '$velloc_rest = @($velloc_argv | Select-Object -Skip 1); $global:LASTEXITCODE = $null; ' +
        '& $velloc_argv[0] @velloc_rest; $velloc_ok = $?; ' +
        'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; if ($velloc_ok) { exit 0 }; exit 1',
      env,
    }
  }
  const enter = cwd !== undefined ? `cd "$${CWD_ENV}" && ` : ''
  const words = names.map(name => `"$${name}"`).join(' ')
  // `exec` so the exit code is the command's own, no shell in between.
  return { command: `${enter}set -- ${words} && unset ${all.join(' ')} && exec "$@"`, env }
}

/** `call` names the call in a refusal: `$.process.run(argv, init)` or
 *  `$.process.spawn(request)`, and `field` where the field sits. */
function checkArgv(argv: unknown, call = '$.process.run(argv, init)'): readonly string[] {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === 'string')) {
    throw new TypeError(`${call}: argv must be a non-empty list of strings`)
  }
  if (argv[0] === '') throw new TypeError(`${call}: argv[0] is the executable`)
  return argv
}

function checkInit(init: unknown, field = '$.process.run: init'): ModProcessRunInit {
  if (init === undefined) return {}
  if (typeof init !== 'object' || init === null || Array.isArray(init)) {
    throw new TypeError('$.process.run(argv, init): init must be an object')
  }
  const i = init as Record<string, unknown>
  if (i.cwd !== undefined && (typeof i.cwd !== 'string' || i.cwd === '')) throw new TypeError(`${field}.cwd must be a path`)
  if (i.stdin !== undefined && typeof i.stdin !== 'string') throw new TypeError(`${field}.stdin must be a string`)
  if (i.timeoutMs !== undefined && (typeof i.timeoutMs !== 'number' || !(i.timeoutMs > 0))) {
    throw new TypeError(`${field}.timeoutMs must be a positive number`)
  }
  if (i.env !== undefined) {
    if (typeof i.env !== 'object' || i.env === null || Array.isArray(i.env)) throw new TypeError(`${field}.env must be an object`)
    for (const [name, value] of Object.entries(i.env)) {
      if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new TypeError(`${field}.env.${name} must be a string under a variable name`)
      }
    }
  }
  return {
    ...(i.cwd !== undefined ? { cwd: i.cwd as string } : {}),
    ...(i.env !== undefined ? { env: { ...(i.env as Record<string, string>) } } : {}),
    ...(i.stdin !== undefined ? { stdin: i.stdin as string } : {}),
    ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs as number } : {}),
  }
}

/** The event's `e` from `$.process.run(argv, init)`'s arguments, checked. */
export function processRunInput(args: readonly unknown[]): { argv: readonly string[]; init?: ModProcessRunInit } {
  const argv = checkArgv(args[0])
  const init = checkInit(args[1])
  return { argv: [...argv], ...(args[1] !== undefined ? { init } : {}) }
}

function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= PROCESS_OUTPUT_LIMIT) return { text, truncated: false }
  return { text: text.slice(0, PROCESS_OUTPUT_LIMIT), truncated: true }
}

/** The folder the host shell starts in: the session's, else the absolute
 *  `cwd` the call names. Neither is refused here, before the host is asked. */
function startFolderOf(sessionCwd: string, requested: string | undefined, call: string): string {
  if (isAbsoluteRuntimePath(sessionCwd)) return sessionCwd
  if (requested !== undefined && isAbsoluteRuntimePath(requested)) return requested
  throw new Error(`${call}: this session has no working folder; pass an absolute cwd`)
}

/** `pending`, or an AbortError the moment `signal` aborts: this route's
 *  command cannot be killed, and runs on to its own timeout. */
function stopWaitingOn<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(runAbandoned())
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function runAbandoned(): Error {
  const error = new Error('$.process.run: the call was abandoned; the command was stopped')
  error.name = 'AbortError'
  return error
}

/**
 * `run`'s answer read off a streaming child: its output in arrival order,
 * merged as the host's runner merges it, cut at the limit. The child is
 * killed when `signal` aborts (AbortError) or `timeoutMs` passes.
 */
async function runToEnd(
  pieces: AsyncIterator<ModProcessSpawnChunk, ModProcessSpawnResult>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ModProcessRunResult> {
  let stopped: Error | undefined
  const stop = (why: Error): void => {
    stopped ??= why
    void pieces.return?.()
  }
  const onAbort = (): void => stop(runAbandoned())
  const timer = setTimeout(
    () => stop(new Error(`$.process.run: the command did not finish within ${timeoutMs}ms; it was stopped`)),
    timeoutMs,
  )
  signal.addEventListener('abort', onAbort, { once: true })
  let output = ''
  let truncated = false
  try {
    for (;;) {
      const step = await pieces.next()
      if (stopped) throw stopped
      if (step.done) {
        return {
          exitCode: step.value.code ?? 1,
          stdout: output,
          stderr: '',
          ...(truncated ? { isStdoutTruncated: true as const } : {}),
        }
      }
      const room = PROCESS_OUTPUT_LIMIT - output.length
      if (step.value.text.length > room) truncated = true
      if (room > 0) output += step.value.text.slice(0, room)
    }
  } catch (error) {
    throw stopped ?? error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** `$.process` over the host's command runner, and its streaming spawn
 *  when it has one. */
export function hostModProcess(
  runCommand: HostCommandRunner,
  options: { cwd: string; spawnStream?: HostStreamSpawner },
): ModProcessHost {
  const { spawnStream } = options
  return {
    ...(spawnStream ? { spawn: (request: ModProcessSpawnRequest) => hostSpawnPieces(spawnStream, request, options) } : {}),
    async run(argv, init, signal) {
      const checked = checkArgv(argv)
      const settings = checkInit(init)
      const timeoutMs = Math.min(settings.timeoutMs ?? PROCESS_DEFAULT_TIMEOUT_MS, PROCESS_MAX_TIMEOUT_MS)
      const cwd = settings.cwd ?? options.cwd
      const startFolder = startFolderOf(options.cwd, settings.cwd, '$.process.run')
      if (signal?.aborted) throw runAbandoned()
      // A call that can be abandoned runs as a child the host can kill.
      if (signal && spawnStream) {
        const request: ModProcessSpawnRequest = {
          argv: [...checked],
          ...(settings.cwd !== undefined ? { cwd: settings.cwd } : {}),
          ...(settings.env !== undefined ? { env: settings.env } : {}),
          ...(settings.stdin !== undefined ? { input: settings.stdin } : {}),
        }
        return runToEnd(hostSpawnPieces(spawnStream, request, options), timeoutMs, signal)
      }
      let lastError: unknown
      for (const shell of ['bash', 'powershell'] as const) {
        try {
          const invocation = shellInvocationOf(checked, cwd, shell)
          const raw = await stopWaitingOn(
            runCommand({
              command: invocation.command,
              shell,
              stdin: settings.stdin ?? '',
              env: { ...settings.env, ...invocation.env },
              timeoutMs,
              cwd: startFolder,
            }),
            signal,
          )
          const stdout = cut(raw.output)
          return {
            exitCode: raw.exitCode,
            stdout: stdout.text,
            // The host merges the streams: everything is in `stdout`.
            stderr: '',
            ...(stdout.truncated ? { isStdoutTruncated: true as const } : {}),
          }
        } catch (error) {
          lastError = error
          if (shell === 'bash' && isShellUnavailableError(error)) continue
          throw error
        }
      }
      throw lastError ?? new Error('$.process.run: no shell is available on the host')
    },
  }
}

// `$.process.spawn`: the host's streaming shell form runs the argv as for `run`;
// output is decoded with one streaming `TextDecoder` per pipe.

/** Unread characters past which the child is killed: the host has no
 *  way to pause a child, so the declaration's "blocks on its next write" is
 *  a bound instead. */
export const PROCESS_SPAWN_UNREAD_LIMIT = 16 * 1_048_576

export type ModProcessSpawnRequest = {
  argv: readonly string[]
  cwd?: string
  env?: Record<string, string>
  input?: string
}

export type ModProcessSpawnChunk = { stream: 'stdout' | 'stderr'; text: string }

export type ModProcessSpawnResult = { code: number | null; signal: string | null }

/** How the host's streaming child ended. */
export type HostStreamExit = { exitCode: number; signal?: number }

/** A live streaming child of the host's. */
export type HostStreamChild = {
  kill(): Promise<boolean>
  /** Stop delivering to the handlers. */
  detach(): void
}

export type HostStreamHandlers = {
  onOutput: (stream: 'stdout' | 'stderr', data: Uint8Array) => void
  onExit: (exit: HostStreamExit) => void
}

/** The host's streaming spawn: `shell.spawn`'s shell form, its output and
 *  exit delivered to the handlers. Rejects when the child cannot start. */
export type HostStreamSpawner = (
  spec: {
    shell: 'bash' | 'powershell'
    command: string
    cwd?: string
    env?: Record<string, string>
    stdinText?: string
    closeStdin: true
  },
  handlers: HostStreamHandlers,
) => Promise<HostStreamChild>

/** The event's `e` from `$.process.spawn(request)`'s argument, checked. */
export function processSpawnInput(args: readonly unknown[]): ModProcessSpawnRequest {
  const request = args[0]
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new TypeError('$.process.spawn(request): request must be an object { argv, cwd, env, input }')
  }
  const r = request as Record<string, unknown>
  for (const key of Object.keys(r)) {
    if (!['argv', 'cwd', 'env', 'input'].includes(key)) {
      throw new TypeError(`$.process.spawn(request): request takes no field named "${key}"`)
    }
  }
  const argv = [...checkArgv(r.argv, '$.process.spawn(request)')]
  if (r.input !== undefined && typeof r.input !== 'string') throw new TypeError('$.process.spawn: request.input must be a string')
  const init = checkInit(
    {
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
      ...(r.env !== undefined ? { env: r.env } : {}),
    },
    '$.process.spawn: request',
  )
  return {
    argv,
    ...(init.cwd !== undefined ? { cwd: init.cwd } : {}),
    ...(init.env !== undefined ? { env: init.env } : {}),
    ...(r.input !== undefined ? { input: r.input as string } : {}),
  }
}

const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  6: 'SIGABRT',
  9: 'SIGKILL',
  13: 'SIGPIPE',
  15: 'SIGTERM',
}

/** `{ code, signal }` from the host's exit: "On Windows a killed child reads
 *  as an exit code, this null." */
export function spawnResultOf(exit: HostStreamExit): ModProcessSpawnResult {
  if (exit.signal !== undefined && exit.signal > 0) {
    return { code: null, signal: SIGNAL_NAMES[exit.signal] ?? `SIG${exit.signal}` }
  }
  return { code: exit.exitCode, signal: null }
}

/**
 * The child as an iterator of its pieces returning how it ended. Started at
 * the first `next()` — "rejects its first pull if it cannot start" — and
 * killed by `return()`, which answers at once, a pull in flight included.
 * Pieces of one pipe that wait unread together are read as one.
 */
export function spawnPieces(
  start: (handlers: HostStreamHandlers) => Promise<HostStreamChild>,
  unreadLimit: number = PROCESS_SPAWN_UNREAD_LIMIT,
): AsyncIterator<ModProcessSpawnChunk, ModProcessSpawnResult> {
  type Step = IteratorResult<ModProcessSpawnChunk, ModProcessSpawnResult>
  type Waiter = { resolve: (step: Step) => void; reject: (error: unknown) => void }
  let state: 'idle' | 'running' | 'ended' | 'closed' = 'idle'
  const queue: ModProcessSpawnChunk[] = []
  let unread = 0
  let exit: ModProcessSpawnResult | undefined
  let failure: Error | undefined
  let waiter: Waiter | undefined
  let child: HostStreamChild | undefined
  const decoders = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') }
  // What a closed stream answers: done, with no result.
  const closedStep = (): Step => ({ done: true, value: undefined as unknown as ModProcessSpawnResult })

  const push = (stream: 'stdout' | 'stderr', text: string): void => {
    if (text === '' || failure) return
    queue.push({ stream, text })
    unread += text.length
    if (unread > unreadLimit) {
      failure = new Error(
        `$.process.spawn: the child wrote more than ${unreadLimit} characters the loop had not read; it was killed`,
      )
      void child?.kill().catch(() => undefined)
    }
  }
  /** The next step, an error to throw, or undefined: wait. */
  const take = (): Step | Error | undefined => {
    if (queue.length > 0) {
      const first = queue.shift()!
      let text = first.text
      while (queue.length > 0 && queue[0]!.stream === first.stream) text += queue.shift()!.text
      unread -= text.length
      return { done: false, value: { stream: first.stream, text } }
    }
    if (failure) {
      state = 'ended'
      return failure
    }
    if (exit) {
      state = 'ended'
      return { done: true, value: exit }
    }
    return undefined
  }
  /** Answer the pull in flight, when what it waits for is here. */
  const settle = (): void => {
    if (!waiter) return
    const step = take()
    if (step === undefined) return
    const { resolve, reject } = waiter
    waiter = undefined
    if (step instanceof Error) reject(step)
    else resolve(step)
  }
  const handlers: HostStreamHandlers = {
    onOutput: (stream, data) => {
      if (state === 'closed') return
      push(stream, decoders[stream].decode(data, { stream: true }))
      settle()
    },
    onExit: raw => {
      if (state === 'closed') return
      push('stdout', decoders.stdout.decode())
      push('stderr', decoders.stderr.decode())
      exit = spawnResultOf(raw)
      settle()
    },
  }
  const pull = (): Promise<Step> => {
    if (state === 'closed') return Promise.resolve(closedStep())
    if (waiter) return Promise.reject(new Error('$.process.spawn: one pull at a time'))
    const step = take()
    if (step instanceof Error) return Promise.reject(step)
    if (step !== undefined) return Promise.resolve(step)
    if (state === 'ended') return Promise.resolve({ done: true, value: exit! })
    return new Promise<Step>((resolve, reject) => {
      waiter = { resolve, reject }
    })
  }
  const iterator: AsyncIterator<ModProcessSpawnChunk, ModProcessSpawnResult> = {
    next: () => {
      if (state !== 'idle') return pull()
      state = 'running'
      return start(handlers).then(started => {
        if ((state as string) === 'closed') {
          // Closed while it started: it never runs on.
          started.detach()
          void started.kill().catch(() => undefined)
          return closedStep()
        }
        child = started
        if (failure) void started.kill().catch(() => undefined)
        return pull()
      })
    },
    return: async () => {
      if (state === 'closed') return closedStep()
      const running = state === 'running'
      state = 'closed'
      queue.length = 0
      const pending = waiter
      waiter = undefined
      pending?.resolve(closedStep())
      if (child) {
        child.detach()
        if (running && !exit) void child.kill().catch(() => undefined)
      }
      return closedStep()
    },
  }
  return iterator
}

/** `$.process.spawn`'s core over the host's streaming spawn: bash, or
 *  PowerShell when the host has no bash, as `run`. */
export function hostSpawnPieces(
  spawnStream: HostStreamSpawner,
  request: ModProcessSpawnRequest,
  options: { cwd: string },
): AsyncIterator<ModProcessSpawnChunk, ModProcessSpawnResult> {
  return spawnPieces(async handlers => {
    const startFolder = startFolderOf(options.cwd, request.cwd, '$.process.spawn')
    let lastError: unknown
    for (const shell of ['bash', 'powershell'] as const) {
      const invocation = shellInvocationOf(request.argv, request.cwd, shell)
      const env = { ...request.env, ...invocation.env }
      // The host expands a `{{secret:NAME}}` in a `shell.spawn` env value
      // (the secrets stored for MCP servers): a plugin's word never does.
      const placeholder = Object.keys(env).find(name => env[name]!.includes('{{secret:'))
      if (placeholder !== undefined) {
        const where = placeholder in invocation.env ? 'an argument' : `env.${placeholder}`
        throw new TypeError(`$.process.spawn: ${where} holds "{{secret:", which a mod cannot pass`)
      }
      try {
        return await spawnStream(
          {
            shell,
            command: invocation.command,
            // The shell starts in the session's directory: a relative `cwd`
            // is the session's.
            cwd: startFolder,
            env,
            ...(request.input !== undefined ? { stdinText: request.input } : {}),
            closeStdin: true,
          },
          handlers,
        )
      } catch (error) {
        lastError = error
        if (shell === 'bash' && isShellUnavailableError(error)) continue
        throw error
      }
    }
    throw lastError ?? new Error('$.process.spawn: no shell is available on the host')
  })
}
