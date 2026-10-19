/**
 * The Files pane search's pure parts (F-9): ranking file paths by where the query falls in the path, reading the filter box's
 * mode from what is typed, where "go up" leads, and splitting a result's text on its hit ranges.
 */
import { describe, expect, it } from 'vitest'
import { rankFilePaths } from '../browser/runtimeHub'
import {
  goUpTarget,
  highlightSegments,
  joinUnder,
  parseFilterInput,
  splitFoundPath,
} from '../browser/webview/panes/fileFind'

const ranked = (paths: string[], query: string, limit = 10) =>
  rankFilePaths(paths, query, limit).files.map(file => paths[file.index])

describe('rankFilePaths', () => {
  it('an exact name beats a prefix, a prefix beats a name that contains it, and those beat a scattered match', () => {
    const paths = ['src/xutilx.ts', 'lib/u_t_i_l.ts', 'a/utility.ts', 'deep/nested/util.ts', 'src/uxtxixl.ts']
    expect(ranked(paths, 'util')).toEqual([
      'deep/nested/util.ts',
      'a/utility.ts',
      'src/xutilx.ts',
      'src/uxtxixl.ts',
    ])
  })

  it('a match inside the name beats one spread over the folders', () => {
    const paths = ['main/app/nothing.ts', 'src/mainApp.ts']
    expect(ranked(paths, 'mapp')[0]).toBe('src/mainApp.ts')
  })

  it('ranges point at the hit in the path; matched counts every match, not only the head', () => {
    const paths = ['a/b/README.md', ...Array.from({ length: 30 }, (_, i) => `docs/readme-${i}.md`)]
    const result = rankFilePaths(paths, 'readme', 5)
    expect(result.matched).toBe(31)
    expect(result.files).toHaveLength(5)
    expect(result.files[0]).toEqual({ index: 0, ranges: [4, 10] })
  })

  it('a query without letters or digits matches as a plain substring', () => {
    expect(ranked(['a.b', 'ab', 'x/.env'], '.')).toEqual(['x/.env', 'a.b'])
  })

  it('a word matches the whole path: name bands, then a folder holding it (shorter first), then fuzzy in the name, then fuzzy in the folders', () => {
    const paths = [
      'cxustom_dir/a.ts',
      'src/custom_browser/tools/file_tool.cc',
      'cxuxsxtxoxm.ts',
      'a/custom_dir/x.txt',
      'my_custom.ts',
      'custom_tool.cc',
      'zz/custom.txt',
      'other/readme.md',
    ]
    expect(ranked(paths, 'custom')).toEqual([
      'zz/custom.txt',
      'custom_tool.cc',
      'my_custom.ts',
      'a/custom_dir/x.txt',
      'src/custom_browser/tools/file_tool.cc',
      'cxuxsxtxoxm.ts',
      'cxustom_dir/a.ts',
    ])
  })

  it('a hit in the folders is a range in the parent part of the path', () => {
    const result = rankFilePaths(['src/custom_browser/a.cc'], 'CUSTOM', 5)
    expect(result.files).toEqual([{ index: 0, ranges: [4, 10] }])
  })

  it('every space-separated word must match, in any order; ranges come back ordered', () => {
    const paths = ['src/custom_browser/tools/file_tool.cc', 'src/custom_browser/a.cc', 'tools/other.cc']
    expect(ranked(paths, 'custom tool')).toEqual(['src/custom_browser/tools/file_tool.cc'])
    expect(ranked(paths, 'tool  custom')).toEqual(['src/custom_browser/tools/file_tool.cc'])
    expect(rankFilePaths(paths, 'tool custom', 5).files[0]!.ranges).toEqual([4, 10, 30, 34])
  })

  it('matched counts folder hits the limit leaves out', () => {
    const paths = ['custom.ts', ...Array.from({ length: 80 }, (_, i) => `src/custom_browser/f${i}.cc`)]
    const result = rankFilePaths(paths, 'custom', 50)
    expect(result.matched).toBe(81)
    expect(result.files).toHaveLength(50)
    expect(paths[result.files[0]!.index]).toBe('custom.ts')
  })

  it('an empty query matches nothing', () => {
    expect(rankFilePaths(['a'], '  ', 10)).toEqual({ files: [], matched: 0 })
  })
})

describe('parseFilterInput', () => {
  it('reads the four modes', () => {
    expect(parseFilterInput('')).toEqual({ mode: 'tree' })
    expect(parseFilterInput('   ')).toEqual({ mode: 'tree' })
    expect(parseFilterInput('main')).toEqual({ mode: 'files', folder: '', query: 'main' })
    expect(parseFilterInput('src/lib/')).toEqual({ mode: 'folder', folder: 'src/lib' })
    expect(parseFilterInput('src\\lib\\')).toEqual({ mode: 'folder', folder: 'src/lib' })
    expect(parseFilterInput('./src//lib/ma')).toEqual({ mode: 'files', folder: 'src/lib', query: 'ma' })
    expect(parseFilterInput('?needle ')).toEqual({ mode: 'content', query: 'needle ' })
    expect(parseFilterInput('?')).toEqual({ mode: 'content', query: '' })
    expect(parseFilterInput('/')).toEqual({ mode: 'tree' })
  })
})

describe('goUpTarget', () => {
  it('a top folder goes up to the project files; a nested one to its parent scope', () => {
    expect(goUpTarget('src')).toEqual({ kind: 'root' })
    expect(goUpTarget('src/lib/deep')).toEqual({ kind: 'folder', name: 'lib', input: 'src/lib/' })
  })
})

describe('paths and highlights', () => {
  it('joins a relative path in the separator the base uses', () => {
    expect(joinUnder('/repo', 'a/b.ts')).toBe('/repo/a/b.ts')
    expect(joinUnder('C:\\repo\\', 'a/b.ts')).toBe('C:\\repo\\a\\b.ts')
    expect(joinUnder('/repo', '')).toBe('/repo')
  })

  it('splits a found path into name and parent', () => {
    expect(splitFoundPath('a/b/c.ts')).toEqual({ name: 'c.ts', parent: 'a/b', nameStart: 4 })
    expect(splitFoundPath('c.ts')).toEqual({ name: 'c.ts', parent: '', nameStart: 0 })
  })

  it('splits text on ranges measured from an offset, ignoring ranges outside it', () => {
    expect(highlightSegments('c.ts', [0, 1, 4, 6], 4)).toEqual([
      { text: 'c.', hit: true },
      { text: 'ts', hit: false },
    ])
    expect(highlightSegments('abc', [], 0)).toEqual([{ text: 'abc', hit: false }])
    expect(highlightSegments('abcdef', [1, 2, 4, 6], 0)).toEqual([
      { text: 'a', hit: false },
      { text: 'b', hit: true },
      { text: 'cd', hit: false },
      { text: 'ef', hit: true },
    ])
  })
})
