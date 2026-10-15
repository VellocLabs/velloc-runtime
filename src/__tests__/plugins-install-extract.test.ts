import { describe, expect, it, vi } from 'vitest'
import {
  MAX_DECOMPRESSED_TARBALL_BYTES,
  decompressGzip,
  extractGitHubTarball,
  extractSubdir,
  parseTar,
  sanitizeArchivePath,
  stripTopLevelDir,
} from '../pluginHost/extract'

// --- helpers to build a deterministic ustar tarball in-memory ----------

/** Encode an ASCII string into a fixed-length field, NUL-padded. */
function encodeField(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length)
  const bytes = new TextEncoder().encode(text)
  out.set(bytes.slice(0, length))
  return out
}

/** Encode a number as a 0-padded octal string of fixed length, with a
 *  trailing NUL — the POSIX ustar size/mode/mtime convention. */
function encodeOctal(n: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  const text = n.toString(8).padStart(length - 1, '0') + '\0'
  out.set(new TextEncoder().encode(text))
  return out
}

/** Build one 512-byte tar header for a regular file. Checksum is
 *  filled in correctly so the parser's (eventual) checksum check
 *  would pass — even though our parser doesn't enforce it today. */
function makeHeader(filename: string, size: number): Uint8Array {
  const header = new Uint8Array(512)
  header.set(encodeField(filename, 100), 0)
  header.set(encodeOctal(0o644, 8), 100)        // mode
  header.set(encodeOctal(0, 8), 108)            // uid
  header.set(encodeOctal(0, 8), 116)            // gid
  header.set(encodeOctal(size, 12), 124)        // size
  header.set(encodeOctal(0, 12), 136)           // mtime
  // checksum field is initially 8 spaces (0x20) during checksum calc.
  for (let i = 148; i < 156; i++) header[i] = 0x20
  header[156] = 0x30                             // typeflag '0' = regular
  header.set(encodeField('ustar', 6), 257)      // magic
  header.set(encodeField('00', 2), 263)         // version
  // Compute checksum.
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]!
  header.set(encodeOctal(sum, 8), 148)
  return header
}

/** Build a 512-byte tar header with an arbitrary typeflag byte. Mirrors
 *  `makeHeader` but lets the caller pick the typeflag (PAX 'x', GNU 'L',
 *  etc.) and recomputes the ustar checksum. */
function makeTypedHeader(filename: string, size: number, typeflag: number): Uint8Array {
  const header = new Uint8Array(512)
  header.set(encodeField(filename, 100), 0)
  header.set(encodeOctal(0o644, 8), 100)
  header.set(encodeOctal(0, 8), 108)
  header.set(encodeOctal(0, 8), 116)
  header.set(encodeOctal(size, 12), 124)
  header.set(encodeOctal(0, 12), 136)
  for (let i = 148; i < 156; i++) header[i] = 0x20
  header[156] = typeflag
  header.set(encodeField('ustar', 6), 257)
  header.set(encodeField('00', 2), 263)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]!
  header.set(encodeOctal(sum, 8), 148)
  return header
}

/** Build a PAX 'x' extended header whose payload carries the given
 *  records (each `"<len> <record>\n"`, len = total record byte length). */
function makePaxHeader(...records: string[]): Uint8Array {
  const enc = new TextEncoder()
  const lines = records.map((r) => {
    // length includes the digits, the space, the record, and the newline.
    // Solve for the self-describing length by iterating until stable.
    let len = r.length + 3 // rough start: 1 digit + space + newline
    for (;;) {
      const candidate = `${len} ${r}\n`.length
      if (candidate === len) break
      len = candidate
    }
    return `${len} ${r}\n`
  })
  const payload = enc.encode(lines.join(''))
  return concat([
    makeTypedHeader('PaxHeaders/0', payload.byteLength, 0x78), // 'x'
    padBlock(payload),
  ])
}

/** Concatenate a list of byte arrays. */
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Pad bytes to the next 512-byte boundary. */
function padBlock(bytes: Uint8Array): Uint8Array {
  const remainder = bytes.length % 512
  if (remainder === 0) return bytes
  const padded = new Uint8Array(bytes.length + (512 - remainder))
  padded.set(bytes)
  return padded
}

