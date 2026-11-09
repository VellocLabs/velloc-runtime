/**
 * The folders an app's background module declares (F-40): what a folder may
 * be, the `fs` value read and folded, a manifest's folders merged across its
 * apps, what an approval covers and what a change adds, and the expansion
 * under the home.
 */
import { describe, expect, it } from 'vitest'

import {
  addedFolderScopes,
  checkScopeFolder,
  coversFolderScopes,
  expandScopeFolder,
  folderScopesOf,
  mergeFolderScopes,
  readFolderScopes,
} from '../mods/app/appFolderScopes'

describe('checkScopeFolder', () => {
  it('takes a folder under the home and refuses the home itself, hidden folders, dots and backslashes', () => {
    expect(checkScopeFolder('~/Documents/invoices')).toBeNull()
    expect(checkScopeFolder('~/Downloads/')).toBeNull()
    expect(checkScopeFolder('~')).toMatch(/does not start with "~\/"/)
    expect(checkScopeFolder('~/')).toMatch(/whole home directory/)
    expect(checkScopeFolder('~//')).toMatch(/whole home directory/)
    expect(checkScopeFolder('/etc')).toMatch(/does not start with "~\/"/)
    expect(checkScopeFolder('~/.ssh')).toMatch(/hidden folder/)
    expect(checkScopeFolder('~/Documents/.velloc')).toMatch(/hidden folder/)
    expect(checkScopeFolder('~/Documents/../x')).toMatch(/holds "\.\."/)
    expect(checkScopeFolder('~/Documents//x')).toMatch(/empty segment/)
    expect(checkScopeFolder('~/Documents\\x')).toMatch(/backslash/)
    expect(checkScopeFolder(`~/${'a'.repeat(200)}`)).toMatch(/longer than 200/)
    expect(checkScopeFolder(7)).toBe('a folder is a string')
  })
})

describe('readFolderScopes', () => {
  it('reads read and write lists, folds duplicates and a read that is also written, and caps the count', () => {
    expect(readFolderScopes({ read: ['~/Downloads/', '~/Documents/invoices', '~/Downloads'], write: ['~/Documents/invoices'] })).toEqual({
      read: ['~/Downloads'],
      write: ['~/Documents/invoices'],
    })
    expect(readFolderScopes({})).toEqual({ read: [], write: [] })
    expect(readFolderScopes([])).toEqual({ error: 'expected { read?: string[], write?: string[] }' })
    expect(readFolderScopes({ read: '~/x' })).toEqual({ error: 'read: expected an array of folders' })
    expect(readFolderScopes({ write: ['~/.ssh'] })).toEqual({ error: 'write: "~/.ssh" names a hidden folder, which a plugin may not declare' })
    expect(readFolderScopes({ read: Array.from({ length: 9 }, (_, i) => `~/f${i}`) })).toEqual({ error: 'at most 8 folders' })
  })
})

describe('folderScopesOf and mergeFolderScopes', () => {
  it('merges the folders of every app template; a bad or empty value counts for nothing', () => {
    const manifest = {
      name: 'pay',
      templates: {
        board: { app: { background: { module: './bg.js', fs: { read: ['~/Downloads'], write: ['~/Documents/invoices'] } } } },
        notes: { app: { background: { module: './n.js', fs: { read: ['~/Documents/invoices', '~/Notes'] } } } },
        plain: { app: { background: './p.js' } },
        broken: { app: { background: { module: './b.js', fs: { read: ['~/.ssh'] } } } },
        empty: { app: { background: { module: './e.js', fs: {} } } },
      },
    }
    expect(folderScopesOf(manifest)).toEqual({ read: ['~/Downloads', '~/Notes'], write: ['~/Documents/invoices'] })
    expect(folderScopesOf({ name: 'pay' })).toBeUndefined()
    expect(folderScopesOf({ templates: { plain: { app: { background: './p.js' } } } })).toBeUndefined()
    expect(folderScopesOf(null)).toBeUndefined()
    expect(folderScopesOf({ templates: { board: { app: { background: './bg.js', backgroundFs: { read: ['~/Downloads'], write: [] } } } } })).toEqual({
      read: ['~/Downloads'],
      write: [],
    })
    expect(mergeFolderScopes(undefined, { read: ['~/a'], write: [] })).toEqual({ read: ['~/a'], write: [] })
    expect(mergeFolderScopes({ read: ['~/a'], write: [] }, { read: [], write: ['~/a'] })).toEqual({ read: [], write: ['~/a'] })
  })
})

describe('coversFolderScopes and addedFolderScopes', () => {
  const approved = { read: ['~/Downloads'], write: ['~/Documents/invoices'] }

  it('an approval covers the same folders, a read of a written folder, and fewer folders', () => {
    expect(coversFolderScopes(approved, approved)).toBe(true)
    expect(coversFolderScopes(approved, { read: ['~/Documents/invoices'], write: [] })).toBe(true)
    expect(coversFolderScopes(approved, { read: [], write: [] })).toBe(true)
    expect(addedFolderScopes(approved, undefined)).toBeUndefined()
  })

  it('a folder not approved, or a read-only one asked for writing, is added', () => {
    expect(addedFolderScopes(approved, { read: ['~/Downloads', '~/Pictures'], write: ['~/Downloads'] })).toEqual({
      read: ['~/Pictures'],
      write: ['~/Downloads'],
    })
    expect(coversFolderScopes(undefined, { read: ['~/Downloads'], write: [] })).toBe(false)
    expect(addedFolderScopes(undefined, { read: ['~/a'], write: ['~/b'] })).toEqual({ read: ['~/a'], write: ['~/b'] })
  })
})

describe('expandScopeFolder', () => {
  it('joins the folder under the home, dropping a trailing slash', () => {
    const slash = (path: string) => path.split('\\').join('/')
    expect(slash(expandScopeFolder('~/Documents/invoices/', 'C:/Users/u'))).toBe('C:/Users/u/Documents/invoices')
    expect(slash(expandScopeFolder('~/Downloads', '/home/u'))).toBe('/home/u/Downloads')
  })
})
