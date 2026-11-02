import type { GitStreamSpawner } from './git-adapter'

export interface VerificationCommand {
  file: string
  args: readonly string[]
  purpose: 'tests' | 'types' | 'startup'
  instruction: string
  script?: string
}
export interface VerificationPlan {
  workspace: string
  files: readonly string[]
  commands: readonly VerificationCommand[]
  uncovered: readonly string[]
  uiUrl?: string
  startupCommand?: VerificationCommand
  runtimeChanged: boolean
  uiChanged: boolean
}
export interface VerificationPlanInput {
  workspace: string
  files: readonly string[]
  guidance: string
  runtimeChanged: boolean
  uiChanged: boolean
  packageManifest?: unknown
  pyproject?: string
  cargoManifest?: string
  goManifest?: string
  existingDevUrl?: string
}
export interface VerificationReceipt {
  kind: 'command' | 'browser'
  state: 'passed' | 'failed' | 'blocked' | 'cancelled' | 'timed-out'
  workspace: string
  command?: VerificationCommand
  url?: string
  exitCode?: number
  output: string
  outputTruncated: boolean
  reason?: string
  coverage: { mainPaths: string[]; boundaries: string[]; uncovered: string[] }
}
export interface VerificationBindings {
  /** The host must enforce workspace containment and deny installs, service changes and external writes, including effects of project scripts. */
  authorize(request: { workspace: string; command?: VerificationCommand; url?: string; signal: AbortSignal }): Promise<boolean>
  spawn: GitStreamSpawner
  record(receipt: VerificationReceipt): Promise<void>
  signal: AbortSignal
  timeoutMs?: number
  maxOutputBytes?: number
  /** Exercise only the existing authorized local app; do not start services or invoke external write endpoints. */
  probeUi?(input: { workspace: string; url: string; files: readonly string[]; signal: AbortSignal }): Promise<{ passed: boolean; output: string; mainPaths: string[]; boundaries: string[]; uncovered: string[] }>
}
export interface VerificationResult {
  receipts: VerificationReceipt[]
  uncovered: string[]
  behaviorVerified: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function planVerification(input: VerificationPlanInput): VerificationPlan {
  const commands: VerificationCommand[] = []
  const uncovered: string[] = []
  if (!/^(?:[A-Za-z]:[\\/]|\/)/u.test(input.workspace) || /[\x00\r\n]/u.test(input.workspace) || input.workspace.split(/[\\/]/u).includes('..')) throw new Error('invalid-verification-workspace')
  if (input.runtimeChanged) {
    const scripts = record(input.packageManifest) && record(input.packageManifest.scripts) ? input.packageManifest.scripts : undefined
    for (const [name, purpose] of [['test', 'tests'], ['typecheck', 'types']] as const) {
      if (typeof scripts?.[name] !== 'string' || !scripts[name].trim()) continue
      const script = scripts[name]
      if (!safePackageScript(scripts, name)) {
        uncovered.push(`unsafe-package-script:${name}`)
        continue
      }
      commands.push({ file: 'npm', args: ['--ignore-scripts', 'run', name], purpose, instruction: `package.json:scripts.${name}`, script })
    }
    if (input.pyproject && /^\s*\[tool\.pytest\.ini_options\]\s*$/mu.test(input.pyproject)) commands.push({ file: 'python', args: ['-m', 'pytest'], purpose: 'tests', instruction: 'pyproject.toml:tool.pytest.ini_options' })
    if (input.cargoManifest && /^\s*\[(?:package|workspace)\]\s*$/mu.test(input.cargoManifest)) commands.push({ file: 'cargo', args: ['test', '--offline', '--locked'], purpose: 'tests', instruction: 'Cargo.toml' })
    if (input.goManifest && /^module\s+\S+/mu.test(input.goManifest)) commands.push({ file: 'go', args: ['test', '-mod=readonly', './...'], purpose: 'tests', instruction: 'go.mod' })
    if (!commands.some(command => command.purpose === 'tests')) uncovered.push('no-existing-test-command')
    uncovered.push('affected-main-paths-and-boundaries-not-confirmed-by-command-success')
  }
  let uiUrl: string | undefined
  if (input.uiChanged && input.runtimeChanged) {
    try {
      const url = new URL(input.existingDevUrl ?? '')
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || !input.guidance.includes(url.href)) throw new Error('invalid-url')
      uiUrl = url.href
    } catch { uncovered.push('no-documented-local-development-url') }
  }
  let startupCommand: VerificationCommand | undefined
  if (uiUrl) {
    const scripts = record(input.packageManifest) && record(input.packageManifest.scripts) ? input.packageManifest.scripts : undefined
    for (const name of ['dev', 'start']) {
      if (!new RegExp(`\\bnpm[ \t]+run[ \t]+${name}(?![\\w:-])`, 'u').test(input.guidance)) continue
      if (!scripts || typeof scripts[name] !== 'string' || !scripts[name].trim()) continue
      if (!safePackageScript(scripts, name)) { uncovered.push(`unsafe-package-script:${name}`); continue }
      startupCommand = Object.freeze({ file: 'npm', args: Object.freeze(['--ignore-scripts', 'run', name]), purpose: 'startup', instruction: `package.json:scripts.${name}`, script: scripts[name] as string })
      break
    }
  }
  return Object.freeze({ startupCommand, workspace: input.workspace, files: Object.freeze([...input.files]), commands: Object.freeze(commands.map(command => Object.freeze({ ...command, args: Object.freeze([...command.args]) }))), uncovered: Object.freeze(uncovered), uiUrl, runtimeChanged: input.runtimeChanged, uiChanged: input.uiChanged })
}

