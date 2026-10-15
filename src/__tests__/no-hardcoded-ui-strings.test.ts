import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import { en } from '../browser/webview/i18n/messages/en'
import {
  SUB_AGENT_CATEGORY_LABEL_KEY,
  SUB_AGENT_STATUS_LABEL_KEY,
} from '../browser/webview/backgroundSubAgents'

// Guard for G-1 ("no hard-coded user-visible text"): scans the `.tsx` under the two UI trees for literal JSX text,
// prose string expressions and prose template literals (whole file, comments stripped), and allows only the
// exclusions below. A heuristic floor: single-word labels, lower-case badges and `.ts` files are not seen, so a
// failure is a finding and a pass is not a clean bill.

const ROOT = join(__dirname, '..')
const UI_DIRS = ['browser/webview', 'components/assistant-ui']

/**
 * Files that legitimately still carry English literals, with the reason.
 * Shrinking this list is good; growing it needs a reason in review.
 */
const ALLOWED = new Map<string, string>([
  [
    'browser/webview/AssistantUiThread.tsx',
    'The deny `feedback` string is a tool result sent to the MODEL, not UI text.',
  ],
  [
    'browser/webview/AskUserQuestionToolUI.tsx',
    'ONLY the answered-questions prose: an `AskUserQuestionOutput` handed to `addResult`, read by the MODEL. Every rendered string in this file goes through the catalog — the exemption covers the tool result, not the file.',
  ],
  [
    'browser/webview/WebviewComposer.tsx',
    'Dead component — exported from the barrel but never rendered. Delete rather than translate.',
  ],
  [
    'browser/webview/WebviewMessageList.tsx',
    'Dead component — exported from the barrel but never rendered. Delete rather than translate.',
  ],
  [
    'browser/webview/settings/sections/PluginsSection.tsx',
    'Marketplace display names are third-party proper nouns; the catalog test also forbids "Claude" in any catalog value.',
  ],
])

const ATTRS = ['aria-label', 'title', 'placeholder', 'alt', 'label']
const ATTR_RE = new RegExp(`\\b(${ATTRS.join('|')})=("|')([^"'{}<>]{2,})\\2`, 'g')
const JSX_TEXT_RE = />\s*([A-Z][A-Za-z][^<>{}\n]{2,80}?)\s*</g
const JSX_EXPR_RE = /[{?:]\s*("|')([A-Z][^"']{3,60})\1/g

// Blind spot 3: JSX text Prettier wrapped across lines, so `>` and `</` never
// share one. Requires a newline inside, which is what makes it disjoint from
// the single-line pass rather than a duplicate of it.
const JSX_WRAPPED_TEXT_RE = />\s*\n\s*([A-Z][^<>{}]*?)\s*\n\s*<\//g

// Blind spot 4: backtick strings. Deliberately narrow — a template literal is
// flagged only when its static text reads as a SENTENCE (ends in terminal
// punctuation), because class lists, URLs, ids and format fragments are the
// overwhelming majority of template literals in a UI tree and none of them do.
const TEMPLATE_RE = /`([^`\\]{15,400})`/g
const INTERPOLATION_RE = /\$\{[^}]*\}/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') walk(full, out)
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

function looksLikeProse(value: string): boolean {
  const s = value.trim()
  if (!/[A-Za-z]/.test(s)) return false
  if (/^(http|\/|#|data:|chrome)/.test(s)) return false
  if (/^[A-Za-z0-9_.-]+$/.test(s)) return false
  return s.includes(' ')
}

/** A sentence, not a fragment: several words ending in terminal punctuation. */
function looksLikeSentence(value: string): boolean {
  const s = value.replace(INTERPOLATION_RE, ' ').replace(/\s+/g, ' ').trim()
  if (!looksLikeProse(s)) return false
  if (!/[.!?]$/.test(s)) return false
  return s.split(' ').filter(w => /[A-Za-z]/.test(w)).length >= 4
}

/**
 * The two whole-file passes work on source with comments removed: they span
 * newlines, so the line-level "starts with //" skip cannot protect them, and
 * this file's own explanatory prose would otherwise match as JSX text.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead)
}

type Hit = { file: string; line: number; text: string }

function scan(file: string): Hit[] {
  const rel = relative(ROOT, file).split(sep).join('/')
  const hits: Hit[] = []
  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      return
    }
    const seen = new Set<string>()
    const push = (text: string) => {
      if (!looksLikeProse(text) || seen.has(text)) return
      seen.add(text)
      hits.push({ file: rel, line: i + 1, text })
    }
    for (const m of line.matchAll(ATTR_RE)) push(m[3]!)
    for (const m of line.matchAll(JSX_TEXT_RE)) push(m[1]!)
    for (const m of line.matchAll(JSX_EXPR_RE)) push(m[2]!)
  })

  const code = stripComments(source)
  const lineOf = (index: number) => code.slice(0, index).split('\n').length
  const seenWhole = new Set<string>()
  const pushWhole = (text: string, index: number) => {
    const flat = text.replace(INTERPOLATION_RE, ' ').replace(/\s+/g, ' ').trim()
    if (seenWhole.has(flat)) return
    seenWhole.add(flat)
    hits.push({ file: rel, line: lineOf(index), text: flat })
  }
  for (const m of code.matchAll(JSX_WRAPPED_TEXT_RE)) {
    if (looksLikeProse(m[1]!.replace(/\s+/g, ' ').trim())) pushWhole(m[1]!, m.index!)
  }
  for (const m of code.matchAll(TEMPLATE_RE)) {
    if (looksLikeSentence(m[1]!)) pushWhole(m[1]!, m.index!)
  }
  return hits
}

describe('no hard-coded user-visible strings in the webview UI', () => {
  const files = UI_DIRS.flatMap(d => walk(join(ROOT, d)))

  it('scans a non-trivial number of components (guard against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(40)
  })

  it('finds no literal outside the documented exclusions', () => {
    const offenders = files
      .flatMap(scan)
      .filter(h => !ALLOWED.has(h.file))
      .map(h => `${h.file}:${h.line}  ${h.text}`)
    expect(offenders).toEqual([])
  })

  // The two label maps the scanner is structurally blind to (blind spot 2):
  // they live in a `.ts` file and hold rendered text. TypeScript pins that the
  // values are MessageKeys; this pins that they actually resolve, so a key
  // renamed in the catalog cannot leave the drawer rendering raw dotted keys.
  it('resolves the background-tasks label maps through the catalog', () => {
    const keys = [
      ...Object.values(SUB_AGENT_CATEGORY_LABEL_KEY),
      ...Object.values(SUB_AGENT_STATUS_LABEL_KEY),
    ]
    // 5 kind categories (subagent / shell / supershell / run_js / running) + 4
    // per-row statuses.
    expect(keys.length).toBe(9)
    const unresolved = keys.filter(k => !(k in en))
    expect(unresolved).toEqual([])
  })

  it('keeps every allow-listed file actually carrying a literal', () => {
    // Stops the list rotting: once a file is cleaned up its entry must go, so
    // the exclusions stay an honest record rather than a permanent amnesty.
    const withHits = new Set(files.flatMap(scan).map(h => h.file))
    const stale = [...ALLOWED.keys()].filter(f => !withHits.has(f))
    expect(stale).toEqual([])
  })
})
