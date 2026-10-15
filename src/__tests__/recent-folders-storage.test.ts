import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_RECENT_FOLDERS,
  addRecentFolder,
  readRecentFolders,
} from '../browser/webview/recentFoldersStorage'
import { WorkspaceStore, resetWorkspaceStoreForTests } from '../browser/webview/workspaceStore'

// The list lives in the workspace store (the runtime's state, mirrored); a
// fresh store per test, seeded from this test's storage, with a clock the test
// sets so timestamps are deterministic.
let clock = 0
function at<T>(time: number, run: () => T): T {
  clock = time
  return run()
}
function freshStore(): void {
  resetWorkspaceStoreForTests(
    new WorkspaceStore(() => (globalThis as { localStorage?: Storage }).localStorage, () => clock),
  )
}

// The vitest environment is `node`, so there is no `localStorage`. Install a
// minimal in-memory implementation around each test and tear it down after, so
// other suites still see the real (absent) global.
let originalDescriptor: PropertyDescriptor | undefined

function installMemoryLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  const mock: Pick<
    Storage,
    'getItem' | 'setItem' | 'removeItem' | 'clear' | 'key' | 'length'
  > = {
    getItem: key => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key, value) => {
      store.set(key, String(value))
    },
    removeItem: key => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: index => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: mock,
    configurable: true,
    writable: true,
  })
  return store
}

beforeEach(() => {
  originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  )
  installMemoryLocalStorage()
  freshStore()
})

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage
  }
  originalDescriptor = undefined
  resetWorkspaceStoreForTests()
})

describe('recentFoldersStorage', () => {
  it('round-trips a folder with a derived basename + timestamp', () => {
    at(1000, () => addRecentFolder('/home/me/my project'))
    const folders = readRecentFolders()
    expect(folders).toHaveLength(1)
    expect(folders[0]).toEqual({
      path: '/home/me/my project',
      name: 'my project',
      lastUsedAt: 1000,
    })
  })

  it('derives the basename for Windows paths too', () => {
    at(1, () => addRecentFolder('C:\\Users\\me\\repo'))
    expect(readRecentFolders()[0]?.name).toBe('repo')
  })

  it('dedupes by exact path, moves the entry to the front, refreshes its time', () => {
    at(1, () => addRecentFolder('/a'))
    at(2, () => addRecentFolder('/b'))
    at(3, () => addRecentFolder('/a')) // re-open /a
    const folders = readRecentFolders()
    expect(folders.map(f => f.path)).toEqual(['/a', '/b'])
    expect(folders[0]).toMatchObject({ path: '/a', lastUsedAt: 3 })
  })

  it('keeps newest-first ordering', () => {
    at(1, () => addRecentFolder('/first'))
    at(2, () => addRecentFolder('/second'))
    at(3, () => addRecentFolder('/third'))
    expect(readRecentFolders().map(f => f.path)).toEqual([
      '/third',
      '/second',
      '/first',
    ])
  })

  it(`caps the list at MAX_RECENT_FOLDERS (${MAX_RECENT_FOLDERS})`, () => {
    for (let i = 0; i < MAX_RECENT_FOLDERS + 5; i++) {
      at(i, () => addRecentFolder(`/folder-${i}`))
    }
    const folders = readRecentFolders()
    expect(folders).toHaveLength(MAX_RECENT_FOLDERS)
    // Newest (highest index) is first; the oldest 5 fell off the tail.
    expect(folders[0]?.path).toBe(`/folder-${MAX_RECENT_FOLDERS + 4}`)
    expect(folders.some(f => f.path === '/folder-0')).toBe(false)
  })

  it('ignores empty / whitespace-only paths', () => {
    at(1, () => addRecentFolder('/real'))
    expect(at(2, () => addRecentFolder(''))).toEqual(readRecentFolders())
    expect(at(3, () => addRecentFolder('   '))).toEqual(readRecentFolders())
    expect(readRecentFolders().map(f => f.path)).toEqual(['/real'])
  })

  it('tolerates a corrupt cache → an empty list', () => {
    globalThis.localStorage.setItem('nexus:workspace-cache', 'definitely-not-json')
    freshStore()
    expect(readRecentFolders()).toEqual([])
  })

  it('tolerates a non-array cached list → an empty list', () => {
    globalThis.localStorage.setItem('nexus:workspace-cache', '{"recentFolders":{"path":"/x"}}')
    freshStore()
    expect(readRecentFolders()).toEqual([])
  })

  it('skips malformed entries but keeps valid ones, re-deriving a missing name', () => {
    globalThis.localStorage.setItem(
      'nexus:workspace-cache',
      JSON.stringify({
        recentFolders: [
          { path: '/good/alpha' }, // missing name + lastUsedAt
          { path: 42 }, // wrong type → dropped
          { notAPath: true }, // no path → dropped
          { path: '/good/beta', name: 'custom', lastUsedAt: 7 },
        ],
      }),
    )
    freshStore()
    const folders = readRecentFolders()
    expect(folders).toEqual([
      { path: '/good/alpha', name: 'alpha', lastUsedAt: 0 },
      { path: '/good/beta', name: 'custom', lastUsedAt: 7 },
    ])
  })

  it('works without localStorage (the cache is only a cache)', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    freshStore()
    expect(readRecentFolders()).toEqual([])
    expect(() => at(1, () => addRecentFolder('/x'))).not.toThrow()
    expect(readRecentFolders().map(f => f.path)).toEqual(['/x'])
  })
})
