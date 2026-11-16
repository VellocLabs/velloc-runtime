/**
 * The phone shell (F-24) and the desktop shell stay apart. Code under `src/mobile/` reaches the
 * desktop webview only through its logic modules (`.ts`: hooks, stores, factories) and the few
 * `.tsx` modules listed below — the conversation view's entry and context-only modules — never a
 * desktop UI component. Nothing outside `src/mobile/` imports from it, and the phone shell's
 * static graph does not carry the desktop shell.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  SRC,
  rel,
  resolveSpecifier,
  staticClosure,
  staticImportPath,
  staticImports,
} from './_helpers/staticImportGraph'

const MOBILE_DIR = join(SRC, 'mobile')
const WEBVIEW_DIR = join(SRC, 'browser', 'webview')

/** The webview `.tsx` modules the phone shell may import directly. */
const ALLOWED_WEBVIEW_TSX = new Set([
  'src/browser/webview/shellSessionThread.tsx',
  'src/browser/webview/i18n/index.tsx',
  'src/browser/webview/RuntimeConnectionBanner.tsx',
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue
      out.push(...sourceFiles(path))
    } else if (/\.(?:ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

const inside = (file: string, dir: string): boolean => file.startsWith(dir + sep)

describe('the phone shell imports', () => {
  it('reach the desktop webview only through logic modules and the listed .tsx modules', () => {
    const offending: string[] = []
    for (const file of sourceFiles(MOBILE_DIR)) {
      for (const specifier of staticImports(file)) {
        const target = resolveSpecifier(specifier, file)
        if (!target || !inside(target, WEBVIEW_DIR) || !target.endsWith('.tsx')) continue
        if (!ALLOWED_WEBVIEW_TSX.has(rel(target))) offending.push(`${rel(file)} -> ${rel(target)}`)
      }
    }
    expect(offending).toEqual([])
  })

  it('are not imported from outside src/mobile', () => {
    const offending: string[] = []
    for (const file of sourceFiles(SRC)) {
      if (inside(file, MOBILE_DIR)) continue
      for (const specifier of staticImports(file)) {
        const target = resolveSpecifier(specifier, file)
        if (target && inside(target, MOBILE_DIR)) offending.push(`${rel(file)} -> ${rel(target)}`)
      }
    }
    expect(offending).toEqual([])
  })

  it('do not carry the desktop shell into the phone bundle', () => {
    const shell = join(MOBILE_DIR, 'MobileShell.tsx')
    const desktop = join(WEBVIEW_DIR, 'MultiSessionShell.tsx')
    expect(staticClosure([shell]).has(desktop), staticImportPath(shell, desktop).join(' -> ')).toBe(false)
  })
})
