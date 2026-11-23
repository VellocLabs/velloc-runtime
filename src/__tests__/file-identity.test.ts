import { describe, expect, it } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { createFileIdentityResolver, FILE_IDENTITY_CACHE_MAX } from '../utils/fileIdentity'
import { normalizePathKey } from '../utils/paths'

/** A file system of `.git` entries: a directory, a file's text, or a file that cannot be read. */
function makeFs(entries: Record<string, 'dir' | 'unreadable' | string>) {
  const stats: string[] = []
  const key = (path: string) => normalizePathKey(path).replace(/\/+$/, '')
  const lookup = new Map(Object.entries(entries).map(([path, value]) => [key(path), value]))
  const fs = {
    stat: async (path: string) => {
      stats.push(key(path))
      const value = lookup.get(key(path))
      if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isDirectory: () => value === 'dir', isFile: () => value !== 'dir' }
    },
    readFile: async (path: string) => {
      const value = lookup.get(key(path))
      if (value === undefined || value === 'dir' || value === 'unreadable') throw new Error('EACCES')
      return value
    },
  }
  return { fs: fs as unknown as RuntimeFs, stats }
}

const WORKSPACE = {
  'D:/ws/.git': 'dir',
  'D:/ws/app/.git': 'dir',
  'D:/ws/.wt/fix/app/.git': 'gitdir: D:/ws/app/.git/worktrees/fix\n',
  'D:/ws/app/.git/worktrees/fix/commondir': '../..\n',
  'D:/ws/.wt/rel/app/.git': 'gitdir: ../../../app/.git/worktrees/rel\n',
  'D:/ws/app/.git/worktrees/rel/commondir': '../..\n',
  'D:/ws/app/vendor/lib/.git': 'gitdir: ../../.git/modules/vendor/lib\n',
  'D:/elsewhere/lib/.git': 'gitdir: D:/ws/app/.git/modules/vendor/lib/worktrees/lib\n',
  'D:/ws/app/.git/modules/vendor/lib/worktrees/lib/commondir': '../..\n',
  'D:/ws/app/.git/modules/vendor/lib/config': '[core]\n\trepositoryformatversion = 0\n\tworktree = ../../../../vendor/lib\n',
  // The submodule `vendor/lib` as checked out inside the linked worktree `fix`: its git dir has no commondir.
  'D:/ws/.wt/fix/app/vendor/lib/.git': 'gitdir: ../../../../../app/.git/worktrees/fix/modules/vendor/lib\n',
  // A submodule of a repository that itself sits under a `worktrees` folder.
  'D:/ws/worktrees/top/.git': 'dir',
  'D:/ws/worktrees/top/sub/.git': 'gitdir: ../.git/modules/sub\n',
  'D:/ws/bare.git/config': '[core]\n\tbare = true\n',
  'D:/ws/bare-wt/.git': 'gitdir: D:/ws/bare.git/worktrees/bare-wt\n',
  'D:/ws/bare.git/worktrees/bare-wt/commondir': '../..\n',
  'D:/noconf/.git': 'gitdir: D:/gone/worktrees/x\n',
  'D:/gone/worktrees/x/commondir': '../..\n',
  'D:/broken/.git': 'unreadable',
  'C:/.git': 'dir',
  '//nas/code/proj/.git': 'dir',
  '//nas/code/fix/.git': 'gitdir: \\\\nas\\code\\proj\\.git\\worktrees\\fix\n',
  '//nas/code/proj/.git/worktrees/fix/commondir': '../..\n',
}

