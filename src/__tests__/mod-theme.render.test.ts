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
import { ModAppLook, ModBackdrop, ModShellPaintsThemeContext, useModThemeLook, useThemeLookOf } from '../components/assistant-ui/mod-theme'
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
      'role-danger-fill': '#a33a2e',
      'role-success-600': '#375c28',
      'role-success-700': '#26421b',
      'role-warning-600': '#7a4a10',
      'role-warning-700': '#5a360a',
      'role-accent-700': '#1f3f60',
      'role-danger-600': '#8f3328',
      'role-pro-600': '#5c417f',
      'text-git-added': '#1e6e30',
      'text-git-removed': '#8a2820',
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
      'role-accent-100': '#cfe0f0',
      'role-accent-fill': '#93b7d9',
      'role-danger-fill': '#f0a49b',
      'role-danger-250': '#f0a49b',
      'role-success-250': '#a8d69a',
      'role-success-100': '#dcefd4',
      'role-warning-250': '#e8c48a',
      'role-warning-100': '#f6e6c8',
      'role-pro-250': '#c9b3e6',
      'text-git-added': '#8fd49f',
      'text-git-removed': '#f0a49b',
    },
  },
}

/** The app's own tokens a palette's untouched side is judged against. */
const OWN_LIGHT: Record<string, string> = {
  '--background': 'oklch(1 0 0)',
  '--card': 'oklch(1 0 0)',
  '--popover': 'oklch(1 0 0)',
  '--muted': 'oklch(0.967 0.001 286.375)',
  '--secondary': 'oklch(0.967 0.001 286.375)',
  '--accent': 'oklch(0.967 0.001 286.375)',
  '--foreground': 'oklch(0.141 0.005 285.823)',
  '--primary': 'oklch(0.21 0.006 285.885)',
  '--primary-foreground': 'oklch(0.985 0 0)',
}
const OWN_DARK: Record<string, string> = {
  '--background': 'oklch(0.239 0 0)',
  '--card': 'oklch(0.277 0 0)',
  '--popover': 'oklch(0.277 0 0)',
  '--muted': 'oklch(0.309 0 0)',
  '--secondary': 'oklch(0.309 0 0)',
  '--accent': 'oklch(0.309 0 0)',
  '--foreground': 'oklch(0.916 0 0)',
  '--primary': 'oklch(0.916 0 0)',
  '--primary-foreground': 'oklch(0.239 0 0)',
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
    const light = paletteTokensOf(PAPER, 'light', OWN_LIGHT)
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
    expect(tokens['--diff-added']).toBe('#1e6e30')
    // Left out of the palette: the app keeps its own.
    expect(tokens['--chart-4']).toBeUndefined()
    expect(Object.values(tokens)).not.toContain('red')
    const dark = paletteTokensOf(PAPER, 'dark', OWN_DARK)
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
    expect(contrastRatio('oklch(1 0 0)', 'oklch(0 0 0)')).toBeCloseTo(21)
    expect(contrastRatio('red', '#ffffff')).toBeUndefined()
    // The host theme writes the root's tokens as rgb().
    expect(contrastRatio('rgb(0, 0, 0)', 'rgb(255, 255, 255)')).toBeCloseTo(21)
    expect(contrastRatio('rgb(0 0 0 / 1)', '#ffffff')).toBeCloseTo(21)
    expect(contrastRatio('rgba(0, 0, 0, 0.5)', '#ffffff')).toBeUndefined()
  })

  it('every text token is judged on every surface, against the app\'s own where the palette leaves one out; what cannot be judged is refused', () => {
    const own = { ...OWN_LIGHT, '--muted-foreground': '#666666', '--syntax-function': '#cf222e' }
    // Surfaces alone, near black: the app's own dark text would stand on them.
    const surfacesOnly = { v: 1, inputs: { light: { 'gray-20': '#111111', 'gray-10': '#111111' } } }
    expect(paletteTokensOf(surfacesOnly, 'light', own)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/--foreground on --/) })
    // Secondary text the color of its surface.
    const faintSecondary = { v: 1, inputs: { light: { 'gray-20': '#ffffff', 'gray-900': '#000000', 'gray-600': '#fefefe' } } }
    expect(paletteTokensOf(faintSecondary, 'light', own)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/--muted-foreground/) })
    // A role color unreadable on the app's own surfaces.
    const faintRole = { v: 1, inputs: { light: { 'role-danger-600': '#ffeeee' } } }
    expect(paletteTokensOf(faintRole, 'light', own)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/--syntax-function/) })
    // The other side unknown: fails closed.
    expect(paletteTokensOf({ v: 1, inputs: { light: { 'gray-900': '#000000' } } }, 'light', {}).kind).toBe('refused')
    expect(paletteTokensOf({ v: 1, inputs: { light: { 'gray-900': '#000000' } } }, 'light', own).kind).toBe('painted')
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

  it('a ground the runtime would refuse draws nothing on the page', () => {
    const many = Array.from({ length: 65 }, () => 'M0 0h1')
    expect(groundVectorOf({ vector: { viewBox: 8, paths: many, color: '#000000' } })).toBeUndefined()
    expect(groundStyleOf({ gradient: { stops: [{ at: 0.6, color: '#000' }, { at: 0.2, color: '#fff' }] } })).toBeUndefined()
    expect(groundStyleOf({ gradient: { stops: Array.from({ length: 17 }, () => '#000') } })).toBeUndefined()
    expect(groundStyleOf({ color: '#000', extra: 1 })).toBeUndefined()
  })

  it('the carrier of a theme names the kind of backdrop it stands before, and a shell that paints it leaves the thread none', () => {
    function Carrier({ theme }: { theme: ModsUiTheme | undefined }) {
      const look = useThemeLookOf(theme)
      return createElement('div', { 'data-testid': 'carrier', ...look.attributes, style: look.style })
    }
    const ground: ModsUiTheme = { plugin: 'look', requestId: 'theme', backdrop: { color: '#102030' } }
    const scene: ModsUiTheme = { plugin: 'look', requestId: 'theme', backdrop: { scene: 'tide', glass: { blur: 8, opacity: 0.6 } } }
    const { rerender } = render(createElement(Carrier, { theme: ground }))
    expect(screen.getByTestId('carrier').getAttribute('data-mod-backdrop')).toBe('ground')
    rerender(createElement(Carrier, { theme: scene }))
    expect(screen.getByTestId('carrier').getAttribute('data-mod-backdrop')).toBe('scene')
    rerender(createElement(Carrier, { theme: { plugin: 'look', requestId: 'theme', colors: PAPER } }))
    expect(screen.getByTestId('carrier').getAttribute('data-mod-backdrop')).toBeNull()
    cleanup()
    render(withUi({ theme: ground }, createElement(ModShellPaintsThemeContext.Provider, { value: true }, createElement(ModBackdrop))))
    expect(screen.queryByTestId('mod-backdrop')).toBeNull()
    cleanup()
    // The shell's own backdrop stands outside what it tells the threads.
    render(
      withUi(
        { theme: ground },
        createElement(
          ModShellPaintsThemeContext.Provider,
          { value: true },
          createElement(ModShellPaintsThemeContext.Provider, { value: false }, createElement(ModBackdrop)),
        ),
      ),
    )
    expect(screen.getByTestId('mod-backdrop')).toBeTruthy()
  })

  it('draws a still ground behind the conversation with presses passing through; an image ground keeps the app\'s own', () => {
    render(withUi({ theme: { plugin: 'look', requestId: 'theme', backdrop: { color: '#102030' } } }, createElement(ModBackdrop)))
    const layer = screen.getByTestId('mod-backdrop')
    expect(layer.getAttribute('data-mod-backdrop-kind')).toBe('color')
    expect(layer.classList).toContain('pointer-events-none')
    expect(layer.hasAttribute('inert')).toBe(true)
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
    expect(screen.getByTestId('mod-backdrop').hasAttribute('inert')).toBe(true)
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
    // A pressed or hovered control's fill keeps its own color, never the tint, and lets the glass show through.
    const highlights = glassTokensOf({ ...glass, tint: '#000000' }, { '--accent': '#faf5e9' }, { '--accent': '#eeeeee', '--sidebar-accent': '#dddddd', '--muted': '#cccccc' })
    expect(highlights['--muted']).toBe('color-mix(in srgb, #cccccc 15%, transparent)')
    expect(highlights['--secondary']).toBeUndefined()
    expect(highlights['--accent']).toBe('color-mix(in srgb, #faf5e9 15%, transparent)')
    expect(highlights['--sidebar-accent']).toBe('color-mix(in srgb, #dddddd 15%, transparent)')
  })
})

describe('the app\'s own look', () => {
  it("copies the page root's tokens around what it wraps while a theme stands, on the app's own opaque ground", () => {
    document.documentElement.style.setProperty('--background', '#ffffff')
    const child = createElement('span', { 'data-testid': 'prompt' })
    render(withUi({ theme: { plugin: 'look', requestId: 'theme', colors: PAPER } }, createElement(ModAppLook, null, child)))
    const wrap = document.querySelector('[data-slot="mod-app-look"]') as HTMLElement
    expect(wrap.style.getPropertyValue('--background')).toBe('#ffffff')
    expect(wrap.style.backgroundColor).toBeTruthy()
    expect(wrap.classList).not.toContain('contents')
    // No ask showing: the wrap takes no room in the footer.
    expect(wrap.classList).toContain('empty:hidden')
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
