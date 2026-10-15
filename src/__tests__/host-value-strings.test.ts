import { describe, expect, it } from 'vitest'

import {
  escapeJsonString,
  HostDouble,
  HostInt,
  hostValueFromJs,
  parseHostJson,
  type HostValue,
} from '../models/drivers/hostValue'

// ── Reference: the per-code-point implementations the fast paths replaced ──
// Kept verbatim as the oracle. They are byte-exact to base::JSONWriter /
// JSONReader (pinned by host-call-options.test.ts) but allocate one rope
// node per character; the replacements must agree with them on every input.

function referenceEscape(text: string): string {
  let out = '"'
  for (const ch of text) {
    let cp = ch.codePointAt(0)!
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd
    switch (cp) {
      case 0x08: out += '\\b'; continue
      case 0x0c: out += '\\f'; continue
      case 0x0a: out += '\\n'; continue
      case 0x0d: out += '\\r'; continue
      case 0x09: out += '\\t'; continue
      case 0x5c: out += '\\\\'; continue
      case 0x22: out += '\\"'; continue
      case 0x3c: out += '\\u003C'; continue
      case 0x2028: out += '\\u2028'; continue
      case 0x2029: out += '\\u2029'; continue
    }
    if (cp < 0x20) out += '\\u' + cp.toString(16).toUpperCase().padStart(4, '0')
    else out += String.fromCodePoint(cp)
  }
  return out + '"'
}

/** The old `parseString`, driven over a whole top-level string literal. */
function referenceParseString(text: string): string | undefined {
  let pos = 0
  if (text[pos] !== '"') return undefined
  pos++
  let out = ''
  for (;;) {
    if (pos >= text.length) return undefined
    const c = text.charCodeAt(pos)
    if (c === 0x22) {
      pos++
      return pos === text.length ? out : undefined
    }
    if (c < 0x20) return undefined
    if (c >= 0xd800 && c <= 0xdfff) {
      const next = text.charCodeAt(pos + 1)
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += text[pos] + text[pos + 1]
        pos += 2
        continue
      }
      return undefined
    }
    if (c !== 0x5c) {
      out += text[pos]
      pos++
      continue
    }
    pos++
    const e = text[pos]
    pos++
    switch (e) {
      case '"': out += '"'; break
      case '\\': out += '\\'; break
      case '/': out += '/'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case 'u': {
        const readHex = (): number | undefined => {
          const hex = text.slice(pos, pos + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined
          pos += 4
          return parseInt(hex, 16)
        }
        const unit = readHex()
        if (unit === undefined) return undefined
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (text[pos] !== '\\' || text[pos + 1] !== 'u') return undefined
          pos += 2
          const low = readHex()
          if (low === undefined || low < 0xdc00 || low > 0xdfff) return undefined
          out += String.fromCharCode(unit, low)
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          return undefined
        } else {
          out += String.fromCharCode(unit)
        }
        break
      }
      default:
        return undefined
    }
  }
}

// ── Deterministic fuzz corpus ──

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// Every class of code unit the writer or reader treats specially, plus plain
// ASCII / BMP runs so the slice paths are exercised between them.
const RAW_PIECES = [
  'a', 'plain ascii run ', 'é', '中文', '！', '\u007f', '/',
  '"', '\\', '<', '>', ' ', ' ',
  '\u0000', '\u0001', '\b', '\f', '\n', '\r', '\t', '\u001f',
  '\u{1f600}', '\u{10ffff}', // pairs
  '\ud800', '\udbff', '\udc00', '\udfff', // halves: lone, or pairing by accident
]

// Only what JSON.stringify escapes as JSONWriter does, plus the `<` / U+2028/9
// it leaves raw: every string here takes the writer's JSON.stringify path.
const STRINGIFY_PATH_PIECES = [
  'a', 'plain ascii run ', 'é', '中文', '\u007f', '/',
  '"', '\\', '<', '<<', ' ', ' ', '\b', '\f', '\n', '\r', '\t',
  '\u{1f600}', '\u{10ffff}', '\\u003C', '\\n',
]

// Pieces of a string LITERAL body: raw characters, valid escapes, and
// malformed escapes the reader must reject.
const LITERAL_PIECES = [
  ...RAW_PIECES,
  '\\"', '\\\\', '\\/', '\\b', '\\f', '\\n', '\\r', '\\t',
  '\\u0041', '\\u00e9', '\\u003C', '\\u2028', '\\ud83d\\ude00', '\\uD83D\\uDE00',
  '\\ud800', '\\udc00', '\\ud800x', '\\ud800\\u0041', '\\u12', '\\x41', '\\', '\\u',
]

