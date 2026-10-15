import { describe, expect, it } from 'vitest'
import {
  createFileHelpers,
  resolveHelperPath,
} from '../browser/runJs/fileHelpers'
import type { RunJsFsOp } from '../browser/runJs/runJsProtocol'

type Call = { op: RunJsFsOp; payload: Record<string, unknown> }

/** Stub broker: records calls, delegates results to `impl` — the same seam the
 *  real helpers get (a `callFs` closure over the data pipe). */
function stubFs(
  impl: (op: RunJsFsOp, payload: Record<string, unknown>) => unknown,
): {
  calls: Call[]
  callFs: (op: RunJsFsOp, payload: Record<string, unknown>) => Promise<unknown>
} {
  const calls: Call[] = []
  return {
    calls,
    callFs: async (op, payload) => {
      calls.push({ op, payload })
      return impl(op, payload)
    },
  }
}

function namedError(name: string, message = name): never {
  const err = new Error(message)
  err.name = name
  throw err
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const text = (b: unknown) => new TextDecoder().decode(b as Uint8Array)

/** Absolute payloads carry `{ path, root }`; the broker joins them before it
 *  touches disk, and so does the tree below. */
function joinPayload(payload: Record<string, unknown>): string {
  const path = typeof payload.path === 'string' ? payload.path : ''
  const root = typeof payload.root === 'string' ? payload.root : ''
  if (root === '') return path
  if (path === '') return root
  return root.endsWith('/') ? `${root}${path}` : `${root}/${path}`
}

/** An in-memory tree behind `stubFs` — the same seam, one layer up: enough of
 *  the broker's op contract for a multi-op helper (NotFoundError on a missing
 *  stat/readdir/readFile, mkdir, recursive remove) that a `move` can be
 *  asserted on the RESULTING tree, not just on the call log. */
function treeImpl(
  seed: { files?: Record<string, string>; dirs?: string[] },
  options?: { nativeMove?: boolean },
) {
  const files = new Map<string, Uint8Array>()
  for (const [at, content] of Object.entries(seed.files ?? {})) {
    files.set(at, utf8(content))
  }
  const dirs = new Set<string>(seed.dirs ?? [])

  const impl = (op: RunJsFsOp, payload: Record<string, unknown>): unknown => {
    const at = joinPayload(payload)
    switch (op) {
      // Default: behave like an OLD host without fs.rename, so the existing
      // move tests keep exercising the copy+delete fallback; `nativeMove`
      // opts a test into the native rename path.
      case 'move': {
        if (!options?.nativeMove) {
          return namedError('NotSupportedError', 'no native move')
        }
        const to = joinPayload({ path: payload.newPath, root: payload.newRoot })
        if (files.has(to) || dirs.has(to)) {
          return namedError('AlreadyExistsError', `occupied: ${to}`)
        }
        if (files.has(at)) {
          files.set(to, files.get(at)!)
          files.delete(at)
          return null
        }
        if (!dirs.has(at)) {
          return namedError('NotFoundError', `no such path: ${at}`)
        }
        dirs.delete(at)
        dirs.add(to)
        for (const child of [...dirs]) {
          if (child.startsWith(`${at}/`)) {
            dirs.delete(child)
            dirs.add(`${to}/${child.slice(at.length + 1)}`)
          }
        }
        for (const [child, bytes] of [...files]) {
          if (child.startsWith(`${at}/`)) {
            files.delete(child)
            files.set(`${to}/${child.slice(at.length + 1)}`, bytes)
          }
        }
        return null
      }
      case 'stat':
        if (files.has(at)) return { kind: 'file', size: files.get(at)!.length }
        if (dirs.has(at)) return { kind: 'directory', size: 0 }
        return namedError('NotFoundError', `no such path: ${at}`)
      case 'readdir': {
        if (!dirs.has(at)) return namedError('NotFoundError', `no such dir: ${at}`)
        const prefix = `${at}/`
        const seen = new Set<string>()
        const entries: Array<{ name: string; kind: 'file' | 'directory' }> = []
        for (const child of [...dirs, ...files.keys()]) {
          if (!child.startsWith(prefix)) continue
          const name = child.slice(prefix.length).split('/')[0]!
          if (seen.has(name)) continue
          seen.add(name)
          entries.push({
            name,
            kind: dirs.has(`${prefix}${name}`) ? 'directory' : 'file',
          })
        }
        return entries
      }
      case 'readFile': {
        const bytes = files.get(at)
        if (!bytes) return namedError('NotFoundError', `no such file: ${at}`)
        return { bytes }
      }
      case 'writeFile':
        files.set(at, payload.bytes as Uint8Array)
        return null
      case 'mkdir':
        dirs.add(at)
        return null
      case 'remove': {
        files.delete(at)
        dirs.delete(at)
        for (const child of [...files.keys()]) {
          if (child.startsWith(`${at}/`)) files.delete(child)
        }
        for (const child of [...dirs]) {
          if (child.startsWith(`${at}/`)) dirs.delete(child)
        }
        return null
      }
      default:
        return null
    }
  }
  return { impl, files, dirs }
}

/** The tree + the helpers built over it, in one line per test. */
function moveHarness(
  seed: { files?: Record<string, string>; dirs?: string[] },
  options?: { nativeMove?: boolean },
) {
  const tree = treeImpl(seed, options)
  const { calls, callFs } = stubFs(tree.impl)
  return { ...tree, calls, helpers: createFileHelpers(callFs) }
}

describe('resolveHelperPath', () => {
  it('normalizes separators and drops "." segments in relative paths', () => {
    expect(resolveHelperPath('src\\browser\\x.ts').payload).toEqual({
      path: 'src/browser/x.ts',
    })
    expect(resolveHelperPath('./src//x.ts').payload).toEqual({
      path: 'src/x.ts',
    })
  })

  it('splits an absolute path into a root anchor + leaf (either separator)', () => {
    expect(resolveHelperPath('C:\\shift\\base\\file.cc').payload).toEqual({
      path: 'file.cc',
      root: 'C:/shift/base',
    })
    expect(resolveHelperPath('/abs/other/place.txt').payload).toEqual({
      path: 'place.txt',
      root: '/abs/other',
    })
    // Drive-root file keeps the 'C:/' root form (a bare 'C:' would parse as
    // relative downstream).
    expect(resolveHelperPath('C:/file.txt').payload).toEqual({
      path: 'file.txt',
      root: 'C:/',
    })
  })

  it('parent payload: relative parent, absolute root anchor, or null at the workspace root', () => {
    expect(resolveHelperPath('a/b/c.txt').parentPayload).toEqual({
      path: 'a/b',
    })
    expect(resolveHelperPath('C:/new/dir/f.txt').parentPayload).toEqual({
      path: '',
      root: 'C:/new/dir',
    })
    expect(resolveHelperPath('top.txt').parentPayload).toBeNull()
  })

  it('reports the whole path as ONE normalized string (what move compares)', () => {
    // The field `move` decides same-path and containment with: separators,
    // '.' segments and duplicate slashes gone, the absolute prefix kept.
    expect(resolveHelperPath('src\\browser\\x.ts').normalized).toBe(
      'src/browser/x.ts',
    )
    expect(resolveHelperPath('./src//x.ts').normalized).toBe('src/x.ts')
    expect(resolveHelperPath('C:\\ws\\src\\x.ts').normalized).toBe(
      'C:/ws/src/x.ts',
    )
    expect(resolveHelperPath('C:/x.ts').normalized).toBe('C:/x.ts')
    expect(resolveHelperPath('/abs/other/x.ts').normalized).toBe(
      '/abs/other/x.ts',
    )
    expect(resolveHelperPath('//unc/share/x.ts').normalized).toBe(
      '//unc/share/x.ts',
    )
  })

  it('rejects non-strings, empty paths, roots, and ".." with TypeError', () => {
    for (const bad of ['', '/', 'C:/', '..', 'a/../b', 'C:/a/../b', 42, null]) {
      expect(() => resolveHelperPath(bad as never), String(bad)).toThrow(
        TypeError,
      )
    }
  })
})

describe('readTextFile', () => {
  it('is ONE readFile round-trip returning decoded UTF-8', async () => {
    const { calls, callFs } = stubFs(() => ({ bytes: utf8('héllo') }))
    const { readTextFile } = createFileHelpers(callFs)
    expect(await readTextFile('src\\app.ts')).toBe('héllo')
    expect(calls).toEqual([
      { op: 'readFile', payload: { path: 'src/app.ts' } },
    ])
  })

  it('carries the root anchor for absolute paths', async () => {
    const { calls, callFs } = stubFs(() => ({ bytes: utf8('x') }))
    const { readTextFile } = createFileHelpers(callFs)
    await readTextFile('C:\\shift\\base\\src\\file.cc')
    expect(calls[0]).toEqual({
      op: 'readFile',
      payload: { path: 'file.cc', root: 'C:/shift/base/src' },
    })
  })

  it('propagates broker DOMException names (NotFoundError) untouched', async () => {
    const { callFs } = stubFs(() => namedError('NotFoundError'))
    const { readTextFile } = createFileHelpers(callFs)
    await expect(readTextFile('missing.txt')).rejects.toMatchObject({
      name: 'NotFoundError',
    })
  })

  it('round-trips BOM + CRLF byte-identically (no strip, no newline translation)', async () => {
    // EF BB BF = UTF-8 BOM; the default TextDecoder silently strips it, which
    // would make read → edit → write drop the BOM from BOM'd files.
    const original = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('a\r\nb\r\n')])
    const written: Uint8Array[] = []
    const { callFs } = stubFs((op, payload) => {
      if (op === 'readFile') return { bytes: original }
      written.push(payload.bytes as Uint8Array)
      return null
    })
    const { readTextFile, writeTextFile } = createFileHelpers(callFs)
    const content = await readTextFile('bom.txt')
    expect(content).toBe('﻿a\r\nb\r\n')
    await writeTextFile('bom.txt', content)
    expect(Array.from(written[0]!)).toEqual(Array.from(original))
  })

  it('handles full-range Unicode content (CJK, emoji, astral pairs)', async () => {
    const s = '汉字 🎉 𝕌𝕟𝕚𝕔𝕠𝕕𝕖 café'
    const { callFs } = stubFs(() => ({ bytes: utf8(s) }))
    const { readTextFile } = createFileHelpers(callFs)
    expect(await readTextFile('u.txt')).toBe(s)
  })

  it('rejects non-UTF-8 content LOUDLY (EncodingError) instead of mojibake', async () => {
    // Silent U+FFFD decode + write-back would corrupt the file; the helper
    // must fail loudly and point at readFileBytes for other encodings.
    const utf16le = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])
    const invalid = new Uint8Array([0x68, 0xc3, 0x28, 0xff])
    const { callFs } = stubFs((_op, payload) =>
      payload.path === 'u16.txt' ? { bytes: utf16le } : { bytes: invalid },
    )
    const { readTextFile } = createFileHelpers(callFs)
    await expect(readTextFile('u16.txt')).rejects.toMatchObject({
      name: 'EncodingError',
      message: expect.stringContaining('UTF-16'),
    })
    await expect(readTextFile('bin.dat')).rejects.toMatchObject({
      name: 'EncodingError',
      message: expect.stringContaining('readFileBytes()'),
    })
  })

  it('performs no Unicode normalization: NFC and NFD forms survive distinct', async () => {
    const nfc = 'café' // é as one code point
    const nfd = 'café' // e + combining acute
    const { callFs } = stubFs((_op, payload) =>
      payload.path === 'nfc.txt' ? { bytes: utf8(nfc) } : { bytes: utf8(nfd) },
    )
    const { readTextFile } = createFileHelpers(callFs)
    const gotNfc = await readTextFile('nfc.txt')
    const gotNfd = await readTextFile('nfd.txt')
    expect(gotNfc).toBe(nfc)
    expect(gotNfd).toBe(nfd)
    expect(gotNfc).not.toBe(gotNfd) // equal only under normalization
    expect(gotNfc.normalize('NFC')).toBe(gotNfd.normalize('NFC'))
  })
})

