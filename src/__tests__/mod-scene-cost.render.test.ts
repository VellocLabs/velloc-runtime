// @vitest-environment happy-dom
/**
 * What a mod theme's scene costs the page (F-25): one image URL per drawing,
 * a still copy while nobody watches it move, and one frost per stack of
 * panels.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '../components/assistant-ui/mod-ui-context'
import { ModBackdrop } from '../components/assistant-ui/mod-theme'
import { SVG_IMAGE_CACHE_SIZE, stillSvgOf, svgImageUrl } from '../components/assistant-ui/mod-svg-image'
import type { ModsUiTheme } from '../browser/runtimeProtocol'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const MOVING =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">' +
  '<style>.drift{animation:drift 3s infinite}</style>' +
  '<g opacity="0"><animate attributeName="opacity" values="0;1;0" dur="18s" repeatCount="indefinite"/><circle class="drift" r="4"/></g>' +
  '<g><animateTransform attributeName="transform" type="translate" from="0 0" to="4 9" dur="3s" repeatCount="indefinite"/><rect width="2" height="9"/></g>' +
  '<g><animateMotion dur="2s" path="M0 0L9 9"/><set attributeName="fill" to="#fff" begin="1s"/><path d="M0 0h4"/></g>' +
  '</svg>'

function sourceOf(url: string | null | undefined): string {
  const prefix = 'data:image/svg+xml;charset=utf-8,'
  expect(url?.startsWith(prefix)).toBe(true)
  return decodeURIComponent(url!.slice(prefix.length))
}

describe('an Svg node\'s image URL', () => {
  it('carries the source whole, and is the same URL each time it is asked for', () => {
    const url = svgImageUrl(MOVING)
    expect(sourceOf(url)).toBe(MOVING)
    expect(svgImageUrl(MOVING)).toBe(url)
  })

  it('is encoded once while the drawing is among the latest, and again after it is dropped', () => {
    const encode = vi.spyOn(globalThis, 'encodeURIComponent')
    const first = '<svg xmlns="http://www.w3.org/2000/svg"><!-- first --></svg>'
    svgImageUrl(first)
    svgImageUrl(first)
    expect(encode.mock.calls.filter(([value]) => value === first)).toHaveLength(1)
    for (let i = 0; i < SVG_IMAGE_CACHE_SIZE; i++) svgImageUrl(`<svg xmlns="http://www.w3.org/2000/svg"><!-- ${i} --></svg>`)
    svgImageUrl(first)
    expect(encode.mock.calls.filter(([value]) => value === first)).toHaveLength(2)
  })
})

describe('a still copy', () => {
  it('drops every animation element, stops style-sheet animation, and keeps each element at its base value', () => {
    const still = stillSvgOf(MOVING)
    expect(still).not.toMatch(/<animate|<set\b/)
    expect(still).toContain('animation:none!important')
    const parsed = new DOMParser().parseFromString(still, 'image/svg+xml')
    expect(parsed.querySelectorAll('circle, rect, path')).toHaveLength(3)
    expect(parsed.querySelector('g')?.getAttribute('opacity')).toBe('0')
    expect(parsed.documentElement.getAttribute('width')).toBe('100%')
  })

  it('of a drawing that does not parse is the drawing itself', () => {
    expect(stillSvgOf('<svg><g></svg')).toBe('<svg><g></svg')
    expect(stillSvgOf('<div/>')).toBe('<div/>')
  })
})

const THEME: ModsUiTheme = {
  plugin: 'tide',
  requestId: 'backdrop',
  backdrop: { scene: 'lagoon', glass: { blur: 14, opacity: 0.55 } },
}

function backdrop(isWorking: boolean) {
  const value: ModUiContextValue = {
    ...EMPTY_MOD_UI,
    theme: THEME,
    hooked: [{ plugin: 'tide', component: 'Backdrop' }],
    render: async () => ({ kind: 'tree', plugin: 'tide', tree: { type: 'Svg', props: { source: MOVING, alt: 'a tide' }, children: [] } }),
  }
  return createElement(ModUiContext.Provider, { value }, createElement(ModBackdrop, { isWorking }))
}

async function shownSource(): Promise<string> {
  await waitFor(() => expect(screen.getByTestId('mod-backdrop').querySelector('img')).not.toBeNull())
  return sourceOf(screen.getByTestId('mod-backdrop').querySelector('img')?.getAttribute('src'))
}

describe('a scene behind the conversation', () => {
  it('moves while the window has the focus and the session is idle', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    render(backdrop(false))
    expect(await shownSource()).toBe(MOVING)
    expect(screen.getByTestId('mod-backdrop').hasAttribute('data-mod-still')).toBe(false)
  })

  it('stands still while the session works, and moves again when the turn ends', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const view = render(backdrop(true))
    expect(await shownSource()).toBe(stillSvgOf(MOVING))
    expect(screen.getByTestId('mod-backdrop').hasAttribute('data-mod-still')).toBe(true)
    view.rerender(backdrop(false))
    expect(await shownSource()).toBe(MOVING)
  })

  it('stands still while another window has the focus, and moves again when this one takes it back', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    render(backdrop(false))
    expect(await shownSource()).toBe(MOVING)
    hasFocus.mockReturnValue(false)
    act(() => void window.dispatchEvent(new Event('blur')))
    expect(await shownSource()).toBe(stillSvgOf(MOVING))
    hasFocus.mockReturnValue(true)
    act(() => void window.dispatchEvent(new Event('focus')))
    expect(await shownSource()).toBe(MOVING)
  })

  it('stands still for a person who asks for less motion', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(window, 'matchMedia').mockImplementation(
      query => ({ matches: query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    )
    render(backdrop(false))
    expect(await shownSource()).toBe(stillSvgOf(MOVING))
  })
})

/** The selectors of each `globals.css` rule under `[data-mod-glass]` that sets
 *  `backdrop-filter` to `value`. */