function randomString(next: () => number, pieces: readonly string[], maxPieces: number): string {
  let out = ''
  const n = Math.floor(next() * maxPieces)
  for (let i = 0; i < n; i++) out += pieces[Math.floor(next() * pieces.length)]
  return out
}

describe('hostValue strings — slice fast paths agree with the per-character reference', () => {
  it('escapeJsonString matches the reference on a fuzz corpus', () => {
    const next = rng(0x5eed)
    for (let i = 0; i < 20000; i++) {
      const text = randomString(next, RAW_PIECES, 24)
      expect(escapeJsonString(text), JSON.stringify(text)).toBe(referenceEscape(text))
    }
  })

  it('escapeJsonString matches the reference on its JSON.stringify path', () => {
    const next = rng(0x57a6)
    for (let i = 0; i < 20000; i++) {
      const text = randomString(next, STRINGIFY_PATH_PIECES, 24)
      expect(escapeJsonString(text), JSON.stringify(text)).toBe(referenceEscape(text))
    }
  })

  it('escapeJsonString: surrogate pairing at string edges and runs', () => {
    for (const text of [
      '', '\ud800', '\udc00', '\ud800𐀀', '𐀀\udc00',
      '\udc00\ud800', 'x\ud800', '\udc00x', '😀\ud83d', 'a"b\\c<d',
    ]) {
      expect(escapeJsonString(text), JSON.stringify(text)).toBe(referenceEscape(text))
    }
  })

  it('parseHostJson string literals match the reference on a fuzz corpus', () => {
    const next = rng(0xface)
    for (let i = 0; i < 20000; i++) {
      const literal = '"' + randomString(next, LITERAL_PIECES, 16) + '"'
      expect(parseHostJson(literal), JSON.stringify(literal)).toBe(referenceParseString(literal))
    }
  })

  it('parses unterminated and trailing-garbage literals like the reference', () => {
    for (const literal of ['"', '"abc', '"abc\\', '"a\\"', '"ab"c', '""', '"\\u0041"']) {
      expect(parseHostJson(literal), literal).toBe(referenceParseString(literal))
    }
  })

  it('reads back what the writer wrote, as the reference pair does', () => {
    const next = rng(0xbeef)
    for (let i = 0; i < 5000; i++) {
      // Lone halves become U+FFFD on write, so compare against the reference
      // round trip rather than the input.
      const text = randomString(next, RAW_PIECES, 24)
      expect(parseHostJson(escapeJsonString(text)), JSON.stringify(text)).toBe(
        referenceParseString(referenceEscape(text)),
      )
    }
  })
})

// ── hostValueFromJs: the direct conversion against its definition ──

/** Order- and type-preserving dump: HostInt and HostDouble differ, Map keys
 *  keep their insertion order. */
function dump(value: HostValue | undefined): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value instanceof HostInt) return `i${Object.is(value.value, -0) ? '-0' : value.value}`
  if (value instanceof HostDouble) return `d${value.value}`
  if (Array.isArray(value)) return '[' + value.map(dump).join(',') + ']'
  return '{' + [...value.entries()].map(([k, v]) => JSON.stringify(k) + ':' + dump(v)).join(',') + '}'
}

function viaText(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return dump(text === undefined ? undefined : parseHostJson(text))
  } catch (error) {
    return `throws ${(error as Error).name}`
  }
}

function direct(value: unknown): string {
  try {
    return dump(hostValueFromJs(value))
  } catch (error) {
    return `throws ${(error as Error).name}`
  }
}

const NUMBERS = [
  0, -0, 1, -1, 7, 2147483647, 2147483648, -2147483648, -2147483649, 0.5, -0.1,
  1e21, 1e-7, 3e12, 1.5e300, Number.MAX_SAFE_INTEGER, 2 ** 53 + 2, NaN, Infinity, -Infinity,
]
const STRINGS = ['', 'a', '<tag>', ' ', 'x\ud800', '\udc00', '\u{1f600}', '"q"\\', '\u0001', '﻿bom']

function randomJs(next: () => number, depth: number): unknown {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const r = next()
  if (depth > 4 || r < 0.35) {
    return pick<unknown>([
      null, true, false, undefined, () => 1, Symbol('s'), 10n,
      new Date(0), Object(3), Object('s'), Object(true),
      ...NUMBERS, ...STRINGS,
    ])
  }
  if (r < 0.65) {
    const list: unknown[] = []
    const n = Math.floor(next() * 5)
    for (let i = 0; i < n; i++) list.push(randomJs(next, depth + 1))
    if (next() < 0.1) list[n + 1] = 1 // a hole
    return list
  }
  const dict: Record<string, unknown> = {}
  const n = Math.floor(next() * 5)
  for (let i = 0; i < n; i++) dict[pick(['a', 'b', '1', 'z\ud800', 'toJSON', '\u{1f600}', 'k' + i])] = randomJs(next, depth + 1)
  return dict
}

