import { describe, expect, it } from 'vitest'
import {
  getParentDir,
  walkParentDirs,
} from '../utils/walkParentDirs'

describe('getParentDir', () => {
  it.each([
    ['/home/user/project/sub', '/home/user/project'],
    ['/home/user/project', '/home/user'],
    ['/home/user', '/home'],
    ['/home', '/'],
    ['/', '/'],
    ['C:\\Users\\me\\project', 'C:\\Users\\me'],
    ['C:\\Users\\me', 'C:\\Users'],
    ['C:\\Users', 'C:\\'],
    ['C:\\', 'C:\\'],
    ['C:/Users/me', 'C:/Users'],
    ['C:/Users', 'C:/'],
  ])('parent of %s is %s', (input, expected) => {
    expect(getParentDir(input)).toBe(expected)
  })

  it('strips trailing slash before computing parent', () => {
    expect(getParentDir('/home/user/')).toBe('/home')
    expect(getParentDir('C:\\Users\\me\\')).toBe('C:\\Users')
  })
})

describe('walkParentDirs', () => {
  function collect(
    start: string,
    homeDir?: string,
  ): Array<{ dir: string; isHome: boolean; isRoot: boolean }> {
    return Array.from(walkParentDirs(start, { homeDir }))
  }

  it('walks POSIX cwd to filesystem root when no homeDir', () => {
    const dirs = collect('/home/user/project')
    expect(dirs.map(d => d.dir)).toEqual([
      '/home/user/project',
      '/home/user',
      '/home',
      '/',
    ])
    expect(dirs.at(-1)?.isRoot).toBe(true)
  })

  it('walks Windows cwd to drive root when no homeDir', () => {
    const dirs = collect('C:\\Users\\me\\project')
    expect(dirs.map(d => d.dir)).toEqual([
      'C:\\Users\\me\\project',
      'C:\\Users\\me',
      'C:\\Users',
      'C:\\',
    ])
    expect(dirs.at(-1)?.isRoot).toBe(true)
  })

  it('stops at homeDir (inclusive) when home is an ancestor of cwd', () => {
    const dirs = collect('/home/user/project/sub', '/home/user')
    expect(dirs.map(d => d.dir)).toEqual([
      '/home/user/project/sub',
      '/home/user/project',
      '/home/user',
    ])
    expect(dirs.at(-1)?.isHome).toBe(true)
  })

  it('walks to root when homeDir is not an ancestor of cwd', () => {
    const dirs = collect('/var/lib/foo', '/home/user')
    expect(dirs.map(d => d.dir)).toEqual([
      '/var/lib/foo',
      '/var/lib',
      '/var',
      '/',
    ])
    expect(dirs.find(d => d.isHome)).toBeUndefined()
  })

  it('matches home across slash styles', () => {
    // homeDir given with backslashes, cwd with forward slashes — should
    // still recognize when they meet.
    const dirs = collect('C:/Users/me/project', 'C:\\Users\\me')
    expect(dirs.map(d => d.dir)).toEqual([
      'C:/Users/me/project',
      'C:/Users/me',
    ])
    expect(dirs.at(-1)?.isHome).toBe(true)
  })

  it('matches home with drive-letter case insensitivity', () => {
    const dirs = collect('c:/Users/me/project', 'C:/Users/me')
    expect(dirs.at(-1)?.isHome).toBe(true)
  })

  it('starting at homeDir itself yields only home', () => {
    const dirs = collect('/home/user', '/home/user')
    expect(dirs).toHaveLength(1)
    expect(dirs[0]?.isHome).toBe(true)
  })

  it('starting at root yields only root', () => {
    const dirs = collect('/')
    expect(dirs).toHaveLength(1)
    expect(dirs[0]?.isRoot).toBe(true)
  })

  it('respects maxDepth as a safety net', () => {
    const dirs = Array.from(
      walkParentDirs('/a/b/c/d/e/f', { maxDepth: 3 }),
    )
    expect(dirs).toHaveLength(3)
    expect(dirs[0]?.dir).toBe('/a/b/c/d/e/f')
    expect(dirs[2]?.dir).toBe('/a/b/c/d')
  })
})
