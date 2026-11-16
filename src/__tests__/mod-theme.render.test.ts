// @vitest-environment happy-dom
/**
 * The session's mod theme on the page (F-25 `$.theme.set`): the palette onto
 * Velloc's tokens in the page's mode, refused whole under too little contrast;
 * still grounds as CSS; a scene drawn by the `Backdrop` site under glass; the
 * app's own look around permission prompts; a cleared theme leaves the page.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '../components/assistant-ui/mod-ui-context'
import { ModAppLook, ModBackdrop, useModThemeLook } from '../components/assistant-ui/mod-theme'
import {
  contrastRatio,
  glassTokensOf,
  groundStyleOf,
  groundVectorOf,
  paletteTokensOf,
  sceneGlassOf,
} from '../components/assistant-ui/mod-theme-paint'
import { holdModsUiView, type ModsUiView } from '../browser/webview/mods/modsUiView'
import type { ModsUiTheme } from '../browser/runtimeProtocol'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'

afterEach(() => {
  cleanup()
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
})

/** A palette shaped as the declared design system writes one: gray stops and
 *  role stops for each mode. */
const PAPER = {
  v: 1,
  label: 'Paper',
  inputs: {
    light: {
      'gray-0': '#faf5e9',
      'gray-10': '#f4ecdc',
      'gray-20': '#efe6d3',
      'gray-400': '#6a5f50',
      'gray-600': '#544a3d',
      'gray-900': '#2a241d',
      'role-accent-600': '#2b537d',
      'role-accent-fill': '#457db5',
      'role-danger-fill': '#cc4236',
      'role-success-600': '#375c28',
      'role-pro-600': '#5c417f',
      'text-git-added': '#1e9e3c',
      'not-a-color': 'red',
    },
    dark: {
      'gray-50': '#f0e7d7',
      'gray-200': '#cfc4b2',
      'gray-400': '#aca08d',
      'gray-800': '#3a3229',
      'gray-830': '#312a22',
      'gray-850': '#28221b',
      'gray-900': '#1f1a15',
      'role-accent-250': '#93b7d9',
    },
  },
}

function withUi(value: Partial<ModUiContextValue>, child: React.ReactElement) {
  return createElement(ModUiContext.Provider, { value: { ...EMPTY_MOD_UI, ...value } }, child)
}

function ThemedRoot() {
  const look = useModThemeLook()
  return createElement('div', { 'data-testid': 'root', ...look.attributes, style: look.style })
}

describe('the palette', () => {
  it("paints Velloc's tokens from the mode's gray and role stops; an entry that is not six-digit hex is ignored", () => {
    const light = paletteTokensOf(PAPER, 'light')
    expect(light.kind).toBe('painted')
    const tokens = light.kind === 'painted' ? light.tokens : {}
    expect(tokens['--background']).toBe('#efe6d3')
    expect(tokens['--card']).toBe('#f4ecdc')
    expect(tokens['--muted']).toBe('#faf5e9')
    expect(tokens['--foreground']).toBe('#2a241d')
    expect(tokens['--muted-foreground']).toBe('#544a3d')
    expect(tokens['--border']).toBe('color-mix(in srgb, #6a5f50 20%, transparent)')
    expect(tokens['--focus-ring']).toBe('#457db5')
    expect(tokens['--syntax-keyword']).toBe('#2b537d')
    expect(tokens['--syntax-string']).toBe('#375c28')
    expect(tokens['--syntax-number']).toBe('#5c417f')
    expect(tokens['--diff-added']).toBe('#1e9e3c')
    // Left out of the palette: the app keeps its own.
    expect(tokens['--warning']).toBeUndefined()
    expect(Object.values(tokens)).not.toContain('red')
    const dark = paletteTokensOf(PAPER, 'dark')
    expect(dark.kind === 'painted' && dark.tokens['--background']).toBe('#1f1a15')
    expect(dark.kind === 'painted' && dark.tokens['--popover']).toBe('#3a3229')
    expect(dark.kind === 'painted' && dark.tokens['--syntax-keyword']).toBe('#93b7d9')
  })

  it('a palette for one mode paints nothing in the other; too little text contrast refuses it whole', () => {
    expect(paletteTokensOf({ ...PAPER, inputs: { dark: PAPER.inputs.dark } }, 'light')).toEqual({ kind: 'none' })
    expect(paletteTokensOf({ v: 2, inputs: PAPER.inputs }, 'light')).toEqual({ kind: 'none' })
    const murky = paletteTokensOf({ v: 1, label: 'x', inputs: { light: { 'gray-20': '#777777', 'gray-900': '#666666' } } }, 'light')
    expect(murky.kind).toBe('refused')
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21)
  })

  it('the thread root carries the tokens in the page mode, and follows the mode as it changes', async () => {
    const theme: ModsUiTheme = { plugin: 'look', requestId: 'theme', colors: PAPER }
    render(withUi({ theme }, createElement(ThemedRoot)))
    const root = screen.getByTestId('root')
    expect(root.getAttribute('data-mod-theme')).toBe('look')
    expect(root.getAttribute('data-mod-theme-palette')).toBe('painted')
    expect(root.style.getPropertyValue('--background')).toBe('#efe6d3')
    document.documentElement.classList.add('dark')
    await waitFor(() => expect(root.style.getPropertyValue('--background')).toBe('#1f1a15'))
  })

  it('no theme: the root carries nothing', () => {
    render(withUi({}, createElement(ThemedRoot)))
    const root = screen.getByTestId('root')
    expect(root.getAttribute('data-mod-theme')).toBeNull()
    expect(root.getAttribute('style') ?? '').toBe('')
  })
})

