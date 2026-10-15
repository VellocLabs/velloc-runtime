/**
 * Provider mods PM-6b - the id map's life: written only when something was
 * added (debounced), read back lazily, bounded, tolerant of a corrupt file,
 * and deleted with the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ID_MAP_FILE_VERSION,
  IdCollisionError,
  IdMap,
  IdMapStores,
} from '../mods/provider/ids/idMapStore'
import { createProviderNouns } from '../mods/provider/nouns/providerNounTable'
import { FileSessionStores, MemorySessionStores, type SessionStoreFs } from '../mods/provider/nouns/sessionStore'
import { unavailableKeyVault } from '../mods/provider/nouns/providerNounDeps'

const ROOT = 'C:/home/.velloc/provider-sessions'
const PROVIDER = 'mod.acme.zen'

/** An in-memory filesystem with counters. */
function fakeFs() {
  const files = new Map<string, string>()
  const calls = { reads: 0, writes: 0, removes: [] as string[] }
  const fs: SessionStoreFs = {
    async readFile(path) {
      calls.reads++
      const text = files.get(path)
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    async writeFile(path, data) {
      calls.writes++
      files.set(path, data)
    },
    async ensureDir() {},
    async removeDir(dir) {
      calls.removes.push(dir)
      for (const path of [...files.keys()]) if (path.startsWith(`${dir}/`)) files.delete(path)
    },
  }
  return { fs, files, calls }
}

const idMapPath = (session: string) => `${ROOT}/${session}/${PROVIDER}.idmap.json`

function filed(options: { maxEntries?: number; maxLoaded?: number; flushDelayMs?: number } = {}) {
  const disk = fakeFs()
  const lines: string[] = []
  const backend = new FileSessionStores({ root: ROOT, fs: disk.fs })
  const stores = new IdMapStores(backend, { report: line => lines.push(line), flushDelayMs: 400, ...options })
  return { ...disk, backend, stores, lines }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the map itself', () => {
  it('maps both ways and refuses two ids for one wire id', () => {
    const map = new IdMap()
    map.add('toolCall', 'a', 'W1')
    map.add('toolCall', 'b', 'W2')
    expect(map.lookup('toolCall', 'a')).toBe('W1')
    expect(map.lookup('message', 'a')).toBeUndefined()
    expect(map.original('W2')).toEqual({ kind: 'toolCall', value: 'b' })
    expect(map.original('nope')).toBeUndefined()
    expect(() => map.add('toolCall', 'c', 'W1')).toThrow(IdCollisionError)
    // The same pair again is not a collision.
    expect(() => map.add('toolCall', 'a', 'W1')).not.toThrow()
    expect(map.size).toBe(2)
  })

  it('drops the oldest entry past its bound, from both sides', () => {
    const map = new IdMap(3)
    for (const n of [1, 2, 3, 4, 5]) map.add('toolCall', `id${n}`, `W${n}`)
    expect(map.size).toBe(3)
    expect(map.lookup('toolCall', 'id1')).toBeUndefined()
    expect(map.original('W2')).toBeUndefined()
    expect(map.lookup('toolCall', 'id3')).toBe('W3')
    expect(map.original('W5')).toEqual({ kind: 'toolCall', value: 'id5' })
  })

  it('parses only its own file shape', () => {
    expect(IdMap.parse('not json')).toBeNull()
    expect(IdMap.parse('{"version":2,"entries":[]}')).toBeNull()
    expect(IdMap.parse('{"version":1,"entries":[["toolCall","a"]]}')).toBeNull()
    expect(IdMap.parse('{"version":1,"entries":[["toolCall","a",3]]}')).toBeNull()
    expect(IdMap.parse(`{"version":${ID_MAP_FILE_VERSION},"entries":[["toolCall","a","W"]]}`)).toEqual([
      { kind: 'toolCall', value: 'a', mapped: 'W' },
    ])
  })
})

