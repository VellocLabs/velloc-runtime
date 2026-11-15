/**
 * Bundles are minified with ASCII-only output (vite/bundleCharset.ts): every
 * non-ASCII character becomes an escape, and the code means the same.
 */
import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import {
  BUNDLE_ESBUILD_OPTIONS,
  escapeNonAsciiRegexLiterals,
  escapeRegexLiteral,
  nonAsciiChunkNames,
} from '../../vite/bundleCharset'

const nonAscii = (code: string) => [...code].filter(c => c.charCodeAt(0) >= 0x80)
const evalRegex = (literal: string): RegExp => new Function(`return ${literal}`)() as RegExp

describe('regex literal escaping', () => {
  it.each([
    ['/[A-Za-z぀-ヿ一-鿿]/', 'カ'],
    [`/[${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]/g`, String.fromCharCode(0x202b)],
    ['/�$/', 'abc�'],
    ['/😀+/u', '😀😀'],
    ['/😀+/', '😀'],
    ['/[─━│┃]/', '┃'],
    ['/\\ẞ/', 'ẞ'],
    ['/\\\\ẞ/', '\\ẞ'],
    ['/[\\-─]/v', '─'],
  ])('%s keeps its meaning and becomes ASCII', (literal, sample) => {
    const flags = literal.slice(literal.lastIndexOf('/') + 1)
    const escaped = escapeRegexLiteral(literal, flags)
    expect(nonAscii(escaped)).toEqual([])
    const before = evalRegex(literal)
    const after = evalRegex(escaped)
    expect(after.flags).toBe(before.flags)
    for (const text of [sample, 'plain ascii', '']) expect(after.test(text)).toBe(before.test(text))
  })

  it('rewrites only regex literals in a module', () => {
    const code = 'const a="─";const r=/[─]/g;export{a,r}'
    expect(escapeNonAsciiRegexLiterals(code)).toBe('const a="─";const r=/[\\u2500]/g;export{a,r}')
  })

  it('returns ASCII code untouched', () => {
    const code = 'export const r=/[\\u2500]/'
    expect(escapeNonAsciiRegexLiterals(code)).toBe(code)
  })

  it('names the chunks that are still not ASCII-only, and only chunks', () => {
    const bundle = {
      'a.js': { type: 'chunk', code: 'var a=1' },
      'b.js': { type: 'chunk', code: '/*! \u00a9 x */var b=1' },
      'c.css': { type: 'asset' },
    }
    expect(nonAsciiChunkNames(bundle)).toEqual(['b.js'])
  })
})

const SOURCE = [
  'export const dash = "a — b"',
  'export const box = `╭─╮ ${1 + 1} │`',
  'export const cjk = "我的，。"',
  'export const astral = "😀"',
  'export const 名前 = 1',
].join('\n')

describe('bundle charset', () => {
  it('minifies strings, templates and identifiers to ASCII-only output', async () => {
    const out = await transform(SOURCE, { ...BUNDLE_ESBUILD_OPTIONS, minify: true, format: 'esm', loader: 'js' })
    expect([...out.code].filter(c => c.charCodeAt(0) >= 0x80)).toEqual([])
  })

  it('keeps every value the same', async () => {
    const out = await transform(SOURCE, { ...BUNDLE_ESBUILD_OPTIONS, minify: true, format: 'cjs', loader: 'js' })
    const module = { exports: {} as Record<string, unknown> }
    new Function('exports', 'module', out.code)(module.exports, module)
    const exports = module.exports
    expect(exports.dash).toBe('a — b')
    expect(exports.box).toBe('╭─╮ 2 │')
    expect(exports.cjk).toBe('我的，。')
    expect(exports.astral).toBe('😀')
    expect(exports['名前']).toBe(1)
  })
})