function nested(depth: number, leaf: unknown): unknown {
  let value = leaf
  for (let i = 1; i < depth; i++) value = [value]
  return value
}

describe('hostValueFromJs — direct conversion equals parseHostJson(JSON.stringify(v))', () => {
  it('on a fuzz corpus of JS values', () => {
    const next = rng(0xd1ec7)
    for (let i = 0; i < 20000; i++) {
      const value = randomJs(next, 1)
      expect(direct(value), viaText(value)).toBe(viaText(value))
    }
  })

  it('on every number edge, top-level skips, and the depth limit', () => {
    const cases: unknown[] = [
      ...NUMBERS, ...STRINGS, undefined, () => 1, Symbol('s'), 10n, null,
      { toJSON: () => ({ a: 1 }) }, { toJSON: 5 }, [undefined, () => 1], { a: undefined, b: 1 },
      new Map([['a', 1]]), new Uint8Array([1, 2]), Object.create({ inherited: 1 }),
      nested(200, 1), nested(201, 1), nested(200, []), nested(201, undefined),
      [nested(200, { a: undefined })],
    ]
    for (const value of cases) {
      expect(direct(value), viaText(value)).toBe(viaText(value))
    }
  })

  it('on a cycle (JSON.stringify throws)', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(direct(cyclic)).toBe(viaText(cyclic))
  })
})

// ── Cost guard ──
// A request body carries base64 images and tool output of several MB, written
// and re-read once per model call. The per-character implementations ran
// >100x slower than the engine's own JSON on such a string; the slice paths
// run within ~2x of it. Measured against JSON.stringify / JSON.parse on the
// same input, interleaved round by round so CPU contention from parallel test
// workers lands on both sides, and the bound holds on any machine.

function bestRatio(rounds: number, native: () => unknown, ours: () => unknown): number {
  let bestNative = Infinity
  let bestOurs = Infinity
  for (let i = 0; i < rounds; i++) {
    let t = performance.now()
    native()
    bestNative = Math.min(bestNative, performance.now() - t)
    t = performance.now()
    ours()
    bestOurs = Math.min(bestOurs, performance.now() - t)
  }
  return bestOurs / Math.max(bestNative, 0.5)
}

describe('hostValue strings — cost on a multi-MB string stays near native JSON', () => {
  // base64 alphabet: nothing to escape, the common large payload.
  const big = 'QUJDRA+/'.repeat(512 * 1024) // 4 MiB
  const literal = JSON.stringify(big)
  const MAX_RATIO = 30

  it('escapeJsonString', () => {
    expect(bestRatio(7, () => JSON.stringify(big), () => escapeJsonString(big))).toBeLessThan(MAX_RATIO)
  })

  it('parseHostJson', () => {
    expect(bestRatio(7, () => JSON.parse(literal), () => parseHostJson(literal))).toBeLessThan(MAX_RATIO)
  })

  // Source code: an escape every few characters (quotes, backslashes, `<`,
  // tabs, newlines) — the shape that defeats a per-escape JS path.
  const CODE_LINE = '  if (a < b && s === "x\\y") { out.push(`${a}\t<tag>`) }\n'
  const code = CODE_LINE.repeat(Math.ceil((4 * 1024 * 1024) / CODE_LINE.length))
  const codeLiteral = JSON.stringify(code)

  it('escapeJsonString on escape-dense source code', () => {
    expect(bestRatio(7, () => JSON.stringify(code), () => escapeJsonString(code))).toBeLessThan(MAX_RATIO)
  })

  it('parseHostJson on escape-dense source code', () => {
    expect(bestRatio(7, () => JSON.parse(codeLiteral), () => parseHostJson(codeLiteral))).toBeLessThan(MAX_RATIO)
  })

  // The payload's strings are shared, never copied: converting a request
  // costs less than serializing it once. Through JSON text it costs a
  // serialization plus a parse — at least ~2x.
  it('hostValueFromJs costs less than one JSON.stringify of the payload', () => {
    const payload = {
      messages: Array.from({ length: 16 }, (_, i) => ({
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: `c${i}`, result: (i % 2 ? big : code).slice(0, 1024 * 1024) }],
      })),
    }
    expect(bestRatio(7, () => JSON.stringify(payload), () => hostValueFromJs(payload))).toBeLessThan(1)
  })
})