describe('the backdrop', () => {
  it('a still ground is CSS: raw colors as given, design-system names through the painted tokens', () => {
    expect(groundStyleOf({ color: '#102030' })).toEqual({ backgroundColor: '#102030' })
    expect(groundStyleOf({ color: 'surface-0' })).toEqual({ backgroundColor: 'var(--background)' })
    expect(groundStyleOf({ color: 'bg-danger' })).toEqual({ backgroundColor: 'color-mix(in srgb, var(--destructive) 15%, transparent)' })
    expect(groundStyleOf({ color: 'url(x)' })).toBeUndefined()
    expect(groundStyleOf({ gradient: { stops: ['surface-0', { at: 1, color: '#000000' }], angle: 90 } })).toEqual({
      backgroundImage: 'linear-gradient(90deg, var(--background) 0%, #000000 100%)',
      backgroundSize: '100% 100%',
      backgroundRepeat: 'no-repeat',
    })
    expect(groundStyleOf({ gradient: { stops: ['#fff', '#000'], shape: 'radial', size: [24, 8], repeat: true } })).toEqual({
      backgroundImage: 'radial-gradient(ellipse farthest-corner, #fff 0%, #000 100%)',
      backgroundSize: '24px 8px',
      backgroundRepeat: 'repeat',
    })
    expect(groundVectorOf({ vector: { viewBox: [24, 8], paths: ['M0 0h4', { d: 'M1 1h2', strokeWidth: 2, color: '#ff0000' }], color: 'text-muted' } })).toEqual({
      width: 24,
      height: 8,
      repeat: false,
      paths: [
        { d: 'M0 0h4', color: 'var(--muted-foreground)' },
        { d: 'M1 1h2', color: '#ff0000', strokeWidth: 2 },
      ],
    })
    expect(groundVectorOf({ vector: { viewBox: 24, paths: ['M0 0h4'] } })).toBeUndefined()
    expect(groundVectorOf({ vector: { viewBox: 24, paths: ['<script>'], color: '#000' } })).toBeUndefined()
  })

  it('draws a still ground behind the conversation with presses passing through; an image ground keeps the app\'s own', () => {
    render(withUi({ theme: { plugin: 'look', requestId: 'theme', backdrop: { color: '#102030' } } }, createElement(ModBackdrop)))
    const layer = screen.getByTestId('mod-backdrop')
    expect(layer.getAttribute('data-mod-backdrop-kind')).toBe('color')
    expect(layer.classList).toContain('pointer-events-none')
    expect(layer.style.backgroundColor).toBeTruthy()
    cleanup()
    render(withUi({ theme: { plugin: 'look', requestId: 'theme', backdrop: { image: { source: 'harbour.jpg' } } } }, createElement(ModBackdrop)))
    expect(screen.queryByTestId('mod-backdrop')).toBeNull()
    cleanup()
    render(withUi({ theme: { plugin: 'look', requestId: 'theme', backdrop: { vector: { viewBox: 8, paths: ['M0 0h4'], color: '#000000' } } } }, createElement(ModBackdrop)))
    expect(screen.getByTestId('mod-backdrop').querySelector('svg path')?.getAttribute('d')).toBe('M0 0h4')
  })

  it("asks the Backdrop site for a scene with its scene, plugin, glass and mode, and draws the hook's tree", async () => {
    const asked: unknown[] = []
    const theme: ModsUiTheme = {
      plugin: 'tide',
      requestId: 'backdrop',
      backdrop: { scene: 'lagoon', glass: { blur: 14, opacity: 0.55 } },
      overrideColorScheme: 'dark',
    }
    render(
      withUi(
        {
          theme,
          hooked: [{ plugin: 'tide', component: 'Backdrop' }],
          render: async input => {
            asked.push(input)
            return { kind: 'tree', plugin: 'tide', tree: { type: 'Svg', props: { source: '<svg/>', alt: 'a tide' }, children: [] } }
          },
        },
        createElement(ModBackdrop),
      ),
    )
    await waitFor(() => expect(screen.getByTestId('mod-backdrop').getAttribute('data-mod-drawn')).toBe('tree'))
    expect(asked[0]).toMatchObject({
      component: 'Backdrop',
      requestId: 'backdrop',
      props: { scene: 'lagoon', plugin: 'tide', glass: { blur: 14, opacity: 0.55 }, overrideColorScheme: 'dark' },
    })
    expect(screen.getByTestId('mod-backdrop').querySelector('img')?.getAttribute('alt')).toBe('a tide')
  })

  it("a scene's glass frosts the surfaces at its opacity, from the tint, the palette or the app's own", () => {
    const glass = sceneGlassOf({ scene: 's', glass: { blur: 14, opacity: 0.55 } })!
    expect(glass).toEqual({ blur: 14, opacity: 0.55 })
    expect(sceneGlassOf({ scene: 's', glass: false })).toBeUndefined()
    expect(sceneGlassOf({ scene: 's', glass: { blur: 14, opacity: 0.55, tint: 'surface-0' } })).toEqual({ blur: 14, opacity: 0.55 })
    const tokens = glassTokensOf(glass, { '--background': '#efe6d3' }, { '--card': 'oklch(1 0 0)' })
    expect(tokens['--background']).toBe('color-mix(in srgb, #efe6d3 55%, transparent)')
    expect(tokens['--card']).toBe('color-mix(in srgb, oklch(1 0 0) 55%, transparent)')
    expect(glassTokensOf({ ...glass, tint: '#000000' }, {}, {})['--toolbar']).toBe('color-mix(in srgb, #000000 55%, transparent)')
  })
})

