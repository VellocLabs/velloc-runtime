import { describe, expect, it } from 'vitest'
import type { RuntimeFs, RuntimeFsEntry, RuntimeFsStat } from '../utils/fs/runtimeFs'
import { listMemoryFiles, renderMemoryManifest } from '../memory/memoryManifest'

// A tiny in-memory tree: files carry text + mtime; directories are implied
// by the paths. `unreadable` directories throw on readdir.
function treeFs(
  files: Record<string, { text: string; mtimeMs?: number }>,
  unreadable: string[] = [],
): RuntimeFs {
  const dirsOf = new Map<string, Map<string, 'file' | 'dir'>>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/') || '/'
      const children = dirsOf.get(dir) ?? new Map()
      children.set(parts[i]!, i === parts.length - 1 ? 'file' : 'dir')
      dirsOf.set(dir, children)
    }
  }
  const stat = (mtimeMs?: number): RuntimeFsStat =>
    ({ size: 0, mtimeMs, isFile: () => true, isDirectory: () => false }) as RuntimeFsStat
  return {
    async readdir(dir: string): Promise<RuntimeFsEntry[]> {
      if (unreadable.includes(dir)) throw new Error('EACCES')
      const children = dirsOf.get(dir)
      if (!children) throw new Error('ENOENT')
      return [...children].map(([name, kind]) => ({
        name,
        isFile: () => kind === 'file',
        isDirectory: () => kind === 'dir',
      })) as RuntimeFsEntry[]
    },
    async stat(path: string) {
      const f = files[path]
      if (!f) throw new Error('ENOENT')
      return stat(f.mtimeMs)
    },
    async readFile(path: string) {
      const f = files[path]
      if (!f) throw new Error('ENOENT')
      return f.text
    },
  } as unknown as RuntimeFs
}

const signal = () => new AbortController().signal

describe('listMemoryFiles', () => {
  it('lists .md topic files, nested ones by relative name, never MEMORY.md', async () => {
    const fs = treeFs({
      '/mem/MEMORY.md': { text: '- index', mtimeMs: 9 },
      '/mem/user_role.md': { text: 'x', mtimeMs: 3 },
      '/mem/notes.txt': { text: 'x', mtimeMs: 4 },
      '/mem/team/feedback.md': { text: 'x', mtimeMs: 2 },
      '/mem/team/MEMORY.md': { text: 'x', mtimeMs: 5 },
    })
    const found = await listMemoryFiles('/mem', signal(), fs)
    expect(found.map(f => f.filename)).toEqual(['user_role.md', 'team/feedback.md'])
    expect(found[1]!.filePath).toBe('/mem/team/feedback.md')
  })

  it('ignores directories nested deeper than five levels', async () => {
    const fs = treeFs({
      '/mem/a/b/c/d/e/ok.md': { text: 'x', mtimeMs: 1 },
      '/mem/a/b/c/d/e/f/too-deep.md': { text: 'x', mtimeMs: 1 },
    })
    const names = (await listMemoryFiles('/mem', signal(), fs)).map(f => f.filename)
    expect(names).toEqual(['a/b/c/d/e/ok.md'])
  })

  it('reads description and type from frontmatter, stripping matching quotes', async () => {
    const fs = treeFs({
      '/mem/a.md': {
        text: '---\nname: a\ndescription: "likes tabs"\ntype: \'feedback\'\n---\nbody',
        mtimeMs: 1,
      },
    })
    const [entry] = await listMemoryFiles('/mem', signal(), fs)
    expect(entry!.description).toBe('likes tabs')
    expect(entry!.type).toBe('feedback')
  })

  it('reports no fields without a closing --- line, and unknown types as undefined', async () => {
    const fs = treeFs({
      '/mem/open.md': { text: '---\ndescription: never closed\nbody', mtimeMs: 2 },
      '/mem/odd.md': { text: '---\ntype: diary\ndescription: d\r\n---\nbody\r\n', mtimeMs: 1 },
    })
    const [open, odd] = await listMemoryFiles('/mem', signal(), fs)
    expect(open!.description).toBeNull()
    expect(open!.type).toBeUndefined()
    expect(odd!.type).toBeUndefined()
    expect(odd!.description).toBe('d')
  })

  it('sorts newest first and keeps at most 200 entries', async () => {
    const files: Record<string, { text: string; mtimeMs: number }> = {}
    for (let i = 0; i < 205; i++) files[`/mem/m${i}.md`] = { text: 'x', mtimeMs: i }
    const found = await listMemoryFiles('/mem', signal(), treeFs(files))
    expect(found).toHaveLength(200)
    expect(found[0]!.filename).toBe('m204.md')
    expect(found[199]!.filename).toBe('m5.md')
  })

  it('skips an unreadable subdirectory and keeps scanning', async () => {
    const fs = treeFs(
      {
        '/mem/locked/hidden.md': { text: 'x', mtimeMs: 1 },
        '/mem/open.md': { text: 'x', mtimeMs: 1 },
      },
      ['/mem/locked'],
    )
    const names = (await listMemoryFiles('/mem', signal(), fs)).map(f => f.filename)
    expect(names).toEqual(['open.md'])
  })

  it('returns nothing once the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fs = treeFs({ '/mem/a.md': { text: 'x', mtimeMs: 1 } })
    expect(await listMemoryFiles('/mem', controller.signal, fs)).toEqual([])
  })
})

describe('renderMemoryManifest', () => {
  it('formats each entry on one line, omitting the absent type or description', () => {
    const text = renderMemoryManifest([
      { filename: 'a.md', filePath: '/m/a.md', mtimeMs: 0, description: 'about a', type: 'user' },
      { filename: 'b.md', filePath: '/m/b.md', mtimeMs: 0, description: null, type: undefined },
    ])
    expect(text).toBe(
      '- [user] a.md (1970-01-01T00:00:00.000Z): about a\n- b.md (1970-01-01T00:00:00.000Z)',
    )
  })

  it('is empty for an empty list', () => {
    expect(renderMemoryManifest([])).toBe('')
  })
})
