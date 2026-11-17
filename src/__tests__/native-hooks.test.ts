import { describe, expect, it } from 'vitest'

import { createNativeHooks, nativeHooksOf, type NativeHookRegistration } from '../toolkit/nativeHooks'
import { buildNativeHooks, NATIVE_HOOK_ORDER, nativeHookRegistrations } from '../nativeFeatures'

const observer = (module: string, seen: string[], extra: Partial<NativeHookRegistration> = {}) =>
  ({
    module,
    event: 'e.x',
    scope: 'all',
    observe: () => {
      seen.push(module)
    },
    ...extra,
  }) as NativeHookRegistration

describe('createNativeHooks', () => {
  it('runs links in the order table order, not registration order', async () => {
    const seen: string[] = []
    const hooks = createNativeHooks({ 'e.x': ['a', 'b', 'c'] }, [
      observer('c', seen),
      observer('a', seen),
      observer('b', seen),
    ])
    await hooks.observe('e.x', {}, {})
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('refuses a module the order table does not list', () => {
    expect(() => createNativeHooks({ 'e.x': ['a'] }, [observer('b', [])])).toThrow(/not in the order table/)
  })

  it('raises only the links at the raised position', async () => {
    const seen: string[] = []
    const hooks = createNativeHooks({ 'e.x': ['in', 'out'] }, [
      observer('in', seen),
      observer('out', seen, { position: 'outer' }),
    ])
    await hooks.observe('e.x', {}, {}, { position: 'outer' })
    expect(seen).toEqual(['out'])
    await hooks.observe('e.x', {}, {})
    expect(seen).toEqual(['out', 'in'])
    expect(hooks.has('e.x', { position: 'outer' })).toBe(true)
    expect(hooks.has('e.y')).toBe(false)
  })

  it('runs observers in place when raised synchronously, and refuses an async one', () => {
    const seen: string[] = []
    const hooks = createNativeHooks({ 'e.x': ['a', 'b'] }, [observer('b', seen), observer('a', seen)])
    hooks.observeSync('e.x', {}, {})
    expect(seen).toEqual(['a', 'b'])
    const late = createNativeHooks({ 'e.x': ['a'] }, [{ module: 'a', event: 'e.x', scope: 'all', observe: async () => {} }])
    expect(() => late.observeSync('e.x', {}, {})).toThrow(/may not return a promise/)
  })

  it('runs main-scope links only for the main agent', async () => {
    const seen: string[] = []
    const hooks = createNativeHooks({ 'e.x': ['main', 'all'] }, [
      observer('main', seen, { scope: 'main' }),
      observer('all', seen),
    ])
    await hooks.observe('e.x', {}, {}, { agentId: 'sub-1' })
    expect(seen).toEqual(['all'])
  })

  it('nests around links, first outermost, core last', async () => {
    const hooks = createNativeHooks({ 'e.x': ['a', 'b'] }, [
      { module: 'b', event: 'e.x', scope: 'all', around: async (e, _l, next) => `b(${await next(`${e}>b`)})` },
      { module: 'a', event: 'e.x', scope: 'all', around: async (e, _l, next) => `a(${await next(`${e}>a`)})` },
    ])
    const result = await hooks.around('e.x', 'in', {}, async e => `core:${e}`)
    expect(result).toBe('a(b(core:in>a>b))')
  })

  it('with no link calls core directly', async () => {
    const hooks = createNativeHooks({}, [])
    expect(await hooks.around('e.x', 1, {}, async e => (e as number) + 1)).toBe(2)
  })

  it('propagates a failing link by default', async () => {
    const hooks = createNativeHooks({ 'e.x': ['a'] }, [
      { module: 'a', event: 'e.x', scope: 'all', observe: () => { throw new Error('boom') } },
    ])
    await expect(hooks.observe('e.x', {}, {})).rejects.toThrow('boom')
  })

  it('skips a failing link that asked to be skipped, running beneath once', async () => {
    let coreRuns = 0
    const seen: string[] = []
    const hooks = createNativeHooks({ 'e.x': ['a', 'b'] }, [
      { module: 'a', event: 'e.x', scope: 'all', onError: 'skip', observe: () => { throw new Error('a') } },
      observer('b', seen),
    ])
    await expect(hooks.observe('e.x', {}, {})).resolves.toBeUndefined()
    expect(seen).toEqual(['b'])

    const around = createNativeHooks({ 'e.y': ['a'] }, [
      {
        module: 'a',
        event: 'e.y',
        scope: 'all',
        onError: 'skip',
        around: async (e, _l, next) => {
          await next(e)
          throw new Error('after next')
        },
      },
    ])
    const result = await around.around('e.y', 'v', {}, async e => {
      coreRuns++
      return `core:${e}`
    })
    expect(result).toBe('core:v')
    expect(coreRuns).toBe(1)
  })
})

describe('nativeHooksOf', () => {
  it('prefers the context registry over the installed one', () => {
    const own = createNativeHooks({}, [])
    expect(nativeHooksOf({ nativeHooks: own })).toBe(own)
    expect(nativeHooksOf(undefined)).not.toBe(own)
  })
})

describe('built-in registrations', () => {
  it('build without error and every registration is ordered', () => {
    expect(() => buildNativeHooks()).not.toThrow()
    for (const registration of nativeHookRegistrations()) {
      expect(NATIVE_HOOK_ORDER[registration.event]).toContain(registration.module)
    }
  })

  it('keeps the order table as reviewed', () => {
    expect(NATIVE_HOOK_ORDER).toMatchInlineSnapshot(`
      {
        "prompt.rerender": [
          "browser",
        ],
        "rows.gather": [
          "memory",
        ],
        "tool.settled": [
          "sessionActivity",
        ],
        "tool.started": [
          "sessionActivity",
        ],
        "turn.background": [
          "memory",
        ],
        "turn.end": [
          "memory",
        ],
        "turn.streamEnd": [
          "sessionActivity",
        ],
        "turn.streamStart": [
          "sessionActivity",
        ],
      }
    `)
  })
})
