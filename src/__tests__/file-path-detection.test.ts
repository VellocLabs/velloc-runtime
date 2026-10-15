import { describe, expect, it } from 'vitest'

import {
  MAX_PATH_CANDIDATES_PER_TEXT,
  asWholeFilePath,
  extractFilePathCandidates,
  resolveCandidatePath,
} from '../utils/filePathDetection'

/**
 * The matcher is tuned for false NEGATIVES: a missed path is invisible, a wrong
 * one is a `>>` affordance that opens nothing. So the "does not match" cases
 * below are the load-bearing ones — dates, fractions, URLs and prose with
 * slashes all look like relative paths to a naive regex.
 */

const paths = (text: string): string[] =>
  extractFilePathCandidates(text).map(c => c.path)

describe('extractFilePathCandidates — finds real paths', () => {
  it('finds a bare relative path with an extension', () => {
    expect(paths('see src/utils/format.ts for details')).toEqual([
      'src/utils/format.ts',
    ])
  })

  it('finds a Windows absolute path in either slash flavour', () => {
    expect(paths('open D:\\work\\repo\\app\\package.json now')).toEqual([
      'D:\\work\\repo\\app\\package.json',
    ])
    expect(paths('open D:/work/repo/x.cc')).toEqual([
      'D:/work/repo/x.cc',
    ])
  })

  it('finds a POSIX absolute path', () => {
    expect(paths('config at /etc/nginx/nginx.conf here')).toEqual([
      '/etc/nginx/nginx.conf',
    ])
  })

  it('finds explicitly relative paths', () => {
    expect(paths('run ./scripts/build.mjs')).toEqual(['./scripts/build.mjs'])
    expect(paths('and ../shared/x.ts too')).toEqual(['../shared/x.ts'])
  })

  it('splits off a :line[:col] suffix', () => {
    const [only] = extractFilePathCandidates('thread.tsx at src/a/thread.tsx:877 ok')
    expect(only).toMatchObject({ path: 'src/a/thread.tsx', line: 877 })
    const [colcol] = extractFilePathCandidates('src/a/b.ts:12:34')
    expect(colcol).toMatchObject({ path: 'src/a/b.ts', line: 12 })
  })

  it('strips trailing sentence punctuation', () => {
    expect(paths('it lives in src/a/b.ts.')).toEqual(['src/a/b.ts'])
    expect(paths('(see src/a/b.ts), then')).toEqual(['src/a/b.ts'])
  })

  it('finds several paths and reports their offsets', () => {
    const text = 'both src/a.ts and src/b.ts changed'
    const found = extractFilePathCandidates(text)
    expect(found.map(c => c.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(text.slice(found[1].index, found[1].index + found[1].raw.length))
      .toBe('src/b.ts')
  })

  it('finds a CJK-named relative path (and never mis-reads it as absolute)', () => {
    // `\w` excludes CJK, so the bare-relative branch used to fail on 文档 and
    // the POSIX-absolute branch grabbed the tail as `/说明.md` — a wrong,
    // absolute candidate. The whole thing is one relative path.
    expect(paths('看 文档/说明.md 这个文件')).toEqual(['文档/说明.md'])
    expect(paths('see docs/说明.md ok')).toEqual(['docs/说明.md'])
  })

  it('trims glued CJK prose before a Latin path start', () => {
    // Chinese has no inter-word spaces, so prose arrives glued to the path.
    expect(paths('改了src/a.ts，然后继续')).toEqual(['src/a.ts'])
    // …but a PURE-CJK first segment is a real dirname, not prose.
    expect(paths('看 文档/说明.md 这个文件')).toEqual(['文档/说明.md'])
    // The offset must track the trim (the remark splitter slices by it).
    const [only] = extractFilePathCandidates('改了src/a.ts，然后')
    expect('改了src/a.ts，然后'.slice(only.index, only.index + only.raw.length))
      .toBe('src/a.ts')
  })

  it('terminates at Chinese punctuation with no space before it', () => {
    // Chinese prose puts no space between a path and the following punctuation;
    // the punctuation must end the match or the path is swallowed and lost.
    expect(paths('改了src/a.ts，然后继续')).toEqual(['src/a.ts'])
    expect(paths('见src/a.ts。')).toEqual(['src/a.ts'])
    expect(paths('（见 src/a.ts）')).toEqual(['src/a.ts'])
    expect(paths('路径是D:\\repo\\x.cc；对吧')).toEqual(['D:\\repo\\x.cc'])
  })

  it('caps how many candidates one text run can produce', () => {
    const text = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`).join(' ')
    expect(extractFilePathCandidates(text)).toHaveLength(
      MAX_PATH_CANDIDATES_PER_TEXT,
    )
  })
})

describe('extractFilePathCandidates — rejects things that merely look like paths', () => {
  it('ignores URLs', () => {
    expect(paths('see https://example.com/docs/guide.md for more')).toEqual([])
    expect(paths('http://localhost:5173/src/main.ts')).toEqual([])
  })

  it('ignores scp/git remotes', () => {
    expect(paths('git@github.com:velloclabs/velloc-runtime.git')).toEqual([])
  })

  it('ignores dates and fractions', () => {
    expect(paths('on 12/25/2026 we shipped')).toEqual([])
    expect(paths('about 1/2 of the time')).toEqual([])
  })

  it('ignores prose with slashes', () => {
    expect(paths('and/or something')).toEqual([])
    expect(paths('TODO/FIXME markers')).toEqual([])
  })

  it('ignores a bare relative path with no extension', () => {
    // Too weak a signal to spend a probe on.
    expect(paths('the src/utils directory')).toEqual([])
  })

  it('still accepts a rooted path with no extension (the probe decides)', () => {
    expect(paths('cd /usr/local/bin now')).toEqual(['/usr/local/bin'])
  })

  it('ignores a bare word with no separator at all', () => {
    expect(paths('package.json is fine')).toEqual([])
  })
})

describe('asWholeFilePath', () => {
  it('accepts a string that is entirely one path', () => {
    expect(asWholeFilePath('  src/a/b.ts  ')).toMatchObject({
      path: 'src/a/b.ts',
    })
  })

  it('accepts a whole path with a line suffix', () => {
    expect(asWholeFilePath('src/a/b.ts:42')).toMatchObject({
      path: 'src/a/b.ts',
      line: 42,
    })
  })

  it('rejects a string that merely CONTAINS a path', () => {
    expect(asWholeFilePath('see src/a/b.ts here')).toBeNull()
    expect(asWholeFilePath('npm run build')).toBeNull()
  })
})

describe('resolveCandidatePath', () => {
  it('returns an absolute path unchanged', () => {
    expect(resolveCandidatePath('/etc/hosts', '/repo')).toBe('/etc/hosts')
    expect(resolveCandidatePath('D:\\a\\b.ts', '/repo')).toBe('D:\\a\\b.ts')
  })

  it('joins a relative path to the project root — and only that', () => {
    expect(resolveCandidatePath('src/a.ts', '/repo')).toBe('/repo/src/a.ts')
    expect(resolveCandidatePath('./src/a.ts', '/repo/')).toBe('/repo/src/a.ts')
  })

  it('follows the root separator style', () => {
    expect(resolveCandidatePath('src/a.ts', 'D:\\repo')).toBe('D:\\repo\\src\\a.ts')
  })

  it('gives up rather than guessing when there is no project root', () => {
    expect(resolveCandidatePath('src/a.ts', undefined)).toBeNull()
  })
})
