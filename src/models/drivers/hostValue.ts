/**
 * A byte-faithful model of Chromium's `base::Value` as the LLM host sees it: numbers
 * are typed (an int32 integer literal is a HostInt, else a HostDouble), dict keys
 * are written in sorted byte order, and `JSONWriter` escaping (`<`, U+2028/9,
 * upper-case `\u00XX`) applies. `hostValueFromJs` is by definition
 * `parseHostJson(JSON.stringify(value))`.
 */

export class HostInt {
  constructor(readonly value: number) {}
}

export class HostDouble {
  constructor(readonly value: number) {}
}

export type HostDict = Map<string, HostValue>
export type HostList = HostValue[]
export type HostValue = null | boolean | string | HostInt | HostDouble | HostList | HostDict

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
// base/json/json_common.h kAbsoluteMaxDepth.
const MAX_DEPTH = 200

export function isHostDict(value: HostValue | undefined): value is HostDict {
  return value instanceof Map
}

export function isHostList(value: HostValue | undefined): value is HostList {
  return Array.isArray(value)
}

// ── DictValue accessors (base/values.h semantics) ─────────────────────────

export function findString(dict: HostDict, key: string): string | undefined {
  const value = dict.get(key)
  return typeof value === 'string' ? value : undefined
}

/** `FindInt`: an INT only — a double (even `3.0`) misses. */
export function findInt(dict: HostDict, key: string): number | undefined {
  const value = dict.get(key)
  return value instanceof HostInt ? value.value : undefined
}

/** `FindDouble`: a double, or an int widened to double. */
export function findDouble(dict: HostDict, key: string): number | undefined {
  const value = dict.get(key)
  if (value instanceof HostDouble || value instanceof HostInt) return value.value
  return undefined
}

export function findBool(dict: HostDict, key: string): boolean | undefined {
  const value = dict.get(key)
  return typeof value === 'boolean' ? value : undefined
}

export function findList(dict: HostDict, key: string): HostList | undefined {
  const value = dict.get(key)
  return isHostList(value) ? value : undefined
}

export function findDict(dict: HostDict, key: string): HostDict | undefined {
  const value = dict.get(key)
  return isHostDict(value) ? value : undefined
}

/** `bridge_support::FindNonEmptyString`. */
export function findNonEmptyString(dict: HostDict, key: string): string | undefined {
  const value = findString(dict, key)
  return value ? value : undefined
}

/** `base::StringToInt` (int32): optional '+'/'-', decimal digits only, no
 *  leading/trailing whitespace, no overflow. */
export function stringToInt(text: string): number | undefined {
  if (!/^[+-]?\d+$/.test(text)) return undefined
  const big = BigInt(text.startsWith('+') ? text.slice(1) : text)
  if (big < BigInt(INT32_MIN) || big > BigInt(INT32_MAX)) return undefined
  return Number(big)
}

// ── Ordering ──────────────────────────────────────────────────────────────

/** std::string `<` on UTF-8 bytes == code-point order (not UTF-16 order). */
export function compareUtf8(a: string, b: string): number {
  const ia = a[Symbol.iterator]()
  const ib = b[Symbol.iterator]()
  for (;;) {
    const na = ia.next()
    const nb = ib.next()
    if (na.done) return nb.done ? 0 : -1
    if (nb.done) return 1
    const ca = na.value.codePointAt(0)!
    const cb = nb.value.codePointAt(0)!
    if (ca !== cb) return ca < cb ? -1 : 1
  }
}

export function sortedEntries(dict: HostDict): Array<[string, HostValue]> {
  return [...dict.entries()].sort((x, y) => compareUtf8(x[0], y[0]))
}

// ── Writer (base::JSONWriter::Write, default options) ─────────────────────

/** `base::NumberToString(double)`: double-conversion shortest, decimal for
 *  exponents in [-6, 12), exponential (`1.5e+12`) outside
 *  (base/strings/string_number_conversions_internal.h). JS switches to
 *  exponential only at 1e21, so the 1e12..1e21 band differs from String(). */
