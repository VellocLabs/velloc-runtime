/**
 * `$.store` and `$.state` (F-25): a plugin's own key-value file across
 * sessions, and the slot's in-memory versioned values, which survive a
 * worker restart and a rebuild over the slot's store but never a new slot.
 *
 * Real module text, loaded by `ModWorkerHost` on a MessageChannel. A mod
 * reports through `$.ui.log`, which lands in `reports`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { RAISED_EVENTS } from '../mods/modAdmission'
import { implementedNouns } from '../mods/modNouns'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { ModStateStore, toJsonData } from '../mods/modState'
import {
  FileModStore,
  MOD_STORE_CAP_BYTES,
  fileModStore,
  parseModStoreFile,
  pluginDirName,
  resetModStoresForTests,
  type ModStoreFs,
} from '../mods/modStore'
import { installModWorkerHost } from '../mods/ModWorkerHost'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(5)
  }
}

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
  resetModStoresForTests()
})

/** A disk of files, shared by every store and sidecar a test opens on it. */
function disk(): ModStoreFs & { files: Map<string, string>; writes: number; failWrites: boolean; failNext: number } {
  const files = new Map<string, string>()
  const d = {
    files,
    writes: 0,
    failWrites: false,
    /** Fail this many writes from now on, then succeed again. */
    failNext: 0,
    async readFile(path: string) {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    async writeFile(path: string, data: string) {
      if (d.failWrites) throw new Error('EACCES')
      if (d.failNext > 0) {
        d.failNext -= 1
        throw new Error('EBUSY')
      }
      d.writes += 1
      files.set(path, data)
    },
    async ensureDir() {},
  }
  return d
}

type Worker = ModWorkerHandle & { crash(): void }

function world(
  modules: Record<string, string>,
  options: {
    stateStore?: ModStateStore
    disk?: ReturnType<typeof disk>
    modsDir?: string
    onStateChanged?: (address: { plugin: string; key: string; id?: string }) => void
  } = {},
) {
  const reports: string[] = []
  const workers: Record<string, Worker[]> = {}
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({
    plugin,
    path: `/plugins/${plugin}/hooks/register.js`,
  }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path =>
      `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniqueLoad}`,
    openWorker: async (plugin): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      const worker: Worker = {
        port: channel.port1,
        closed,
        close: () => settle({ reason: 'closed' }),
        crash: () => settle({ reason: 'crashed' }),
      }
      ;(workers[plugin] ??= []).push(worker)
      return worker
    },
    session: {
      id: () => 'sess-store',
      cwd: () => '/work/project',
      ...(options.disk
        ? {
            store: (plugin: string) =>
              fileModStore(options.modsDir ?? '/home/u/.velloc/mods', plugin, options.disk!, {
                report: line => reports.push(line),
              }),
          }
        : {}),
    },
    report: line => reports.push(line),
    respawnBackoffMs: [10],
    ...(options.stateStore ? { stateStore: options.stateStore } : {}),
    ...(options.onStateChanged ? { onStateChanged: options.onStateChanged } : {}),
  })
  runtimes.push(runtime)
  return { runtime, reports, workers }
}

/** A `prompt.submit` hook that logs what `expr` evaluates to. */
const logging = (expr: string): string => `
  on('prompt.submit', async ($, e, next) => {
    try {
      await $.ui.log(JSON.stringify(await (${expr})))
    } catch (error) {
      await $.ui.log('ERR ' + error.name + ': ' + error.message)
    }
    return next(e)
  })
`

describe('the nouns are listed as raised events', () => {
  it('store.* and state.* are implemented and raised', () => {
    for (const noun of ['store.get', 'store.set', 'store.delete', 'store.keys', 'state.get', 'state.set']) {
      expect(implementedNouns(), noun).toContain(noun)
      expect(RAISED_EVENTS, noun).toContain(noun)
    }
  })
})

describe('toJsonData', () => {
  it('round-trips JSON data and refuses what is not', () => {
    expect(toJsonData({ a: 1, d: new Date(0), u: undefined, m: new Map() }, 'x')).toEqual({
      a: 1,
      d: '1970-01-01T00:00:00.000Z',
      m: {},
    })
    expect(() => toJsonData(undefined, '$.store.set')).toThrow(/may not be undefined/)
    expect(() => toJsonData(() => 1, '$.store.set')).toThrow(/not JSON data/)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => toJsonData(cycle, '$.store.set')).toThrow(/not JSON data/)
  })
})