/** Build a tarball from a list of files. Ends with two empty blocks. */
function buildTar(files: Array<{ name: string; content: string }>): Uint8Array {
  const parts: Uint8Array[] = []
  for (const f of files) {
    const data = new TextEncoder().encode(f.content)
    parts.push(makeHeader(f.name, data.byteLength))
    parts.push(padBlock(data))
  }
  parts.push(new Uint8Array(512)) // end-of-archive
  parts.push(new Uint8Array(512))
  // Concatenate.
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Gzip-encode a tarball using the platform CompressionStream. The
 *  cast bridges the DOM lib's `Uint8Array<ArrayBuffer>` generic to
 *  our plain `Uint8Array` stream — same shape at runtime. */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >
  const src = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(bytes); c.close() },
  })
  const buf = await new Response(src.pipeThrough(cs)).arrayBuffer()
  return new Uint8Array(buf)
}

// --- sanitizeArchivePath tests --------------------------------------------

describe('sanitizeArchivePath', () => {
  it('passes a clean relative path through', () => {
    expect(sanitizeArchivePath('skills/foo/SKILL.md')).toBe('skills/foo/SKILL.md')
  })

  it('collapses redundant `.` segments', () => {
    expect(sanitizeArchivePath('./skills/./foo/SKILL.md')).toBe('skills/foo/SKILL.md')
  })

  it('rejects an empty string', () => {
    expect(sanitizeArchivePath('')).toBeNull()
  })

  it('rejects strings containing NUL', () => {
    expect(sanitizeArchivePath('skills/\0name')).toBeNull()
  })

  it('rejects backslashes (Windows separator)', () => {
    expect(sanitizeArchivePath('skills\\foo')).toBeNull()
  })

  it('rejects absolute POSIX paths', () => {
    expect(sanitizeArchivePath('/etc/passwd')).toBeNull()
  })

  it('rejects `~`-prefixed paths', () => {
    expect(sanitizeArchivePath('~/.ssh/authorized_keys')).toBeNull()
  })

  it('rejects Windows drive-letter paths', () => {
    expect(sanitizeArchivePath('C:/Windows/System32')).toBeNull()
    expect(sanitizeArchivePath('C:\\Windows')).toBeNull()
  })

  it('rejects any path containing a `..` segment', () => {
    expect(sanitizeArchivePath('../secret')).toBeNull()
    expect(sanitizeArchivePath('foo/../bar')).toBeNull()
    expect(sanitizeArchivePath('a/b/../../c')).toBeNull()
  })

  it('rejects non-string inputs (defensive cast)', () => {
    expect(sanitizeArchivePath(123 as unknown as string)).toBeNull()
  })
})

// --- parseTar + stripTopLevelDir tests ------------------------------------

