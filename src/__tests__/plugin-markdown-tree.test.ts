import { describe, expect, it } from 'vitest'
import type { RuntimeFsEntry, RuntimeFs } from '../utils/fs/runtimeFs'
import { visitMarkdownFiles } from '../pluginHost/markdownTree'

/** Minimal readdir-only fs over a list of file paths. */
function treeFs(files: string[], unreadable: string[] = []): RuntimeFs {
  const readdir = async (dir: string): Promise<RuntimeFsEntry[]> => {
    if (unreadable.includes(dir)) throw new Error('EACCES')
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    const seen = new Map<string, boolean>()
    for (const f of files) {
      if (!f.startsWith(prefix)) continue
      const rest = f.slice(prefix.length).split('/')
      const isDir = rest.length > 1
      seen.set(rest[0], (seen.get(rest[0]) ?? false) || isDir)
    }
    if (seen.size === 0) throw new Error('ENOENT')
    return [...seen].map(([name, isDir]) => ({
      name,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    }))
  }
  return { readdir } as unknown as RuntimeFs
}

async function collect(
  root: string,
  fs: RuntimeFs,
  skillDirsAreLeaves?: boolean,
): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = []
  await visitMarkdownFiles(root, (p, folders) => void out.push([p, folders.join(':')]), {
    fs,
    skillDirsAreLeaves,
  })
  return out.sort()
}

describe('visitMarkdownFiles', () => {
  it('visits every .md file with the folders between root and file', async () => {
    const fs = treeFs(['/r/a.md', '/r/x/b.md', '/r/x/y/c.md', '/r/notes.txt'])
    expect(await collect('/r', fs)).toEqual([
      ['/r/a.md', ''],
      ['/r/x/b.md', 'x'],
      ['/r/x/y/c.md', 'x:y'],
    ])
  })

  it('matches the extension case-insensitively', async () => {
    const fs = treeFs(['/r/A.MD', '/r/b.Md'])
    expect((await collect('/r', fs)).map(e => e[0])).toEqual(['/r/A.MD', '/r/b.Md'])
  })

  it('descends into skill directories by default', async () => {
    const fs = treeFs(['/r/s/SKILL.md', '/r/s/ref/deep.md'])
    expect((await collect('/r', fs)).map(e => e[0])).toEqual(['/r/s/SKILL.md', '/r/s/ref/deep.md'])
  })

  it('treats a directory with SKILL.md (any case) as a leaf when asked', async () => {
    const fs = treeFs(['/r/s/skill.MD', '/r/s/extra.md', '/r/s/ref/deep.md', '/r/t/u/v.md'])
    expect((await collect('/r', fs, true)).map(e => e[0])).toEqual([
      '/r/s/extra.md',
      '/r/s/skill.MD',
      '/r/t/u/v.md',
    ])
  })

  it('skips a directory that cannot be listed and keeps walking', async () => {
    const fs = treeFs(['/r/bad/x.md', '/r/good/y.md'], ['/r/bad'])
    expect((await collect('/r', fs)).map(e => e[0])).toEqual(['/r/good/y.md'])
  })

  it('resolves for an unreadable root', async () => {
    expect(await collect('/missing', treeFs([]))).toEqual([])
  })

  it('resolves only after async visits settle', async () => {
    const fs = treeFs(['/r/a.md', '/r/x/b.md'])
    const done: string[] = []
    await visitMarkdownFiles(
      '/r',
      async p => {
        await new Promise(r => setTimeout(r, 5))
        done.push(p)
      },
      { fs },
    )
    expect(done.sort()).toEqual(['/r/a.md', '/r/x/b.md'])
  })
})