describe('the app\'s own look', () => {
  it("copies the page root's tokens around what it wraps while a theme stands", () => {
    document.documentElement.style.setProperty('--background', 'oklch(1 0 0)')
    const child = createElement('span', { 'data-testid': 'prompt' })
    render(withUi({ theme: { plugin: 'look', requestId: 'theme', colors: PAPER } }, createElement(ModAppLook, null, child)))
    const wrap = document.querySelector('[data-slot="mod-app-look"]') as HTMLElement
    expect(wrap.style.getPropertyValue('--background')).toBe('oklch(1 0 0)')
    expect(wrap.contains(screen.getByTestId('prompt'))).toBe(true)
    cleanup()
    render(withUi({}, createElement(ModAppLook, null, child)))
    expect(document.querySelector('[data-slot="mod-app-look"]')).toBeNull()
  })
})

describe('the client store', () => {
  it('takes the theme from each state and drops it when a state carries none', () => {
    const handlers = new Map<string, (event: { type?: string; payload: unknown }) => void>()
    const connection = {
      subscribe: (topic: string, handler: (event: { type?: string; payload: unknown }) => void) => {
        handlers.set(topic, handler)
        return () => handlers.delete(topic)
      },
    } as unknown as RuntimeConnection
    const views: ModsUiView[] = []
    const release = holdModsUiView(connection, 's1', view => views.push(view))
    const theme: ModsUiTheme = { plugin: 'look', requestId: 'theme', colors: PAPER }
    handlers.get('mods/ui/s1')!({ type: 'state', payload: { status: [], notices: [], theme } })
    expect(views.at(-1)?.theme).toEqual(theme)
    handlers.get('mods/ui/s1')!({ type: 'state', payload: { status: [], notices: [] } })
    expect(views.at(-1)?.theme).toBeUndefined()
    release()
  })
})