describe('parseTar', () => {
  it('extracts files from a well-formed ustar archive', () => {
    const tar = buildTar([
      { name: 'a.txt', content: 'AAA' },
      { name: 'b.txt', content: 'BBBB' },
    ])
    const entries = parseTar(tar)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.path).toBe('a.txt')
    expect(new TextDecoder().decode(entries[0]!.content)).toBe('AAA')
    expect(entries[1]!.path).toBe('b.txt')
    expect(new TextDecoder().decode(entries[1]!.content)).toBe('BBBB')
  })

  it('returns [] for an empty archive (two NUL blocks only)', () => {
    const tar = new Uint8Array(1024) // 2 × 512 NUL blocks
    expect(parseTar(tar)).toEqual([])
  })

  it('drops an entry with an unsafe path (warns then skips)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tar = buildTar([
      { name: 'good.txt', content: 'OK' },
      { name: '../bad.txt', content: 'EVIL' },
    ])
    const entries = parseTar(tar)
    expect(entries.map(e => e.path)).toEqual(['good.txt'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('applies a PAX `path=` long-name to the following truncated entry', () => {
    // GitHub codeload uses a PAX 'x' record to carry a path that overflows
    // the 100-byte ustar `name` field; the real entry's name is truncated.
    // The file must surface under the FULL path, not the truncated one.
    const longName =
      'obra-superpowers-6fd4507/skills/'
      + 'a-very-deeply-nested-directory-whose-name-pushes-the-total/'
      + 'past-one-hundred-bytes/SKILL.md'
    expect(longName.length).toBeGreaterThan(100)
    const truncated = longName.slice(0, 100)
    const tar = concat([
      makePaxHeader(`path=${longName}`),
      makeHeader(truncated, new TextEncoder().encode('# long\n').byteLength),
      padBlock(new TextEncoder().encode('# long\n')),
      new Uint8Array(512),
      new Uint8Array(512),
    ])
    const entries = parseTar(tar)
    expect(entries.map(e => e.path)).toEqual([longName])
    expect(new TextDecoder().decode(entries[0]!.content)).toBe('# long\n')
  })

  it('applies a GNU `L` long-name to the following entry', () => {
    const longName = 'wrap-1234567/' + 'x'.repeat(120) + '/file.md'
    const nameBytes = new TextEncoder().encode(longName + '\0')
    const tar = concat([
      makeTypedHeader('././@LongLink', nameBytes.byteLength, 0x4c), // 'L'
      padBlock(nameBytes),
      makeHeader('wrap-1234567/truncated-name', 3),
      padBlock(new TextEncoder().encode('HEY')),
      new Uint8Array(512),
      new Uint8Array(512),
    ])
    const entries = parseTar(tar)
    expect(entries.map(e => e.path)).toEqual([longName])
    expect(new TextDecoder().decode(entries[0]!.content)).toBe('HEY')
  })

  it('throws on a structurally invalid header (no silent block skip)', () => {
    // A non-zero block whose size field is non-octal garbage is unreadable.
    const bad = buildTar([{ name: 'good.txt', content: 'OK' }])
    // Corrupt the size field (offset 124, length 12) of the first header.
    for (let i = 124; i < 136; i++) bad[i] = 0x5a // 'Z' — not octal
    expect(() => parseTar(bad)).toThrow(/invalid header/i)
  })

  it('throws on an unknown typeflag (no desync)', () => {
    const tar = concat([
      makeTypedHeader('mystery', 0, 0x40), // '@' — unrecognized
      new Uint8Array(512),
      new Uint8Array(512),
    ])
    expect(() => parseTar(tar)).toThrow(/unknown typeflag/i)
  })
})

describe('stripTopLevelDir', () => {
  it('strips the `<repo>-<sha>/` wrapper when all entries share it', () => {
    const stripped = stripTopLevelDir([
      { path: 'obra-superpowers-6fd4507/README.md', content: new Uint8Array() },
      { path: 'obra-superpowers-6fd4507/skills/foo/SKILL.md', content: new Uint8Array() },
    ])
    expect(stripped.map(e => e.path)).toEqual([
      'README.md',
      'skills/foo/SKILL.md',
    ])
  })

  it('returns the input unchanged when no uniform top-level dir exists', () => {
    const input = [
      { path: 'README.md', content: new Uint8Array() },
      { path: 'skills/foo/SKILL.md', content: new Uint8Array() },
    ]
    expect(stripTopLevelDir(input)).toBe(input)
  })

  it('returns input unchanged when entries have multiple top-level dirs', () => {
    const input = [
      { path: 'a/file.md', content: new Uint8Array() },
      { path: 'b/file.md', content: new Uint8Array() },
    ]
    expect(stripTopLevelDir(input)).toBe(input)
  })

  it('returns empty array for empty input', () => {
    expect(stripTopLevelDir([])).toEqual([])
  })
})

