import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  BLOB_CHUNK_HEADER_MAX_BYTES,
  FRAME_KEYS,
  FRAME_KINDS,
  RUNTIME_PROTOCOL_VERSION,
  SYS_PING_ROUTE,
  TOPICS_SUBSCRIBE_ROUTE,
  TOPICS_UNSUBSCRIBE_ROUTE,
  decodeBlobChunk,
  decodeFrame,
  encodeBlobChunk,
  encodeFrame,
  isBlobRef,
  isFrame,
  isRouteKey,
  readFrame,
  isSysPingPayload,
  isTopicsSubscribePayload,
  isTopicsUnsubscribePayload,
  isWireError,
  parseRouteKey,
  parseTopic,
  route,
  routeKey,
  topic,
  wireError,
  type BlobChunkHeader,
  type Frame,
  type FrameKind,
  type ParsedTopic,
} from '../browser/runtimeProtocol'

/**
 * UI ⇄ Runtime protocol v1 guards (P-3): the conformance vectors (from an independent Python encoder) round-trip
 * byte for byte; the TS types, `FRAME_KEYS` and vectors agree on keys; `routeKey` / `parseTopic` invert each other;
 * and `src/browser/runtimeProtocol/` stays zero-dependency.
 */

const PROTOCOL_DIR = join(__dirname, '..', 'browser', 'runtimeProtocol')

type Vectors = {
  protocol: number
  frames: Array<{ name: string; frame: unknown }>
  rejected: Array<{ name: string; value: unknown }>
  tolerated: Array<{ name: string; value: unknown; reads: unknown }>
  blobChunks: Array<{
    name: string
    header: BlobChunkHeader
    bytesHex: string
    encodedHex: string
  }>
}

const vectors: Vectors = JSON.parse(
  readFileSync(join(PROTOCOL_DIR, 'vectors', 'v1.json'), 'utf8'),
) as Vectors