describe('file identity', () => {
  const resolve = (path: string) => createFileIdentityResolver(makeFs(WORKSPACE).fs, { homeDir: 'C:\\Users\\me' })(path)

  it('names a file of the main checkout by its repository and relative path', async () => {
    expect(await resolve('D:\\ws\\notes.md')).toEqual({ repo: 'd:/ws', path: 'notes.md' })
  })

  it('gives a nested repository its own identity, nearest .git first', async () => {
    expect(await resolve('D:\\ws\\app\\src\\a.ts')).toEqual({ repo: 'd:/ws/app', path: 'src/a.ts' })
  })

  it('folds a linked worktree into its main repository and keeps the worktree root', async () => {
    expect(await resolve('D:\\ws\\.wt\\fix\\app\\src\\a.ts')).toEqual({ repo: 'd:/ws/app', worktree: 'd:/ws/.wt/fix/app', path: 'src/a.ts' })
    expect(await resolve('D:/ws/.wt/rel/app/src/a.ts')).toEqual({ repo: 'd:/ws/app', worktree: 'd:/ws/.wt/rel/app', path: 'src/a.ts' })
  })

  it('treats a submodule as its own repository, and folds a worktree of it through the module config', async () => {
    expect(await resolve('D:\\ws\\app\\vendor\\lib\\x.ts')).toEqual({ repo: 'd:/ws/app/vendor/lib', path: 'x.ts' })
    expect(await resolve('D:\\elsewhere\\lib\\x.ts')).toEqual({ repo: 'd:/ws/app/vendor/lib', worktree: 'd:/elsewhere/lib', path: 'x.ts' })
  })

  it('stops at the home directory: a file there outside any repository keeps its absolute path', async () => {
    const { fs, stats } = makeFs(WORKSPACE)
    const identity = await createFileIdentityResolver(fs, { homeDir: 'C:\\Users\\me' })('C:\\Users\\me\\.config\\x.json')
    expect(identity).toEqual({ path: 'c:/Users/me/.config/x.json' })
    expect(stats).toEqual(['c:/Users/me/.config/.git', 'c:/Users/me/.git'])
  })

  it('takes a .git file it cannot read as the root of its own repository', async () => {
    expect(await resolve('D:\\broken\\src\\a.ts')).toEqual({ repo: 'd:/broken', path: 'src/a.ts' })
  })

  it('leaves a worktree whose common dir has no readable config as its own repository', async () => {
    expect(await resolve('D:\\noconf\\a.ts')).toEqual({ repo: 'd:/noconf', path: 'a.ts' })
  })

  it('gives a submodule checked out in a linked worktree its own identity, not the superproject paths', async () => {
    expect(await resolve('D:\\ws\\.wt\\fix\\app\\vendor\\lib\\a.ts')).toEqual({ repo: 'd:/ws/.wt/fix/app/vendor/lib', path: 'a.ts' })
  })

  it('does not take a worktrees folder in a submodule path for a linked worktree', async () => {
    expect(await resolve('D:\\ws\\worktrees\\top\\sub\\a.ts')).toEqual({ repo: 'd:/ws/worktrees/top/sub', path: 'a.ts' })
  })

  it('folds a worktree of a bare repository into the bare directory', async () => {
    expect(await resolve('D:\\ws\\bare-wt\\a.ts')).toEqual({ repo: 'd:/ws/bare.git', worktree: 'd:/ws/bare-wt', path: 'a.ts' })
  })

  it('keys a long-path spelling like the plain one, and keeps a UNC share through a worktree fold', async () => {
    expect(await resolve('\\\\?\\D:\\ws\\notes.md')).toEqual(await resolve('D:\\ws\\notes.md'))
    expect(await resolve('\\\\nas\\code\\proj\\a.ts')).toEqual({ repo: '//nas/code/proj', path: 'a.ts' })
    expect(await resolve('\\\\?\\UNC\\nas\\code\\fix\\a.ts')).toEqual({ repo: '//nas/code/proj', worktree: '//nas/code/fix', path: 'a.ts' })
  })

  it('stops at home however its case is spelled', async () => {
    const { fs, stats } = makeFs(WORKSPACE)
    await createFileIdentityResolver(fs, { homeDir: 'C:\\Users\\me' })('c:/users/ME/x.json')
    expect(stats).toEqual(['c:/users/ME/.git'])
  })

  it('folds separators and the drive letter only, keeping the case of the rest', async () => {
    expect(await resolve('d:/ws/Src/A.ts')).toEqual({ repo: 'd:/ws', path: 'Src/A.ts' })
    expect(await resolve('D:\\ws\\Src\\A.ts')).toEqual(await resolve('d:/ws/Src/A.ts'))
  })

  it('works on POSIX paths', async () => {
    const { fs } = makeFs({ '/home/me/proj/.git': 'dir' })
    const resolver = createFileIdentityResolver(fs, { homeDir: '/home/me' })
    expect(await resolver('/home/me/proj/lib/a.ts')).toEqual({ repo: '/home/me/proj', path: 'lib/a.ts' })
    expect(await resolver('/home/me/notes.txt')).toEqual({ path: '/home/me/notes.txt' })
  })

  it('answers a second file in a directory it has walked without reading the disk again', async () => {
    const { fs, stats } = makeFs(WORKSPACE)
    const resolver = createFileIdentityResolver(fs)
    await resolver('D:\\ws\\app\\src\\deep\\a.ts')
    const first = stats.length
    expect(await resolver('D:\\ws\\app\\src\\deep\\b.ts')).toEqual({ repo: 'd:/ws/app', path: 'src/deep/b.ts' })
    expect(await resolver('D:\\ws\\app\\src\\c.ts')).toEqual({ repo: 'd:/ws/app', path: 'src/c.ts' })
    expect(stats.length).toBe(first)
    await resolver('D:\\ws\\app\\src\\other\\d.ts')
    expect(stats.slice(first)).toEqual(['d:/ws/app/src/other/.git'])
  })

  it('shares one walk between lookups made at the same time', async () => {
    const { fs, stats } = makeFs(WORKSPACE)
    const resolver = createFileIdentityResolver(fs)
    await Promise.all([resolver('D:\\ws\\app\\src\\deep\\a.ts'), resolver('D:\\ws\\app\\src\\deep\\b.ts')])
    expect(stats).toEqual(['d:/ws/app/src/deep/.git', 'd:/ws/app/src/.git', 'd:/ws/app/.git'])
  })

  it('starts its cache over once it holds the maximum number of directories', async () => {
    const { fs, stats } = makeFs(WORKSPACE)
    const resolver = createFileIdentityResolver(fs)
    await resolver('D:\\ws\\notes.md')
    for (let i = 0; i < FILE_IDENTITY_CACHE_MAX; i += 1) await resolver(`D:\\ws\\d${i}\\a.ts`)
    expect(stats.filter(path => path === 'd:/ws/.git')).toHaveLength(2)
  })
})