describe('readFileBytes / writeFileBytes', () => {
  it('round-trips raw bytes as ONE op each way', async () => {
    const payloadBytes = new Uint8Array([0, 1, 2, 0xff, 0xfe, 128])
    const written: Uint8Array[] = []
    const { calls, callFs } = stubFs((op, payload) => {
      if (op === 'readFile') return { bytes: payloadBytes }
      written.push(payload.bytes as Uint8Array)
      return null
    })
    const { readFileBytes, writeFileBytes } = createFileHelpers(callFs)
    const got = await readFileBytes('a.bin')
    expect(Array.from(got)).toEqual(Array.from(payloadBytes))
    await writeFileBytes('b.bin', got)
    expect(calls.map(c => c.op)).toEqual(['readFile', 'writeFile'])
    expect(Array.from(written[0]!)).toEqual(Array.from(payloadBytes))
  })

  it('writes ONLY an offset view’s window, never the whole underlying buffer', async () => {
    // new Uint8Array(buf, 20, 10) must write 10 bytes, not buf's 100.
    const buf = new ArrayBuffer(100)
    const whole = new Uint8Array(buf)
    whole.fill(7)
    whole.set([1, 2, 3, 4, 5, 6, 8, 9, 10, 11], 20)
    const view = new Uint8Array(buf, 20, 10)
    const written: Uint8Array[] = []
    const { callFs } = stubFs((_op, payload) => {
      written.push(payload.bytes as Uint8Array)
      return null
    })
    const { writeFileBytes } = createFileHelpers(callFs)
    await writeFileBytes('w.bin', view)
    expect(written[0]!.byteLength).toBe(10)
    expect(Array.from(written[0]!)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11])
    // Same for a non-Uint8Array view (DataView over a slice).
    await writeFileBytes('w2.bin', new DataView(buf, 20, 10))
    expect(written[1]!.byteLength).toBe(10)
    expect(Array.from(written[1]!)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11])
  })

  it('accepts a bare ArrayBuffer', async () => {
    const buf = new Uint8Array([9, 8, 7]).buffer
    const written: Uint8Array[] = []
    const { callFs } = stubFs((_op, payload) => {
      written.push(payload.bytes as Uint8Array)
      return null
    })
    const { writeFileBytes } = createFileHelpers(callFs)
    await writeFileBytes('ab.bin', buf)
    expect(Array.from(written[0]!)).toEqual([9, 8, 7])
  })

  it('creates the parent on OperationError and retries once (shared write path)', async () => {
    let writes = 0
    const { calls, callFs } = stubFs(op => {
      if (op === 'writeFile' && ++writes === 1) namedError('OperationError')
      return null
    })
    const { writeFileBytes } = createFileHelpers(callFs)
    await writeFileBytes('new/dir/f.bin', new Uint8Array([1]))
    expect(calls.map(c => c.op)).toEqual(['writeFile', 'mkdir', 'writeFile'])
  })

  it('refuses strings with a pointer at writeTextFile', async () => {
    const { calls, callFs } = stubFs(() => null)
    const { writeFileBytes } = createFileHelpers(callFs)
    await expect(
      writeFileBytes('a.txt', 'text' as unknown as Uint8Array),
    ).rejects.toThrow(/writeTextFile/)
    expect(calls).toHaveLength(0)
  })
})

