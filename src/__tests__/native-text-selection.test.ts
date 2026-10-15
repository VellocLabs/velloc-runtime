// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The shell is chrome, not a document: `globals.css` denies selection at `html` and opts the content surfaces back
 * in. The real `user-select` rules are fed to a DOM and checked with `getComputedStyle` on elements they match
 * directly (happy-dom does not resolve inheritance; the e2e suite covers that).
 */

/** Every rule in `css` whose declarations mention `user-select`, flattened out
 *  of their `@layer` and returned in source order. The scanner matches
 *  innermost `selector { decls }` blocks — none of the rules of interest nest —
 *  so at-rule wrappers fall away on their own. */
function extractUserSelectRules(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rules: string[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(withoutComments)) !== null) {
    const selector = match[1].trim()
    const declarations = match[2]
    if (!/(^|[^-])user-select\s*:/.test(declarations)) continue
    // A leading at-rule fragment (`@layer base {` opens before the first
    // nested rule) would come through as part of the selector.
    if (selector.startsWith('@')) continue
    rules.push(`${selector} { ${declarations.trim()} }`)
  }
  return rules
}

const GLOBALS_CSS = readFileSync(
  join(__dirname, '..', 'styles', 'globals.css'),
  'utf8',
)

/** Build `markup`, apply the extracted rules, and report the computed
 *  `user-select` of the element carrying `id="probe"`. */
function computedUserSelect(markup: string): string {
  document.head.innerHTML = ''
  document.body.innerHTML = markup
  const style = document.createElement('style')
  style.textContent = extractUserSelectRules(GLOBALS_CSS).join('\n')
  document.head.appendChild(style)
  const probe = document.getElementById('probe')
  if (!probe) throw new Error('markup must contain an element with id="probe"')
  return getComputedStyle(probe).userSelect
}

describe('native-app text selection', () => {
  beforeAll(() => {
    // Guard the extractor itself: an empty list would make every "is text"
    // assertion below pass for the wrong reason.
    expect(
      extractUserSelectRules(GLOBALS_CSS).length,
      'globals.css must carry the native-selection rules (deny at html, opt ' +
        'content surfaces back in). See the block above `html { user-select: ' +
        'none }` for why.',
    ).toBeGreaterThanOrEqual(3)
  })

  it('denies selection at the document root', () => {
    const style = document.createElement('style')
    style.textContent = extractUserSelectRules(GLOBALS_CSS).join('\n')
    document.head.innerHTML = ''
    document.head.appendChild(style)
    expect(
      getComputedStyle(document.documentElement).userSelect,
      'html must declare `user-select: none` — every shell widget inherits ' +
        'its non-selectability from there.',
    ).toBe('none')
  })

  // One case per opt-in selector. Each is a surface whose text the user reads
  // and copies, so each has to keep working; the markup mirrors the real
  // component that carries the hook.
  it.each([
    ['composer textarea', '<textarea id="probe"></textarea>'],
    ['text input', '<input id="probe" />'],
    ['editable host', '<div id="probe" contenteditable="true"></div>'],
    [
      'transcript viewport (thread.tsx)',
      '<div id="probe" class="aui-thread-viewport"></div>',
    ],
    ['markdown body', '<div id="probe" class="aui-md"></div>'],
    ['fenced code block', '<pre id="probe"></pre>'],
    ['inline code', '<code id="probe"></code>'],
    ['CodeMirror view', '<div id="probe" class="cm-editor"></div>'],
    [
      'file view (file-content-view.tsx)',
      '<div id="probe" class="aui-file-content"></div>',
    ],
    [
      'diff body (edit-tool-diff.tsx)',
      '<div id="probe" class="aui-edit-diff-body"></div>',
    ],
    ['explicit opt-in hook', '<div id="probe" data-nexus-selectable></div>'],
  ])('keeps %s selectable', (_name, markup) => {
    expect(computedUserSelect(markup)).toBe('text')
  })

  it('keeps the composer footer unselectable inside the opted-in viewport', () => {
    // Specificity is equal (one class each), so this only holds while the
    // footer rule stays AFTER the opt-in rule in globals.css. That ordering is
    // what this case pins.
    expect(
      computedUserSelect(
        '<div id="probe" class="aui-thread-viewport-footer"></div>',
      ),
      'the composer footer is chrome — its buttons and chips must not be ' +
        'selectable even though it lives inside `.aui-thread-viewport`.',
    ).toBe('none')
  })

  it('honours the explicit opt-out hook', () => {
    expect(
      computedUserSelect('<div id="probe" data-nexus-selectable="false"></div>'),
    ).toBe('none')
  })

  it('does not opt in a disabled contenteditable host', () => {
    // `[contenteditable]` matches `false` too; the `:not()` is what stops a
    // read-only rich-text host from becoming selectable.
    expect(
      computedUserSelect('<div id="probe" contenteditable="false"></div>'),
    ).not.toBe('text')
  })
})
