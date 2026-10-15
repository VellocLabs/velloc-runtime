import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_ADDED_PROJECTS,
  addProject,
  projectDisplayName,
  readAddedProjects,
  readProjectsCollapsed,
  removeProject,
  writeProjectsCollapsed,
} from '../browser/webview/projectsStorage'
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
// minimal in-memory implementation around each test (same pattern as
// last-folder-by-type-storage.test.ts) and tear it down after.
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

let store: Map<string, string>

beforeEach(() => {
  originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  store = installMemoryLocalStorage()
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

describe('projectsStorage', () => {
  it('returns an empty list when nothing was ever stored', () => {
    expect(readAddedProjects()).toEqual([])
  })

  it('round-trips an added project', () => {
    at(1000, () => addProject('D:\\work\\repo'))
    expect(readAddedProjects()).toEqual([
      { path: 'D:\\work\\repo', addedAt: 1000 },
    ])
  })

  it('puts the newest addition first', () => {
    at(1, () => addProject('/a'))
    at(2, () => addProject('/b'))
    expect(readAddedProjects().map(p => p.path)).toEqual(['/b', '/a'])
  })

  it('dedupes by exact path and refreshes the timestamp', () => {
    at(1, () => addProject('/a'))
    at(2, () => addProject('/b'))
    at(3, () => addProject('/a'))
    expect(readAddedProjects()).toEqual([
      { path: '/a', addedAt: 3 },
      { path: '/b', addedAt: 2 },
    ])
  })

  it('treats different casings as different projects (the on-disk dir is case-sensitive)', () => {
    at(1, () => addProject('/Repo'))
    at(2, () => addProject('/repo'))
    expect(readAddedProjects()).toHaveLength(2)
  })

  it('trims surrounding whitespace and ignores a blank path', () => {
    at(1, () => addProject('  /a  '))
    at(2, () => addProject('   '))
    expect(readAddedProjects().map(p => p.path)).toEqual(['/a'])
  })

  it('caps the list, dropping the oldest entries', () => {
    for (let i = 0; i < MAX_ADDED_PROJECTS + 5; i++) at(i, () => addProject(`/p${i}`))
    const stored = readAddedProjects()
    expect(stored).toHaveLength(MAX_ADDED_PROJECTS)
    expect(stored[0].path).toBe(`/p${MAX_ADDED_PROJECTS + 4}`)
  })

  it('removes a project', () => {
    at(1, () => addProject('/a'))
    at(2, () => addProject('/b'))
    expect(removeProject('/a').map(p => p.path)).toEqual(['/b'])
    expect(readAddedProjects().map(p => p.path)).toEqual(['/b'])
  })

  it('keys on the same normalisation a tree node uses, so a delete cannot miss', () => {
    // A node's identity is `normalizeProjectPath` (trim + strip trailing
    // separators) and that is the path a delete passes back. If the picker
    // returns a trailing separator, a trim-only key would store `/a/`, fail to
    // match `/a`, and leave the entry behind — the project would come back as
    // an empty node.
    at(1, () => addProject('/a/'))
    expect(readAddedProjects().map(p => p.path)).toEqual(['/a'])
    expect(removeProject('/a')).toEqual([])
    expect(readAddedProjects()).toEqual([])
  })

  it('treats a trailing-separator variant as the SAME project when adding', () => {
    at(1, () => addProject('/a'))
    at(2, () => addProject('/a/'))
    expect(readAddedProjects()).toEqual([{ path: '/a', addedAt: 2 }])
  })

  it('a cached entry that predates the normalisation seeds the list normalised', () => {
    store.set('nexus:workspace-cache', '{"projects":[{"path":"/a/","addedAt":1}]}')
    freshStore()
    expect(readAddedProjects().map(p => p.path)).toEqual(['/a'])
  })

  it('tolerates a corrupt cache', () => {
    store.set('nexus:workspace-cache', '{not json')
    freshStore()
    expect(readAddedProjects()).toEqual([])
  })

  it('tolerates a non-array cached list and malformed entries', () => {
    store.set('nexus:workspace-cache', '{"projects":{"path":"/a"}}')
    freshStore()
    expect(readAddedProjects()).toEqual([])
    store.set('nexus:workspace-cache', '{"projects":[{"path":""},{"nope":1},{"path":"/ok"}]}')
    freshStore()
    expect(readAddedProjects()).toEqual([{ path: '/ok', addedAt: 0 }])
  })

  it('never throws when localStorage is unavailable', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    freshStore()
    expect(() => at(1, () => addProject('/a'))).not.toThrow()
    expect(readAddedProjects().map(p => p.path)).toEqual(['/a'])
  })

  describe('the Projects section collapsed flag', () => {
    it('starts COLLAPSED on a profile that never touched it', () => {
      // The sidebar's first screen is Recents; Projects opens on request.
      expect(readProjectsCollapsed()).toBe(true)
    })

    it('round-trips both directions', () => {
      writeProjectsCollapsed(false)
      expect(store.get('nexus:sidebar:projectsCollapsed')).toBe('0')
      expect(readProjectsCollapsed()).toBe(false)
      writeProjectsCollapsed(true)
      expect(store.get('nexus:sidebar:projectsCollapsed')).toBe('1')
      expect(readProjectsCollapsed()).toBe(true)
    })

    it('treats anything but an explicit "0" as collapsed', () => {
      // Only "the user expanded it" opens the section — a stale or garbled
      // value must not decide the sidebar's opening shape.
      for (const value of ['1', '', 'true', 'expanded']) {
        store.set('nexus:sidebar:projectsCollapsed', value)
        expect(readProjectsCollapsed()).toBe(true)
      }
    })

    it('falls back to collapsed when localStorage is unavailable', () => {
      delete (globalThis as { localStorage?: unknown }).localStorage
      expect(readProjectsCollapsed()).toBe(true)
      expect(() => writeProjectsCollapsed(false)).not.toThrow()
    })
  })

  describe('projectDisplayName', () => {
    it('takes the last segment of a Windows path', () => {
      expect(projectDisplayName('D:\\work\\repo')).toBe('repo')
    })

    it('takes the last segment of a POSIX path', () => {
      expect(projectDisplayName('/home/me/repo')).toBe('repo')
    })

    it('ignores a trailing separator', () => {
      expect(projectDisplayName('/home/me/repo/')).toBe('repo')
      expect(projectDisplayName('D:\\work\\repo\\')).toBe('repo')
    })
  })
})