export function numberToStringDouble(value: number): string {
  if (Object.is(value, -0)) return '-0'
  if (value === 0) return '0'
  const exponential = value.toExponential()
  const exponent = Number(exponential.slice(exponential.indexOf('e') + 1))
  if (exponent >= -6 && exponent < 12) return String(value)
  return exponential
}

function writeDouble(value: number): string {
  let real = numberToStringDouble(value)
  if (!/[.eE]/.test(real)) real += '.0'
  if (real[0] === '.') real = '0' + real
  else if (real.startsWith('-.')) real = '-0' + real.slice(1)
  return real
}

// Everything JSONWriter writes differently from the raw character: control
// characters, `"`, `\`, `<`, U+2028/9 — and every surrogate code unit, so the
// replacer can tell a pair (kept) from a lone half (U+FFFD).
const ESCAPE_TARGETS = /[\u0000-\u001f"\\<\u2028\u2029\ud800-\udfff]/g

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

function escapeTarget(ch: string, offset: number, text: string): string {
  const cp = ch.charCodeAt(0)
  if (cp >= 0xd800 && cp <= 0xdfff) {
    // A lone surrogate cannot exist in the C++ std::string (UTF-8); the
    // UTF-16→UTF-8 hop turned it into U+FFFD. A pair is written raw.
    const paired = isHighSurrogate(cp)
      ? isLowSurrogate(text.charCodeAt(offset + 1))
      : isHighSurrogate(text.charCodeAt(offset - 1))
    return paired ? ch : '\ufffd'
  }
  switch (cp) {
    case 0x08: return '\\b'
    case 0x0c: return '\\f'
    case 0x0a: return '\\n'
    case 0x0d: return '\\r'
    case 0x09: return '\\t'
    case 0x5c: return '\\\\'
    case 0x22: return '\\"'
    case 0x3c: return '\\u003C'
    case 0x2028: return '\\u2028'
    case 0x2029: return '\\u2029'
  }
  return '\\u' + cp.toString(16).toUpperCase().padStart(4, '0')
}

// Controls JSON.stringify writes as lower-case `\u00xx` where JSONWriter
// writes upper-case. (\b \f \n \r \t are written alike by both.)
const HEX_ESCAPED_CONTROL = /[\u0000-\u0007\u000b\u000e-\u001f]/

/**
 * `base::EscapeJSONString`, quoted. Never appends per character: a per-character
 * `+=` builds a rope node per character and multiplies a large string's memory.
 */
export function escapeJsonString(text: string): string {
  if (HEX_ESCAPED_CONTROL.test(text) || !text.isWellFormed()) {
    return '"' + text.replace(ESCAPE_TARGETS, escapeTarget) + '"'
  }
  let out = JSON.stringify(text)
  if (out.includes('<')) out = out.replaceAll('<', '\\u003C')
  if (out.includes(' ')) out = out.replaceAll(' ', '\\u2028')
  if (out.includes(' ')) out = out.replaceAll(' ', '\\u2029')
  return out
}

export function writeHostJson(value: HostValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return escapeJsonString(value)
  if (value instanceof HostInt) return String(value.value)
  if (value instanceof HostDouble) return writeDouble(value.value)
  if (Array.isArray(value)) return '[' + value.map(writeHostJson).join(',') + ']'
  return (
    '{'
    + sortedEntries(value)
      .map(([k, v]) => escapeJsonString(k) + ':' + writeHostJson(v))
      .join(',')
    + '}'
  )
}

// ── Reader (base::JSONReader, JSON_PARSE_RFC) ─────────────────────────────

class ParseFailure extends Error {}

// A run of string-body characters that need no check: not a quote, backslash,
// control character or surrogate half. Sticky, and always matches (maybe
// empty), so `lastIndex` lands on the next character that does.
const PLAIN_RUN = /[^"\\\u0000-\u001f\ud800-\udfff]*/y

/** Parses `text` like `base::JSONReader::Read(text, JSON_PARSE_RFC)`;
 *  undefined when the C++ reader would return nullopt. */
export function parseHostJson(text: string): HostValue | undefined {
  // base::JSONReader (the serde_json_lenient wrapper, lib.rs) drops a leading
  // UTF-8 byte-order mark before parsing, in every mode.
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const fail = (): never => {
    throw new ParseFailure()
  }
  const skipWs = () => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos)
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++
      else break
    }
  }
  // Four hex digits at `at` as a code unit; -1 when they are not.
  const hex4 = (at: number): number => {
    let unit = 0
    for (let i = at; i < at + 4; i++) {
      const d = text.charCodeAt(i)
      const v = d >= 0x30 && d <= 0x39 ? d - 0x30
        : d >= 0x41 && d <= 0x46 ? d - 0x37
          : d >= 0x61 && d <= 0x66 ? d - 0x57
            : -1
      if (v < 0) return -1
      unit = unit * 16 + v
    }
    return unit
  }
  // JS only VALIDATES the literal — the reader's rules, allocating nothing —
  // and the engine builds the value: a slice when there is no escape, else
  // `JSON.parse` of the literal, one flat decode. Once validated, JSON.parse
  // accepts it and decodes every escape as the C++ reader does; what the two
  // disagree on (a lone `\ud800`, a raw lone surrogate) was rejected above.
  // Building the value here per character instead made a rope of one ~30-byte
  // node per character: ~33 MB alive per 1 MB base64 image for the parse.
  const parseString = (): string => {
    // opening quote already checked
    const open = pos
    pos++
    let escaped = false
    for (;;) {
      // Skip the whole run of plain characters in one native scan.
      PLAIN_RUN.lastIndex = pos
      PLAIN_RUN.test(text)
      pos = PLAIN_RUN.lastIndex
      if (pos >= text.length) fail()
      const c = text.charCodeAt(pos)
      if (c === 0x22) {
        pos++
        return escaped ? (JSON.parse(text.slice(open, pos)) as string) : text.slice(open + 1, pos - 1)
      }
      if (c < 0x20) fail()
      if (c >= 0xd800 && c <= 0xdfff) {
        // Raw surrogates must form a pair (valid UTF-8 on the C++ side).
        if (isHighSurrogate(c) && isLowSurrogate(text.charCodeAt(pos + 1))) {
          pos += 2
          continue
        }
        fail()
      }
      // A backslash.
      escaped = true
      const e = text.charCodeAt(pos + 1)
      if (e === 0x75 /* u */) {
        const unit = hex4(pos + 2)
        if (unit < 0 || isLowSurrogate(unit)) fail()
        pos += 6
        if (isHighSurrogate(unit)) {
          if (text.charCodeAt(pos) !== 0x5c || text.charCodeAt(pos + 1) !== 0x75) fail()
          if (!isLowSurrogate(hex4(pos + 2))) fail()
          pos += 6
        }
        continue
      }
      switch (e) {
        case 0x22: // "
        case 0x5c: // \
        case 0x2f: // /
        case 0x62: // b
        case 0x66: // f
        case 0x6e: // n
        case 0x72: // r
        case 0x74: // t
          pos += 2
          continue
      }
      fail()
    }
  }
  const parseNumber = (): HostValue => {
    const match = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(pos, pos + 400))
    if (!match) fail()
    const literal = match![0]
    pos += literal.length
    const value = Number(literal)
    if (!match![1] && !match![2] && value >= INT32_MIN && value <= INT32_MAX) {
      return new HostInt(value === 0 ? 0 : value)
    }
    if (!Number.isFinite(value)) fail()
    return new HostDouble(value)
  }
  const parseValue = (depth: number): HostValue => {
    if (depth > MAX_DEPTH) fail()
    skipWs()
    const c = text[pos]
    if (c === '{') {
      pos++
      const dict: HostDict = new Map()
      skipWs()
      if (text[pos] === '}') {
        pos++
        return dict
      }
      for (;;) {
        skipWs()
        if (text[pos] !== '"') fail()
        const key = parseString()
        skipWs()
        if (text[pos] !== ':') fail()
        pos++
        dict.set(key, parseValue(depth + 1))
        skipWs()
        if (text[pos] === ',') {
          pos++
          continue
        }
        if (text[pos] === '}') {
          pos++
          return dict
        }
        fail()
      }
    }
    if (c === '[') {
      pos++
      const list: HostList = []
      skipWs()
      if (text[pos] === ']') {
        pos++
        return list
      }
      for (;;) {
        list.push(parseValue(depth + 1))
        skipWs()
        if (text[pos] === ',') {
          pos++
          continue
        }
        if (text[pos] === ']') {
          pos++
          return list
        }
        fail()
      }
    }
    if (c === '"') return parseString()
    if (text.startsWith('true', pos)) {
      pos += 4
      return true
    }
    if (text.startsWith('false', pos)) {
      pos += 5
      return false
    }
    if (text.startsWith('null', pos)) {
      pos += 4
      return null
    }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return parseNumber()
    return fail()
  }
  try {
    const value = parseValue(1)
    skipWs()
    if (pos !== text.length) return undefined
    return value
  } catch (error) {
    if (error instanceof ParseFailure) return undefined
    throw error
  }
}