describe('writeTextFile', () => {
  it('is ONE writeFile round-trip in the common case', async () => {
    const { calls, callFs } = stubFs(() => null)
    const { writeTextFile } = createFileHelpers(callFs)
    await writeTextFile('a/b.txt', 'content')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('writeFile')
    expect(calls[0]!.payload.path).toBe('a/b.txt')
    expect(text(calls[0]!.payload.bytes)).toBe('content')
  })

  it('on OperationError creates the parent (recursive mkdir) and retries ONCE', async () => {
    let writes = 0
    const { calls, callFs } = stubFs(op => {
      if (op === 'writeFile' && ++writes === 1) namedError('OperationError')
      return null
    })
    const { writeTextFile } = createFileHelpers(callFs)
    await writeTextFile('new/dir/f.txt', 'x')
    expect(calls.map(c => c.op)).toEqual(['writeFile', 'mkdir', 'writeFile'])
    expect(calls[1]!.payload).toEqual({ path: 'new/dir' })
  })

  it('anchors the retry mkdir at the absolute root for absolute paths', async () => {
    let writes = 0
    const { calls, callFs } = stubFs(op => {
      if (op === 'writeFile' && ++writes === 1) namedError('OperationError')
      return null
    })
    const { writeTextFile } = createFileHelpers(callFs)
    await writeTextFile('C:/new/deep/f.txt', 'x')
    expect(calls[1]).toEqual({
      op: 'mkdir',
      payload: { path: '', root: 'C:/new/deep' },
    })
    expect(calls[2]!.payload).toEqual(
      expect.objectContaining({ path: 'f.txt', root: 'C:/new/deep' }),
    )
  })

  it('never retries a permission refusal (NotAllowedError propagates untouched)', async () => {
    const { calls, callFs } = stubFs(() => namedError('NotAllowedError', 'denied by rule'))
    const { writeTextFile } = createFileHelpers(callFs)
    await expect(writeTextFile('a/b.txt', 'x')).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
    expect(calls.map(c => c.op)).toEqual(['writeFile'])
  })

  it('does not retry when the parent is the workspace root (no mkdir possible)', async () => {
    const { calls, callFs } = stubFs(() => namedError('OperationError'))
    const { writeTextFile } = createFileHelpers(callFs)
    await expect(writeTextFile('top.txt', 'x')).rejects.toMatchObject({
      name: 'OperationError',
    })
    expect(calls.map(c => c.op)).toEqual(['writeFile'])
  })

  it('rejects non-string content with TypeError (binary belongs to the handle API)', async () => {
    const { calls, callFs } = stubFs(() => null)
    const { writeTextFile } = createFileHelpers(callFs)
    await expect(
      writeTextFile('a.bin', new Uint8Array([1]) as unknown as string),
    ).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(0)
  })
})

