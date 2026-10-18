import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  read,
  rel,
  SRC,
  sourceBytes,
  staticClosure,
  stripComments,
} from './_helpers/staticImportGraph'

/**
 * Boot-chunk budget for the cold UI split (`browser/webview/coldUi.ts`): the settings page, the pane bodies and
 * the session-import dialog stay behind `import()`, off the shell's boot chunk. The reachability assertions walk
 * the shell's real static import graph; the budget is a floor on what the split keeps out, not a ceiling.
 */

const SHELL = join(SRC, 'browser', 'webview', 'MultiSessionShell.tsx')
const COLD_UI = join(SRC, 'browser', 'webview', 'coldUi.ts')

/**
 * The panels `coldUi.ts` owns, as `[component, specifier, path]` — the
 * exported name, the specifier `coldUi.ts` must load it with, and the resolved
 * file the reachability walk looks for.
 */
const COLD_PANELS = [
  [
    'SettingsScreen',
    './settings/SettingsScreen',
    join(SRC, 'browser', 'webview', 'settings', 'SettingsScreen.tsx'),
  ],
  [
    'SidePaneBody',
    './panes/sidePanes',
    join(SRC, 'browser', 'webview', 'panes', 'sidePanes.tsx'),
  ],
  [
    'FilesPane',
    './panes/FilesPane',
    join(SRC, 'browser', 'webview', 'panes', 'FilesPane.tsx'),
  ],
  [
    'ImportDialog',
    './sessionImport/ImportDialog',
    join(SRC, 'browser', 'webview', 'sessionImport', 'ImportDialog.tsx'),
  ],
]

/**
 * Floor on the source bytes reachable from the cold panels but not from the shell's static graph, set under the
 * measured size so refactoring inside the panels cannot trip it.
 */
const MIN_DEFERRED_BYTES = 450 * 1024

describe('cold UI stays out of the boot chunk', () => {
  const shellClosure = staticClosure([SHELL])

  it('routes the shell to the panels through coldUi', () => {
    // The split only holds while the shell goes through the split-point
    // module. If this fails the panels arrive some other way, and the
    // assertions below are testing nothing.
    expect(shellClosure.has(COLD_UI)).toBe(true)
    expect(read(SHELL)).toMatch(/from '\.\/coldUi'/)
  })

  it.each(COLD_PANELS)(
    'keeps %s off the shell static graph',
    (component, _specifier, modulePath) => {
      expect(
        shellClosure.has(modulePath),
        `${rel(modulePath)} is reachable from MultiSessionShell through STATIC `
        + 'imports, so the bundler folds it back into the boot-critical chunk. '
        + `Reach ${component} through coldUi.ts's import() instead — and if a `
        + 'value is needed at module scope, move that value to a leaf module '
        + 'rather than importing the panel for it.',
      ).toBe(false)
    },
  )

  it('defers at least the measured bulk of the three panels', () => {
    const deferred = new Set<string>()
    for (const [, , modulePath] of COLD_PANELS) {
      for (const file of staticClosure([modulePath])) {
        if (!shellClosure.has(file)) deferred.add(file)
      }
    }
    const bytes = sourceBytes(deferred)
    expect(
      bytes,
      `only ${(bytes / 1024).toFixed(0)} KB of panel source is deferred, below `
      + `the ${(MIN_DEFERRED_BYTES / 1024).toFixed(0)} KB floor. Something a `
      + 'cold panel owns is now reachable from the shell statically too, so it '
      + 'ships on the boot path whether or not the panel is ever opened.',
    ).toBeGreaterThanOrEqual(MIN_DEFERRED_BYTES)
  })
})

describe('coldUi.ts split points', () => {
  const source = stripComments(read(COLD_UI))
  const coldUiClosure = staticClosure([COLD_UI])

  it.each(COLD_PANELS)(
    'reaches %s only through import()',
    (component, specifier, modulePath) => {
      expect(
        coldUiClosure.has(modulePath),
        `coldUi.ts must load ${component} with import(), not a static import — `
        + 'a static one puts it straight back into whichever chunk imports '
        + 'coldUi, which is the boot chunk.',
      ).toBe(false)
      expect(source).toContain(`import('${specifier}')`)
    },
  )

  it('names each specifier once, so the warm-up and the lazy load share a chunk', () => {
    // `prefetchColdUi` and the `lazy()` wrappers go through the same `load*`
    // arrows on purpose: the module map keys `import()` by specifier, so two
    // spellings of one path are two chunks — and the warm-up then warms
    // neither of the ones the user actually waits on.
    for (const [, specifier] of COLD_PANELS) {
      const occurrences = source.split(`import('${specifier}')`).length - 1
      expect(
        occurrences,
        `${specifier} must appear in exactly one import() call in coldUi.ts.`,
      ).toBe(1)
    }
  })

  it('warms the chunks from the shell', () => {
    // Without the warm-up this split IS the regression Sidebar.tsx reverted:
    // the first fetch happens when the user clicks, and Suspense shows a stall.
    expect(source).toMatch(/export function prefetchColdUi\b/)
    expect(
      read(SHELL),
      'MultiSessionShell must call prefetchColdUi() from a mount effect.',
    ).toMatch(/useEffect\(\(\) => prefetchColdUi\(\), \[\]\)/)
  })
})