/** `base::JSONReader::ReadDict`. */
export function parseHostJsonDict(text: string): HostDict | undefined {
  const value = parseHostJson(text)
  return isHostDict(value) ? value : undefined
}

/** Anything `fromPlainJs` does not model exactly; the caller falls back to the
 *  text round trip, which is the definition. */
class NotPlainJson extends Error {}

const SKIPPED = Symbol('skipped')

/**
 * `parseHostJson(JSON.stringify(value))` without the text in between, sharing the
 * value's strings. Mirrors the round trip rule by rule; anything whose outcome is
 * not a plain value (toJSON, boxed primitive, BigInt, lone surrogate, too deep or
 * cyclic) throws `NotPlainJson`.
 */
function fromPlainJs(value: unknown, depth: number): HostValue | typeof SKIPPED {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return SKIPPED
  }
  if (depth > MAX_DEPTH) throw new NotPlainJson()
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
      return value
    case 'string':
      if (!value.isWellFormed()) throw new NotPlainJson()
      return value
    case 'number':
      if (Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX) {
        return new HostInt(value === 0 ? 0 : value)
      }
      return Number.isFinite(value) ? new HostDouble(value) : null
    case 'object': {
      if (
        typeof (value as { toJSON?: unknown }).toJSON === 'function'
        || value instanceof Number
        || value instanceof String
        || value instanceof Boolean
        || value instanceof BigInt
      ) {
        throw new NotPlainJson()
      }
      if (Array.isArray(value)) {
        const list: HostList = []
        for (let i = 0; i < value.length; i++) {
          const item = fromPlainJs(value[i], depth + 1)
          if (item !== SKIPPED) {
            list.push(item)
            continue
          }
          // Written as `null` — a value the reader counts against its depth.
          if (depth + 1 > MAX_DEPTH) throw new NotPlainJson()
          list.push(null)
        }
        return list
      }
      const dict: HostDict = new Map()
      for (const key of Object.keys(value)) {
        const item = fromPlainJs((value as Record<string, unknown>)[key], depth + 1)
        if (item === SKIPPED) continue
        if (!key.isWellFormed()) throw new NotPlainJson()
        dict.set(key, item)
      }
      return dict
    }
    default:
      // bigint
      throw new NotPlainJson()
  }
}

/** A JS value as the host receives it over the bridge (JSON text → reader):
 *  by definition `parseHostJson(JSON.stringify(value))`, which is what runs
 *  whenever `fromPlainJs` cannot vouch for an identical result. */
export function hostValueFromJs(value: unknown): HostValue | undefined {
  try {
    const direct = fromPlainJs(value, 1)
    return direct === SKIPPED ? undefined : direct
  } catch (error) {
    if (!(error instanceof NotPlainJson)) throw error
  }
  const text = JSON.stringify(value)
  return text === undefined ? undefined : parseHostJson(text)
}

/** A HostValue back to plain JS (numbers lose their int/double tag). */
export function hostValueToJs(value: HostValue): unknown {
  if (value instanceof HostInt || value instanceof HostDouble) return value.value
  if (Array.isArray(value)) return value.map(hostValueToJs)
  if (value instanceof Map) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of sortedEntries(value)) out[k] = hostValueToJs(v)
    return out
  }
  return value
}

/** Builds a HostDict from entries — for readability at call sites. */
export function hostDict(entries: Array<[string, HostValue]>): HostDict {
  return new Map(entries)
}
