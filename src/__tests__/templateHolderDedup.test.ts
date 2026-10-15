// Duplicate-paragraph guard for the template holders (F-19): no paragraph of 40+ words in two holder files; shared
// prose belongs in one `shared_includes/` holder. Exempt: the two profile renderings of one holder (`<name>.md` /
// `<name>-lean.md`), and the fixed SAFETY instruction, whose copies the second test requires byte-identical.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEAN_SUFFIX } from '../prompting/templateParsing'

const TEMPLATE_ROOT = path.resolve(process.cwd(), 'src/template')
const MIN_WORDS = 40
/** The fixed safety block every intro carries. */
const CYBER_RISK_PREFIX = 'IMPORTANT: Help with authorized security testing'

type Holder = { file: string; name: string }

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function holderFiles(): Holder[] {
  const out: Holder[] = []
  const add = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const base = f.slice(0, -'.md'.length)
      const name = base.endsWith(`-${LEAN_SUFFIX}`)
        ? base.slice(0, -(LEAN_SUFFIX.length + 1))
        : base
      out.push({ file: path.relative(TEMPLATE_ROOT, path.join(dir, f)), name })
    }
  }
  add(path.join(TEMPLATE_ROOT, 'shared_includes'))
  for (const type of readdirSync(TEMPLATE_ROOT)) {
    const inc = path.join(TEMPLATE_ROOT, type, 'includes')
    if (type !== 'shared_includes' && isDir(inc)) add(inc)
  }
  return out
}

function paragraphs(file: string): string[] {
  return readFileSync(path.join(TEMPLATE_ROOT, file), 'utf8')
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)
    .map(p => p.trim())
    .filter(p => p.split(/\s+/).length >= MIN_WORDS)
}

describe('template holders — no duplicated paragraphs', () => {
  it(`no paragraph of ${MIN_WORDS}+ words appears in two holder files (profile variants of one holder exempt)`, () => {
    const holders = holderFiles()
    expect(holders.length).toBeGreaterThan(10)
    const seen = new Map<string, Holder[]>()
    for (const h of holders) {
      for (const p of paragraphs(h.file)) {
        const list = seen.get(p) ?? []
        list.push(h)
        seen.set(p, list)
      }
    }
    const offenders: string[] = []
    for (const [p, where] of seen) {
      if (p.startsWith(CYBER_RISK_PREFIX)) continue
      const distinctHolders = new Set(where.map(h => h.name))
      if (where.length > 1 && distinctHolders.size > 1) {
        offenders.push(`${where.map(h => h.file).join(' + ')}: "${p.slice(0, 60)}…"`)
      }
    }
    expect(offenders, 'move the shared paragraph into ONE shared_includes/ holder').toEqual([])
  })

  it('the safety instruction is one constant: every copy is byte-identical', () => {
    // The exemption above is only safe while this holds. Every intro that
    // carries the fixed cyber-risk instruction must carry the SAME bytes —
    // an edit to one copy shows up here rather than silently diverging.
    // The SENTENCE, not the paragraph: code's standard intro continues the
    // same paragraph with its URL rule, which the lean one has no room for.
    const copies = holderFiles()
      .flatMap(h =>
        paragraphs(h.file)
          .filter(p => p.startsWith(CYBER_RISK_PREFIX))
          .map(p => ({ file: h.file, p: p.split('\n')[0] })),
      )
    // Every type's intro that has one, plus code's lean rendering.
    expect(copies.length).toBeGreaterThanOrEqual(3)
    const distinct = new Set(copies.map(x => x.p))
    expect(
      [...distinct],
      `the safety instruction differs between ${copies.map(x => x.file).join(', ')}`,
    ).toHaveLength(1)
  })

  it('the exemption is real: code_intro and code_intro-lean share their identity paragraph', () => {
    const std = paragraphs('code/includes/code_intro.md')
    const lean = paragraphs('code/includes/code_intro-lean.md')
    expect(std[0]).toBe(lean[0])
  })
})
