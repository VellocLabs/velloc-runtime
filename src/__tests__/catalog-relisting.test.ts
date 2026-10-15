import { describe, expect, it } from 'vitest'
import { startCatalogRelisting } from '../mods/provider/catalogRelisting'
import { createProviderCatalogNoun } from '../mods/provider/nouns/providerCatalogNoun'

function rig(opts: {
  readKeys: Record<string, string[]>
  relist?: (id: string) => Promise<boolean>
}) {
  let listener: ((e: { providerKeys: string[] }) => void) | undefined
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const relisted: string[] = []
  const published: string[][] = []
  const reports: string[] = []
  const r = startCatalogRelisting({
    onCatalogUpdated: l => {
      listener = l
      return () => {
        listener = undefined
      }
    },
    providerIds: () => Object.keys(opts.readKeys),
    readKeysOf: id => opts.readKeys[id] ?? [],
    relist: async id => {
      relisted.push(id)
      return opts.relist ? opts.relist(id) : true
    },
    publish: async ids => {
      published.push(ids)
    },
    report: line => reports.push(line),
    timers: {
      set: fn => {
        const id = nextTimer++
        timers.set(id, fn)
        return id
      },
      clear: h => {
        timers.delete(h as number)
      },
    },
  })
  return {
    r,
    relisted,
    published,
    reports,
    emit: (...keys: string[]) => listener?.({ providerKeys: keys }),
    fire: async () => {
      const fns = [...timers.values()]
      timers.clear()
      fns.forEach(f => f())
      await r.idle()
    },
    pendingTimers: () => timers.size,
  }
}

describe('catalog relisting', () => {
  it('re-lists only the providers whose read keys intersect the update', async () => {
    const t = rig({ readKeys: { a: ['opencode'], b: ['anthropic'], c: [] } })
    t.emit('opencode', 'zai')
    await t.fire()
    expect(t.relisted).toEqual(['a'])
    expect(t.published).toEqual([['a']])
  })

  it('one update burst is one pass: events inside the window collapse, the publish is single', async () => {
    const t = rig({ readKeys: { a: ['k1'], b: ['k1', 'k2'], c: ['k3'] } })
    t.emit('k1')
    t.emit('k2')
    t.emit('k1')
    expect(t.pendingTimers()).toBe(1)
    await t.fire()
    expect(t.relisted.sort()).toEqual(['a', 'b'])
    expect(t.published.length).toBe(1)
    expect(t.published[0].sort()).toEqual(['a', 'b'])
  })

  it('a failed listing is left out of the publish and does not stop the others', async () => {
    const t = rig({
      readKeys: { a: ['k'], b: ['k'] },
      relist: async id => id !== 'a',
    })
    t.emit('k')
    await t.fire()
    expect(t.relisted).toEqual(['a', 'b'])
    expect(t.published).toEqual([['b']])
  })

  it('a listing that throws is reported and keeps going', async () => {
    const t = rig({
      readKeys: { a: ['k'], b: ['k'] },
      relist: async id => {
        if (id === 'a') throw new Error('mod crashed')
        return true
      },
    })
    t.emit('k')
    await t.fire()
    expect(t.published).toEqual([['b']])
    expect(t.reports.join('\n')).toContain('mod crashed')
  })

  it('publishes nothing when no listing landed', async () => {
    const t = rig({ readKeys: { a: ['k'] }, relist: async () => false })
    t.emit('k')
    await t.fire()
    expect(t.published).toEqual([])
  })

  it('a provider is never listed twice at once; a second pass waits for the first', async () => {
    let active = 0
    let maxActive = 0
    const gates: Array<() => void> = []
    const t = rig({
      readKeys: { a: ['k'] },
      relist: () =>
        new Promise<boolean>(resolve => {
          active++
          maxActive = Math.max(maxActive, active)
          gates.push(() => {
            active--
            resolve(true)
          })
        }),
    })
    t.emit('k')
    const first = t.fire()
    await Promise.resolve()
    t.emit('k')
    const second = t.fire()
    await new Promise(r => setTimeout(r, 0))
    expect(gates.length).toBe(1)
    gates.shift()!()
    await first
    await new Promise(r => setTimeout(r, 0))
    gates.shift()!()
    await second
    expect(maxActive).toBe(1)
    expect(t.relisted).toEqual(['a', 'a'])
  })

  it('dispose stops listening and drops a pending pass', async () => {
    const t = rig({ readKeys: { a: ['k'] } })
    t.emit('k')
    t.r.dispose()
    t.emit('k')
    await t.fire()
    expect(t.relisted).toEqual([])
  })

  it('the $.catalog noun feeds it: a key read directly or borrowed from triggers a re-list', async () => {
    const noun = createProviderCatalogNoun({
      models: async () => undefined,
      model: async (key, id) =>
        key === 'opencode-go' && id === 'glm'
          ? { name: 'glm', inputModalities: ['text'], match: 'borrowed', from: 'zai' }
          : undefined,
      status: async () => ({ source: 'none', models: 0 }),
    })
    await noun.table.model({ noun: 'catalog', method: 'model', args: ['opencode-go', 'glm', { alsoTry: ['zai'] }], providers: ['mod.go'] } as never)
    const seen: string[] = []
    let l: ((e: { providerKeys: string[] }) => void) | undefined
    startCatalogRelisting({
      onCatalogUpdated: fn => ((l = fn), () => {}),
      providerIds: () => ['mod.go', 'mod.other'],
      readKeysOf: noun.readKeysOf,
      relist: async id => (seen.push(id), true),
      publish: async () => {},
      report: () => {},
      debounceMs: 0,
    })
    l!({ providerKeys: ['zai'] })
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toEqual(['mod.go'])
    seen.length = 0
    l!({ providerKeys: ['unrelated'] })
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toEqual([])
  })
})
