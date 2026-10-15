import { describe, expect, it } from 'vitest'
import {
  buildForegroundShellResult,
  resolveExplicitBackgroundShellArgs,
  resolveForcedBackgroundShellArgs,
  SHELL_NO_TIMEOUT_CAP_SENTINEL_MS,
} from '../toolkit/builtin/host/shellArgs'
import type { SubAgentSnapshot } from '../browser/worker/BackgroundShellCoordinator'

/**
 * `resolveForcedBackgroundShellArgs`: an auto-backgrounded (detached) foreground Bash/PowerShell runs to completion;
 * the C++ `timeout` is the no-timeout-cap sentinel, never a finite kill.
 */
describe('resolveForcedBackgroundShellArgs', () => {
  it('detaches a normal command with the no-timeout-cap sentinel (NOT a finite kill)', () => {
    const { effectiveInput, foregroundBudgetMs } =
      resolveForcedBackgroundShellArgs({ command: './cli.sh base.build' })
    // Always launched as a background Spawn…
    expect(effectiveInput.run_in_background).toBe(true)
    // …with the no-cap sentinel, so C++ never kills it by the clock. The
    // explicit regression: it must NOT be the old 10-minute (600000) hard kill.
    expect(effectiveInput.timeout).toBe(SHELL_NO_TIMEOUT_CAP_SENTINEL_MS)
    expect(effectiveInput.timeout).not.toBe(600_000)
    // The sentinel is well above the host's kMaxBashTimeoutMs so an old binary
    // clamps it to the max (safe degrade), never below it.
    expect(effectiveInput.timeout as number).toBeGreaterThan(600_000)
    // No model timeout → the inline wait is the 2-minute default
    // (SHELL_DEFAULT_TIMEOUT_MS), NOT a 15s budget.
    expect(foregroundBudgetMs).toBe(120_000)
  })

  it("drops the model's timeout from the C++ args but uses it as the detach point", () => {
    const { effectiveInput, foregroundBudgetMs } =
      resolveForcedBackgroundShellArgs({
        command: 'npm run build',
        timeout: 3_000,
      })
    // The model's 3s timeout is the detach point, not a kill: the C++ timeout is
    // still the no-cap sentinel, and the inline wait is the timeout itself.
    expect(effectiveInput.timeout).toBe(SHELL_NO_TIMEOUT_CAP_SENTINEL_MS)
    expect(foregroundBudgetMs).toBe(3_000)
  })

  it('waits inline for a long model timeout instead of detaching at 15s', () => {
    // Regression: the middle layer used to clamp every inline wait to 15s, so a
    // 5-minute build the model was willing to wait for was detached and had to
    // be polled back with TaskOutput. It now waits the full timeout.
    const { effectiveInput, foregroundBudgetMs } =
      resolveForcedBackgroundShellArgs({
        command: 'make',
        timeout: 300_000,
      })
    expect(effectiveInput.timeout).toBe(SHELL_NO_TIMEOUT_CAP_SENTINEL_MS)
    expect(foregroundBudgetMs).toBe(300_000)
  })

  it('clamps an over-max model timeout to the 10-minute max', () => {
    const { foregroundBudgetMs } = resolveForcedBackgroundShellArgs({
      command: 'make',
      timeout: 3_600_000,
    })
    expect(foregroundBudgetMs).toBe(600_000)
  })

  it('ignores a non-positive or non-numeric timeout (2-minute default)', () => {
    for (const timeout of [0, -5, Number.NaN, '30000']) {
      const { foregroundBudgetMs } = resolveForcedBackgroundShellArgs({
        command: 'make',
        timeout,
      })
      expect(foregroundBudgetMs).toBe(120_000)
    }
  })

  it('KEEPS the timeout for a leading sleep so C++ kills it there', () => {
    // A non-auto-backgroundable command (leading `sleep`) keeps its timeout so
    // C++ kills it at the timeout — it must NOT get the no-cap sentinel (that
    // would let a bare sleep run forever). A command on the auto-background
    // disallow-list is killed at its timeout.
    const { effectiveInput, foregroundBudgetMs } =
      resolveForcedBackgroundShellArgs({ command: 'sleep 30', timeout: 500 })
    expect(effectiveInput.run_in_background).toBe(true)
    expect(effectiveInput.timeout).toBe(500)
    expect(effectiveInput.timeout).not.toBe(SHELL_NO_TIMEOUT_CAP_SENTINEL_MS)
    // The inline wait outlasts the kill so it finalizes and returns inline.
    expect(foregroundBudgetMs).toBeGreaterThan(500)
    expect(foregroundBudgetMs).toBeLessThan(15_000)
  })

  it('kills a leading sleep at a long timeout too (a leading sleep never auto-backgrounds)', () => {
    // NEVER_DETACH_WORDS covers a leading sleep regardless of
    // the timeout length, so it is killed at the timeout rather than detached.
    const { effectiveInput, foregroundBudgetMs } =
      resolveForcedBackgroundShellArgs({ command: 'sleep 30', timeout: 20_000 })
    expect(effectiveInput.timeout).toBe(20_000)
    expect(foregroundBudgetMs).toBeGreaterThan(20_000)
  })

  it('gives a leading sleep without a timeout the 2-minute default kill', () => {
    const { effectiveInput } = resolveForcedBackgroundShellArgs({
      command: 'sleep 1',
    })
    expect(effectiveInput.timeout).toBe(120_000)
  })

  it('preserves other args (command, description) while forcing background', () => {
    const { effectiveInput } = resolveForcedBackgroundShellArgs({
      command: 'echo hi',
      description: 'say hi',
    })
    expect(effectiveInput.command).toBe('echo hi')
    expect(effectiveInput.description).toBe('say hi')
    expect(effectiveInput.run_in_background).toBe(true)
  })
})

