/**
 * Size measures of a loaded text file; a heavy file skips the synchronous
 * Markdown renderer (F-9).
 * Contract: one linear pass, no allocation per line. `bytes` is the UTF-8
 * length, a lone surrogate counted as the 3-byte replacement character (as
 * `utf8ByteLength`); `lines` counts line breaks plus a final unterminated line;
 * `tableRows` counts lines whose first non-blank character is `|`, inside
 * fences too.
 */
export type TextHeaviness = { bytes: number; lines: number; tableRows: number };

export const HEAVY_TEXT_LIMITS = {
  bytes: 512 * 1024,
  lines: 10_000,
  tableRows: 1_500,
} as const;

const NEWLINE = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const PIPE = 0x7c;

export function measureText(text: string): TextHeaviness {
  let bytes = 0;
  let lines = 0;
  let tableRows = 0;
  let atLineStart = true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
        atLineStart = false;
        continue;
      }
      bytes += 3;
    } else bytes += 3;

    if (code === NEWLINE) {
      lines += 1;
      atLineStart = true;
      continue;
    }
    if (atLineStart) {
      if (code === SPACE || code === TAB || code === CR) continue;
      if (code === PIPE) tableRows += 1;
      atLineStart = false;
    }
  }
  if (text.length > 0 && text.charCodeAt(text.length - 1) !== NEWLINE) lines += 1;
  return { bytes, lines, tableRows };
}

/** True when any measure is over its limit in `HEAVY_TEXT_LIMITS`. */
export function isHeavyText(m: TextHeaviness): boolean {
  return (
    m.bytes > HEAVY_TEXT_LIMITS.bytes ||
    m.lines > HEAVY_TEXT_LIMITS.lines ||
    m.tableRows > HEAVY_TEXT_LIMITS.tableRows
  );
}