export interface VerificationServerBindings extends Pick<VerificationBindings, 'spawn' | 'authorize' | 'signal' | 'timeoutMs'> {
  workspace: string
  record?: VerificationBindings['record']
}
export interface VerificationServerHandle {
  readonly output: string
  readonly outputTruncated: boolean
  stop(): Promise<void>
}

function safePackageScript(scripts: Record<string, unknown>, name: string): boolean {
  const script = scripts[name]
  return typeof script === 'string' && !!script.trim()
    && ![`pre${name}`, `post${name}`].some(key => typeof scripts[key] === 'string')
    && !/(?:^|[\s;&|])(install|add|publish|deploy|restart|reboot|shutdown|curl|wget|push)(?:\s|$)/iu.test(script)
}

/** Startup approval/spawn is bounded; readiness and observation belong to the caller. */
export async function startVerificationServer(command: VerificationCommand, bindings: VerificationServerBindings): Promise<VerificationServerHandle> {
  const timeout = bindings.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) throw new Error('invalid-verification-budget')
  if (!/^(?:[A-Za-z]:[\\/]|\/)/u.test(bindings.workspace) || /[\x00\r\n]/u.test(bindings.workspace) || bindings.workspace.split(/[\\/]/u).includes('..')) throw new Error('invalid-verification-workspace')
  const name = command.args[2]
  if (command.purpose !== 'startup' || command.file !== 'npm' || command.args.length !== 3 || command.args[0] !== '--ignore-scripts' || command.args[1] !== 'run' || !['dev', 'start'].includes(name) || !safePackageScript({ [name]: command.script }, name)) throw new Error('invalid-verification-startup-command')
  const supplied = Object.freeze({ ...command, args: Object.freeze([...command.args]) })
  const workspace = bindings.workspace
  return new Promise((resolve, reject) => {
    let handle: Awaited<ReturnType<GitStreamSpawner>> | undefined
    let settled = false, stopped = false, exited = false, detached = false
    let output = '', bytes = 0, outputTruncated = false
    let stopPromise: Promise<void> | undefined
    let readyTimer: ReturnType<typeof setTimeout> | undefined
    const detach = () => { if (handle && !detached) { detached = true; handle.detach() } }
    const cleanup = () => { clearTimeout(timer); clearTimeout(readyTimer); bindings.signal.removeEventListener('abort', abort) }
    const stop = (): Promise<void> => {
      stopped = true
      cleanup()
      if (!handle) return Promise.resolve()
      if (!stopPromise) stopPromise = (async () => {
        try { if (!exited) await handle!.kill() } finally { detach() }
      })()
      return stopPromise
    }
    const fail = (error: unknown) => {
      void stop().catch(() => {})
      if (!settled) { settled = true; reject(error) }
    }
    const abort = () => fail(new Error('verification-cancelled'))
    const timer = setTimeout(() => fail(new Error('verification-startup-timeout')), timeout)
    bindings.signal.addEventListener('abort', abort, { once: true })
    const server: VerificationServerHandle = { get output() { return output }, get outputTruncated() { return outputTruncated }, stop }
    Promise.resolve().then(async () => {
      if (bindings.signal.aborted || stopped) throw new Error('verification-cancelled')
      if (!await bindings.authorize({ workspace, command: supplied, signal: bindings.signal })) throw new Error('verification-denied')
      if (bindings.signal.aborted || stopped) throw new Error('verification-cancelled')
      return bindings.spawn({ file: supplied.file, args: [...supplied.args], cwd: workspace, env: { npm_config_ignore_scripts: 'true', npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } }, {
        onOutput(_stream, chunk) {
          if (stopped || exited) return
          const remaining = Math.max(0, 32_000 - bytes)
          output += new TextDecoder().decode(chunk.subarray(0, remaining))
          bytes += chunk.length
          outputTruncated ||= bytes > 32_000
        },
        onExit(exit) {
          exited = true
          cleanup()
          detach()
          if (!settled) fail(new Error(`verification-startup-exited:${exit.exitCode}`))
        },
      })
    }).then(async child => {
      handle = child
      if (stopped || bindings.signal.aborted) { await stop(); return }
      if (exited) { detach(); return }
      await child.closeStdin()
      if (stopped || exited) return
      readyTimer = setTimeout(() => {
        if (stopped || exited) return
        clearTimeout(timer)
        settled = true
        resolve(server)
      }, 0)
    }).catch(fail)
  })
}