describe('extractSubdir', () => {
  const entries = [
    { path: 'README.md', content: new Uint8Array() },
    {
      path: 'external_plugins/github/.claude-plugin/plugin.json',
      content: new TextEncoder().encode('{"name":"github"}'),
    },
    { path: 'external_plugins/github/skills/gh/SKILL.md', content: new Uint8Array() },
    // sibling whose name is a prefix of the target — must NOT leak in.
    { path: 'external_plugins/github-extra/x.txt', content: new Uint8Array() },
    { path: 'external_plugins/other/y.txt', content: new Uint8Array() },
  ]

  it('re-roots entries at the subdirectory + drops everything outside it', () => {
    const out = extractSubdir(entries, 'external_plugins/github')
    expect(out.map(e => e.path)).toEqual([
      '.claude-plugin/plugin.json',
      'skills/gh/SKILL.md',
    ])
    expect(new TextDecoder().decode(out[0]!.content)).toBe('{"name":"github"}')
  })

  it('normalizes a leading "./" and trailing slash', () => {
    expect(
      extractSubdir(entries, './external_plugins/github/').map(e => e.path),
    ).toEqual(['.claude-plugin/plugin.json', 'skills/gh/SKILL.md'])
  })

  it('returns [] for an unsafe (".."), empty, or "." subdir', () => {
    expect(extractSubdir(entries, '../escape')).toEqual([])
    expect(extractSubdir(entries, 'a/../b')).toEqual([])
    expect(extractSubdir(entries, '')).toEqual([])
    expect(extractSubdir(entries, '.')).toEqual([])
  })

  it('returns [] when the subdir matches no entries', () => {
    expect(extractSubdir(entries, 'does/not/exist')).toEqual([])
  })
})

// --- decompressGzip + extractGitHubTarball (round-trip) -------------------

describe('decompressGzip + extractGitHubTarball (round-trip with platform CompressionStream)', () => {
  it('inflates what CompressionStream deflated', async () => {
    const original = new TextEncoder().encode('Hello, gzip world!')
    const compressed = await gzip(original)
    expect(compressed.byteLength).toBeGreaterThan(0)
    const inflated = await decompressGzip(compressed)
    expect(new TextDecoder().decode(inflated)).toBe('Hello, gzip world!')
  })

  it('extracts a GitHub-style wrapped tarball end-to-end', async () => {
    const tar = buildTar([
      { name: 'obra-superpowers-abc123/.claude-plugin/plugin.json',
        content: '{"name":"superpowers","version":"1.0"}' },
      { name: 'obra-superpowers-abc123/skills/foo/SKILL.md',
        content: '# foo\n' },
    ])
    const gz = await gzip(tar)
    const entries = await extractGitHubTarball(gz)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.path).toBe('.claude-plugin/plugin.json')
    expect(entries[1]!.path).toBe('skills/foo/SKILL.md')
  })
})

// --- gzip-bomb guard ------------------------------------------------------

describe('decompressGzip — decompressed-size cap (gzip-bomb guard)', () => {
  it('aborts when the inflated output exceeds the cap', async () => {
    // 8 MiB of zeros compresses to a few KB but inflates well past a 1 MiB cap.
    // This is the bomb shape: tiny compressed payload, huge expansion — the
    // 5 MiB compressed-download cap upstream is no defence on its own.
    const bomb = await gzip(new Uint8Array(8 * 1024 * 1024))
    expect(
      bomb.byteLength,
      'the bomb must be small when compressed (else it is not a bomb)',
    ).toBeLessThan(256 * 1024)
    await expect(
      decompressGzip(bomb, 1 * 1024 * 1024),
    ).rejects.toThrow(/gzip bomb|exceeds/i)
  })

  it('inflates an archive that stays within the cap unchanged', async () => {
    const payload = new TextEncoder().encode('x'.repeat(50_000))
    const out = await decompressGzip(await gzip(payload), 1 * 1024 * 1024)
    expect(out.byteLength).toBe(50_000)
    expect(new TextDecoder().decode(out)).toBe('x'.repeat(50_000))
  })

  it('defaults to a generous-but-bounded cap (≥ the 5 MiB compressed cap)', () => {
    // The default must clear the compressed-download cap (a legit 5 MiB-
    // compressed plugin inflates several-fold) yet stay far below bomb scale.
    expect(MAX_DECOMPRESSED_TARBALL_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024)
    expect(MAX_DECOMPRESSED_TARBALL_BYTES).toBeLessThanOrEqual(512 * 1024 * 1024)
  })
})
