// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  DARK_CLASS,
  DARK_SCHEME_QUERY,
  applyHostColorScheme,
  installHostColorSchemeSync,
} from '../browser/boot/hostColorScheme'

/**
 * The guest's `.dark` token set is selected by ONE bit — the `dark` class on
 * `<html>` — and `installHostColorSchemeSync` is the only writer of that bit.
 * These pin its contract: it mirrors `(prefers-color-scheme: dark)` at
 * install time, follows every change event, stops after dispose, and is inert
 * (root untouched, no throw) in a realm without `matchMedia`.
 */

type Listener = () => void

function fakeMatchMedia(initialDark: boolean) {
  const listeners = new Set<Listener>()
  const queries: string[] = []
  const mql = {
    matches: initialDark,
    addEventListener(_type: 'change', l: Listener) {
      listeners.add(l)
    },
    removeEventListener(_type: 'change', l: Listener) {
      listeners.delete(l)
    },
  }
  const win = {
    matchMedia(query: string) {
      queries.push(query)
      return mql
    },
  }
  const flip = (dark: boolean): void => {
    mql.matches = dark
    for (const l of listeners) l()
  }
  return { win, queries, flip, listeners }
}

describe('installHostColorSchemeSync', () => {
  it('queries prefers-color-scheme and mirrors it onto the root at install', () => {
    const root = document.createElement('html')
    const { win, queries } = fakeMatchMedia(true)

    installHostColorSchemeSync(win, root)

    expect(queries).toEqual([DARK_SCHEME_QUERY])
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
  })

  it('leaves a light host light — no class added', () => {
    const root = document.createElement('html')
    const { win } = fakeMatchMedia(false)

    installHostColorSchemeSync(win, root)

    expect(root.classList.contains(DARK_CLASS)).toBe(false)
  })

  it('follows change events both ways until disposed', () => {
    const root = document.createElement('html')
    const { win, flip, listeners } = fakeMatchMedia(false)

    const dispose = installHostColorSchemeSync(win, root)
    flip(true)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
    flip(false)
    expect(root.classList.contains(DARK_CLASS)).toBe(false)

    dispose()
    expect(listeners.size).toBe(0)
    flip(true)
    expect(root.classList.contains(DARK_CLASS)).toBe(false)
  })

  it('preserves unrelated classes on the root', () => {
    const root = document.createElement('html')
    root.className = 'keep-me'
    const { win, flip } = fakeMatchMedia(true)

    installHostColorSchemeSync(win, root)
    expect(root.className.split(/\s+/).sort()).toEqual([DARK_CLASS, 'keep-me'])
    flip(false)
    expect(root.className).toBe('keep-me')
  })

  it('is inert when the window has no matchMedia', () => {
    const root = document.createElement('html')

    const dispose = installHostColorSchemeSync({}, root)

    expect(root.classList.contains(DARK_CLASS)).toBe(false)
    expect(() => dispose()).not.toThrow()
  })
})

describe('applyHostColorScheme', () => {
  it('stands down once the host theme receiver has stamped the root', () => {
    const root = document.createElement('html')
    root.classList.add(DARK_CLASS)
    root.setAttribute('data-host-theme', 'dark')
    applyHostColorScheme(root, false)
    expect(root.classList.contains(DARK_CLASS)).toBe(true)
    root.removeAttribute('data-host-theme')
    applyHostColorScheme(root, false)
    expect(root.classList.contains(DARK_CLASS)).toBe(false)
  })

  it('is idempotent in both directions', () => {
    const root = document.createElement('html')
    applyHostColorScheme(root, true)
    applyHostColorScheme(root, true)
    expect(root.className).toBe(DARK_CLASS)
    applyHostColorScheme(root, false)
    applyHostColorScheme(root, false)
    expect(root.className).toBe('')
  })
})