describe('replaceTextFile', () => {
  /** A stub whose readFile serves `content` and whose writeFile succeeds. */
  function fileStub(content: string) {
    return stubFs(op => (op === 'readFile' ? { bytes: utf8(content) } : null))
  }

  it('is ONE read + ONE write, and returns the number of occurrences replaced', async () => {
    const { calls, callFs } = fileStub('const a = 1;\nconst b = 2;\n')
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(
      replaceTextFile('src/x.ts', 'const b = 2;', 'const b = 3;'),
    ).resolves.toBe(1)

    expect(calls.map(c => c.op)).toEqual(['readFile', 'writeFile'])
    expect(calls[0]!.payload).toEqual({ path: 'src/x.ts' })
    expect(text(calls[1]!.payload.bytes)).toBe('const a = 1;\nconst b = 3;\n')
  })

  it('throws NotFoundError and does NOT write when the text does not match', async () => {
    const { calls, callFs } = fileStub('hello world\n')
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(replaceTextFile('a.txt', 'goodbye', 'hi')).rejects.toMatchObject(
      {
        name: 'NotFoundError',
        message: expect.stringContaining(
          'No occurrence of the given text in a.txt',
        ),
      },
    )
    // The file must be left exactly as it was.
    expect(calls.map(c => c.op)).toEqual(['readFile'])
  })

  describe('uniform-newline compatibility fallback', () => {
    it('replaces in a uniform CRLF file given an LF find, and writes CRLF', async () => {
      const { calls, callFs } = fileStub('line one\r\nline two\r\n')
      const { replaceTextFile } = createFileHelpers(callFs)

      await expect(
        replaceTextFile('a.txt', 'line one\nline two', 'LINE\nTWO'),
      ).resolves.toBe(1)
      // Output span AND replace adopt the file's CRLF; surrounding bytes intact.
      expect(text(calls[1]!.payload.bytes)).toBe('LINE\r\nTWO\r\n')
    })

    it('replaces in a uniform LF file given a CRLF find, and writes LF', async () => {
      const { calls, callFs } = fileStub('line one\nline two\n')
      const { replaceTextFile } = createFileHelpers(callFs)

      await expect(
        replaceTextFile('a.txt', 'line one\r\nline two', 'LINE\r\nTWO'),
      ).resolves.toBe(1)
      expect(text(calls[1]!.payload.bytes)).toBe('LINE\nTWO\n')
    })

    it('replaces every match in a uniform CRLF file under { all: true } (converted)', async () => {
      const { calls, callFs } = fileStub('foo\r\nbar\r\nfoo\r\n')
      const { replaceTextFile } = createFileHelpers(callFs)

      await expect(
        replaceTextFile('a.txt', 'foo\nbar', 'x\ny', { all: true }),
      ).resolves.toBe(1) // 'foo\r\nbar' occurs once as a contiguous span
      expect(text(calls[1]!.payload.bytes)).toBe('x\r\ny\r\nfoo\r\n')
    })

    it('still throws AmbiguousMatchError when the converted find matches 2+', async () => {
      // Exact LF find misses; converted CRLF find matches TWICE → ambiguous.
      const { calls, callFs } = fileStub('foo\r\nbar\r\nfoo\r\nbar\r\n')
      const { replaceTextFile } = createFileHelpers(callFs)

      await expect(
        replaceTextFile('a.txt', 'foo\nbar', 'x'),
      ).rejects.toMatchObject({ name: 'AmbiguousMatchError' })
      expect(calls.map(c => c.op)).toEqual(['readFile'])
    })

    it('does NOT normalize replace on an exact match (no semantic widening)', async () => {
      // Exact CRLF find + LF replace on a CRLF file → replace used VERBATIM.
      const { calls, callFs } = fileStub('a\r\nb\r\n')
      const { replaceTextFile } = createFileHelpers(callFs)

      await replaceTextFile('a.txt', 'a\r\nb', 'x\ny')
      expect(text(calls[1]!.payload.bytes)).toBe('x\ny\r\n')
    })

    it('refuses a fallback edit that collapses to find === replace (no fake replacement)', async () => {
      // LF find + its CRLF twin as replace on a CRLF file: the fallback
      // canonicalizes `replace` to CRLF, so it equals the converted find. The
      // write used to land unchanged bytes and report 1 replacement.
      const { calls, callFs } = fileStub('a\r\nb\r\n')
      const { replaceTextFile } = createFileHelpers(callFs)

      await expect(
        replaceTextFile('a.txt', 'a\nb', 'a\r\nb'),
      ).rejects.toMatchObject({
        name: 'TypeError',
        message: expect.stringContaining('differ only in line endings'),
      })
      expect(calls.map(c => c.op)).toEqual(['readFile'])
    })

    it('normalizes a mixed replace safely during a fallback (no \r\r\n)', async () => {
      const { calls, callFs } = fileStub('foo\r\nbar\r\n')
      const { replaceTextFile } = createFileHelpers(callFs)

      // CRLF file + LF find → fallback; replace is mixed ('a\r\nb\nc').
      await replaceTextFile('a.txt', 'foo\nbar', 'a\r\nb\nc')
      const out = text(calls[1]!.payload.bytes)
      expect(out).toBe('a\r\nb\r\nc\r\n')
      expect(out).not.toContain('\r\r\n')
    })

    it('does NOT fall back on a mixed-EOL file (safety regression)', async () => {
      // A\r\nB (CRLF region) and C\nD (LF region). The LF-only find 'B\nC'
      // exact-misses (the real file has B\r\n then C), and the LF→CRLF
      // conversion would be the WRONG guess — the file is mixed, so NO
      // fallback is attempted at all.
      const { calls, callFs } = fileStub('A\r\nB\r\nC\nD\n')
      const { replaceTextFile } = createFileHelpers(callFs)

      await expect(
        replaceTextFile('a.txt', 'B\nC', 'x'),
      ).rejects.toMatchObject({
        name: 'NotFoundError',
        message: expect.stringContaining(
          'The file contains mixed line endings; newline-compatible matching was not attempted.',
        ),
      })
      expect(calls.map(c => c.op)).toEqual(['readFile'])
    })

    it('does NOT fall back when the find itself is mixed-EOL', async () => {
      const { calls, callFs } = fileStub('a\r\nb\r\n')
      const { replaceTextFile } = createFileHelpers(callFs)

      await expect(
        replaceTextFile('a.txt', 'a\nb\r\nzzz', 'x'),
      ).rejects.toMatchObject({
        name: 'NotFoundError',
        message: expect.stringContaining(
          'The requested text contains mixed line endings; newline-compatible matching was not attempted.',
        ),
      })
    })

    it('treats bare CR as mixed and disables the fallback', async () => {
      const { calls, callFs } = fileStub('abc\rdef\rghi')
      const { replaceTextFile } = createFileHelpers(callFs)

      await expect(
        replaceTextFile('a.txt', 'abc\ndef', 'x'),
      ).rejects.toMatchObject({ name: 'NotFoundError' })
      expect(calls.map(c => c.op)).toEqual(['readFile'])
    })

    it('LF→CRLF conversion never produces \r\r\n from an LF-only find', async () => {
      const { calls, callFs } = fileStub('one\r\ntwo\r\n')
      const { replaceTextFile } = createFileHelpers(callFs)

      await replaceTextFile('a.txt', 'one\ntwo', 'ONE\nTWO')
      expect(text(calls[1]!.payload.bytes)).toBe('ONE\r\nTWO\r\n')
    })
  })

  it('does not guess a line-ending cause for an unrelated miss', async () => {
    const { callFs } = fileStub('line one\r\nline two\r\n')
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(
      replaceTextFile('a.txt', 'nowhere in the file', 'x'),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining('line endings'),
    })
  })

  it('throws AmbiguousMatchError with the count and does NOT write on 2+ matches', async () => {
    const { calls, callFs } = fileStub('x\nfoo\ny\nfoo\nz\nfoo\n')
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(replaceTextFile('a.txt', 'foo', 'bar')).rejects.toMatchObject({
      name: 'AmbiguousMatchError',
      message: expect.stringContaining(
        '3 occurrences of the given text in a.txt',
      ),
    })
    expect(calls.map(c => c.op)).toEqual(['readFile'])
  })

  it('replaces every occurrence under { all: true } and returns the count', async () => {
    const { calls, callFs } = fileStub('foo|foo|foo')
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(
      replaceTextFile('a.txt', 'foo', 'bar', { all: true }),
    ).resolves.toBe(3)
    expect(calls.map(c => c.op)).toEqual(['readFile', 'writeFile'])
    expect(text(calls[1]!.payload.bytes)).toBe('bar|bar|bar')
  })

  it('treats the replacement LITERALLY - "$&" and "$1" are not expanded', async () => {
    // String.prototype.replace would expand these; this helper must not.
    const { calls, callFs } = fileStub('value = TOKEN;')
    const { replaceTextFile } = createFileHelpers(callFs)

    await replaceTextFile('a.txt', 'TOKEN', 'cost($&) + $1 + $$')
    expect(text(calls[1]!.payload.bytes)).toBe('value = cost($&) + $1 + $$;')
  })

  it('treats the replacement literally under { all: true } as well', async () => {
    const { calls, callFs } = fileStub('T T')
    const { replaceTextFile } = createFileHelpers(callFs)

    await replaceTextFile('a.txt', 'T', '$&', { all: true })
    expect(text(calls[1]!.payload.bytes)).toBe('$& $&')
  })

  it('counts non-overlapping occurrences the way the replacement does', async () => {
    const { calls, callFs } = fileStub('aaaa')
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(
      replaceTextFile('a.txt', 'aa', 'b', { all: true }),
    ).resolves.toBe(2)
    expect(text(calls[1]!.payload.bytes)).toBe('bb')
  })

  it('rejects a no-op edit (find === replace) before any I/O', async () => {
    const { calls, callFs } = fileStub('same')
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(replaceTextFile('a.txt', 'same', 'same')).rejects.toThrow(
      TypeError,
    )
    expect(calls).toHaveLength(0)
  })

  it('rejects an empty find before any I/O (it would match everywhere)', async () => {
    const { calls, callFs } = fileStub('anything')
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(replaceTextFile('a.txt', '', 'x')).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(0)
  })

  it('rejects non-string find/replace before any I/O', async () => {
    const { calls, callFs } = fileStub('anything')
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(
      replaceTextFile('a.txt', 1 as unknown as string, 'x'),
    ).rejects.toThrow(TypeError)
    await expect(
      replaceTextFile('a.txt', 'a', new Uint8Array([1]) as unknown as string),
    ).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(0)
  })

  it('surfaces the read EncodingError on a non-UTF-8 file, and does not write', async () => {
    const { calls, callFs } = stubFs(op =>
      op === 'readFile'
        ? { bytes: new Uint8Array([0xff, 0xfe, 0x41, 0x00]) }
        : null,
    )
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(replaceTextFile('a.txt', 'A', 'B')).rejects.toMatchObject({
      name: 'EncodingError',
    })
    expect(calls.map(c => c.op)).toEqual(['readFile'])
  })

  it('preserves a BOM and CRLF around the edited region', async () => {
    const { calls, callFs } = fileStub('﻿alpha\r\nbeta\r\n')
    const { replaceTextFile } = createFileHelpers(callFs)

    await replaceTextFile('a.txt', 'beta', 'gamma')
    const bytes = calls[1]!.payload.bytes as Uint8Array
    // Asserted on the BYTES: the test's default decoder would strip the BOM
    // and hide exactly the regression this guards.
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(text(bytes)).toBe('alpha\r\ngamma\r\n')
  })

  it('creates missing parents on the write like writeTextFile does', async () => {
    let writes = 0
    const { calls, callFs } = stubFs(op => {
      if (op === 'readFile') return { bytes: utf8('old') }
      if (op === 'writeFile' && ++writes === 1) namedError('OperationError')
      return null
    })
    const { replaceTextFile } = createFileHelpers(callFs)

    await replaceTextFile('new/dir/f.txt', 'old', 'new')
    expect(calls.map(c => c.op)).toEqual([
      'readFile',
      'writeFile',
      'mkdir',
      'writeFile',
    ])
  })

  it('rejects a path with ".." before any I/O', async () => {
    const { calls, callFs } = fileStub('x')
    const { replaceTextFile } = createFileHelpers(callFs)

    await expect(replaceTextFile('../outside.txt', 'x', 'y')).rejects.toThrow(
      TypeError,
    )
    expect(calls).toHaveLength(0)
  })
})

