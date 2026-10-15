/**
 * Provider mods — a deleted session ends in the provider modules (PM-4b):
 * which modules are raised (only those known to hook it — a never-loaded one
 * is not woken), the 5 s budget the deletion never waits past, and that the
 * session's stores are deleted whatever the hooks did, after them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionEnder,
  endProviderSessions,
  PROVIDER_SESSION_END_BUDGET_MS,
  setProviderSessionEnder,
} from '../mods/provider/providerSessionEnd'

afterEach(() => {
  setProviderSessionEnder(undefined)
  vi.useRealTimers()
})

type HookKnowledge = Record<string, boolean | undefined>

function setup(hooks: HookKnowledge, behaviour: (providerId: string, e: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> = async () => ({ raised: true })) {
  const log: string[] = []
  const reports: string[] = []
  const runtime = {
    hasHook: (id: string) => hooks[id] ?? false,
    call: vi.fn(async (id: string, event: string, e: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}) => {
      log.push(`call:${id}:${event}:${e.sessionId}:${e.reason}`)
      const outcome = await behaviour(id, e, options.signal)
      log.push(`called:${id}`)
      return outcome
    }),
  }
  const end = vi.fn(async (sessionId: string) => {
    log.push(`end:${sessionId}`)
  })
  const ender = createSessionEnder({
    runtime: runtime as never,
    providerIds: () => Object.keys(hooks),
    end,
    report: line => reports.push(line),
  })
  return { ender, runtime, end, log, reports }
}

describe('raising provider.sessionEnd', () => {
  it('raises it in each module known to hook it, then deletes the stores', async () => {
    const { ender, runtime, log } = setup({ 'mod.a.x': true, 'mod.b.y': true })
    await ender('s1')
    expect(runtime.call).toHaveBeenCalledTimes(2)
    expect(log).toContain('call:mod.a.x:provider.sessionEnd:s1:deleted')
    expect(log).toContain('call:mod.b.y:provider.sessionEnd:s1:deleted')
    // the stores go after every module has answered
    expect(log.at(-1)).toBe('end:s1')
    expect(log.indexOf('end:s1')).toBeGreaterThan(log.indexOf('called:mod.a.x'))
    expect(log.indexOf('end:s1')).toBeGreaterThan(log.indexOf('called:mod.b.y'))
  })

  it('never wakes a module whose hooks are unknown (never loaded) or that has none', async () => {
    const { ender, runtime, end } = setup({ 'mod.known.x': true, 'mod.cold.y': undefined, 'mod.nohook.z': false })
    await ender('s1')
    expect(runtime.call.mock.calls.map(c => c[0])).toEqual(['mod.known.x'])
    expect(end).toHaveBeenCalledWith('s1')
  })

  it('with no module to ask it still deletes the stores', async () => {
    const { ender, runtime, end } = setup({ 'mod.cold.y': undefined })
    await ender('s9')
    expect(runtime.call).not.toHaveBeenCalled()
    expect(end).toHaveBeenCalledWith('s9')
  })

  it('a hook that fails does not stop the others or the deletion, and is reported', async () => {
    const { ender, end, reports, log } = setup({ 'mod.a.x': true, 'mod.b.y': true }, async id => {
      if (id === 'mod.a.x') throw new Error('hook blew up')
      return { raised: true }
    })
    await ender('s1')
    expect(end).toHaveBeenCalledWith('s1')
    expect(log).toContain('called:mod.b.y')
    expect(reports.join('\n')).toContain('mod.a.x: provider.sessionEnd did not run: hook blew up')
  })

  it('a hook that never answers is abandoned at the budget, aborted, and the stores still go', async () => {
    vi.useFakeTimers()
    let aborted = false
    const { ender, end, reports } = setup({ 'mod.slow.x': true }, (_id, _e, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('abandoned', 'AbortError'))
        })
      }),
    )
    const done = ender('s1')
    await vi.advanceTimersByTimeAsync(PROVIDER_SESSION_END_BUDGET_MS - 1)
    expect(end).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    await done
    expect(aborted).toBe(true)
    expect(end).toHaveBeenCalledWith('s1')
    expect(reports.join('\n')).toContain('not finished within 5000 ms')
    // an abandoned call is not also reported as a failure
    expect(reports.join('\n')).not.toContain('did not run')
  })

  it('a slow module cannot hold the deletion past the budget even when it ignores the signal', async () => {
    vi.useFakeTimers()
    const { ender, end } = setup({ 'mod.slow.x': true }, () => new Promise(() => {}))
    const done = ender('s1')
    await vi.advanceTimersByTimeAsync(PROVIDER_SESSION_END_BUDGET_MS + 1)
    await done
    expect(end).toHaveBeenCalledWith('s1')
  })

  it('a store deletion that fails is reported and does not reject', async () => {
    const reports: string[] = []
    const ender = createSessionEnder({
      runtime: { hasHook: () => false, call: vi.fn() } as never,
      providerIds: () => [],
      end: async () => {
        throw new Error('disk gone')
      },
      report: line => reports.push(line),
    })
    await expect(ender('s1')).resolves.toBeUndefined()
    expect(reports.join('\n')).toContain('disk gone')
  })
})

describe('the deletion path’s call', () => {
  it('is a no-op while no provider runtime has installed an ender', async () => {
    await expect(endProviderSessions(['a', 'b'])).resolves.toBeUndefined()
  })

  it('ends each session once, together, and never rejects', async () => {
    const seen: string[] = []
    setProviderSessionEnder(async id => {
      seen.push(id)
      if (id === 'bad') throw new Error('boom')
    })
    await expect(endProviderSessions(['lead', 'mate-1', 'bad', 'lead'])).resolves.toBeUndefined()
    expect(seen.sort()).toEqual(['bad', 'lead', 'mate-1'])
  })

  it('a lead and its teammates wait one budget in all, not one each', async () => {
    vi.useFakeTimers()
    const { ender } = setup({ 'mod.slow.x': true }, () => new Promise(() => {}))
    setProviderSessionEnder(ender)
    let finished = false
    const done = endProviderSessions(['lead', 't1', 't2']).then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(PROVIDER_SESSION_END_BUDGET_MS + 1)
    await done
    expect(finished).toBe(true)
  })
})
