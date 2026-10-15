/**
 * `$.session.repo()` — the git repository the session runs in, read off the
 * working copy with no git process (`mods/sessionRepo.ts`).
 */
import { describe, expect, it } from 'vitest'
import { originUrlOf, readSessionRepo, type RepoFs } from '../mods/sessionRepo'

/** An fs of paths: a string is a file's text, `DIR` a directory. */
const DIR = Symbol('dir')
function fsOf(entries: Record<string, string | typeof DIR>): RepoFs {
  return {
    async stat(path) {
      const entry = entries[path]
      if (entry === undefined) throw new Error(`ENOENT ${path}`)
      return { isDirectory: () => entry === DIR, isFile: () => entry !== DIR }
    },
    async readFile(path) {
      const entry = entries[path]
      if (entry === undefined || entry === DIR) throw new Error(`ENOENT ${path}`)
      return entry
    },
  }
}

const CONFIG = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = https://github.com/acme/widgets.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[remote "backup"]
\turl = https://example.com/other.git
`

describe('originUrlOf', () => {
  it('reads the origin remote\'s url, push URL preferred, and no other remote', () => {
    expect(originUrlOf(CONFIG)).toBe('https://github.com/acme/widgets.git')
    expect(originUrlOf(CONFIG.replace('fetch =', 'pushurl = git@github.com:acme/widgets.git\n\tfetch ='))).toBe(
      'git@github.com:acme/widgets.git',
    )
    expect(originUrlOf('[remote "backup"]\n\turl = x\n')).toBeNull()
    expect(originUrlOf('')).toBeNull()
  })
})

describe('readSessionRepo', () => {
  it('finds the nearest .git directory above the cwd and its origin', async () => {
    const fs = fsOf({
      '/work/project/.git': DIR,
      '/work/project/.git/config': CONFIG,
    })
    await expect(readSessionRepo(fs, '/work/project/src/deep')).resolves.toEqual({
      root: '/work/project',
      remote: 'https://github.com/acme/widgets.git',
      internal: false,
      name: null,
    })
  })

  it('is null outside a repository, and never rejects', async () => {
    await expect(readSessionRepo(fsOf({}), '/work/elsewhere')).resolves.toBeNull()
    await expect(readSessionRepo(fsOf({}), 'C:\\Users\\u')).resolves.toBeNull()
    await expect(readSessionRepo(fsOf({}), '/')).resolves.toBeNull()
  })

  it('a repository with no origin has remote null', async () => {
    const fs = fsOf({ '/r/.git': DIR, '/r/.git/config': '[core]\n' })
    await expect(readSessionRepo(fs, '/r')).resolves.toEqual({ root: '/r', remote: null, internal: false, name: null })
    await expect(readSessionRepo(fsOf({ '/r/.git': DIR }), '/r')).resolves.toMatchObject({ root: '/r', remote: null })
  })

  it('a linked worktree reports the MAIN working tree\'s root and its config', async () => {
    const fs = fsOf({
      '/work/wt/.git': 'gitdir: /work/main/.git/worktrees/wt\n',
      '/work/main/.git/config': CONFIG,
    })
    await expect(readSessionRepo(fs, '/work/wt/sub')).resolves.toEqual({
      root: '/work/main',
      remote: 'https://github.com/acme/widgets.git',
      internal: false,
      name: null,
    })
  })

  it('a submodule is its own working tree, its config under the superproject', async () => {
    const fs = fsOf({
      '/work/super/lib/.git': 'gitdir: ../.git/modules/lib',
      '/work/super/.git/modules/lib/config': '[remote "origin"]\n\turl = https://example.com/lib.git\n',
    })
    await expect(readSessionRepo(fs, '/work/super/lib')).resolves.toEqual({
      root: '/work/super/lib',
      remote: 'https://example.com/lib.git',
      internal: false,
      name: null,
    })
  })

  it('Windows paths work, with the drive as the root', async () => {
    const fs = fsOf({ 'C:/work/p/.git': DIR, 'C:/work/p/.git/config': CONFIG })
    await expect(readSessionRepo(fs, 'C:\\work\\p\\src')).resolves.toMatchObject({ root: 'C:/work/p' })
  })
})