describe('$.store', () => {
  it('get reads what set wrote; keys in insertion order; delete removes', async () => {
    const d = disk()
    const { runtime, reports } = world(
      {
        p: logging(`(async () => {
          const before = await $.store.get('count')
          await $.store.set('count', Number(before ?? 0) + 1)
          await $.store.set('10', 'ten')
          await $.store.set('b', { when: new Date(0), gone: undefined })
          await $.store.set('a', [1, 2])
          await $.store.delete('10')
          return { count: await $.store.get('count'), keys: await $.store.keys(), b: await $.store.get('b') }
        })()`),
      },
      { disk: d },
    )
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: {"count":1,"keys":["count","b","a"],"b":{"when":"1970-01-01T00:00:00.000Z"}}'])
    expect(parseModStoreFile(d.files.get('/home/u/.velloc/mods/p/store.json')!)).toEqual({
      version: 1,
      entries: [
        ['count', 1],
        ['b', { when: '1970-01-01T00:00:00.000Z' }],
        ['a', [1, 2]],
      ],
    })
  })

  it('is the plugin\'s own: two plugins have two files, and survives a new runtime', async () => {
    const d = disk()
    const a = world(
      {
        one: `on('session.start', async ($, e, next) => { await $.store.set('k', 'one'); return next(e) })`,
        two: `on('session.start', async ($, e, next) => { await $.store.set('k', 'two'); return next(e) })`,
      },
      { disk: d },
    )
    await a.runtime.ready
    await until(() => d.files.size === 2)
    a.runtime.dispose()
    resetModStoresForTests()
    const b = world({ one: logging("$.store.get('k')"), two: logging("$.store.get('k')") }, { disk: d })
    await b.runtime.ready
    await b.runtime.promptSubmit('hi')
    expect(b.reports.sort()).toEqual(['one: "one"', 'two: "two"'])
  })

  it('refuses a function, a cycle, undefined, and a store over the cap', async () => {
    const d = disk()
    const { runtime, reports } = world(
      {
        p: logging(`(async () => {
          const errors = []
          for (const value of [undefined, () => 1]) {
            errors.push(await $.store.set('x', value).then(() => 'set', e => e.name))
          }
          errors.push(await $.store.set('big', 'x'.repeat(${MOD_STORE_CAP_BYTES})).then(() => 'set', e => e.name))
          return { errors, keys: await $.store.keys() }
        })()`),
      },
      { disk: d },
    )
    await runtime.ready
    await runtime.promptSubmit('hi')
    // A function cannot cross the port at all: a TypeError from the worker.
    expect(reports).toEqual(['p: {"errors":["TypeError","TypeError","RangeError"],"keys":[]}'])
    expect(d.files.size).toBe(0)
  })

  it('a write that fails rolls the value back, so get reads what the disk holds', async () => {
    const d = disk()
    const store = new FileModStore({ path: '/m/p/store.json', dir: '/m/p', fs: d })
    await store.set('a', 1)
    d.failWrites = true
    await expect(store.set('a', 2)).rejects.toThrow('EACCES')
    await expect(store.set('b', 2)).rejects.toThrow('EACCES')
    await expect(store.delete('a')).rejects.toThrow('EACCES')
    expect(await store.get('a')).toBe(1)
    expect(await store.keys()).toEqual(['a'])
  })

  it('a failed write among concurrent ones leaves memory as the disk holds it', async () => {
    const d = disk()
    const store = new FileModStore({ path: '/m/p/store.json', dir: '/m/p', fs: d })
    await store.keys()
    d.failNext = 1
    const first = store.set('k', 1)
    const second = store.set('k', 2)
    await expect(first).rejects.toThrow('EBUSY')
    await second
    const onDisk = new FileModStore({ path: '/m/p/store.json', dir: '/m/p', fs: d })
    expect(await store.get('k')).toBe(2)
    expect(await onDisk.get('k')).toBe(2)
    // A failed delete keeps the key where it was in the order.
    await store.set('z', 3)
    d.failNext = 1
    const gone = store.delete('k')
    const kept = store.set('y', 4)
    await expect(gone).rejects.toThrow('EBUSY')
    await kept
    expect(await store.keys()).toEqual(['k', 'z', 'y'])
    expect(await new FileModStore({ path: '/m/p/store.json', dir: '/m/p', fs: d }).keys()).toEqual(['k', 'z', 'y'])
  })

  /** One runtime's fs over `d`: once `dispose()`d, every call fails as a sealed bridge scope does. */
  function runtimeFs(d: ReturnType<typeof disk>): ModStoreFs & { dispose(): void } {
    let disposed = false
    const live = <T>(call: () => Promise<T>): Promise<T> =>
      disposed ? Promise.reject(new Error('Runtime scope was disposed.')) : call()
    return {
      readFile: (path, options) => live(() => d.readFile(path, options)),
      writeFile: (path, data, options) => live(() => d.writeFile(path, data, options)),
      ensureDir: dir => live(() => d.ensureDir(dir)),
      dispose: () => {
        disposed = true
      },
    }
  }

  it('a runtime that opens the store after the first one ended still writes to disk', async () => {
    const d = disk()
    const first = runtimeFs(d)
    const a = fileModStore('/m', 'p', first)
    await a.set('k', 1)
    first.dispose()
    const b = fileModStore('/m', 'p', runtimeFs(d))
    await b.set('k', 2)
    expect(await b.get('k')).toBe(2)
    expect(parseModStoreFile(d.files.get('/m/p/store.json')!)?.entries).toEqual([['k', 2]])
    await expect(a.set('k', 3)).rejects.toThrow('Runtime scope was disposed.')
    expect(await b.get('k')).toBe(2)
  })

  it('a read through an ended runtime is not taken for an empty store', async () => {
    const d = disk()
    d.files.set('/m/p/store.json', JSON.stringify({ version: 1, entries: [['kept', 1]] }))
    const first = runtimeFs(d)
    first.dispose()
    await expect(fileModStore('/m', 'p', first).keys()).rejects.toThrow('Runtime scope was disposed.')
    const b = fileModStore('/m', 'p', runtimeFs(d))
    await b.set('added', 2)
    expect(await b.keys()).toEqual(['kept', 'added'])
    expect(parseModStoreFile(d.files.get('/m/p/store.json')!)?.entries).toEqual([['kept', 1], ['added', 2]])
  })

  it('a corrupt file reads as empty and is reported; a missing one is empty', async () => {
    const d = disk()
    d.files.set('/m/p/store.json', '{not json')
    const reports: string[] = []
    const store = new FileModStore({ path: '/m/p/store.json', dir: '/m/p', fs: d, report: l => reports.push(l) })
    expect(await store.keys()).toEqual([])
    expect(reports).toEqual(['mods: /m/p/store.json could not be read; the store starts empty'])
    const fresh = new FileModStore({ path: '/m/q/store.json', dir: '/m/q', fs: d })
    expect(await fresh.get('x')).toBeUndefined()
  })

  it('a plugin name is made a safe directory name', () => {
    expect(pluginDirName('my-plugin')).toBe('my-plugin')
    expect(pluginDirName('../etc')).toMatch(/^__etc-[0-9a-f]{8}$/)
    expect(pluginDirName('a/b\\c:d')).toMatch(/^a_b_c_d-[0-9a-f]{8}$/)
    expect(pluginDirName('')).toBe('_')
  })

  it('two different plugin names never share a store directory', () => {
    const names = ['foo/bar', 'foo:bar', 'foo\\bar', 'foo_bar', '@foo/bar', '.hidden', '_hidden']
    expect(new Set(names.map(pluginDirName)).size).toBe(names.length)
    expect(pluginDirName('foo_bar')).toBe('foo_bar') // already safe: unchanged
    expect(pluginDirName('foo/bar')).toBe(pluginDirName('foo/bar')) // stable
  })

  it('names that differ only in case get different directories (Windows paths ignore case)', () => {
    const upper = pluginDirName('Notes')
    expect(upper).toMatch(/^notes-[0-9a-f]{8}$/)
    expect(upper.toLowerCase()).not.toBe(pluginDirName('notes').toLowerCase())
    expect(pluginDirName('notes')).toBe('notes')
  })

  it('is an event: another mod may hook store.set and rewrite the value', async () => {
    const { runtime, reports } = world({
      guard: `on('store.set', { key: 'name' }, ($, e, next) => next({ ...e, value: e.value.toUpperCase() }))`,
      p: logging(`(async () => { await $.store.set('name', 'max'); return $.store.get('name') })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: "MAX"'])
  })
})

describe('$.state', () => {
  it('get is undefined at version 0; set bumps the version; any plugin reads it', async () => {
    const { runtime, reports } = world({
      owner: `on('session.start', async ($, e, next) => {
        const before = await $.state.get({ plugin: 'owner', key: 'count' })
        const a = await $.state.set({ plugin: 'owner', key: 'count' }, 1)
        const b = await $.state.set({ plugin: 'owner', key: 'count' }, 2)
        await $.ui.log(JSON.stringify({ before, a, b }))
        return next(e)
      })`,
      reader: logging("$.state.get({ plugin: 'owner', key: 'count' })"),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'owner: {"before":{"version":0},"a":{"isSet":true,"version":1},"b":{"isSet":true,"version":2}}',
      'reader: {"value":2,"version":2}',
    ])
  })

  it('ifVersion is compare-and-set: a stale version is refused and nothing changes', async () => {
    const { runtime, reports } = world({
      p: logging(`(async () => {
        const ref = { plugin: 'p', key: 'n' }
        await $.state.set(ref, 'first')
        const held = await $.state.get(ref)
        const ok = await $.state.set(ref, 'second', { ifVersion: held.version })
        const stale = await $.state.set(ref, 'third', { ifVersion: held.version })
        return { ok, stale, now: await $.state.get(ref) }
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'p: {"ok":{"isSet":true,"version":2},"stale":{"isSet":false,"version":2},"now":{"value":"second","version":2}}',
    ])
  })

  it('a StateFamily member is one value per id', async () => {
    const { runtime, reports } = world({
      p: logging(`(async () => {
        await $.state.set({ plugin: 'p', key: 'isOpen', id: 'a' }, true)
        await $.state.set({ plugin: 'p', key: 'isOpen', id: 'b' }, false)
        return [
          (await $.state.get({ plugin: 'p', key: 'isOpen', id: 'a' })).value,
          (await $.state.get({ plugin: 'p', key: 'isOpen', id: 'b' })).value,
          (await $.state.get({ plugin: 'p', key: 'isOpen' })).version,
        ]
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: [true,false,0]'])
  })

  it('its owner alone writes it: another plugin\'s set is refused by name, before any hook', async () => {
    const { runtime, reports } = world({
      watcher: `on('state.set', ($, e, next) => { $.ui.log('saw set ' + e.plugin + '.' + e.key); return next(e) })`,
      owner: `on('session.start', async ($, e, next) => { await $.state.set({ plugin: 'owner', key: 'v' }, 1); return next(e) })`,
      other: logging(`$.state.set({ plugin: 'owner', key: 'v' }, 2).catch(e => e.name + ': ' + e.message)`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual([
      'watcher: saw set owner.v',
      'other: "NotAllowedError: $.state.set: { plugin: \\"owner\\" } is another plugin\'s value; hook its state.set and rewrite e.value instead"',
    ])
  })

  it('a hook sees previous, may rewrite the value, and the reference is pinned', async () => {
    const { runtime, reports } = world({
      guard: `on('state.set', { plugin: 'p', key: 'n' }, async ($, e, next) => {
        $.ui.log('previous=' + JSON.stringify(e.previous) + ' value=' + e.value)
        return next({ ...e, plugin: 'guard', key: 'other', value: e.value * 10 })
      })`,
      p: logging(`(async () => {
        await $.state.set({ plugin: 'p', key: 'n' }, 1)
        await $.state.set({ plugin: 'p', key: 'n' }, 2)
        return [(await $.state.get({ plugin: 'p', key: 'n' })).value, (await $.state.get({ plugin: 'guard', key: 'other' })).version]
      })()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['guard: previous=undefined value=1', 'guard: previous=10 value=2', 'p: [20,0]'])
  })

  it('a bad reference, an undefined value, or a bad ifVersion is a TypeError', async () => {
    const { runtime, reports } = world({
      p: logging(`(async () => [
        await $.state.get({ key: 'x' }).catch(e => e.name),
        await $.state.set({ plugin: 'p', key: 'x' }, undefined).catch(e => e.name),
        await $.state.set({ plugin: 'p', key: 'x' }, 1, { ifVersion: 'latest' }).catch(e => e.name),
      ])()`),
    })
    await runtime.ready
    await runtime.promptSubmit('hi')
    expect(reports).toEqual(['p: ["TypeError","TypeError","TypeError"]'])
  })

  it('survives a worker restart: the module\'s variables start over, $.state does not', async () => {
    const { runtime, reports, workers } = world({
      p: `
        let local = 0
        on('session.start', async ($, e, next) => {
          local += 1
          const held = await $.state.get({ plugin: 'p', key: 'starts' })
          await $.state.set({ plugin: 'p', key: 'starts' }, (held.value ?? 0) + 1)
          await $.ui.log('local=' + local + ' starts=' + (held.value ?? 0) + '+1')
          return next(e)
        })
      `,
    })
    await runtime.ready
    expect(reports).toEqual(['p: local=1 starts=0+1'])
    workers.p![0]!.crash()
    await until(() => reports.includes('p: local=1 starts=1+1'))
    expect(reports.filter(line => line.startsWith('p: local'))).toEqual([
      'p: local=1 starts=0+1',
      'p: local=1 starts=1+1',
    ])
    expect(runtime.status()).toMatchObject([{ state: 'loaded', generation: 2 }])
  })
})

describe("the slot's $.state lifetime", () => {
  /** A mod that keeps a flag in `$.state` and seeds it from `$.store` at
   *  `session.start`, and a prompt hook that reports both. */
  const SEEDED = `
    const flag = { plugin: 'p', key: 'flag' }
    on('session.start', async ($, e, next) => {
      const r = await next(e)
      const stored = await $.store.get('flag')
      if (stored !== undefined) await $.state.set(flag, stored)
      return r
    })
    on('prompt.submit', async ($, e, next) => {
      if (e.text === 'flip') {
        const held = (await $.state.get(flag)).value === true
        await $.state.set(flag, !held)
        await $.store.set('flag', !held)
      } else {
        await $.ui.log('state=' + JSON.stringify((await $.state.get(flag)).value) + ' store=' + JSON.stringify(await $.store.get('flag')))
      }
      return next(e)
    })
  `

  it('a new slot starts empty and re-seeds from $.store, whatever the last slot held', async () => {
    const d = disk()
    const a = world({ p: SEEDED }, { disk: d })
    await a.runtime.ready
    await a.runtime.promptSubmit('flip')
    await a.runtime.state.set({ plugin: 'p', key: 'scratch' }, 7)
    await a.runtime.end()

    const b = world({ p: SEEDED + logging("$.state.get({ plugin: 'p', key: 'scratch' })") }, { disk: d })
    await b.runtime.ready
    await b.runtime.promptSubmit('hi')
    expect(b.reports).toEqual(['p: state=true store=true', 'p: {"version":0}'])
  })

  it("a runtime built over the slot's store keeps its values: the idle unload's reload", async () => {
    const slot = new ModStateStore()
    const a = world({ p: `on('session.start', async ($, e, next) => { await $.state.set({ plugin: 'p', key: 'n' }, 5); return next(e) })` }, { stateStore: slot })
    await a.runtime.ready
    await a.runtime.end('other')

    const b = world({ p: logging("$.state.get({ plugin: 'p', key: 'n' })") }, { stateStore: slot })
    await b.runtime.ready
    await b.runtime.promptSubmit('hi')
    expect(b.reports).toEqual(['p: {"value":5,"version":1}'])
  })

  it("a runtime that ended stops hearing the slot's store; the one built after it hears it", async () => {
    const slot = new ModStateStore()
    const heardByA: string[] = []
    const heardByB: string[] = []
    const a = world({ p: `on('prompt.submit', ($, e, next) => next(e))` }, { stateStore: slot, onStateChanged: x => heardByA.push(x.key) })
    await a.runtime.ready
    slot.set({ plugin: 'p', key: 'before' }, 1)
    await a.runtime.end('other')
    const b = world({ p: `on('prompt.submit', ($, e, next) => next(e))` }, { stateStore: slot, onStateChanged: x => heardByB.push(x.key) })
    await b.runtime.ready
    slot.set({ plugin: 'p', key: 'after' }, 1)
    expect(heardByA).toEqual(['before'])
    expect(heardByB).toEqual(['after'])
  })

  it('watch names every address a set lands on, never a refused one; the undo stops it', () => {
    const changed: string[] = []
    const store = new ModStateStore()
    const unwatch = store.watch(a => changed.push(`${a.plugin}.${a.key}${a.id ? '#' + a.id : ''}`))
    store.set({ plugin: 'p', key: 'a' }, 1)
    store.set({ plugin: 'p', key: 'a' }, 2, 7)
    store.set({ plugin: 'p', key: 'b', id: 'x' }, 2)
    unwatch()
    store.set({ plugin: 'p', key: 'c' }, 3)
    expect(changed).toEqual(['p.a', 'p.b#x'])
    expect(store.entries().map(e => e.key)).toEqual(['a', 'b', 'c'])
  })
})