describe('move', () => {
  it('is stat, stat, read, write, remove — destination written BEFORE the source goes', async () => {
    const { calls, files, helpers } = moveHarness({
      files: { 'a.cc': 'BODY' },
    })

    await expect(helpers.move('a.cc', 'b.cc')).resolves.toBeUndefined()

    // Both probes precede the write, and the remove is LAST: the ordering is
    // the whole safety argument for a copy-then-delete move. The `move`
    // attempt between the probes is the native fast path, refused
    // NotSupportedError by this old-host harness.
    expect(calls.map(c => [c.op, joinPayload(c.payload)])).toEqual([
      ['stat', 'a.cc'],
      ['stat', 'b.cc'],
      ['move', 'a.cc'],
      ['readFile', 'a.cc'],
      ['writeFile', 'b.cc'],
      ['remove', 'a.cc'],
    ])
    expect(text(files.get('b.cc'))).toBe('BODY')
    expect(files.has('a.cc')).toBe(false)
  })

  it('normalizes separators and carries the root anchor for absolute paths', async () => {
    const { calls, files, helpers } = moveHarness({
      files: { 'C:/ws/src/a.cc': 'BODY' },
    })

    await helpers.move('C:\\ws\\src\\a.cc', 'C:/ws/src/nested/b.cc')

    expect(calls.map(c => [c.op, c.payload.path, c.payload.root])).toEqual([
      ['stat', 'a.cc', 'C:/ws/src'],
      ['stat', 'b.cc', 'C:/ws/src/nested'],
      ['move', 'a.cc', 'C:/ws/src'],
      ['readFile', 'a.cc', 'C:/ws/src'],
      ['writeFile', 'b.cc', 'C:/ws/src/nested'],
      ['remove', 'a.cc', 'C:/ws/src'],
    ])
    expect(text(files.get('C:/ws/src/nested/b.cc'))).toBe('BODY')
  })

  it('moves BYTES, so binary and non-UTF-8 content survives untouched', async () => {
    const { calls, files, helpers } = moveHarness({})
    // Lone 0xFF/0xFE — readTextFile would reject this with EncodingError, and
    // a hand-rolled text move would write back mojibake.
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x41])
    files.set('bin.dat', raw)

    await helpers.move('bin.dat', 'moved.dat')

    expect(files.get('moved.dat')).toEqual(raw)
    expect(calls.some(c => c.op === 'readFile')).toBe(true)
  })

  it('creates a missing destination parent through the shared write retry', async () => {
    const tree = treeImpl({ files: { 'a.cc': 'BODY' } })
    const { calls, callFs } = stubFs((op, payload) => {
      // One plain write failure, exactly as a missing parent surfaces.
      if (op === 'writeFile' && !tree.dirs.has('deep/dir')) {
        return namedError('OperationError', 'no parent')
      }
      return tree.impl(op, payload)
    })

    await createFileHelpers(callFs).move('a.cc', 'deep/dir/b.cc')

    expect(calls.map(c => [c.op, joinPayload(c.payload)])).toEqual([
      ['stat', 'a.cc'],
      ['stat', 'deep/dir/b.cc'],
      ['move', 'a.cc'],
      ['readFile', 'a.cc'],
      ['writeFile', 'deep/dir/b.cc'],
      ['mkdir', 'deep/dir'],
      ['writeFile', 'deep/dir/b.cc'],
      ['remove', 'a.cc'],
    ])
    expect(text(tree.files.get('deep/dir/b.cc'))).toBe('BODY')
  })

  it('NEVER overwrites: an existing destination is AlreadyExistsError, nothing written', async () => {
    const { calls, files, helpers } = moveHarness({
      files: { 'a.cc': 'SOURCE', 'b.cc': 'KEEP' },
    })

    await expect(helpers.move('a.cc', 'b.cc')).rejects.toMatchObject({
      name: 'AlreadyExistsError',
    })
    await expect(helpers.move('a.cc', 'b.cc')).rejects.toThrow(
      /never overwrites/,
    )

    // The destination kept its content and the source is still there.
    expect(text(files.get('b.cc'))).toBe('KEEP')
    expect(text(files.get('a.cc'))).toBe('SOURCE')
    expect(calls.some(c => c.op === 'writeFile' || c.op === 'remove')).toBe(
      false,
    )
  })

  it('refuses an existing destination DIRECTORY the same way', async () => {
    const { calls, helpers } = moveHarness({
      files: { 'a.cc': 'SOURCE' },
      dirs: ['b'],
    })

    await expect(helpers.move('a.cc', 'b')).rejects.toMatchObject({
      name: 'AlreadyExistsError',
    })
    expect(calls.some(c => c.op === 'writeFile' || c.op === 'remove')).toBe(
      false,
    )
  })

  it('a destination the caller may not READ is not "free" — the refusal propagates', async () => {
    // NotAllowedError from the destination probe must never be swallowed into
    // "absent", which would write straight through a denied path.
    const { calls, callFs } = stubFs((op, payload) => {
      if (op === 'stat' && payload.path === 'b.cc') {
        return namedError('NotAllowedError', 'denied')
      }
      if (op === 'stat') return { kind: 'file', size: 4 }
      return null
    })

    await expect(createFileHelpers(callFs).move('a.cc', 'b.cc')).rejects.toMatchObject(
      { name: 'NotAllowedError' },
    )
    expect(calls.some(c => c.op === 'writeFile')).toBe(false)
  })

  it('names the SOURCE when it is the missing one', async () => {
    const { calls, helpers } = moveHarness({})

    await expect(helpers.move('gone.cc', 'b.cc')).rejects.toMatchObject({
      name: 'NotFoundError',
    })
    // A two-path call has to say WHICH path was missing.
    await expect(helpers.move('gone.cc', 'b.cc')).rejects.toThrow(/gone\.cc/)
    // Probed source-first: a wrong source never even looks at the destination.
    expect(calls.map(c => c.op)).toEqual(['stat', 'stat'])
  })

  it('leaves the source in place when the write fails', async () => {
    const tree = treeImpl({ files: { 'a.cc': 'BODY' } })
    const { calls, callFs } = stubFs((op, payload) => {
      if (op === 'writeFile') return namedError('NotAllowedError', 'denied')
      return tree.impl(op, payload)
    })

    await expect(createFileHelpers(callFs).move('a.cc', 'b.cc')).rejects.toMatchObject(
      { name: 'NotAllowedError' },
    )
    expect(text(tree.files.get('a.cc'))).toBe('BODY')
    expect(calls.some(c => c.op === 'remove')).toBe(false)
  })

  it('rejects a same-path move before any I/O', async () => {
    const { calls, helpers } = moveHarness({ files: { 'a.cc': 'BODY' } })

    // Same file, spelled two ways: a no-op that would report success.
    await expect(helpers.move('a.cc', './a.cc')).rejects.toBeInstanceOf(TypeError)
    await expect(helpers.move('src\\a.cc', 'src/a.cc')).rejects.toBeInstanceOf(
      TypeError,
    )
    expect(calls).toEqual([])
  })

  it('refuses to move a directory into itself, before any I/O', async () => {
    const { calls, helpers } = moveHarness({ dirs: ['src', 'src/sub'] })

    await expect(helpers.move('src', 'src/sub/new')).rejects.toMatchObject({
      name: 'InvalidModificationError',
    })
    // Case-insensitively: on Windows 'SRC/new' IS inside 'src', and letting it
    // through would delete the destination with the source tree.
    await expect(helpers.move('src', 'SRC/new')).rejects.toMatchObject({
      name: 'InvalidModificationError',
    })
    expect(calls).toEqual([])
  })

  it('containment is path-boundary, not prefix: "a" does not contain "ab"', async () => {
    const { files, helpers } = moveHarness({ files: { a: 'BODY' } })

    await expect(helpers.move('a', 'ab')).resolves.toBeUndefined()
    expect(text(files.get('ab'))).toBe('BODY')
  })

  it('rejects ".." and non-string paths on either side before any I/O', async () => {
    const { calls, helpers } = moveHarness({ files: { 'a.cc': 'BODY' } })

    await expect(helpers.move('../a.cc', 'b.cc')).rejects.toBeInstanceOf(TypeError)
    await expect(helpers.move('a.cc', '../b.cc')).rejects.toBeInstanceOf(TypeError)
    await expect(
      helpers.move('a.cc', undefined as unknown as string),
    ).rejects.toBeInstanceOf(TypeError)
    expect(calls).toEqual([])
  })

  it('moves a directory tree: listed whole, rebuilt top-down, source removed LAST', async () => {
    const { calls, files, dirs, helpers } = moveHarness({
      files: {
        'old/a.ts': 'A',
        'old/deep/b.ts': 'B',
        'old/deep/deeper/c.ts': 'C',
      },
      dirs: ['old', 'old/deep', 'old/deep/deeper', 'old/empty'],
    })

    await helpers.move('old', 'new')

    const ops = calls.map(c => [c.op, joinPayload(c.payload)] as const)
    // The WHOLE tree is listed before the first write, so a destination that
    // landed inside the source could never feed the walk its own output.
    const firstWrite = ops.findIndex(([op]) => op === 'writeFile' || op === 'mkdir')
    // 'move' is the refused native attempt (this harness plays an old host).
    expect(
      ops
        .slice(0, firstWrite)
        .every(([op]) => op === 'stat' || op === 'readdir' || op === 'move'),
    ).toBe(true)
    // Parents before children (BFS), and the source tree goes last.
    expect(ops.filter(([op]) => op === 'mkdir').map(([, at]) => at)).toEqual([
      'new',
      'new/deep',
      'new/empty',
      'new/deep/deeper',
    ])
    expect(ops[ops.length - 1]).toEqual(['remove', 'old'])

    expect(text(files.get('new/a.ts'))).toBe('A')
    expect(text(files.get('new/deep/b.ts'))).toBe('B')
    expect(text(files.get('new/deep/deeper/c.ts'))).toBe('C')
    // Empty directories are part of the shape a move preserves.
    expect(dirs.has('new/empty')).toBe(true)
    expect([...files.keys()].some(at => at.startsWith('old/'))).toBe(false)
    expect(dirs.has('old')).toBe(false)
  })

  it('moves an EMPTY directory (no writes, still one mkdir and one remove)', async () => {
    const { calls, dirs, helpers } = moveHarness({ dirs: ['old'] })

    await helpers.move('old', 'new')

    expect(calls.map(c => c.op)).toEqual([
      'stat',
      'stat',
      'move',
      'readdir',
      'mkdir',
      'remove',
    ])
    expect(dirs.has('new')).toBe(true)
    expect(dirs.has('old')).toBe(false)
  })

  it('refuses a DIRECTORY move whose two paths are spelled differently', async () => {
    // Absolute vs relative: the worker cannot resolve one against the other,
    // so "is the destination inside the source?" is undecidable here — and
    // guessing wrong deletes the destination with the source tree.
    const { calls, helpers } = moveHarness({ dirs: ['old'] })

    await expect(helpers.move('old', 'C:/ws/new')).rejects.toBeInstanceOf(TypeError)
    await expect(helpers.move('old', 'C:/ws/new')).rejects.toThrow(
      /spell both the same way/,
    )
    // Refused before anything is created — only the probes and the refused
    // native attempt ran.
    expect(calls.every(c => c.op === 'stat' || c.op === 'move')).toBe(true)
  })

  it('allows a mixed-form FILE move — nothing can live inside a file', async () => {
    const { files, helpers } = moveHarness({ files: { 'a.cc': 'BODY' } })

    await expect(helpers.move('a.cc', 'C:/ws/b.cc')).resolves.toBeUndefined()
    expect(text(files.get('C:/ws/b.cc'))).toBe('BODY')
    expect(files.has('a.cc')).toBe(false)
  })

  // ── native fast path (host with fs.rename) ────────────────────────────────

  it('native: ONE move primitive after the probes — no read/write/remove', async () => {
    const { calls, files, helpers } = moveHarness(
      { files: { 'a.cc': 'BODY' } },
      { nativeMove: true },
    )

    await helpers.move('a.cc', 'b.cc')

    expect(calls.map(c => c.op)).toEqual(['stat', 'stat', 'move'])
    expect(text(files.get('b.cc'))).toBe('BODY')
    expect(files.has('a.cc')).toBe(false)
  })

  it('native: the payload carries newPath + newRoot for an absolute destination', async () => {
    const { calls, files, helpers } = moveHarness(
      { files: { 'a.cc': 'BODY' } },
      { nativeMove: true },
    )

    await helpers.move('a.cc', 'C:\\ws\\out\\b.cc')

    const move = calls.find(c => c.op === 'move')!
    expect(move.payload).toEqual({
      path: 'a.cc',
      newPath: 'b.cc',
      newRoot: 'C:/ws/out',
    })
    expect(text(files.get('C:/ws/out/b.cc'))).toBe('BODY')
  })

  it('native: moves a directory tree in ONE primitive, empty dirs included', async () => {
    const { calls, dirs, files, helpers } = moveHarness(
      {
        files: { 'old/a.ts': 'A', 'old/deep/b.ts': 'B' },
        dirs: ['old', 'old/deep', 'old/empty'],
      },
      { nativeMove: true },
    )

    await helpers.move('old', 'new')

    expect(calls.map(c => c.op)).toEqual(['stat', 'stat', 'move'])
    expect(text(files.get('new/a.ts'))).toBe('A')
    expect(text(files.get('new/deep/b.ts'))).toBe('B')
    expect(dirs.has('new/empty')).toBe(true)
    expect(dirs.has('old')).toBe(false)
  })

  it('native: a mixed-form DIRECTORY move goes through (broker decides containment)', async () => {
    // The worker cannot compare 'old' with 'C:/ws/new', but the native path
    // resolves both absolutely broker-side — only the FALLBACK refuses this.
    const { dirs, helpers } = moveHarness(
      { dirs: ['old'] },
      { nativeMove: true },
    )

    await expect(helpers.move('old', 'C:/ws/new')).resolves.toBeUndefined()
    expect(dirs.has('C:/ws/new')).toBe(true)
    expect(dirs.has('old')).toBe(false)
  })

  it('native: a missing destination parent gets ONE mkdir + retry (write-helper contract)', async () => {
    const tree = treeImpl({ files: { 'a.cc': 'BODY' } }, { nativeMove: true })
    let moveAttempts = 0
    const { calls, callFs } = stubFs((op, payload) => {
      if (op === 'move' && ++moveAttempts === 1) {
        // The host does not auto-create parents (base::Move semantics) — the
        // first attempt fails plain.
        return namedError('OperationError', 'no parent')
      }
      return tree.impl(op, payload)
    })

    await createFileHelpers(callFs).move('a.cc', 'deep/dir/b.cc')

    expect(calls.map(c => [c.op, joinPayload(c.payload)])).toEqual([
      ['stat', 'a.cc'],
      ['stat', 'deep/dir/b.cc'],
      ['move', 'a.cc'],
      ['mkdir', 'deep/dir'],
      ['move', 'a.cc'],
    ])
    expect(text(tree.files.get('deep/dir/b.cc'))).toBe('BODY')
    expect(tree.files.has('a.cc')).toBe(false)
  })

  it('native: only NotSupportedError falls back — a real failure IS the outcome', async () => {
    const tree = treeImpl({ files: { 'a.cc': 'BODY' } }, { nativeMove: true })
    const { calls, callFs } = stubFs((op, payload) => {
      if (op === 'move') return namedError('OperationError', 'disk says no')
      return tree.impl(op, payload)
    })

    await expect(
      createFileHelpers(callFs).move('a.cc', 'C:/out/b.cc'),
    ).rejects.toMatchObject({ name: 'OperationError' })
    // No copy+delete after the native failure — only the parent-creation
    // retry ran. The source is untouched and nothing was written.
    expect(calls.map(c => c.op)).toEqual([
      'stat',
      'stat',
      'move',
      'mkdir',
      'move',
    ])
    expect(text(tree.files.get('a.cc'))).toBe('BODY')
  })
})
