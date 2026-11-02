import { describe, expect, it, vi } from 'vitest'
import { planVerification, runVerification, type VerificationBindings, type VerificationPlanInput } from './verification'
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