describe('persistence', () => {
  it('writes once, after a delay, however many entries were added; reads back across instances', async () => {
    const { stores, files, calls, backend } = filed()
    const map = await stores.open(PROVIDER, 'sess-1')
    map.add('toolCall', 'a', 'W1')
    map.add('toolCall', 'b', 'W2')
    map.add('session', 'sess-1', 'ses_x')
    expect(calls.writes).toBe(0)
    await vi.advanceTimersByTimeAsync(399)
    expect(calls.writes).toBe(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(calls.writes).toBe(1)
    expect(files.has(idMapPath('sess-1'))).toBe(true)

    // A new instance (a restart): the map is read lazily, on first open.
    const again = new IdMapStores(backend)
    const readsBefore = calls.reads
    const reopened = await again.open(PROVIDER, 'sess-1')
    expect(calls.reads).toBe(readsBefore + 1)
    expect(reopened.lookup('toolCall', 'b')).toBe('W2')
    expect(reopened.lookup('session', 'sess-1')).toBe('ses_x')
    expect(reopened.original('W1')).toEqual({ kind: 'toolCall', value: 'a' })
  })

  it('a fully cached request writes nothing and sets no timer', async () => {
    const { stores, calls } = filed()
    const map = await stores.open(PROVIDER, 'sess-1')
    map.add('toolCall', 'a', 'W1')
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.writes).toBe(1)
    for (let i = 0; i < 5; i++) {
      const same = await stores.open(PROVIDER, 'sess-1')
      expect(same.lookup('toolCall', 'a')).toBe('W1')
    }
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls.writes).toBe(1)
    expect(calls.reads).toBe(1)
  })

  it('a corrupt file is an empty map, said once, and the next write replaces it', async () => {
    const { stores, files, lines } = filed()
    files.set(idMapPath('sess-1'), '{"version":1,"entries":[["toolCall"')
    const map = await stores.open(PROVIDER, 'sess-1')
    expect(map.size).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/could not be read; it starts empty/)
    map.add('toolCall', 'a', 'W1')
    await vi.advanceTimersByTimeAsync(500)
    expect(IdMap.parse(files.get(idMapPath('sess-1'))!)).toEqual([{ kind: 'toolCall', value: 'a', mapped: 'W1' }])
    expect(lines).toHaveLength(1)
  })

  it('an unreadable or missing file is an empty map and no complaint', async () => {
    const { stores, lines } = filed()
    expect((await stores.open(PROVIDER, 'never-stored')).size).toBe(0)
    expect(lines).toEqual([])
  })

  it('a write that fails is said once, and kept for the next add', async () => {
    const { stores, fs, lines, calls } = (() => {
      const f = filed()
      return { ...f, fs: f.fs }
    })()
    let failing = true
    const write = fs.writeFile
    fs.writeFile = async (path, data, o) => {
      if (failing) throw new Error('disk full')
      return write(path, data, o)
    }
    const map = await stores.open(PROVIDER, 'sess-1')
    map.add('toolCall', 'a', 'W1')
    await vi.advanceTimersByTimeAsync(500)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/could not be saved \(disk full\)/)
    failing = false
    map.add('toolCall', 'b', 'W2')
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.writes).toBe(1)
    expect(lines).toHaveLength(1)
  })

  it('is bounded by entries: the file holds the newest', async () => {
    const { stores, files } = filed({ maxEntries: 3 })
    const map = await stores.open(PROVIDER, 'sess-1')
    for (const n of [1, 2, 3, 4, 5]) map.add('toolCall', `id${n}`, `W${n}`)
    await vi.advanceTimersByTimeAsync(500)
    expect(IdMap.parse(files.get(idMapPath('sess-1'))!)!.map(entry => entry.value)).toEqual(['id3', 'id4', 'id5'])
  })

  it('is bounded by maps in memory: the oldest is written, then read back when needed', async () => {
    const { stores, files, calls } = filed({ maxLoaded: 2 })
    const a = await stores.open(PROVIDER, 'sess-a')
    a.add('toolCall', 'a', 'Wa')
    await stores.open(PROVIDER, 'sess-b')
    expect(calls.writes).toBe(0)
    await stores.open(PROVIDER, 'sess-c') // sess-a leaves memory
    await vi.advanceTimersByTimeAsync(0)
    expect(files.has(idMapPath('sess-a'))).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    const back = await stores.open(PROVIDER, 'sess-a')
    expect(back.lookup('toolCall', 'a')).toBe('Wa')
  })

  it('without a session id the map is a fresh one that is never kept', async () => {
    const { stores, calls } = filed()
    const map = await stores.open(PROVIDER, undefined)
    map.add('toolCall', 'a', 'W1')
    expect((await stores.open(PROVIDER, undefined)).size).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls.writes).toBe(0)
  })

  it('a realm with no file backend keeps maps in memory for the realm', async () => {
    const stores = new IdMapStores(undefined)
    const map = await stores.open(PROVIDER, 'sess-1')
    map.add('toolCall', 'a', 'W1')
    expect(vi.getTimerCount()).toBe(0)
    expect((await stores.open(PROVIDER, 'sess-1')).lookup('toolCall', 'a')).toBe('W1')
  })

  it('the in-memory session backend keeps the file text for the session\'s life', async () => {
    const backend = new MemorySessionStores()
    const stores = new IdMapStores(backend)
    const map = await stores.open(PROVIDER, 'sess-1')
    map.add('toolCall', 'a', 'W1')
    await stores.flushAll()
    expect((await new IdMapStores(backend).open(PROVIDER, 'sess-1')).lookup('toolCall', 'a')).toBe('W1')
    await backend.end('sess-1')
    expect((await new IdMapStores(backend).open(PROVIDER, 'sess-1')).size).toBe(0)
  })
})

