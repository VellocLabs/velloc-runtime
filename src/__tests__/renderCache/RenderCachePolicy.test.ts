/**
 * The render-cache purge policy (P-3): one idle purge per quiet period with no
 * turn running, re-armed by client activity and by a turn ending; never during
 * a turn; the settings flag turns the automatic purges off; a manual purge runs
 * whatever the flag says. The last active window losing activation purges every
 * target with a trim, even during a turn. Every purge waits out the startup
 * grace and keeps the minimum interval from the one before.
 */
import { describe, expect, it } from 'vitest'
import {
  RENDER_CACHE_IDLE_PURGE_MS,
  RENDER_CACHE_INACTIVE_SETTLE_MS,
  RENDER_CACHE_MIN_INTERVAL_MS,
  RENDER_CACHE_STARTUP_GRACE_MS,
  RenderCachePolicy,
  RenderCachePurgeDeferredError,
  type RenderCachePurgeOutcome,
} from '../../renderCache/RenderCachePolicy'
import type { RenderCacheState } from '../../renderCache/renderCacheProtocol'

type HarnessOptions = {
  busy?: boolean
  enabled?: boolean
  fail?: string
  releaseIdleCaches?: () => void
  /** Default 0: most cases are not about the gate. */
  startupGraceMs?: number
  minIntervalMs?: number
}

type FakeTimer = { fn: () => void; ms: number; due: number; cleared: boolean }

function harness(options: HarnessOptions = {}) {
  let busy = options.busy ?? false
  let enabled = options.enabled ?? true
  let now = 1_000
  const timers: FakeTimer[] = []
  const purges: number[] = []
  const targets: string[][] = []
  const trims: boolean[] = []
  const appInactive: boolean[] = []
  const states: RenderCacheState[] = []
  const outcome: RenderCachePurgeOutcome = { purged: ['guest', 'gpu'], throttled: [], guestProcesses: 2, gpuProcesses: 1 }
  const policy = new RenderCachePolicy({
    isAnyBusy: () => busy,
    idlePurgeEnabled: async () => enabled,
    releaseIdleCaches: options.releaseIdleCaches,
    startupGraceMs: options.startupGraceMs ?? 0,
    minIntervalMs: options.minIntervalMs ?? 0,
    purge: async (asked, purgeOptions) => {
      purges.push(now)
      targets.push([...asked])
      trims.push(purgeOptions.trimWorkingSet)
      appInactive.push(purgeOptions.onlyWhenAppInactive)
      if (options.fail) throw new Error(options.fail)
      if (purgeOptions.trimWorkingSet) return { ...outcome, workingSetTrim: 'scheduled' as const }
      return outcome
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, due: now + ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: handle => {
      ;(handle as FakeTimer).cleared = true
    },
  })
  policy.onStateChange(state => states.push(state))
  const live = () => timers.filter(t => !t.cleared)
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  }
  const run = async (timer: FakeTimer) => {
    timer.cleared = true
    now = Math.max(now, timer.due)
    timer.fn()
    await settle()
  }
  /** Fire the one armed timer and let the purge settle. */
  const elapse = async () => {
    const armed = live()
    expect(armed).toHaveLength(1)
    await run(armed[0])
  }
  /** Fire the one armed timer of `ms`. */
  const fire = async (ms: number) => {
    const armed = live().filter(t => t.ms === ms)
    expect(armed).toHaveLength(1)
    await run(armed[0])
  }
  /** The one armed timer that is neither the idle timer nor the settle delay. */
  const gate = () => {
    const armed = live().filter(t => t.ms !== RENDER_CACHE_IDLE_PURGE_MS && t.ms !== RENDER_CACHE_INACTIVE_SETTLE_MS)
    expect(armed).toHaveLength(1)
    return armed[0]
  }
  /** The last active window loses activation, and the settle delay passes. */
  const deactivate = async () => {
    policy.noteActive(true)
    policy.noteActive(false)
    await fire(RENDER_CACHE_INACTIVE_SETTLE_MS)
  }
  return {
    policy,
    purges,
    targets,
    trims,
    appInactive,
    settle,
    states,
    live,
    elapse,
    fire,
    gate,
    deactivate,
    advance: (ms: number) => {
      now += ms
    },
    setBusy: (value: boolean) => {
      busy = value
    },
  }
}

