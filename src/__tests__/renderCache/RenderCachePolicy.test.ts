/**
 * The render-cache purge policy (P-3): one purge per quiet period with no turn
 * running, re-armed by client activity and by a turn ending; never during a
 * turn; the settings flag turns the idle purge off; a manual purge always runs.
 */
import { describe, expect, it } from 'vitest'
import {
  RENDER_CACHE_IDLE_PURGE_MS,
  RenderCachePolicy,
  type RenderCachePurgeOutcome,
} from '../../renderCache/RenderCachePolicy'
import type { RenderCacheState } from '../../renderCache/renderCacheProtocol'

function harness(options: { busy?: boolean; enabled?: boolean; fail?: string } = {}) {
  let busy = options.busy ?? false
  let enabled = options.enabled ?? true
  let now = 1_000
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const purges: number[] = []
  const states: RenderCacheState[] = []
  const outcome: RenderCachePurgeOutcome = { purged: ['guest', 'gpu'], throttled: [], guestProcesses: 2, gpuProcesses: 1 }
  const policy = new RenderCachePolicy({
    isAnyBusy: () => busy,
    idlePurgeEnabled: async () => enabled,
    purge: async () => {
      purges.push(now)
      if (options.fail) throw new Error(options.fail)
      return outcome
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: handle => {
      ;(handle as { cleared: boolean }).cleared = true
    },
  })
  policy.onStateChange(state => states.push(state))
  const live = () => timers.filter(t => !t.cleared)
  /** Fire the one armed timer and let the purge settle. */
  const elapse = async () => {
    const armed = live()
    expect(armed).toHaveLength(1)
    armed[0].cleared = true
    now += armed[0].ms
    armed[0].fn()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }
  return {
    policy,
    purges,
    states,
    live,
    elapse,
    setBusy: (value: boolean) => {
      busy = value
    },
    setEnabled: (value: boolean) => {
      enabled = value
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

  it('the settings flag off skips the idle purge and is published', async () => {
    const h = harness({ enabled: false })
    h.policy.start()
    await h.elapse()
    expect(h.purges).toHaveLength(0)
    expect(h.policy.getState().idlePurge).toBe(false)
    expect(h.states.at(-1)?.idlePurge).toBe(false)
  })

  it('a manual purge runs whatever the timer or flag says', async () => {
    const h = harness({ busy: true, enabled: false })
    h.policy.start()
    const record = await h.policy.purgeNow()
    expect(record.reason).toBe('manual')
    expect(h.purges).toHaveLength(1)
    expect(h.states.at(-1)?.last?.reason).toBe('manual')
  })

  it('a failed purge is recorded and the manual call rejects', async () => {
    const h = harness({ fail: 'host gone' })
    h.policy.start()
    await h.elapse()
    expect(h.policy.getState().lastError).toBe('host gone')
    await expect(h.policy.purgeNow()).rejects.toThrow('host gone')
  })

  it('dispose stops the timer and the listeners', () => {
    const h = harness()
    h.policy.start()
    h.policy.dispose()
    expect(h.policy.isArmed()).toBe(false)
    h.policy.noteActivity()
    expect(h.policy.isArmed()).toBe(false)
  })
})