/**
 * Explicit background (`run_in_background: true`): the C++ `timeout` is the no-timeout-cap sentinel, not the 120s
 * default / 10-minute max kill, for every explicit background including a leading `sleep`/`Start-Sleep`.
 */
describe('resolveExplicitBackgroundShellArgs', () => {
  it('gives an explicit-background command the no-timeout-cap sentinel (NOT the 120s default kill)', () => {
    // The regression: an explicit `run_in_background: true` with no timeout was
    // dispatched unchanged, so C++ killed it at kDefaultBashTimeoutMs (120s).
    const { effectiveInput } = resolveExplicitBackgroundShellArgs({
      command: './cli.sh base.build',
      run_in_background: true,
    })
    expect(effectiveInput.timeout).toBe(SHELL_NO_TIMEOUT_CAP_SENTINEL_MS)
    expect(effectiveInput.timeout).not.toBe(120_000)
    expect(effectiveInput.timeout).not.toBe(600_000)
    expect(effectiveInput.timeout as number).toBeGreaterThan(600_000)
  })

  it('replaces even an explicit model timeout with the sentinel (no kill timer)', () => {
    const { effectiveInput } = resolveExplicitBackgroundShellArgs({
      command: 'npm run build',
      run_in_background: true,
      timeout: 300_000,
    })
    expect(effectiveInput.timeout).toBe(SHELL_NO_TIMEOUT_CAP_SENTINEL_MS)
  })

  it('clears the timer even for a leading sleep (explicit background)', () => {
    // The auto-background disallow-list governs only whether a FOREGROUND
    // timeout auto-backgrounds or kills. An EXPLICIT background drops the kill
    // timer for every command — a leading `sleep` included. So an explicitly backgrounded `sleep 300`
    // runs to completion here too.
    const { effectiveInput } = resolveExplicitBackgroundShellArgs({
      command: 'sleep 300',
      run_in_background: true,
      timeout: 500,
    })
    expect(effectiveInput.timeout).toBe(SHELL_NO_TIMEOUT_CAP_SENTINEL_MS)
  })

  it('clears the timer for a PowerShell Start-Sleep too', () => {
    const { effectiveInput } = resolveExplicitBackgroundShellArgs({
      command: 'Start-Sleep -Seconds 30',
      run_in_background: true,
    })
    expect(effectiveInput.timeout).toBe(SHELL_NO_TIMEOUT_CAP_SENTINEL_MS)
  })

  it('leaves run_in_background and the other args untouched (only rewrites timeout)', () => {
    const { effectiveInput } = resolveExplicitBackgroundShellArgs({
      command: 'make',
      run_in_background: true,
      description: 'build it',
    })
    expect(effectiveInput.run_in_background).toBe(true)
    expect(effectiveInput.command).toBe('make')
    expect(effectiveInput.description).toBe('build it')
  })

  it('does NOT force run_in_background (the model already set it)', () => {
    // Unlike the forced middle layer, this resolver must not flip the flag —
    // it only rewrites the timeout of an already-background command.
    const { effectiveInput } = resolveExplicitBackgroundShellArgs({
      command: 'make',
    })
    expect(effectiveInput.run_in_background).toBeUndefined()
  })
})

/**
 * A forced/auto-background shell that completes INLINE within the foreground
 * budget is returned as the raw `{output, exit_code}` shape — but it is still a
 * registered `local_bash` task in the Background Tasks drawer. Carrying its
 * `task_id` on that inline result is what lets the conversation card offer the
 * ">>" jump to the drawer item (the "quick shell had a drawer item but no jump"
 * fix). Consumed UI-side by `extractBackgroundShellResultPreview`.
 */
describe('buildForegroundShellResult — inline completion carries the task id', () => {
  const snap = {
    output: 'ok',
    exitCode: 0,
  } as unknown as SubAgentSnapshot

  it('includes task_id when the run was a (registered) background task', () => {
    const result = buildForegroundShellResult(snap, 'b-quick')
    expect(result).toMatchObject({ output: 'ok', exit_code: 0, task_id: 'b-quick' })
  })

  it('omits task_id entirely when there is no task (middle layer off / no manager)', () => {
    const result = buildForegroundShellResult(snap)
    expect(result).toEqual({ output: 'ok', exit_code: 0 })
    expect('task_id' in result).toBe(false)
  })
})