describe('RenderCachePolicy', () => {
  it('purges once after the quiet period, and again only after new activity', async () => {
    const h = harness()
    h.policy.start()
    expect(h.live()[0].ms).toBe(RENDER_CACHE_IDLE_PURGE_MS)
    await h.elapse()
    expect(h.purges).toHaveLength(1)
    expect(h.policy.isArmed()).toBe(false)

    h.policy.noteActivity()
    expect(h.policy.isArmed()).toBe(true)
    await h.elapse()
    expect(h.purges).toHaveLength(2)
    expect(h.policy.getState()).toMatchObject({
      available: true,
      purges: 2,
      last: { reason: 'idle', purged: ['guest', 'gpu'], guestProcesses: 2 },
    })
  })

  it('activity restarts the quiet period', async () => {
    const h = harness()
    h.policy.start()
    const first = h.live()[0]
    h.policy.noteActivity()
    expect(first.cleared).toBe(true)
    expect(h.live()).toHaveLength(1)
  })

  it('never arms while a turn runs; the turn ending starts a quiet period', async () => {
    const h = harness({ busy: true })
    h.policy.start()
    expect(h.policy.isArmed()).toBe(false)
    h.policy.noteActivity()
    expect(h.policy.isArmed()).toBe(false)

    h.setBusy(false)
    h.policy.noteBusyChanged()
    expect(h.policy.isArmed()).toBe(true)
    await h.elapse()
    expect(h.purges).toHaveLength(1)
  })

  it('a turn starting disarms the timer; a status refresh without a transition changes nothing', () => {
    const h = harness()
    h.policy.start()
    const armed = h.live()[0]
    h.policy.noteBusyChanged()
    expect(armed.cleared).toBe(false)

    h.setBusy(true)
    h.policy.noteBusyChanged()
    expect(armed.cleared).toBe(true)
    expect(h.policy.isArmed()).toBe(false)
  })

  it('does not purge if a turn is running when the timer fires', async () => {
    const h = harness()
    h.policy.start()
    h.setBusy(true)
    await h.elapse()
    expect(h.purges).toHaveLength(0)
  })

  it('the settings flag is read and published at start, before any quiet period ends', async () => {
    const h = harness({ enabled: false })
    h.policy.start()
    await h.settle()
    expect(h.purges).toHaveLength(0)
    expect(h.policy.getState().idlePurge).toBe(false)
    expect(h.states.at(-1)?.idlePurge).toBe(false)
  })

  it('activity re-reads the turn state, so a turn that ended unreported does not block the purge', async () => {
    const h = harness({ busy: true })
    h.policy.start()
    expect(h.policy.isArmed()).toBe(false)
    h.setBusy(false)
    h.policy.noteActivity()
    expect(h.policy.isArmed()).toBe(true)
    await h.elapse()
    expect(h.purges).toHaveLength(1)
  })

  it('a turn found running when the timer fires re-arms the purge when it ends', async () => {
    const h = harness()
    h.policy.start()
    h.setBusy(true)
    await h.elapse()
    expect(h.purges).toHaveLength(0)
    h.setBusy(false)
    h.policy.noteBusyChanged()
    expect(h.policy.isArmed()).toBe(true)
    await h.elapse()
    expect(h.purges).toHaveLength(1)
  })

  it('the settings flag off skips the idle purge and is published', async () => {
    const h = harness({ enabled: false })
    h.policy.start()
    await h.elapse()
    expect(h.purges).toHaveLength(0)
    expect(h.policy.getState().idlePurge).toBe(false)
    expect(h.states.at(-1)?.idlePurge).toBe(false)
  })

  it('a manual purge runs whatever the turn or flag says', async () => {
    const h = harness({ busy: true, enabled: false })
    h.policy.start()
    const record = await h.policy.purgeNow()
    expect(record.reason).toBe('manual')
    expect(h.purges).toHaveLength(1)
    expect(h.states.at(-1)?.last?.reason).toBe('manual')
  })

  it('every purge first releases the idle sessions\' caches, idle, inactive and manual alike', async () => {
    const order: string[] = []
    const h = harness({ releaseIdleCaches: () => order.push('release') })
    h.policy.start()
    await h.elapse()
    await h.deactivate()
    await h.policy.purgeNow()
    expect(order).toEqual(['release', 'release', 'release'])
    expect(h.purges).toHaveLength(3)
  })

  it('a failing cache release never blocks the host purge', async () => {
    const h = harness({ releaseIdleCaches: () => { throw new Error('boom') } })
    h.policy.start()
    const record = await h.policy.purgeNow()
    expect(record.reason).toBe('manual')
    expect(h.purges).toHaveLength(1)
  })

  it('a failed purge is recorded and the manual call rejects', async () => {
    const h = harness({ fail: 'host gone' })
    h.policy.start()
    await h.elapse()
    expect(h.policy.getState().lastError).toBe('host gone')
    await expect(h.policy.purgeNow()).rejects.toThrow('host gone')
  })

  it('the last active window losing activation purges every target with a trim, once', async () => {
    const h = harness()
    h.policy.start()
    await h.deactivate()
    expect(h.targets).toEqual([['guest', 'gpu', 'agentTabs']])
    expect(h.trims).toEqual([true])
    expect(h.appInactive).toEqual([true])
    expect(h.policy.getState().last).toMatchObject({ reason: 'inactive', workingSetTrim: 'scheduled' })

    h.policy.noteActive(false)
    await h.settle()
    expect(h.live().filter(t => t.ms === RENDER_CACHE_INACTIVE_SETTLE_MS)).toHaveLength(0)
    expect(h.purges).toHaveLength(1)

    await h.deactivate()
    expect(h.purges).toHaveLength(2)
  })

  it('a window activated within the settle delay cancels the inactive purge', async () => {
    const h = harness()
    h.policy.start()
    h.policy.noteActive(true)
    h.policy.noteActive(false)
    const settleTimer = h.live().find(t => t.ms === RENDER_CACHE_INACTIVE_SETTLE_MS)
    h.policy.noteActive(true)
    expect(settleTimer?.cleared).toBe(true)
    await h.settle()
    expect(h.purges).toHaveLength(0)
  })

  it('the inactive purge runs while a turn runs', async () => {
    const h = harness({ busy: true })
    h.policy.start()
    await h.deactivate()
    expect(h.targets).toEqual([['guest', 'gpu', 'agentTabs']])
  })

  it('a first report of inactive, with no window seen active, does not purge', async () => {
    const h = harness()
    h.policy.start()
    h.policy.noteActive(false)
    await h.settle()
    expect(h.live().filter(t => t.ms === RENDER_CACHE_INACTIVE_SETTLE_MS)).toHaveLength(0)
    expect(h.purges).toHaveLength(0)
  })

  it('the settings flag off skips the inactive purge', async () => {
    const h = harness({ enabled: false })
    h.policy.start()
    await h.deactivate()
    expect(h.purges).toHaveLength(0)
  })

  it('a failed inactive purge is recorded', async () => {
    const h = harness({ fail: 'host gone' })
    h.policy.start()
    await h.deactivate()
    expect(h.policy.getState().lastError).toBe('host gone')
    expect(h.policy.getState().purges).toBe(0)
  })

  it('a purge the host skipped for a foreground window is recorded as skipped', async () => {
    const policy = new RenderCachePolicy({
      isAnyBusy: () => false,
      idlePurgeEnabled: async () => true,
      startupGraceMs: 0,
      purge: async () => ({
        purged: [],
        throttled: [],
        guestProcesses: 0,
        gpuProcesses: 0,
        agentTabProcesses: 0,
        skipped: 'app_active' as const,
      }),
      setTimer: fn => {
        fn()
        return {}
      },
      clearTimer: () => {},
    })
    policy.noteActive(true)
    policy.noteActive(false)
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    expect(policy.getState().last).toMatchObject({ reason: 'inactive', skipped: 'app_active', agentTabProcesses: 0 })
  })

  it('the inactive purge leaves the idle purge armed for guest and gpu', async () => {
    const h = harness()
    h.policy.start()
    await h.deactivate()
    await h.fire(RENDER_CACHE_IDLE_PURGE_MS)
    expect(h.targets).toEqual([['guest', 'gpu', 'agentTabs'], ['guest', 'gpu']])
  })

  it('an idle purge asks for a working-set trim only while no page is visible', async () => {
    const h = harness()
    h.policy.start()
    h.policy.noteVisibility(true)
    await h.elapse()
    h.policy.noteVisibility(false)
    h.policy.noteActivity()
    await h.elapse()
    await h.policy.purgeNow()
    expect(h.trims).toEqual([false, true, false])
  })

  it('nothing purges inside the startup grace; an automatic purge waits for its end', async () => {
    const h = harness({ startupGraceMs: RENDER_CACHE_STARTUP_GRACE_MS })
    h.policy.start()
    await h.deactivate()
    expect(h.purges).toHaveLength(0)
    await expect(h.policy.purgeNow()).rejects.toBeInstanceOf(RenderCachePurgeDeferredError)
    await expect(h.policy.purgeNow()).rejects.toMatchObject({
      reason: 'startup_grace',
      retryAt: 1_000 + RENDER_CACHE_STARTUP_GRACE_MS,
    })

    const gate = h.gate()
    expect(gate.ms).toBe(RENDER_CACHE_STARTUP_GRACE_MS - RENDER_CACHE_INACTIVE_SETTLE_MS)
    await h.fire(gate.ms)
    expect(h.targets).toEqual([['guest', 'gpu', 'agentTabs']])
  })

  it('a window active again when the startup grace ends cancels the waiting inactive purge', async () => {
    const h = harness({ startupGraceMs: RENDER_CACHE_STARTUP_GRACE_MS })
    h.policy.start()
    await h.deactivate()
    h.policy.noteActive(true)
    await h.fire(h.gate().ms)
    expect(h.purges).toHaveLength(0)
  })

  it('two purges keep the minimum interval; the later one waits for it', async () => {
    const h = harness({ minIntervalMs: RENDER_CACHE_MIN_INTERVAL_MS })
    h.policy.start()
    await h.policy.purgeNow()
    h.advance(3_000)
    await expect(h.policy.purgeNow()).rejects.toMatchObject({ reason: 'min_interval' })
    await h.deactivate()
    expect(h.purges).toHaveLength(1)

    await h.fire(h.gate().ms)
    expect(h.purges).toHaveLength(2)
    expect(h.purges[1] - h.purges[0]).toBe(RENDER_CACHE_MIN_INTERVAL_MS)
    expect(h.policy.getState().last?.reason).toBe('inactive')
  })

  it('an idle purge due inside the interval waits for it, then runs', async () => {
    const h = harness({ minIntervalMs: RENDER_CACHE_MIN_INTERVAL_MS })
    h.policy.start()
    h.advance(RENDER_CACHE_IDLE_PURGE_MS - 2_000)
    await h.policy.purgeNow()
    await h.fire(RENDER_CACHE_IDLE_PURGE_MS)
    expect(h.purges).toHaveLength(1)
    await h.fire(h.gate().ms)
    expect(h.purges).toHaveLength(2)
    expect(h.policy.getState().last?.reason).toBe('idle')
  })

  it('a turn starting while the idle purge waits for the gate drops it', async () => {
    const h = harness({ minIntervalMs: RENDER_CACHE_MIN_INTERVAL_MS })
    h.policy.start()
    h.advance(RENDER_CACHE_IDLE_PURGE_MS - 2_000)
    await h.policy.purgeNow()
    await h.fire(RENDER_CACHE_IDLE_PURGE_MS)
    h.setBusy(true)
    h.policy.noteBusyChanged()
    await h.fire(h.gate().ms)
    expect(h.purges).toHaveLength(1)
  })

  it('dispose stops the timers and the listeners', () => {
    const h = harness()
    h.policy.start()
    h.policy.noteActive(true)
    h.policy.noteActive(false)
    h.policy.dispose()
    expect(h.policy.isArmed()).toBe(false)
    expect(h.live()).toHaveLength(0)
    h.policy.noteActivity()
    expect(h.policy.isArmed()).toBe(false)
  })
})
