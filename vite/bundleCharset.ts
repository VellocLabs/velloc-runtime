import { parseAst, type Plugin } from 'vite'

/**
 * esbuild options shared by the page and worker builds (Vite sets `utf8`;
 * esbuild's own default, used by the isolated worker builds, is already ASCII).
 *
 * `charset: 'ascii'` writes each non-ASCII character as an escape. A script
 * source holding even one character above U+00FF is kept by the browser at two
 * bytes per character for its whole length; an ASCII-only source stays at one.
 */
export const BUNDLE_ESBUILD_OPTIONS = { charset: 'ascii' } as const

const hex4 = (unit: number): string => `\\u${unit.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * One regex literal's source with each non-ASCII character escaped; same
 * pattern, same flags. `\X` (an identity escape of a non-ASCII X) becomes the
 * code-point escape of X.
 */
export function escapeRegexLiteral(raw: string, flags: string): string {
  const unicode = flags.includes('u') || flags.includes('v')
  let out = ''
  for (let i = 0; i < raw.length; ) {
    const codePoint = raw.codePointAt(i)!
    const width = codePoint > 0xffff ? 2 : 1
    if (codePoint < 0x80) {
      out += raw[i]
      i += 1
      continue
    }
    let slashes = 0
    while (out[out.length - 1 - slashes] === '\\') slashes++
    if (slashes % 2 === 1) out = out.slice(0, -1)
    if (codePoint <= 0xffff) out += hex4(codePoint)
    else if (unicode) out += `\\u{${codePoint.toString(16).toUpperCase()}}`
    else out += hex4(raw.charCodeAt(i)) + hex4(raw.charCodeAt(i + 1))
    i += width
  }
  return out
}

type AstNode = { type?: string; start?: number; end?: number; regex?: { flags: string } }

/** `code` with every regex literal holding a non-ASCII character rewritten ASCII-only. */
export function escapeNonAsciiRegexLiterals(code: string): string {
  if (!/[^\x00-\x7f]/.test(code)) return code
  const edits: Array<{ start: number; end: number; text: string }> = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const ast = node as AstNode
    if (ast.type === 'Literal' && ast.regex && ast.start !== undefined && ast.end !== undefined) {
      const raw = code.slice(ast.start, ast.end)
      if (/[^\x00-\x7f]/.test(raw)) edits.push({ start: ast.start, end: ast.end, text: escapeRegexLiteral(raw, ast.regex.flags) })
      return
    }
    for (const key in node) {
      if (key !== 'type' && key !== 'start' && key !== 'end') visit((node as Record<string, unknown>)[key])
    }
  }
  visit(parseAst(code))
  if (edits.length === 0) return code
  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const edit of edits) {
    out += code.slice(at, edit.start) + edit.text
    at = edit.end
  }
  return out + code.slice(at)
}

/** Names of the emitted chunks whose code still holds a non-ASCII character (a kept comment, say). */
export function nonAsciiChunkNames(bundle: Record<string, { type: string; code?: string }>): string[] {
  return Object.entries(bundle)
    .filter(([, output]) => output.type === 'chunk' && /[^\x00-\x7f]/.test(output.code ?? ''))
    .map(([fileName]) => fileName)
}

/**
 * Runs after minification: escapes the regex literals esbuild's ASCII charset
 * leaves as written, then warns about any chunk that is still not ASCII-only.
 */
export function asciiRegexLiteralsPlugin(): Plugin {
  return {
    name: 'velloc:ascii-regex-literals',
    apply: 'build',
    renderChunk: {
      order: 'post',
      handler(code) {
        const next = escapeNonAsciiRegexLiterals(code)
        return next === code ? null : { code: next, map: null }
      },
    },
    generateBundle(_options, bundle) {
      for (const name of nonAsciiChunkNames(bundle)) {
        this.warn(`${name} holds a non-ASCII character; its source is stored at two bytes per character`)
      }
    },
  }
}