describe('deleted with the session', () => {
  function nounsFor(h: ReturnType<typeof filed>) {
    return createProviderNouns({
      vault: unavailableKeyVault,
      sessions: h.backend,
      idMaps: h.stores,
      device: () => ({}),
      declaredSecrets: () => [],
      writeProviderSecrets: async () => {},
    })
  }

  it('endProviderSession removes the file and cancels a write still waiting', async () => {
    const h = filed()
    const nouns = nounsFor(h)
    const map = await h.stores.open(PROVIDER, 'sess-1')
    map.add('toolCall', 'a', 'W1')
    await vi.advanceTimersByTimeAsync(500)
    expect(h.files.has(idMapPath('sess-1'))).toBe(true)

    map.add('toolCall', 'b', 'W2') // a write is now pending
    expect(vi.getTimerCount()).toBe(1)
    await nouns.endProviderSession('sess-1')
    expect(h.calls.removes).toEqual([`${ROOT}/sess-1`])
    expect(h.files.has(idMapPath('sess-1'))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.files.has(idMapPath('sess-1'))).toBe(false)
    // The map is forgotten: a later request of that id starts empty.
    expect((await h.stores.open(PROVIDER, 'sess-1')).size).toBe(0)
  })

  it('waits for a write already in flight, so it cannot land after the removal', async () => {
    const h = filed()
    const nouns = nounsFor(h)
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const write = h.fs.writeFile
    h.fs.writeFile = async (path, data, o) => {
      await gate
      return write(path, data, o)
    }
    const map = await h.stores.open(PROVIDER, 'sess-1')
    map.add('toolCall', 'a', 'W1')
    await vi.advanceTimersByTimeAsync(500) // the write starts and waits at the gate
    let ended = false
    const ending = nouns.endProviderSession('sess-1').then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(ended).toBe(false)
    release()
    await ending
    expect(h.files.has(idMapPath('sess-1'))).toBe(false)
  })

  it('leaves other sessions alone', async () => {
    const h = filed()
    const nouns = nounsFor(h)
    for (const session of ['sess-1', 'sess-2']) (await h.stores.open(PROVIDER, session)).add('toolCall', 'a', `W-${session}`)
    await vi.advanceTimersByTimeAsync(500)
    await nouns.endProviderSession('sess-1')
    expect(h.files.has(idMapPath('sess-2'))).toBe(true)
    expect((await h.stores.open(PROVIDER, 'sess-2')).lookup('toolCall', 'a')).toBe('W-sess-2')
  })

  it('an endProviderSession with no id maps in the realm still removes the stores', async () => {
    const h = filed()
    const nouns = createProviderNouns({
      vault: unavailableKeyVault,
      sessions: h.backend,
      device: () => ({}),
      declaredSecrets: () => [],
      writeProviderSecrets: async () => {},
    })
    await nouns.endProviderSession('sess-1')
    expect(h.calls.removes).toEqual([`${ROOT}/sess-1`])
  })
})
