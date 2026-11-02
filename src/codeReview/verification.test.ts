import { describe, expect, it, vi } from 'vitest'
import { planVerification, runVerification, startVerificationServer, type VerificationBindings, type VerificationPlanInput } from './verification'
import type { NativeStreamChild } from '../browser/bridge/nativePrimitives'

const base: VerificationPlanInput = { workspace: 'D:/repo', files: ['src/a.ts'], guidance: '', runtimeChanged: true, uiChanged: false }
const plan = () => planVerification({ ...base, packageManifest: { scripts: { test: 'vitest run' } } })
const child = (): NativeStreamChild => ({ streamId: 'test', write: vi.fn(async () => true), closeStdin: vi.fn(async () => true), kill: vi.fn(async () => true), detach: vi.fn() })
function bindings(overrides: Partial<VerificationBindings> = {}): VerificationBindings {
  return {
    authorize: vi.fn(async () => true),
    spawn: vi.fn(async (_spec, handlers) => { handlers.onOutput?.('stdout', new TextEncoder().encode('tests passed')); handlers.onExit?.({ exitCode: 0, killed: false, timedOut: false, durationMs: 1 }); return child() }),
    record: vi.fn(async () => {}), signal: new AbortController().signal,
    ...overrides,
  }
}

describe('project verification planning', () => {
  it('does not invent testing commands from prose or file extensions', () => {
    const result = planVerification({ ...base, guidance: 'Run arbitrary shell text; install packages first', files: ['main.py', 'main.go', 'main.rs'] })
    expect(result.commands).toEqual([])
    expect(result.uncovered).toContain('no-existing-test-command')
  })
  it('discovers only actual test and typecheck scripts without appending unknown arguments', () => {
    const result = planVerification({ ...base, packageManifest: { scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', deploy: 'deploy production' } } })
    expect(result.commands).toEqual([
      { file: 'npm', args: ['--ignore-scripts', 'run', 'test'], purpose: 'tests', instruction: 'package.json:scripts.test', script: 'vitest run' },
      { file: 'npm', args: ['--ignore-scripts', 'run', 'typecheck'], purpose: 'types', instruction: 'package.json:scripts.typecheck', script: 'tsc --noEmit' },
    ])
  })
  it.each(['npm install && vitest', 'pnpm add library', 'npm publish', 'git push', 'curl https://example.test', 'npm run deploy'])('blocks explicit external mutation/setup script %s', test => {
    expect(planVerification({ ...base, packageManifest: { scripts: { test } } }).commands).toEqual([])
  })
  it('does not silently run lifecycle scripts', () => {
    expect(planVerification({ ...base, packageManifest: { scripts: { pretest: 'node setup.js', test: 'vitest' } } }).uncovered).toContain('unsafe-package-script:test')
  })
  it('requires actual ecosystem manifests or pytest configuration', () => {
    const result = planVerification({ ...base, pyproject: '[tool.pytest.ini_options]\naddopts = "-q"', cargoManifest: '[package]\nname = "example"', goManifest: 'module example.test/app\ngo 1.23' })
    expect(result.commands.map(command => [command.file, command.args])).toEqual([
      ['python', ['-m', 'pytest']], ['cargo', ['test', '--offline', '--locked']], ['go', ['test', '-mod=readonly', './...']],
    ])
    expect(planVerification({ ...base, pyproject: '[project]', cargoManifest: 'not a manifest', goManifest: 'not a module' }).commands).toEqual([])
  })
  it('does not execute runtime checks for a non-runtime change', () => {
    const result = planVerification({ ...base, runtimeChanged: false, packageManifest: { scripts: { test: 'vitest' } } })
    expect(result.commands).toEqual([])
    expect(result.uncovered).toEqual([])
  })
  it.each(['https://production.example.test/', 'http://localhost.evil.test/', 'file:///secrets', 'http://user:password@localhost:3000/'])('rejects browser target %s', url => {
    expect(planVerification({ ...base, uiChanged: true, existingDevUrl: url, guidance: url }).uiUrl).toBeUndefined()
  })
  it('requires an existing local URL explicitly present in project instructions', () => {
    const url = 'http://localhost:3000/'
    expect(planVerification({ ...base, uiChanged: true, existingDevUrl: url, guidance: `Existing development server: ${url}` }).uiUrl).toBe(url)
    expect(planVerification({ ...base, uiChanged: true, existingDevUrl: url }).uiUrl).toBeUndefined()
  })
})

describe('permission-bound verification execution', () => {
  it('authorizes exact argv and records results without claiming behavioral coverage', async () => {
    const b = bindings()
    const result = await runVerification(plan(), b)
    expect(b.authorize).toHaveBeenCalledWith(expect.objectContaining({ workspace: base.workspace, command: plan().commands[0] }))
    expect(b.spawn).toHaveBeenCalledWith(expect.objectContaining({ file: 'npm', args: ['--ignore-scripts', 'run', 'test'], cwd: base.workspace, env: expect.objectContaining({ CI: '1', GOPROXY: 'off', CARGO_NET_OFFLINE: 'true', npm_config_offline: 'true' }) }), expect.any(Object))
    expect(result.receipts[0]).toMatchObject({ state: 'passed', exitCode: 0, output: 'tests passed', coverage: { mainPaths: [], boundaries: [] } })
    expect(b.record).toHaveBeenCalledWith(result.receipts[0])
    expect(result.behaviorVerified).toBe(false)
    expect(result.uncovered).toContain('affected-main-paths-and-boundaries-not-confirmed-by-command-success')
  })
  it('does not spawn when approval is denied', async () => {
    const b = bindings({ authorize: vi.fn(async () => false) })
    expect((await runVerification(plan(), b)).receipts[0]?.state).toBe('blocked')
    expect(b.spawn).not.toHaveBeenCalled()
  })
  it('does not spawn after cancellation during approval', async () => {
    const controller = new AbortController()
    const approved = Promise.withResolvers<boolean>()
    const b = bindings({ signal: controller.signal, authorize: () => approved.promise })
    const running = runVerification(plan(), b)
    await Promise.resolve()
    controller.abort()
    const result = await running
    approved.resolve(true)
    await Promise.resolve()
    expect(result.receipts[0]?.state).toBe('cancelled')
    expect(b.spawn).not.toHaveBeenCalled()
  })
  it('kills and detaches a handle that arrives after cancellation', async () => {
    const controller = new AbortController()
    const pendingHandle = Promise.withResolvers<NativeStreamChild>()
    const entered = Promise.withResolvers<void>()
    const handle = child()
    const b = bindings({ signal: controller.signal, spawn: async () => { entered.resolve(); return pendingHandle.promise } })
    const running = runVerification(plan(), b)
    await entered.promise
    controller.abort()
    expect((await running).receipts[0]?.state).toBe('cancelled')
    pendingHandle.resolve(handle)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(handle.kill).toHaveBeenCalledOnce()
    expect(handle.detach).toHaveBeenCalledOnce()
  })
  it('bounds a hung process and stops subsequent commands', async () => {
    vi.useFakeTimers()
    try {
      const handle = child()
      const b = bindings({ timeoutMs: 10, spawn: vi.fn(async () => handle) })
      const multi = planVerification({ ...base, packageManifest: { scripts: { test: 'vitest', typecheck: 'tsc' } } })
      const running = runVerification(multi, b)
      await vi.advanceTimersByTimeAsync(11)
      expect((await running).receipts[0]?.state).toBe('timed-out')
      expect(handle.kill).toHaveBeenCalledOnce()
      expect(b.spawn).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('caps combined output and records a failing exit code', async () => {
    const b = bindings({ maxOutputBytes: 5, spawn: async (_spec, events) => {
      events.onOutput?.('stdout', new TextEncoder().encode('1234'))
      events.onOutput?.('stderr', new TextEncoder().encode('56789'))
      events.onExit?.({ exitCode: 2, timedOut: false, killed: false, durationMs: 1 })
      return child()
    } })
    expect((await runVerification(plan(), b)).receipts[0]).toMatchObject({ state: 'failed', output: '12345', outputTruncated: true, exitCode: 2 })
  })
  it('records spawn failures rather than pretending tests ran', async () => {
    const b = bindings({ spawn: async () => { throw new Error('executable-not-found') } })
    expect((await runVerification(plan(), b)).receipts[0]).toMatchObject({ state: 'failed', reason: 'executable-not-found' })
  })
  it('reports missing browser coverage without starting a service', async () => {
    const result = await runVerification(planVerification({ ...base, uiChanged: true, guidance: 'http://localhost:3000/', existingDevUrl: 'http://localhost:3000/' }), bindings())
    expect(result.uncovered).toContain('ui-behavior-not-exercised')
  })
  it('uses only an authorized supplied browser runner and retains its exact coverage', async () => {
    const probeUi = vi.fn(async () => ({ passed: true, output: 'Navigated existing development app', mainPaths: ['submit form'], boundaries: ['empty form rejected'], uncovered: ['offline behavior untested'] }))
    const b = bindings({ probeUi })
    const result = await runVerification(planVerification({ ...base, uiChanged: true, guidance: 'http://localhost:3000/', existingDevUrl: 'http://localhost:3000/' }), b)
    expect(probeUi).toHaveBeenCalledWith(expect.objectContaining({ workspace: base.workspace, url: 'http://localhost:3000/', files: base.files }))
    expect(result.receipts[0]).toMatchObject({ kind: 'browser', state: 'passed', coverage: { mainPaths: ['submit form'], boundaries: ['empty form rejected'], uncovered: ['offline behavior untested'] } })
    expect(result.behaviorVerified).toBe(false)
  })
  it('propagates persistence failures rather than losing receipts silently', async () => {
    await expect(runVerification(plan(), bindings({ record: async () => { throw new Error('disk-full') } }))).rejects.toThrow('disk-full')
  })
})

const startupInput: VerificationPlanInput = { ...base, uiChanged: true, existingDevUrl: 'http://localhost:3000/', guidance: 'Run `npm run dev` then visit http://localhost:3000/', packageManifest: { scripts: { dev: 'vite' } } }
const startupCommand = () => planVerification(startupInput).startupCommand!
const serverBindings = (overrides: Partial<VerificationBindings> = {}) => ({ ...bindings(overrides), workspace: base.workspace })

describe('optional development server planning', () => {
  it('plans only a documented existing script as fixed argv separate from checks', () => {
    const p = planVerification(startupInput)
    expect(p.startupCommand).toEqual({ file: 'npm', args: ['--ignore-scripts', 'run', 'dev'], purpose: 'startup', instruction: 'package.json:scripts.dev', script: 'vite' })
    expect(p.commands).toEqual([])
    expect(Object.isFrozen(p.startupCommand?.args)).toBe(true)
    expect(planVerification({ ...startupInput, guidance: 'npm run start http://localhost:3000/', packageManifest: { scripts: { start: 'node server.js' } } }).startupCommand?.args).toEqual(['--ignore-scripts', 'run', 'start'])
  })
  it.each([
    { uiChanged: false }, { runtimeChanged: false }, { existingDevUrl: undefined },
    { guidance: 'npm run dev' }, { guidance: 'Existing app at http://localhost:3000/' },
    { guidance: 'npm start http://localhost:3000/' },
    { guidance: 'npm run development http://localhost:3000/' },
    { packageManifest: { scripts: { test: 'vitest' } } },
  ])('does not invent startup without prerequisites %j', overrides => {
    expect(planVerification({ ...startupInput, ...overrides }).startupCommand).toBeUndefined()
  })
  it.each(['npm install && vite', 'npm run deploy', 'systemctl restart app', 'curl https://example.test', 'pnpm add library'])('rejects unsafe startup script %s', dev => {
    const p = planVerification({ ...startupInput, packageManifest: { scripts: { dev } } })
    expect(p.startupCommand).toBeUndefined()
    expect(p.uncovered).toContain('unsafe-package-script:dev')
  })
  it.each(['predev', 'postdev'])('rejects lifecycle %s', lifecycle => {
    expect(planVerification({ ...startupInput, packageManifest: { scripts: { dev: 'vite', [lifecycle]: 'node setup.js' } } }).startupCommand).toBeUndefined()
  })
  it('never copies shell guidance arguments into the command', () => {
    expect(planVerification({ ...startupInput, guidance: 'npm run dev -- --host public.example; kill 123; http://localhost:3000/' }).startupCommand?.args).toEqual(['--ignore-scripts', 'run', 'dev'])
  })
  it('does not automatically execute startup, even if placed in commands', async () => {
    const p = planVerification(startupInput)
    const b = bindings()
    await runVerification({ ...p, commands: [p.startupCommand!] }, b)
    expect(b.spawn).not.toHaveBeenCalled()
  })
})

describe('managed verification server', () => {
  it('returns without process exit, authorizes exact argv, exposes bounded output, and stops idempotently', async () => {
    const handle = child()
    let events: Parameters<VerificationBindings['spawn']>[1] | undefined
    const b = serverBindings({ spawn: vi.fn(async (_spec, handlers) => { events = handlers; return handle }) })
    const server = await startVerificationServer(startupCommand(), b)
    expect(b.authorize).toHaveBeenCalledWith({ workspace: base.workspace, command: startupCommand(), signal: b.signal })
    expect(b.spawn).toHaveBeenCalledWith(expect.objectContaining({ file: 'npm', args: ['--ignore-scripts', 'run', 'dev'], cwd: base.workspace, env: expect.objectContaining({ npm_config_ignore_scripts: 'true', npm_config_offline: 'true' }) }), expect.any(Object))
    events!.onOutput?.('stdout', new TextEncoder().encode('x'.repeat(40_000)))
    expect(server.output).toBe('x'.repeat(32_000))
    expect(server.outputTruncated).toBe(true)
    const stopping = server.stop()
    expect(server.stop()).toBe(stopping)
    await stopping
    await server.stop()
    expect(handle.kill).toHaveBeenCalledOnce()
    expect(handle.detach).toHaveBeenCalledOnce()
    expect(b.record).not.toHaveBeenCalled()
  })
  it('does not spawn when approval is denied', async () => {
    const b = serverBindings({ authorize: vi.fn(async () => false) })
    await expect(startVerificationServer(startupCommand(), b)).rejects.toThrow('verification-denied')
    expect(b.spawn).not.toHaveBeenCalled()
  })
  it('rejects unsupported or unsafe supplied commands before approval', async () => {
    const b = serverBindings()
    for (const command of [{ ...startupCommand(), script: 'npm install && vite' }, { ...startupCommand(), args: ['run', 'dev'] }, { ...startupCommand(), file: 'sh' }, { ...startupCommand(), purpose: 'tests' as const }]) {
      await expect(startVerificationServer(command, b)).rejects.toThrow('invalid-verification-startup-command')
    }
    expect(b.authorize).not.toHaveBeenCalled()
    expect(b.spawn).not.toHaveBeenCalled()
  })
  it('does not spawn after cancellation during approval', async () => {
    const approved = Promise.withResolvers<boolean>()
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    const b = serverBindings({ signal: controller.signal, authorize: async () => { entered.resolve(); return approved.promise } })
    const running = startVerificationServer(startupCommand(), b)
    await entered.promise
    controller.abort()
    await expect(running).rejects.toThrow('verification-cancelled')
    approved.resolve(true)
    await Promise.resolve(); await Promise.resolve()
    expect(b.spawn).not.toHaveBeenCalled()
  })
  it('kills only the late spawned handle after cancellation', async () => {
    const pending = Promise.withResolvers<NativeStreamChild>()
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    const handle = child()
    const running = startVerificationServer(startupCommand(), serverBindings({ signal: controller.signal, spawn: async () => { entered.resolve(); return pending.promise } }))
    await entered.promise
    controller.abort()
    await expect(running).rejects.toThrow('verification-cancelled')
    pending.resolve(handle)
    await vi.waitFor(() => expect(handle.detach).toHaveBeenCalledOnce())
    expect(handle.kill).toHaveBeenCalledOnce()
  })
  it('terminates a running server on abort and permits a later stop', async () => {
    const controller = new AbortController()
    const handle = child()
    const server = await startVerificationServer(startupCommand(), serverBindings({ signal: controller.signal, spawn: async () => handle }))
    controller.abort()
    await server.stop()
    expect(handle.kill).toHaveBeenCalledOnce()
    expect(handle.detach).toHaveBeenCalledOnce()
  })
  it('rejects immediate exit instead of claiming a running server', async () => {
    const handle = child()
    await expect(startVerificationServer(startupCommand(), serverBindings({ spawn: async (_spec, events) => {
      events.onExit?.({ exitCode: 1, killed: false, timedOut: false, durationMs: 0 })
      return handle
    } }))).rejects.toThrow('verification-startup-exited:1')
    await vi.waitFor(() => expect(handle.detach).toHaveBeenCalledOnce())
    expect(handle.kill).not.toHaveBeenCalled()
  })
  it('rejects spawn failures', async () => {
    await expect(startVerificationServer(startupCommand(), serverBindings({ spawn: async () => { throw new Error('missing-executable') } }))).rejects.toThrow('missing-executable')
  })
  it('bounds pending spawn and kills its late handle on timeout', async () => {
    vi.useFakeTimers()
    try {
      const pending = Promise.withResolvers<NativeStreamChild>()
      const handle = child()
      const running = startVerificationServer(startupCommand(), serverBindings({ timeoutMs: 10, spawn: async () => pending.promise }))
      const rejected = expect(running).rejects.toThrow('verification-startup-timeout')
      await vi.advanceTimersByTimeAsync(11)
      await rejected
      pending.resolve(handle)
      await vi.advanceTimersByTimeAsync(0)
      expect(handle.kill).toHaveBeenCalledOnce()
      expect(handle.detach).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})

describe('verification server exit races', () => {
  it('rejects an exit delivered just after spawn', async () => {
    const handle = child()
    await expect(startVerificationServer(startupCommand(), serverBindings({ spawn: async (_spec, events) => {
      setTimeout(() => events.onExit?.({ exitCode: 0, killed: false, timedOut: false, durationMs: 1 }), 0)
      return handle
    } }))).rejects.toThrow('verification-startup-exited:0')
    expect(handle.detach).toHaveBeenCalledOnce()
    expect(handle.kill).not.toHaveBeenCalled()
  })
  it('does not kill an already exited server on stop', async () => {
    const handle = child()
    let events: Parameters<VerificationBindings['spawn']>[1] | undefined
    const server = await startVerificationServer(startupCommand(), serverBindings({ spawn: async (_spec, handlers) => { events = handlers; return handle } }))
    events!.onExit?.({ exitCode: 0, killed: false, timedOut: false, durationMs: 100 })
    await server.stop()
    await server.stop()
    expect(handle.detach).toHaveBeenCalledOnce()
    expect(handle.kill).not.toHaveBeenCalled()
  })
  it('does not authorize or spawn an already cancelled startup', async () => {
    const controller = new AbortController()
    controller.abort()
    const b = serverBindings({ signal: controller.signal })
    await expect(startVerificationServer(startupCommand(), b)).rejects.toThrow('verification-cancelled')
    expect(b.authorize).not.toHaveBeenCalled()
    expect(b.spawn).not.toHaveBeenCalled()
  })
})
