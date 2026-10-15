/**
 * Cheap field extraction over raw JSONL text — the lite (title) pass reads
 * a 64 KiB head + tail of each file and must not JSON.parse every line.
 * Ports the reference CLI's `firstStringValue` /
 * `lastStringValue` (sessionStoragePortable.ts): scan for
 * `"key":"` and walk to the closing quote honouring escapes.
 */

function decodeJsonEscapes(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

function scanValue(
  text: string,
  valueStart: number,
): { value: string; end: number } | null {
  let i = valueStart
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === '"') {
      return { value: decodeJsonEscapes(text.slice(valueStart, i)), end: i }
    }
    i++
  }
  return null
}

/** First `"key":"…"` string value in `text`, or undefined. */
export function firstStringValue(
  text: string,
  key: string,
): string | undefined {
  for (const pattern of [`"${key}":"`, `"${key}": "`]) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue
    const found = scanValue(text, idx + pattern.length)
    if (found) return found.value
  }
  return undefined
}

/** LAST `"key":"…"` string value in `text`, or undefined — for appended
 *  records (customTitle, summary, lastPrompt). */
export function lastStringValue(
  text: string,
  key: string,
): string | undefined {
  let lastValue: string | undefined
  for (const pattern of [`"${key}":"`, `"${key}": "`]) {
    let searchFrom = 0
    for (;;) {
      const idx = text.indexOf(pattern, searchFrom)
      if (idx < 0) break
      const found = scanValue(text, idx + pattern.length)
      if (!found) break
      lastValue = found.value
      searchFrom = found.end + 1
    }
  }
  return lastValue
}

/** `"key":true` / `"key": true` anywhere in `line`. */
export function hasTrueFlag(line: string, key: string): boolean {
  return line.includes(`"${key}":true`) || line.includes(`"${key}": true`)
}
