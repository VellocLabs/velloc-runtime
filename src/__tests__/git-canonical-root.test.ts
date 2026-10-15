import { describe, expect, it } from 'vitest'
import { mainRepoRoot } from '../utils/gitInfo'
import {
  unconfiguredFs,
  type RuntimeFsEntry,
  type RuntimeFs,
  type RuntimeFsStat,
} from '../utils/fs/runtimeFs'

type Entry =
  | { kind: 'file'; content?: string }
  | { kind: 'dir' }

function fakeStat(kind: 'file' | 'dir'): RuntimeFsStat {
  return {
    size: 0,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isCharacterDevice: () => false,
    isBlockDevice: () => false,
  }
}

function makeFs(tree: Record<string, Entry>): RuntimeFs {
  return {
    ...unconfiguredFs,
    async stat(path: string): Promise<RuntimeFsStat> {
      const entry = tree[path]
      if (!entry) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return fakeStat(entry.kind)
    },
    async readFile(path: string): Promise<string> {
      const entry = tree[path]
      if (!entry || entry.kind !== 'file' || entry.content === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return entry.content
    },
    async readdir(): Promise<RuntimeFsEntry[]> {
      throw new Error('not implemented')
    },
  } as RuntimeFs
}

describe('mainRepoRoot', () => {
  it('returns the working tree when .git is a directory at cwd', async () => {
    const fs = makeFs({
      '/repo/.git': { kind: 'dir' },
    })
    expect(await mainRepoRoot('/repo', fs)).toBe('/repo')
  })

  it('walks up from a subdir to find the repo root', async () => {
    const fs = makeFs({
      '/repo/.git': { kind: 'dir' },
    })
    expect(await mainRepoRoot('/repo/src/foo', fs)).toBe('/repo')
  })

  it('returns undefined when no .git is found', async () => {
    const fs = makeFs({})
    expect(
      await mainRepoRoot('/some/dir', fs, { homeDir: '/some' }),
    ).toBeUndefined()
  })

  it('resolves a worktree pointer to the main repo working tree', async () => {
    // Worktree layout:
    //   /main-repo/.git           ← directory (real repo)
    //   /main-repo/.git/worktrees/feature   ← worktree metadata
    //   /worktrees/feature/.git   ← file with gitdir: /main-repo/.git/worktrees/feature
    //
    // mainRepoRoot('/worktrees/feature/sub') should return
    // '/main-repo'.
    const fs = makeFs({
      '/worktrees/feature/.git': {
        kind: 'file',
        content: 'gitdir: /main-repo/.git/worktrees/feature\n',
      },
    })
    expect(
      await mainRepoRoot('/worktrees/feature/sub', fs, {
        homeDir: '/worktrees',
      }),
    ).toBe('/main-repo')
  })

  it('returns undefined when .git file body lacks gitdir:', async () => {
    const fs = makeFs({
      '/somewhere/.git': {
        kind: 'file',
        content: 'random garbage\n',
      },
    })
    expect(
      await mainRepoRoot('/somewhere', fs, { homeDir: '/' }),
    ).toBeUndefined()
  })

  it('stops at home boundary', async () => {
    // .git lives above home, but the walk should stop before reaching
    // it because the home directory bounds the search.
    const fs = makeFs({
      '/home/user/project': { kind: 'dir' },
      '/.git': { kind: 'dir' },
    })
    expect(
      await mainRepoRoot('/home/user/project', fs, {
        homeDir: '/home/user',
      }),
    ).toBeUndefined()
  })
})
