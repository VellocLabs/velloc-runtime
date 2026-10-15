import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readLastFolderForType,
  writeLastFolderForType,
} from '../browser/webview/lastFolderByTypeStorage'
import { WorkspaceStore, resetWorkspaceStoreForTests } from '../browser/webview/workspaceStore'

/** A fresh workspace store per test, seeded from this test's storage. */
function freshStore(): void {
  resetWorkspaceStoreForTests(
    new WorkspaceStore(() => (globalThis as { localStorage?: Storage }).localStorage),
  )
}

// The vitest environment is `node`, so there is no `localStorage`. Install a
// minimal in-memory implementation around each test (same pattern as
// recent-folders-storage.test.ts) and tear it down after.
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
  originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
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

describe('lastFolderByTypeStorage', () => {
  it('round-trips a per-type folder', () => {
    writeLastFolderForType('code', '/home/me/repo')
    expect(readLastFolderForType('code')).toBe('/home/me/repo')
  })

  it('returns undefined for a type with no recorded folder', () => {
    expect(readLastFolderForType('chat')).toBeUndefined()
    writeLastFolderForType('code', '/a')
    // A different type is still untouched.
    expect(readLastFolderForType('chat')).toBeUndefined()
  })

  it('isolates folders ACROSS types — the core cross-type-leak guard', () => {
    // Bind code → A, then chat → B (a MORE-recent write of a DIFFERENT type).
    writeLastFolderForType('code', '/folder/A')
    writeLastFolderForType('chat', '/folder/B')
    // code must still resolve to A, NOT the most-recently-written B. (This is
    // exactly what the global recents MRU got wrong: recents[0] would be B.)
    expect(readLastFolderForType('code')).toBe('/folder/A')
    expect(readLastFolderForType('chat')).toBe('/folder/B')
  })

  it('overwrites only the same type on a re-bind', () => {
    writeLastFolderForType('code', '/old')
    writeLastFolderForType('chat', '/chatdir')
    writeLastFolderForType('code', '/new')
    expect(readLastFolderForType('code')).toBe('/new')
    expect(readLastFolderForType('chat')).toBe('/chatdir')
  })

  it('trims whitespace and ignores empty path / empty type', () => {
    writeLastFolderForType('code', '  /trim/me  ')
    expect(readLastFolderForType('code')).toBe('/trim/me')
    writeLastFolderForType('code', '   ')
    // Empty write is a no-op — the prior value stays.
    expect(readLastFolderForType('code')).toBe('/trim/me')
    writeLastFolderForType('', '/nope')
    expect(readLastFolderForType('')).toBeUndefined()
  })

  it('tolerates a corrupt cache (reads undefined, a write recovers)', () => {
    globalThis.localStorage?.setItem('nexus:workspace-cache', '{not json')
    freshStore()
    expect(readLastFolderForType('code')).toBeUndefined()
    writeLastFolderForType('code', '/recovered')
    expect(readLastFolderForType('code')).toBe('/recovered')
  })

  it('ignores non-string / non-object stored shapes', () => {
    globalThis.localStorage?.setItem('nexus:workspace-cache', '{"lastFolderByType":["array"]}')
    freshStore()
    expect(readLastFolderForType('code')).toBeUndefined()
    globalThis.localStorage?.setItem(
      'nexus:workspace-cache',
      JSON.stringify({ lastFolderByType: { code: 123, chat: '/ok' } }),
    )
    freshStore()
    expect(readLastFolderForType('code')).toBeUndefined()
    expect(readLastFolderForType('chat')).toBe('/ok')
  })
})