type BoundedResult<T> = { state: 'completed'; value: T } | { state: 'cancelled' | 'timed-out' | 'failed'; reason?: string }
async function bounded<T>(signal: AbortSignal, timeout: number, task: (signal: AbortSignal) => Promise<T>): Promise<BoundedResult<T>> {
  if (signal.aborted) return { state: 'cancelled' }
  const child = new AbortController()
  return new Promise(resolve => {
    let settled = false
    const finish = (result: BoundedResult<T>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (result.state !== 'completed') child.abort()
      resolve(result)
    }
    const abort = () => finish({ state: 'cancelled' })
    const timer = setTimeout(() => finish({ state: 'timed-out' }), timeout)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => signal.aborted ? finish({ state: 'cancelled' }) : task(child.signal).then(value => finish({ state: 'completed', value }))).catch(error => finish({ state: 'failed', reason: error instanceof Error ? error.message : 'verification-failed' }))
  })
}

export async function runVerification(plan: VerificationPlan, bindings: VerificationBindings): Promise<VerificationResult> {
  const timeout = bindings.timeoutMs ?? 120_000
  const cap = bindings.maxOutputBytes ?? 32_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000 || !Number.isSafeInteger(cap) || cap < 1 || cap > 1_000_000) throw new Error('invalid-verification-budget')
  const receipts: VerificationReceipt[] = []
  const uncovered = [...plan.uncovered]
  const save = async (receipt: VerificationReceipt) => { await bindings.record(receipt); receipts.push(receipt) }
  for (const command of plan.commands) {
    if (command.purpose !== 'tests' && command.purpose !== 'types') continue
    let output = '', bytes = 0, outputTruncated = false
    const result = await bounded(bindings.signal, timeout, async signal => {
      if (!await bindings.authorize({ workspace: plan.workspace, command, signal })) return { blocked: true as const }
      if (signal.aborted) throw new Error('verification-cancelled')
      return new Promise<{ blocked: false; exitCode: number }>((resolve, reject) => {
        let handle: Awaited<ReturnType<GitStreamSpawner>> | undefined
        let ended = false
        const stop = () => { void handle?.kill().catch(() => {}); handle?.detach() }
        const abort = () => { ended = true; stop(); reject(new Error('verification-cancelled')) }
        const fail = (error: unknown) => { ended = true; signal.removeEventListener('abort', abort); stop(); reject(error) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) { abort(); return }
        Promise.resolve().then(() => {
          if (signal.aborted) throw new Error('verification-cancelled')
          return bindings.spawn({ file: command.file, args: [...command.args], cwd: plan.workspace, env: { CI: '1', npm_config_ignore_scripts: 'true', npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', CARGO_NET_OFFLINE: 'true', PIP_NO_INDEX: '1' } }, {
            onOutput(_stream, chunk) {
              if (ended) return
              const remaining = Math.max(0, cap - bytes)
              output += new TextDecoder().decode(chunk.subarray(0, remaining))
              bytes += chunk.length
              outputTruncated ||= bytes > cap
            },
            onExit(exit) {
              if (ended) return
              ended = true
              signal.removeEventListener('abort', abort)
              handle?.detach()
              if (exit.killed || exit.timedOut) reject(new Error(exit.timedOut ? 'process-timeout' : 'process-killed'))
              else resolve({ blocked: false, exitCode: exit.exitCode })
            },
          })
        }).then(child => {
          handle = child
          if (signal.aborted) stop()
          else if (ended) child.detach()
          else void child.closeStdin().catch(fail)
        }, fail)
      })
    })
    const state = result.state !== 'completed' ? result.state : result.value.blocked ? 'blocked' : result.value.exitCode === 0 ? 'passed' : 'failed'
    await save({ kind: 'command', state, workspace: plan.workspace, command, output, outputTruncated,
      ...(result.state === 'completed' && !result.value.blocked ? { exitCode: result.value.exitCode } : {}),
      ...(result.state === 'failed' ? { reason: result.reason } : {}),
      coverage: { mainPaths: [], boundaries: [], uncovered: ['command-exit-does-not-establish-behavior-coverage'] } })
    if (state !== 'passed') uncovered.push(`command-${state}:${command.instruction}`)
    if (state === 'cancelled' || state === 'timed-out') break
  }
  if (plan.uiChanged && plan.runtimeChanged) {
    if (!plan.uiUrl || !bindings.probeUi) uncovered.push('ui-behavior-not-exercised')
    else {
      const result = await bounded(bindings.signal, timeout, async signal => {
        if (!await bindings.authorize({ workspace: plan.workspace, url: plan.uiUrl, signal })) return undefined
        if (signal.aborted) throw new Error('verification-cancelled')
        return bindings.probeUi!({ workspace: plan.workspace, url: plan.uiUrl!, files: plan.files, signal })
      })
      const probe = result.state === 'completed' ? result.value : undefined
      const state = result.state !== 'completed' ? result.state : !probe ? 'blocked' : probe.passed ? 'passed' : 'failed'
      await save({ kind: 'browser', state, workspace: plan.workspace, url: plan.uiUrl, output: (probe?.output ?? '').slice(0, cap), outputTruncated: (probe?.output.length ?? 0) > cap,
        coverage: { mainPaths: probe?.mainPaths ?? [], boundaries: probe?.boundaries ?? [], uncovered: probe?.uncovered ?? ['ui-behavior-not-exercised'] } })
      uncovered.push(...(probe?.uncovered ?? ['ui-behavior-not-exercised']))
      if (state !== 'passed') uncovered.push(`browser-${state}`)
    }
  }
  return { receipts, uncovered: [...new Set(uncovered)], behaviorVerified: !plan.runtimeChanged }
}