function kindOf(frame: unknown): FrameKind {
  return (frame as { kind: FrameKind }).kind
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

describe('runtime protocol v1 — conformance vectors', () => {
  it('vectors target this protocol version', () => {
    expect(vectors.protocol).toBe(RUNTIME_PROTOCOL_VERSION)
  })

  it('every accepted vector is a frame and survives an encode/decode round-trip', () => {
    for (const { name, frame } of vectors.frames) {
      expect(isFrame(frame), name).toBe(true)
      expect(decodeFrame(encodeFrame(frame as Frame)), name).toEqual(frame)
    }
  })

  it('every frame kind has at least one accepted vector', () => {
    const covered = new Set(vectors.frames.map(({ frame }) => kindOf(frame)))
    for (const kind of FRAME_KINDS) {
      expect(covered.has(kind), kind).toBe(true)
    }
  })

  it('every accepted vector carries only keys FRAME_KEYS declares for its kind', () => {
    for (const { name, frame } of vectors.frames) {
      const allowed = FRAME_KEYS[kindOf(frame)] as readonly string[]
      const extra = Object.keys(frame as object).filter(key => !allowed.includes(key))
      expect(extra, name).toEqual([])
    }
  })

  it('every key FRAME_KEYS declares is exercised by at least one vector of its kind', () => {
    for (const kind of FRAME_KINDS) {
      const seen = new Set(
        vectors.frames
          .filter(({ frame }) => kindOf(frame) === kind)
          .flatMap(({ frame }) => Object.keys(frame as object)),
      )
      for (const key of FRAME_KEYS[kind]) {
        expect(seen.has(key), `${kind}.${key}`).toBe(true)
      }
    }
  })

  it('only hello and welcome carry the protocol version', () => {
    for (const kind of FRAME_KINDS) {
      const carriesVersion = (FRAME_KEYS[kind] as readonly string[]).includes('v')
      expect(carriesVersion, kind).toBe(kind === 'hello' || kind === 'welcome')
    }
    // A version this runtime does not serve is still a frame: version policy is
    // the hub's (it answers `bye`), not the codec's.
    expect(vectors.frames.some(({ frame }) => kindOf(frame) === 'hello' && (frame as { v: number }).v === 2)).toBe(true)
  })

  it('every rejected vector is rejected, as a value and as text', () => {
    const tolerated = new Set(vectors.tolerated.map(t => t.name))
    for (const { name, value } of vectors.rejected) {
      expect(isFrame(value), name).toBe(false)
      if (tolerated.has(name)) continue
      expect(readFrame(value), name).toBeNull()
      expect(decodeFrame(JSON.stringify(value)), name).toBeNull()
    }
  })

  it('a receiver reads an unknown enumeration value as its fallback, never drops the frame', () => {
    const rejected = new Set(vectors.rejected.map(r => r.name))
    expect(vectors.tolerated.length).toBeGreaterThan(0)
    for (const { name, value, reads } of vectors.tolerated) {
      // Still not something a sender may emit…
      expect(rejected.has(name), name).toBe(true)
      expect(isFrame(value), name).toBe(false)
      // …but read, as a value (MessagePort) and as text (WebSocket).
      expect(readFrame(value), name).toEqual(reads)
      expect(decodeFrame(JSON.stringify(value)), name).toEqual(reads)
      expect(isFrame(reads), `${name} reads as a valid frame`).toBe(true)
    }
  })

  it('readFrame returns a known-valid frame unchanged', () => {
    for (const { name, frame } of vectors.frames) {
      expect(readFrame(frame), name).toBe(frame)
    }
  })

  it('accepts an absent payload / result the way JSON.stringify produces it', () => {
    // A client that calls request(route) with no payload sends `payload: undefined`,
    // which JSON.stringify drops; the frame must still be a frame on the far side.
    const req: Frame = { kind: 'req', id: 'r-9', route: 'session.list', payload: undefined }
    expect(encodeFrame(req)).not.toContain('payload')
    expect(decodeFrame(encodeFrame(req))).toEqual({ kind: 'req', id: 'r-9', route: 'session.list' })
    const res: Frame = { kind: 'res', id: 'r-9', ok: true, result: undefined }
    expect(decodeFrame(encodeFrame(res))).toEqual({ kind: 'res', id: 'r-9', ok: true })
  })

  it('decodeFrame returns null for text that is not JSON', () => {
    expect(decodeFrame('{nope')).toBeNull()
    expect(decodeFrame('')).toBeNull()
  })
})

describe('runtime protocol v1 — built-in request payloads', () => {
  it('the built-in routes are well-formed route keys', () => {
    for (const key of [TOPICS_SUBSCRIBE_ROUTE, TOPICS_UNSUBSCRIBE_ROUTE, SYS_PING_ROUTE]) {
      expect(isRouteKey(key), key).toBe(true)
    }
    expect(parseRouteKey(TOPICS_SUBSCRIBE_ROUTE)).toEqual({ cap: 'topics', act: 'subscribe' })
    expect(parseRouteKey(SYS_PING_ROUTE)).toEqual({ cap: 'sys', act: 'ping' })
  })

  it('topics.subscribe payload: an array of {topic, since?}', () => {
    expect(isTopicsSubscribePayload({ topics: [{ topic: 'sessions' }, { topic: 'session/s1/state', since: 40 }] })).toBe(true)
    expect(isTopicsSubscribePayload({ topics: [] })).toBe(true)
    expect(isTopicsSubscribePayload({ topics: [1, 2] })).toBe(false)
    expect(isTopicsSubscribePayload({ topics: [{ since: 3 }] })).toBe(false)
    expect(isTopicsSubscribePayload({ topics: [{ topic: 'sessions', since: -1 }] })).toBe(false)
    expect(isTopicsSubscribePayload({})).toBe(false)
    expect(isTopicsSubscribePayload(undefined)).toBe(false)
  })

  it('topics.unsubscribe payload: an array of topic ids', () => {
    expect(isTopicsUnsubscribePayload({ topics: ['sessions'] })).toBe(true)
    expect(isTopicsUnsubscribePayload({ topics: [{ topic: 'sessions' }] })).toBe(false)
    expect(isTopicsUnsubscribePayload({})).toBe(false)
  })

  it('sys.ping payload: {t}', () => {
    expect(isSysPingPayload({ t: 1757289600000 })).toBe(true)
    expect(isSysPingPayload({ t: 'now' })).toBe(false)
    expect(isSysPingPayload({})).toBe(false)
  })
})

describe('runtime protocol v1 — blob chunk framing', () => {
  it('encodes each vector byte-for-byte as the independent encoder did', () => {
    for (const { name, header, bytesHex, encodedHex } of vectors.blobChunks) {
      expect(bytesToHex(encodeBlobChunk(header, hexToBytes(bytesHex))), name).toBe(encodedHex)
    }
  })

  it('decodes each vector back to its header and bytes, with bytes as a view (no copy)', () => {
    for (const { name, header, bytesHex, encodedHex } of vectors.blobChunks) {
      const input = hexToBytes(encodedHex)
      const decoded = decodeBlobChunk(input)
      expect(decoded, name).not.toBeNull()
      expect(decoded!.header, name).toEqual(header)
      expect(bytesToHex(decoded!.bytes), name).toBe(bytesHex)
      expect(decoded!.bytes.buffer, name).toBe(input.buffer)
    }
  })

  it('rejects truncated, oversize-header, and malformed inputs', () => {
    // Shorter than the length prefix.
    expect(decodeBlobChunk(new Uint8Array([0, 0, 0]))).toBeNull()
    // Length prefix claims more header than the buffer holds.
    expect(decodeBlobChunk(new Uint8Array([0, 0, 0, 10, 0x7b]))).toBeNull()
    // Header over the cap, even when the bytes are all present.
    const oversize = new Uint8Array(4 + BLOB_CHUNK_HEADER_MAX_BYTES + 1)
    new DataView(oversize.buffer).setUint32(0, BLOB_CHUNK_HEADER_MAX_BYTES + 1, false)
    expect(decodeBlobChunk(oversize)).toBeNull()
    // Header is not JSON.
    const notJson = new TextEncoder().encode('abc')
    const notJsonBuf = new Uint8Array([0, 0, 0, notJson.byteLength, ...notJson])
    expect(decodeBlobChunk(notJsonBuf)).toBeNull()
    // Header missing a required field / with an invalid field.
    for (const bad of ['{"id":"x","index":0}', '{"id":"x","index":-1,"last":true}', '[1]']) {
      const hdr = new TextEncoder().encode(bad)
      expect(decodeBlobChunk(new Uint8Array([0, 0, 0, hdr.byteLength, ...hdr])), bad).toBeNull()
    }
  })

  it('encodeBlobChunk refuses a header over the cap', () => {
    expect(() =>
      encodeBlobChunk(
        { id: 'x'.repeat(BLOB_CHUNK_HEADER_MAX_BYTES), index: 0, last: true },
        new Uint8Array(),
      ),
    ).toThrow(RangeError)
  })
})

describe('runtime protocol v1 — routes and topics', () => {
  it('routeKey and parseRouteKey invert each other', () => {
    const r = route('session', 'submit')
    expect(routeKey(r)).toBe('session.submit')
    expect(parseRouteKey('session.submit')).toEqual(r)
    expect(parseRouteKey('ui.pickProjectFolder')).toEqual({ cap: 'ui', act: 'pickProjectFolder' })
    expect(isRouteKey('ui.pickProjectFolder')).toBe(true)
  })

  it('parseRouteKey rejects anything that is not exactly two identifier segments', () => {
    for (const bad of ['session', 'a.b.c', '.submit', 'session.', 'ses sion.submit', '1session.submit', '']) {
      expect(parseRouteKey(bad), bad).toBeNull()
      expect(isRouteKey(bad), bad).toBe(false)
    }
    expect(isRouteKey({ cap: 'session', act: 'submit' })).toBe(false)
  })

  it('topic builders and parseTopic invert each other', () => {
    const cases: Array<[string, ParsedTopic]> = [
      [topic.sessions(), { family: 'sessions' }],
      [
        topic.session('subagent-abc_1', 'state'),
        { family: 'session', sessionId: 'subagent-abc_1', kind: 'state' },
      ],
      [
        topic.session('s1', 'transcript'),
        { family: 'session', sessionId: 's1', kind: 'transcript' },
      ],
      [
        topic.sessionTool('s1', 'toolu_01'),
        { family: 'sessionTool', sessionId: 's1', toolCallId: 'toolu_01' },
      ],
      [topic.tasks(), { family: 'tasks' }],
      [topic.settings('features'), { family: 'settings', cap: 'features' }],
      [topic.shell('panel-1'), { family: 'shell', panelId: 'panel-1' }],
      [topic.notifications(), { family: 'notifications' }],
      [topic.presence(), { family: 'presence' }],
      [topic.diagTrace(), { family: 'diagTrace' }],
      [topic.mods(), { family: 'mods' }],
      [topic.modsUi('s1'), { family: 'modsUi', sessionId: 's1' }],
      [topic.terminals(), { family: 'terminals' }],
      [topic.terminal('term_1'), { family: 'terminal', terminalId: 'term_1' }],
    ]
    for (const [id, parsed] of cases) {
      expect(parseTopic(id), id).toEqual(parsed)
    }
  })

  it('topic builders refuse segments parseTopic could not read back', () => {
    expect(() => topic.session('a/b', 'state')).toThrow(RangeError)
    expect(() => topic.session('', 'state')).toThrow(RangeError)
    expect(() => topic.sessionTool('s1', 'x/y')).toThrow(RangeError)
    expect(() => topic.sessionTool('', 'toolu_01')).toThrow(RangeError)
    expect(() => topic.settings('')).toThrow(RangeError)
    expect(() => topic.shell('p/1')).toThrow(RangeError)
  })

  it('parseTopic rejects ids no builder produces', () => {
    for (const bad of [
      'session/s1',
      'session/s1/bogus',
      'session//state',
      'session/s1/tool',
      'mods/ui',
      'mods/ui/s1/x',
      'settings',
      'shell/a/b',
      'diag',
      'sessions/',
      '',
    ]) {
      expect(parseTopic(bad), bad).toBeNull()
    }
  })
})

describe('runtime protocol v1 — wire errors and blob refs', () => {
  it('derives retryable from the code and omits data when absent', () => {
    expect(wireError('timeout', 'slow').retryable).toBe(true)
    expect(wireError('host_unavailable', 'no bridge').retryable).toBe(true)
    const stale = wireError('stale', 'answered elsewhere')
    expect(stale.retryable).toBe(false)
    expect('data' in stale).toBe(false)
    expect(wireError('bad_payload', 'x', { field: 'sessionId' }).data).toEqual({ field: 'sessionId' })
  })

  it('isWireError guards the shape and optionally the code', () => {
    const e = wireError('stale', 'x')
    expect(isWireError(e)).toBe(true)
    expect(isWireError(e, 'stale')).toBe(true)
    expect(isWireError(e, 'timeout')).toBe(false)
    expect(isWireError({ code: 'boom', message: 'x', retryable: false })).toBe(false)
    expect(isWireError({ code: 'stale', message: 'x' })).toBe(false)
  })

  it('isBlobRef accepts the documented shape only', () => {
    expect(isBlobRef({ $blob: 'b', bytes: 3 })).toBe(true)
    expect(isBlobRef({ $blob: 'b', bytes: 3, mime: 'image/png', sha256: 'ab' })).toBe(true)
    expect(isBlobRef({ $blob: 'b', bytes: -1 })).toBe(false)
    expect(isBlobRef({ $blob: 'b', bytes: 1, mime: 5 })).toBe(false)
    expect(isBlobRef({ blob: 'b', bytes: 1 })).toBe(false)
  })
})

describe('runtime protocol v1 — zero-dependency guard', () => {
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        sourceFiles(full, out)
      } else if (/\.(?:ts|tsx|js|mjs)$/.test(name)) {
        out.push(full)
      }
    }
    return out
  }

  // Anchored on the specifier, not on the `import` / `export` keyword, so a
  // statement's layout (single-line, multi-line braces, `export … from`) does
  // not matter — an earlier version anchored on the keyword and could not see
  // any multi-line import, which is most of them.
  const FROM_SPECIFIER = /\bfrom\s+['"]([^'"]+)['"]/g
  const SIDE_EFFECT_IMPORT = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g
  const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]/g

  function specifiersOf(text: string): string[] {
    const out: string[] = []
    for (const pattern of [FROM_SPECIFIER, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT]) {
      for (const match of text.matchAll(pattern)) out.push(match[1])
    }
    return out
  }

  const files = sourceFiles(PROTOCOL_DIR)
  const specifiersByFile = new Map(
    files.map(file => [
      relative(PROTOCOL_DIR, file).replace(/\\/g, '/'),
      specifiersOf(readFileSync(file, 'utf8')),
    ]),
  )

  it('sees the multi-line imports the files actually have (the guard is not blind)', () => {
    expect([...specifiersByFile.keys()]).toContain('frames.ts')
    // codec.ts imports from './frames' with a multi-line brace list; index.ts
    // re-exports every module with multi-line `export { … } from` blocks.
    expect(specifiersByFile.get('codec.ts')).toEqual(
      expect.arrayContaining(['./frames', './errors', './route']),
    )
    expect(specifiersByFile.get('index.ts')).toEqual(
      expect.arrayContaining(['./errors', './frames', './route', './topics', './codec']),
    )
  })

  it('src/browser/runtimeProtocol imports nothing from outside the directory', () => {
    const offenders: string[] = []
    for (const [rel, specifiers] of specifiersByFile) {
      expect(rel.endsWith('.tsx'), `${rel}: no React/DOM code in the protocol package`).toBe(false)
      for (const spec of specifiers) {
        if (!spec.startsWith('./') || spec.includes('..')) {
          offenders.push(`${rel}: ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
