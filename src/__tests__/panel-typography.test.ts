import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ROW_LINE_HEIGHT, rowsMaxHeight } from '../components/assistant-ui/file-content-view'

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/**
 * Surfaces that follow the Text size step (F-18) carry the type-scale utilities (`text-body`, `text-caption`,
 * `text-code`, `text-composer`), not Tailwind's fixed `text-xs` / `text-sm`. These guards read the source: a render
 * test cannot see a size.
 */
describe('panel and code surfaces carry the type-scale utilities', () => {
  const stepped = [
    'browser/webview/topbar/SessionTabStrip.tsx',
    'browser/webview/panes/PaneFrame.tsx',
    'browser/webview/panes/PaneArea.tsx',
    'browser/webview/panes/FilesPane.tsx',
    'browser/webview/panes/FilesBrowse.tsx',
    'browser/webview/panes/FileTreeView.tsx',
    'browser/webview/FilePanel.tsx',
    'browser/webview/DiffPanel.tsx',
    'browser/webview/PlanDetailsPanel.tsx',
    'browser/webview/SkillPanel.tsx',
    'browser/webview/SessionRows.tsx',
    'browser/webview/ProjectSection.tsx',
    'components/assistant-ui/tool-call-detail-body.tsx',
    'components/assistant-ui/file-content-view.tsx',
    'components/assistant-ui/edit-tool-diff.tsx',
    'components/assistant-ui/file-entry-row.tsx',
    'components/assistant-ui/tool-detail-tree.tsx',
    'components/assistant-ui/tool-fallback.tsx',
    'components/assistant-ui/read-tool-view.tsx',
    'components/assistant-ui/background-results-card.tsx',
    'components/assistant-ui/plan-card.tsx',
  ]

  it('uses no fixed text-xs / text-sm / arbitrary rem size', () => {
    const offenders: string[] = []
    for (const rel of stepped) {
      const text = read(rel)
      for (const m of text.matchAll(/\btext-(xs|sm|\[0\.\d+rem\]|\[1[01]px\])\b/g)) {
        // Skip the words inside comments that merely describe the old look.
        const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index))
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
        offenders.push(`${rel}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every sidebar row shares one height constant', () => {
    // A session row, a project row and "show more" read as one list only if
    // they are one height; a literal per site drifts one edit at a time.
    const count = (rel: string) => read(rel).split('h-[26px]').length - 1
    expect(count('browser/webview/SessionRows.tsx')).toBe(1) // the constant
    expect(count('browser/webview/ProjectSection.tsx')).toBe(0)
    expect(read('browser/webview/SessionRows.tsx')).toContain("export const SIDEBAR_ROW_HEIGHT = 'h-[26px]'")
    expect(read('browser/webview/SessionRows.tsx').match(/SIDEBAR_ROW_HEIGHT,/g)).toHaveLength(2)
    expect(read('browser/webview/ProjectSection.tsx')).toContain('SIDEBAR_ROW_HEIGHT,')
  })

  it('the topbar session tab and the composer hint are on the interface size', () => {
    expect(read('browser/webview/topbar/SessionTabStrip.tsx')).toMatch(/rounded px-2 text-body"/)
    expect(read('components/assistant-ui/thread.tsx')).toMatch(/aui-composer-input-hint [^"]*text-body"/)
    expect(read('components/assistant-ui/thread.tsx')).toMatch(/aui-edit-composer-input [^"]*text-composer /)
  })

  it('code rows are one code line tall at every step', () => {
    // `leading-6` (24px) used to fix the row height while the code size
    // stepped, so the inline cap of N rows stopped landing on a row boundary.
    expect(ROW_LINE_HEIGHT).toBe('var(--nx-code-leading)')
    // The cap is a border-box height: it budgets the views' `py-1` + 1px
    // border too, or N unwrapped rows overflow by 10px and scroll.
    expect(rowsMaxHeight(20)).toBe('calc(20 * var(--nx-code-leading) + 0.5rem + 2px)')
    expect(read('components/assistant-ui/edit-tool-diff.tsx')).toMatch(
      /aui-edit-diff-body overflow-auto rounded-md border [^"]*py-1 /,
    )
    expect(read('components/assistant-ui/file-content-view.tsx')).toMatch(
      /aui-file-content overflow-auto rounded-md border /,
    )
    expect(read('components/assistant-ui/file-content-view.tsx')).toContain('"min-w-fit py-1"')
    expect(read('components/assistant-ui/file-content-view.tsx')).toContain('leading-(--nx-code-leading)')
    expect(read('components/assistant-ui/file-content-view.tsx')).not.toContain('leading-6')
    expect(read('components/assistant-ui/edit-tool-diff.tsx')).not.toContain('leading-relaxed')
  })

  it('the CodeMirror viewer sizes from the code tokens', () => {
    const cm = read('components/assistant-ui/CodeMirrorView.tsx')
    expect(cm).toContain('fontSize: "var(--nx-code-size)"')
    expect(cm).toContain('lineHeight: "var(--nx-code-leading)"')
    expect(cm).not.toContain('fontSize: "0.75rem"')
    expect(cm).not.toContain('lineHeight: "1.5rem"')
  })
})