function glassSelectors(value: 'blur' | 'none'): string[] {
  const css = readFileSync(join(__dirname, '..', 'styles', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  for (const rule of css.matchAll(/(\[data-mod-glass\][^{}]*)\{([^{}]*)\}/g)) {
    const declared = /backdrop-filter:\s*([^;]+);/.exec(rule[2]!)?.[1]?.trim()
    if (declared && (value === 'none' ? declared === 'none' : declared.startsWith('blur('))) out.push(rule[1]!.replace(/\s+/g, ' ').trim())
  }
  return out
}

describe('a scene\'s glass', () => {
  const matchesAny = (id: string, selectors: string[]) => selectors.some(selector => document.getElementById(id)!.matches(selector))

  it('frosts a panel once: a panel inside a frosted panel frosts nothing again', () => {
    document.body.innerHTML =
      '<main data-mod-glass="">' +
      '<aside id="sidebar" class="bg-sidebar"><div id="row" class="bg-card"><span id="chip" class="bg-background"></span></div></aside>' +
      '<div id="area" data-testid="nexus-session-area" class="bg-background">' +
      '<div id="thread" class="aui-thread-root bg-background">' +
      '<div id="card" class="bg-card"><div id="inner" class="bg-base-surface"></div></div>' +
      '</div></div></main>'
    const frosts = glassSelectors('blur')
    const clears = glassSelectors('none')
    expect(frosts).toHaveLength(1)
    expect(clears).toHaveLength(1)
    for (const id of ['sidebar', 'row', 'chip', 'card', 'inner']) expect(matchesAny(id, frosts)).toBe(true)
    // The outermost panel of each stack keeps its frost.
    expect(matchesAny('sidebar', clears)).toBe(false)
    expect(matchesAny('row', clears)).toBe(true)
    expect(matchesAny('chip', clears)).toBe(true)
    // The session area and the thread root frost nothing, so a card in them is outermost.
    expect(matchesAny('card', clears)).toBe(false)
    expect(matchesAny('inner', clears)).toBe(true)
  })
})
