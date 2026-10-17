// @vitest-environment happy-dom
/**
 * A mod's tree as a thread draws it (F-25): the mapper from a render
 * tree to React, the inline panes and the band above the prompt, and the
 * input they send back as `uiInput`.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  ModAbovePrompt,
  ModCommandOutputSite,
  ModDockedPane,
  ModPanes,
  ModPromptHintSite,
  ModRenderTree,
  ModToolResultSite,
  ModToolUseSite,
  MOD_TOOL_RESULT_MAX_CHARS,
  isRaisableToolResult,
  ModUserMessageSite,
  modToolUseProps,
} from '../components/assistant-ui/mod-render'
import { FOOTER_BAR_FRAME } from '../components/assistant-ui/footer-bar-frame'
import { TooltipProvider } from '../components/ui/tooltip'
import {
  EMPTY_MOD_UI,
  ModUiContext,
  modToolUseValue,
  useModToolUseRewrite,
  type ModUiContextValue,
} from '../components/assistant-ui/mod-ui-context'

afterEach(() => cleanup())

function withUi(value: Partial<ModUiContextValue>, child: React.ReactElement) {
  return createElement(ModUiContext.Provider, { value: { ...EMPTY_MOD_UI, ...value } }, child)
}

const site = { component: 'Pane' as const, requestId: 'clock', plugin: 'p' }
const press = { plugin: 'p', handle: 4 }

describe('ModRenderTree', () => {
  it('draws Boxes as flex rows or columns in cells, Texts with their styles, strings as text', () => {
    const tree = {
      type: 'Box',
      props: { flexDirection: 'column', paddingX: 2, width: 40, borderStyle: 'round', backgroundColor: 'gray' },
      children: [
        { type: 'Text', props: { bold: true, dimColor: true, color: 'red' }, children: ['hello ', { type: 'Text', props: { underline: true }, children: ['there'] }] },
        'bare',
      ],
    }
    const { container } = render(withUi({}, createElement(ModRenderTree, { tree, site })))
    const box = container.querySelector('div > div > div') as HTMLElement
    expect(box.style.display).toBe('flex')
    expect(box.style.flexDirection).toBe('column')
    expect(box.style.paddingLeft).toBe('2ch')
    expect(box.style.width).toBe('40ch')
    expect(box.style.border).toContain('1px solid')
    expect(container.textContent).toBe('hello therebare')
    const text = container.querySelector('span') as HTMLElement
    expect(text.style.fontWeight).toBe('600')
    expect(text.style.opacity).toBe('0.6')
  })

  it("colors a Text by its theme key on Velloc's tokens; an unknown key or an inherited name draws uncolored", () => {
    const text = (color: string) => ({ type: 'Text', props: { color }, children: [color] })
    const tree = {
      type: 'Box',
      props: {},
      children: [text('success'), text('inactive'), text('diffAddedWord'), text('diffRemovedWord'), text('red'), text('noSuchKey'), text('constructor')],
    }
    const { container } = render(withUi({}, createElement(ModRenderTree, { tree, site })))
    const colorOf = (label: string) =>
      ([...container.querySelectorAll('span')] as HTMLElement[]).find(el => el.textContent === label)?.style.color
    expect(colorOf('success')).toBe('var(--success)')
    expect(colorOf('inactive')).toBe('var(--muted-foreground)')
    expect(colorOf('diffAddedWord')).toBe('var(--success-emphasis)')
    expect(colorOf('diffRemovedWord')).toBe('var(--destructive)')
    expect(colorOf('red')).toBe('var(--destructive)')
    expect(colorOf('noSuchKey')).toBe('')
    expect(colorOf('constructor')).toBe('')
  })

  it('clips the tree to its own box: an absolute Box at a negative offset stays inside it', () => {
    const tree = { type: 'Box', props: { position: 'absolute', top: -20, left: -40, width: 400 }, children: ['cover'] }
    const { container } = render(withUi({}, createElement(ModRenderTree, { tree, site })))
    const root = container.querySelector('div > div') as HTMLElement
    expect(root.className).toContain('relative')
    expect(root.className).toContain('overflow-hidden')
  })

  it('a Button press sends ui.press with the drawing\'s handle; a plain primary one still presses', () => {
    const uiInput = vi.fn(async () => ({ ok: true }))
    const tree = {
      type: 'Box',
      children: [
        { type: 'Button', props: { key: 'bump', label: 'Bump', variant: 'primary' }, press },
        { type: 'Button', props: { key: 'h', label: 'Hide', plain: true, hotkey: 'h' }, press: { plugin: 'p', handle: 5 } },
      ],
    }
    render(withUi({ uiInput }, createElement(ModRenderTree, { tree, site })))
    fireEvent.click(screen.getByTestId('mod-button-bump'))
    expect(uiInput).toHaveBeenCalledWith({ kind: 'press', element: 'bump', plugin: 'p', component: 'Pane', requestId: 'clock', handle: 4 })
    expect(screen.getByTestId('mod-button-h').textContent).toBe('h:Hide')
    fireEvent.click(screen.getByTestId('mod-button-h'))
    expect(uiInput).toHaveBeenLastCalledWith(expect.objectContaining({ element: 'h', handle: 5 }))
  })

  it('a Button holding Texts draws them in its place, named by its label, and presses wherever it is clicked', () => {
    const uiInput = vi.fn(async () => ({ ok: true }))
    const tree = {
      type: 'Button',
      props: { key: 'open', label: 'Open notes' },
      press,
      children: ['notes ', { type: 'Text', props: { dimColor: true }, children: ['2m'] }],
    }
    render(withUi({ uiInput }, createElement(ModRenderTree, { tree, site })))
    const button = screen.getByTestId('mod-button-open')
    expect(button.textContent).toBe('notes 2m')
    expect(button.getAttribute('aria-label')).toBe('Open notes')
    fireEvent.click(button.querySelector('span[style*="opacity"]')!)
    expect(uiInput).toHaveBeenCalledWith(expect.objectContaining({ kind: 'press', element: 'open', handle: 4 }))
  })

  it('draws a Text at its size step and weight, bold as semibold under an explicit weight, mono and tabular', () => {
    const tree = {
      type: 'Box',
      children: [
        { type: 'Text', props: { size: 'title', weight: 'medium', mono: true, tabular: true }, children: ['42%'] },
        { type: 'Text', props: { bold: true }, children: ['old'] },
        { type: 'Text', props: { bold: true, weight: 'regular' }, children: ['outranked'] },
        { type: 'Text', props: { size: 'caption' }, children: ['small'] },
      ],
    }
    const { container } = render(withUi({}, createElement(ModRenderTree, { tree, site })))
    const [title, old, outranked, caption] = [...container.querySelectorAll('div > div > span')] as HTMLElement[]
    expect(title!.style.fontSize).toBe('1.125rem')
    expect(title!.style.fontWeight).toBe('500')
    expect(title!.style.fontFamily).toBe('var(--font-mono)')
    expect(title!.style.fontVariantNumeric).toBe('tabular-nums')
    expect(old!.style.fontWeight).toBe('600')
    expect(outranked!.style.fontWeight).toBe('400')
    expect(caption!.style.fontSize).toBe('0.625rem')
  })

  it("draws a Box's spacing steps on the desktop scale, cells as before, and Buttons in a row with no gap xs apart", () => {
    const button = (key: string) => ({ type: 'Button', props: { key, label: key }, press })
    const tree = {
      type: 'Box',
      props: { flexDirection: 'column', gap: 'md', paddingX: 'lg', paddingY: 1, marginTop: 'xl' },
      children: [
        { type: 'Box', children: [button('a'), button('b')] },
        { type: 'Box', props: { gap: 2 }, children: [button('c')] },
      ],
    }
    const { container } = render(withUi({}, createElement(ModRenderTree, { tree, site })))
    const outer = container.querySelector('div > div > div') as HTMLElement
    expect(outer.style.gap).toBe('0.75rem')
    expect(outer.style.paddingLeft).toBe('1rem')
    expect(outer.style.paddingRight).toBe('1rem')
    expect(outer.style.paddingTop).toBe('calc(1 * 1.5em)')
    expect(outer.style.marginTop).toBe('1.5rem')
    const [row, gapped] = [...outer.children] as HTMLElement[]
    expect(row!.style.columnGap).toBe('0.25rem')
    expect(gapped!.style.gap).toBe('2ch')
    expect(gapped!.style.columnGap).not.toBe('0.25rem')
  })

  it("an empty Button on an engine action draws the action's words, else its name, and presses; a labelled one keeps its own", () => {
    const uiInput = vi.fn(async () => ({ ok: true }))
    const tree = {
      type: 'Box',
      children: [
        { type: 'Button', props: { key: 'base', label: '', plain: true, action: 'app:cycleDiffBase' }, press },
        { type: 'Button', props: { key: 'down', label: '↓ 3 more', plain: true, action: 'app:diffFileListDown' }, press },
        { type: 'Button', props: { key: 'close', label: '', action: 'pane:close' }, press },
        // An engine action the hint line has no words for.
        { type: 'Button', props: { key: 'send', label: '', action: 'chat:submit' }, press },
      ],
    }
    render(withUi({ uiInput }, createElement(ModRenderTree, { tree, site })))
    expect(screen.getByTestId('mod-button-base').textContent).toBe('Switch diff panel base')
    expect(screen.getByTestId('mod-button-down').textContent).toBe('↓ 3 more')
    expect(screen.getByTestId('mod-button-close').textContent).toBe('Close plugin pane')
    expect(screen.getByTestId('mod-button-send').textContent).toBe('chat:submit')
    fireEvent.click(screen.getByTestId('mod-button-base'))
    expect(uiInput).toHaveBeenCalledWith(expect.objectContaining({ kind: 'press', element: 'base', handle: 4 }))
  })

  it('an Input sends a change on typing and a submit on Enter; a Select sends its pick', () => {
    const uiInput = vi.fn(async () => ({ ok: true }))
    const tree = {
      type: 'Box',
      children: [
        { type: 'Input', props: { key: 'q', placeholder: 'ask', value: 'pre', submitLabel: 'send' }, press },
        { type: 'Select', props: { key: 'pick', options: [{ value: 'a', label: 'A' }, { value: 'b' }], value: 'a' }, press: { plugin: 'p', handle: 9 } },
      ],
    }
    render(withUi({ uiInput }, createElement(ModRenderTree, { tree, site })))
    const input = screen.getByTestId('mod-input-q') as HTMLInputElement
    expect(input.value).toBe('pre')
    expect(input.placeholder).toBe('ask')
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(uiInput).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'input', element: 'q', inputKind: 'change', value: 'hello', handle: 4 }))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(uiInput).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'input', inputKind: 'submit', value: 'hello' }))
    fireEvent.change(screen.getByTestId('mod-select-pick'), { target: { value: 'b' } })
    expect(uiInput).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'select', element: 'pick', value: 'b', handle: 9 }))
  })

  it('an Input with rows is a field of that many lines: Enter submits, Shift+Enter or a backslash before Enter starts a line', () => {
    const uiInput = vi.fn(async () => ({ ok: true }))
    const tree = { type: 'Input', props: { key: 'note', rows: 3, value: 'one' }, press }
    render(withUi({ uiInput }, createElement(ModRenderTree, { tree, site })))
    const area = screen.getByTestId('mod-input-note') as HTMLTextAreaElement
    expect(area.tagName).toBe('TEXTAREA')
    expect(area.getAttribute('rows')).toBe('3')
    fireEvent.keyDown(area, { key: 'Enter', shiftKey: true })
    expect(uiInput).not.toHaveBeenCalled()
    fireEvent.change(area, { target: { value: 'one\\' } })
    area.setSelectionRange(4, 4)
    fireEvent.keyDown(area, { key: 'Enter' })
    expect(uiInput).toHaveBeenLastCalledWith(expect.objectContaining({ inputKind: 'change', value: 'one\n' }))
    expect(uiInput).not.toHaveBeenCalledWith(expect.objectContaining({ inputKind: 'submit' }))
    fireEvent.change(area, { target: { value: 'one\ntwo' } })
    fireEvent.keyDown(area, { key: 'Enter' })
    expect(uiInput).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'input', element: 'note', inputKind: 'submit', value: 'one\ntwo' }))
  })

  it('an Enter that commits an input method candidate neither submits nor starts a line', () => {
    const uiInput = vi.fn(async () => ({ ok: true }))
    render(
      withUi(
        { uiInput },
        createElement(ModRenderTree, {
          tree: { type: 'Box', children: [{ type: 'Input', props: { key: 'one', value: 'x' }, press }, { type: 'Input', props: { key: 'many', rows: 2, value: 'x\\' }, press }] },
          site,
        }),
      ),
    )
    fireEvent.keyDown(screen.getByTestId('mod-input-one'), { key: 'Enter', isComposing: true })
    const area = screen.getByTestId('mod-input-many') as HTMLTextAreaElement
    area.setSelectionRange(2, 2)
    fireEvent.keyDown(area, { key: 'Enter', isComposing: true })
    expect(uiInput).not.toHaveBeenCalled()
  })

  it('a Button whose children draw nothing draws its label', () => {
    const tree = { type: 'Button', props: { key: 'open', label: 'Open notes' }, press, children: ['', { type: 'Text', children: [] }] }
    render(withUi({}, createElement(ModRenderTree, { tree, site })))
    expect(screen.getByTestId('mod-button-open').textContent).toBe('Open notes')
  })

  it('a Text with dir rtl reads right to left, flush right', () => {
    const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [{ type: 'Text', props: { dir: 'rtl' }, children: ['שלום'] }] }
    const { container } = render(withUi({}, createElement(ModRenderTree, { tree, site })))
    const text = container.querySelector('span[dir]') as HTMLElement
    expect(text.getAttribute('dir')).toBe('rtl')
    expect(text.style.textAlign).toBe('right')
  })

  it('a Link opens in a new tab with its label; a Code numbers its lines; an Svg is an image; an engine node is nothing', () => {
    const tree = {
      type: 'Box',
      children: [
        { type: 'Link', props: { href: 'https://example.com/x', label: 'Example' } },
        { type: 'Code', props: { source: 'a\nb', startLine: 10, language: 'ts' } },
        { type: 'Svg', props: { source: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', alt: 'a dot', width: 20 } },
        { type: 'engine', ref: 0 },
      ],
    }
    const { container } = render(withUi({}, createElement(ModRenderTree, { tree, site })))
    const link = container.querySelector('a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://example.com/x')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.textContent).toBe('Example')
    expect(container.querySelector('pre')?.textContent).toContain('10')
    expect(container.querySelector('pre')?.textContent).toContain('11')
    const img = container.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('alt')).toBe('a dot')
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(container.querySelector('script')).toBeNull()
  })
})

describe('ModPanes and ModAbovePrompt', () => {
  const pane = (id: string, isShown: boolean, title = id) => ({ plugin: 'p', id, title, isShown, isFocused: false, closeOnEscape: false })

  it('draws nothing with no pane; one pane shows its title and asks for its tree; the close mark closes it', async () => {
    const render$ = vi.fn(async () => ({ kind: 'tree' as const, tree: { type: 'Text', children: ['tick 1'] }, plugin: 'p' }))
    const closePane = vi.fn(async () => {})
    const { container, rerender } = render(withUi({}, createElement(ModPanes)))
    expect(container.innerHTML).toBe('')
    rerender(
      withUi(
        { panes: [pane('clock', true, 'Clock')], hooked: [{ plugin: 'p', component: 'Pane', requestId: 'clock' }], render: render$, closePane },
        createElement(ModPanes),
      ),
    )
    expect(screen.getByTestId('mod-pane-title-p-clock').textContent).toContain('Clock')
    await waitFor(() => expect(screen.getByTestId('mod-pane-p-clock').textContent).toBe('tick 1'))
    expect(render$).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'Pane',
        requestId: 'clock',
        props: expect.objectContaining({ title: 'Clock', placement: 'inline', isFocused: false }),
        viewport: expect.objectContaining({ isFullscreen: false }),
      }),
    )
    fireEvent.click(screen.getByTestId('mod-pane-close-p-clock'))
    expect(closePane).toHaveBeenCalledWith('p', 'clock')
  })

  it('an unhooked pane asks for nothing; a stale counter asks again', async () => {
    const render$ = vi.fn(async () => ({ kind: 'engine' as const }))
    const { rerender } = render(withUi({ panes: [pane('x', true)], hooked: [], render: render$ }, createElement(ModPanes)))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(render$).not.toHaveBeenCalled()
    const hooked = [{ plugin: 'p' }]
    rerender(withUi({ panes: [pane('x', true)], hooked, render: render$ }, createElement(ModPanes)))
    await waitFor(() => expect(render$).toHaveBeenCalledTimes(1))
    rerender(withUi({ panes: [pane('x', true)], hooked, render: render$, stale: { all: 0, sites: { 'Pane\u0000x': 1 } } }, createElement(ModPanes)))
    await waitFor(() => expect(render$).toHaveBeenCalledTimes(2))
    rerender(withUi({ panes: [pane('x', true)], hooked, render: render$, stale: { all: 1, sites: { 'Pane\u0000x': 1 } } }, createElement(ModPanes)))
    await waitFor(() => expect(render$).toHaveBeenCalledTimes(3))
  })

  it('several panes are tabs: the shown one is selected, a click shows another', () => {
    const showPane = vi.fn(async () => {})
    render(withUi({ panes: [pane('a', false, 'A'), pane('b', true, 'B')], showPane }, createElement(ModPanes)))
    expect(screen.getByTestId('mod-pane-tab-p-b').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('mod-pane-tab-p-a').getAttribute('aria-selected')).toBe('false')
    fireEvent.click(screen.getByTestId('mod-pane-tab-p-a'))
    expect(showPane).toHaveBeenCalledWith('p', 'a')
  })

  it('the band draws nothing unhooked, and its hook\'s tree when hooked', async () => {
    const render$ = vi.fn(async () => ({ kind: 'tree' as const, tree: { type: 'Text', children: ['last turn: 3s'] }, plugin: 'band' }))
    const { container, rerender } = render(withUi({ render: render$ }, createElement(ModAbovePrompt)))
    expect(container.innerHTML).toBe('')
    rerender(withUi({ hooked: [{ plugin: 'band', component: 'AbovePrompt' }], render: render$ }, createElement(ModAbovePrompt)))
    await waitFor(() => expect(screen.getByTestId('mod-band').textContent).toBe('last turn: 3s'))
    expect(render$).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'AbovePrompt', requestId: 'band', props: expect.objectContaining({ hasSurvey: false, maxRows: 8 }) }),
    )
  })

  it('the band sits in the status bar\'s frame once its tree is drawn, and is unframed until then', async () => {
    const frameOf = () => document.querySelector('[data-slot="mod-above-prompt"]')!
    const isFramed = () => FOOTER_BAR_FRAME.split(' ').every(token => frameOf().classList.contains(token))
    let resolveTree!: (value: { kind: 'tree'; tree: { type: string; children: string[] }; plugin: string }) => void
    const render$ = vi.fn(() => new Promise(resolve => { resolveTree = resolve }))
    render(withUi({ hooked: [{ plugin: 'band', component: 'AbovePrompt' }], render: render$ as never }, createElement(ModAbovePrompt)))
    await waitFor(() => expect(render$).toHaveBeenCalled())
    // No tree yet: an empty frame would be a blank bar above the prompt.
    expect(frameOf().getAttribute('data-framed')).toBeNull()
    expect(isFramed()).toBe(false)
    resolveTree({ kind: 'tree', tree: { type: 'Text', children: ['last turn: 3s'] }, plugin: 'band' })
    await waitFor(() => expect(screen.getByTestId('mod-band').textContent).toBe('last turn: 3s'))
    expect(frameOf().getAttribute('data-framed')).toBe('true')
    expect(isFramed()).toBe(true)
  })
})

describe('ModUserMessageSite', () => {
  const props = { text: 'fix the build', origin: { kind: 'unclassified' as const }, isExpanded: true }
  const drawEngine = (rewrite?: { text: string }) =>
    createElement('div', { 'data-testid': 'engine-row' }, rewrite ? rewrite.text : 'fix the build')

  it("unhooked, it is the engine's row and asks for nothing", () => {
    const renderSite = vi.fn()
    render(withUi({ render: renderSite }, createElement(ModUserMessageSite, { requestId: 'u-1', props, drawEngine })))
    expect(screen.getByTestId('engine-row').textContent).toBe('fix the build')
    expect(renderSite).not.toHaveBeenCalled()
  })

  it("hooked, it asks with the row's props and draws the engine's row with a rewritten text", async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const, rewrite: { text: 'FIX THE BUILD' } }))
    render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p', component: 'UserMessage' }] },
        createElement(ModUserMessageSite, { requestId: 'u-1', props, drawEngine }),
      ),
    )
    // While asking, the engine's own row stands.
    expect(screen.getByTestId('engine-row').textContent).toBe('fix the build')
    await waitFor(() => expect(screen.getByTestId('engine-row').textContent).toBe('FIX THE BUILD'))
    expect(renderSite).toHaveBeenCalledWith(expect.objectContaining({ component: 'UserMessage', requestId: 'u-1', props }))
  })

  it("a hook's tree wraps the row: each engine node draws the row with the props its ref carried", async () => {
    const tree = {
      type: 'Box',
      props: { flexDirection: 'column' },
      children: [{ type: 'Text', children: ['BADGE'] }, { type: 'engine', ref: 0 }, { type: 'engine', ref: 1 }],
    }
    const renderSite = vi.fn(async () => ({ kind: 'tree' as const, tree, plugin: 'p', rewrites: { '1': { text: 'LOUD' } } }))
    render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p' }] },
        createElement(ModUserMessageSite, { requestId: 'u-1', props, drawEngine }),
      ),
    )
    await waitFor(() => expect(screen.getAllByTestId('engine-row')).toHaveLength(2))
    expect(screen.getAllByTestId('engine-row').map(row => row.textContent)).toEqual(['fix the build', 'LOUD'])
    expect(screen.getByText('BADGE')).toBeTruthy()
  })
})

describe('ModCommandOutputSite', () => {
  const props = { command: 'cost', args: '', text: 'Total: $0.12', isErrored: false }
  const drawEngine = (rewrite?: { text: string }) =>
    createElement('div', { 'data-testid': 'command-row' }, rewrite ? rewrite.text : 'Total: $0.12')

  it("unhooked, it is the engine's row and asks for nothing; a hook on another site asks nothing either", () => {
    const renderSite = vi.fn()
    render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p', component: 'UserMessage' }] },
        createElement(ModCommandOutputSite, { requestId: 'c-1', props, drawEngine }),
      ),
    )
    expect(screen.getByTestId('command-row').textContent).toBe('Total: $0.12')
    expect(renderSite).not.toHaveBeenCalled()
  })

  it("hooked, it asks with the row's props and draws the engine's row with the rewritten text", async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const, rewrite: { text: 'TOTAL' } }))
    const { container } = render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p', component: 'CommandOutput' }] },
        createElement(ModCommandOutputSite, { requestId: 'c-1', props, drawEngine }),
      ),
    )
    await waitFor(() => expect(screen.getByTestId('command-row').textContent).toBe('TOTAL'))
    expect(renderSite).toHaveBeenCalledWith(expect.objectContaining({ component: 'CommandOutput', requestId: 'c-1', props }))
    expect(container.querySelector('[data-slot="mod-command-output"]')?.getAttribute('data-mod-drawn')).toBe('engine')
  })

  it("a hook's own tree draws in the row's place", async () => {
    const tree = { type: 'Text', children: ['MINE'] }
    const renderSite = vi.fn(async () => ({ kind: 'tree' as const, tree, plugin: 'p' }))
    render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p', component: 'CommandOutput' }] },
        createElement(ModCommandOutputSite, { requestId: 'c-1', props, drawEngine }),
      ),
    )
    await waitFor(() => expect(screen.getByText('MINE')).toBeTruthy())
    expect(screen.queryByTestId('command-row')).toBeNull()
  })
})

describe('ModPromptHintSite', () => {
  const props = { isDraft: true, isWorking: false, hint: 'Enter to send' }
  const drawEngine = (rewrite?: { hint: string; tail?: string }) =>
    createElement(
      'span',
      { 'data-testid': 'hint-line' },
      rewrite ? rewrite.hint : 'Enter to send',
      rewrite?.tail ? createElement('span', { 'data-testid': 'hint-tail' }, rewrite.tail) : null,
    )

  it("unhooked, it is the engine's line and asks for nothing; a hook on another site asks nothing either", () => {
    const renderSite = vi.fn()
    const { container } = render(
      withUi({ render: renderSite, hooked: [{ plugin: 'p', component: 'CommandOutput' }] }, createElement(ModPromptHintSite, { props, drawEngine })),
    )
    expect(screen.getByTestId('hint-line').textContent).toBe('Enter to send')
    expect(container.querySelector('[data-slot="mod-prompt-hint"]')).toBeNull()
    expect(renderSite).not.toHaveBeenCalled()
  })

  it("hooked, it asks for its one instance with the line's props and draws the engine's line with the hook's tail", async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const, rewrite: { hint: 'Enter to send', tail: 'main' } }))
    const { container } = render(
      withUi({ render: renderSite, hooked: [{ plugin: 'p', component: 'PromptHint' }] }, createElement(ModPromptHintSite, { props, drawEngine })),
    )
    await waitFor(() => expect(screen.getByTestId('hint-tail').textContent).toBe('main'))
    expect(renderSite).toHaveBeenCalledWith(expect.objectContaining({ component: 'PromptHint', requestId: 'hint', props }))
    expect(container.querySelector('[data-slot="mod-prompt-hint"]')?.getAttribute('data-mod-drawn')).toBe('engine')
  })

  it("a hook's own tree draws in the line's place, and its Button presses as ui.press on the site", async () => {
    const uiInput = vi.fn(async () => ({ ok: true }))
    const tree = { type: 'Box', children: [{ type: 'Text', children: ['MINE'] }, { type: 'Button', props: { key: 'go', label: 'Go' }, press: { plugin: 'p', handle: 7 } }] }
    const renderSite = vi.fn(async () => ({ kind: 'tree' as const, tree, plugin: 'p' }))
    render(
      withUi(
        { render: renderSite, uiInput, hooked: [{ plugin: 'p', component: 'PromptHint' }] },
        createElement(ModPromptHintSite, { props, drawEngine }),
      ),
    )
    await waitFor(() => expect(screen.getByText('MINE')).toBeTruthy())
    expect(screen.queryByTestId('hint-line')).toBeNull()
    fireEvent.click(screen.getByTestId('mod-button-go'))
    expect(uiInput).toHaveBeenCalledWith({ kind: 'press', element: 'go', plugin: 'p', component: 'PromptHint', requestId: 'hint', handle: 7 })
  })
})

describe('ModToolUseSite', () => {
  const part = { toolCallId: 't-1', toolName: 'Bash', args: { command: 'ls' }, result: 'a\nb', status: { type: 'complete' }, isError: false }
  // The row draws its args / result as received, and its nested body reads
  // the rewrite again from context, as the lazy-detail bodies do.
  function NestedBody() {
    const rewrite = useModToolUseRewrite()
    return createElement('span', { 'data-testid': 'nested' }, String(modToolUseValue(rewrite, 'output', 'sidecar output')))
  }
  const drawEngine = (rewrite?: { input?: unknown; output?: unknown }) =>
    createElement(
      'li',
      { 'data-testid': 'tool-row' },
      JSON.stringify(modToolUseValue(rewrite, 'input', part.args)) + ' -> ' + String(modToolUseValue(rewrite, 'output', part.result)),
      createElement(NestedBody),
    )

  it('maps a part to ToolUse props: running, settled, cancelled, failed', () => {
    expect(modToolUseProps(part)).toEqual({
      tool_use_id: 't-1',
      tool: 'Bash',
      input: { command: 'ls' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: 'a\nb',
    })
    expect(modToolUseProps({ ...part, result: undefined, status: { type: 'running' } })).toEqual(
      expect.not.objectContaining({ output: expect.anything() }),
    )
    expect(modToolUseProps({ ...part, result: undefined, status: { type: 'running' } }).isRunning).toBe(true)
    expect(modToolUseProps({ ...part, status: { type: 'requires-action' } }).isRunning).toBe(true)
    expect(modToolUseProps({ ...part, result: undefined, status: undefined }).isRunning).toBe(true)
    expect(modToolUseProps({ ...part, status: undefined }).isRunning).toBe(false)
    const cancelled = modToolUseProps({ ...part, status: { type: 'incomplete', reason: 'cancelled' } })
    expect([cancelled.isInterrupted, cancelled.isErrored]).toEqual([true, false])
    const failed = modToolUseProps({ ...part, status: { type: 'incomplete', reason: 'error' } })
    expect([failed.isInterrupted, failed.isErrored]).toEqual([false, true])
    expect(modToolUseProps({ ...part, isError: true }).isErrored).toBe(true)
    expect(modToolUseProps({ ...part, result: undefined }).output).toBeNull()
  })

  it("unhooked, it is the engine's row and asks for nothing; a hook on another row asks nothing either", () => {
    const renderSite = vi.fn()
    render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolUse', requestId: 't-9' }] },
        createElement('ul', null, createElement(ModToolUseSite, { part, drawEngine, as: 'li' })),
      ),
    )
    expect(screen.getByTestId('tool-row').textContent).toBe('{"command":"ls"} -> a\nbsidecar output')
    expect(renderSite).not.toHaveBeenCalled()
  })

  it('hooked, it asks with the props and draws the row with the rewrite, which reaches the nested body too', async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const, rewrite: { output: 'hidden' } }))
    const { container } = render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolUse' }] },
        createElement('ul', null, createElement(ModToolUseSite, { part, drawEngine, as: 'li' })),
      ),
    )
    await waitFor(() => expect(screen.getByTestId('tool-row').textContent).toBe('{"command":"ls"} -> hiddenhidden'))
    expect(renderSite).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'ToolUse', requestId: 't-1', props: modToolUseProps(part) }),
    )
    // In a plan list the site is a list item of its own, the row's <li> in a list beneath it.
    const seat = container.querySelector('ul > li[data-slot="mod-tool-use"]')
    expect(seat?.getAttribute('data-mod-drawn')).toBe('engine')
    expect(seat?.querySelector(':scope > ul > li[data-testid="tool-row"]')).toBeTruthy()
  })

  it("a hook's tree draws in the row's place, an engine node in it with that node's rewrite", async () => {
    const tree = { type: 'Box', children: [{ type: 'Text', children: ['AUDITED'] }, { type: 'engine', ref: 3 }] }
    const renderSite = vi.fn(async () => ({ kind: 'tree' as const, tree, plugin: 'p', rewrites: { '3': { input: { command: '***' } } } }))
    render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolUse' }] },
        createElement(ModToolUseSite, { part, drawEngine }),
      ),
    )
    await waitFor(() => expect(screen.getByText('AUDITED')).toBeTruthy())
    expect(screen.getByTestId('tool-row').textContent).toBe('{"command":"***"} -> a\nbsidecar output')
  })
})

describe('ModToolResultSite', () => {
  const props = { tool_use_id: 'r-1', tool: 'Grep', output: 'SECRET', isErrored: false }
  const drawEngine = (rewrite?: { output: unknown }) =>
    createElement('div', { 'data-testid': 'result-block' }, String(rewrite ? rewrite.output : props.output))

  it("unhooked, it is the engine's block and asks for nothing", () => {
    const renderSite = vi.fn()
    render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolUse' }] },
        createElement(ModToolResultSite, { props, drawEngine }),
      ),
    )
    expect(screen.getByTestId('result-block').textContent).toBe('SECRET')
    expect(renderSite).not.toHaveBeenCalled()
  })

  it('hooked, it asks with the props and draws the rewritten output', async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const, rewrite: { output: 'MASKED' } }))
    const { container } = render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolResult' }] },
        createElement(ModToolResultSite, { props, drawEngine }),
      ),
    )
    await waitFor(() => expect(screen.getByTestId('result-block').textContent).toBe('MASKED'))
    expect(renderSite).toHaveBeenCalledWith(expect.objectContaining({ component: 'ToolResult', requestId: 'r-1', props }))
    expect(container.querySelector('[data-slot="mod-tool-result"]')?.getAttribute('data-mod-drawn')).toBe('engine')
  })

  it('a result not yet loaded, or longer than the bound, is not raised', () => {
    const renderSite = vi.fn()
    const hooked = [{ plugin: 'p', component: 'ToolResult' }]
    render(withUi({ render: renderSite, hooked }, createElement(ModToolResultSite, { props: { ...props, output: undefined }, drawEngine })))
    render(
      withUi(
        { render: renderSite, hooked },
        createElement(ModToolResultSite, { props: { ...props, output: 'x'.repeat(MOD_TOOL_RESULT_MAX_CHARS + 1) }, drawEngine }),
      ),
    )
    expect(renderSite).not.toHaveBeenCalled()
    expect(isRaisableToolResult('x'.repeat(MOD_TOOL_RESULT_MAX_CHARS - 2))).toBe(true)
    expect(isRaisableToolResult(1n)).toBe(false)
  })

  it("a hook's tree draws in the block's place, an engine node with its rewrite", async () => {
    const tree = { type: 'Box', children: [{ type: 'Text', children: ['NOTE'] }, { type: 'engine', ref: 2 }] }
    const renderSite = vi.fn(async () => ({ kind: 'tree' as const, tree, plugin: 'p', rewrites: { '2': { output: 'SHORT' } } }))
    render(
      withUi(
        { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolResult' }] },
        createElement(ModToolResultSite, { props, drawEngine }),
      ),
    )
    await waitFor(() => expect(screen.getByText('NOTE')).toBeTruthy())
    expect(screen.getByTestId('result-block').textContent).toBe('SHORT')
  })
})

describe("the plugin icons on the band and a pane", () => {
  const draw = (answer: Record<string, unknown>, component: React.ReactElement, value: Partial<ModUiContextValue> = {}) => {
    const openPluginSettings = vi.fn()
    const render$ = vi.fn(async () => ({ kind: 'tree' as const, ...answer }))
    render(createElement(TooltipProvider, null, withUi({ render: render$ as never, openPluginSettings, ...value }, component)))
    return openPluginSettings
  }
  const band = { hooked: [{ plugin: 'usage', component: 'AbovePrompt' as const }] }

  it('a text-only band gets the icon of every plugin that drew it, on the frame, and a click opens that plugin', async () => {
    const open = draw({ tree: { type: 'Text', children: ['19% of context'] }, plugins: ['usage', 'clock'] }, createElement(ModAbovePrompt), band)
    const link = await screen.findByTestId('mod-plugin-link-usage')
    const frame = document.querySelector('[data-slot="mod-above-prompt"]')!
    expect(frame.classList).toContain('group/mod-bar')
    const icons = frame.querySelector('[data-slot="mod-plugin-icons"]')!
    expect(icons.parentElement).toBe(frame)
    expect([...icons.children].map(icon => icon.getAttribute('data-testid'))).toEqual(['mod-plugin-link-usage', 'mod-plugin-link-clock'])
    // The cells are measured inside the strip kept clear for the icons.
    expect(screen.getByTestId('mod-band').parentElement!.style.paddingRight).toBe('40px')
    fireEvent.click(link)
    expect(open).toHaveBeenCalledWith('usage')
  })

  it('an older runtime names no plugins: the one whose handles are in the tree gets the icon', async () => {
    draw({ tree: { type: 'Text', children: ['BAND'] }, plugin: 'clock' }, createElement(ModAbovePrompt), band)
    await screen.findByTestId('mod-plugin-link-clock')
    expect(document.querySelectorAll('[data-slot="mod-plugin-icons"] button')).toHaveLength(1)
  })

  it("a band two plugins drew splits into sections with a rule between, each with its own plugin's icon at its right", async () => {
    const open = draw(
      {
        tree: { type: 'Box', children: [{ type: 'Text', children: ['19% of context'] }, { type: 'Text', children: ['12:00'] }] },
        plugins: ['usage', 'clock'],
        sections: [
          { plugin: 'usage', tree: { type: 'Text', children: ['19% of context'] } },
          { plugin: 'clock', tree: { type: 'Text', children: ['12:00'] } },
        ],
      },
      createElement(ModAbovePrompt),
      band,
    )
    const clockLink = await screen.findByTestId('mod-plugin-link-clock')
    const frame = document.querySelector('[data-slot="mod-above-prompt"]')!
    // The outer frame shows no icon of its own; hovering it shows none at once.
    expect(frame.classList).not.toContain('group/mod-bar')
    expect([...frame.querySelectorAll(':scope > [data-slot="mod-plugin-icons"]')]).toHaveLength(0)
    const sections = [...frame.querySelectorAll('[data-slot="mod-band-section"]')]
    expect(sections.map(section => section.getAttribute('data-plugin'))).toEqual(['usage', 'clock'])
    for (const [index, plugin] of ['usage', 'clock'].entries()) {
      const section = sections[index]!
      expect(section.classList).toContain('group/mod-bar')
      const icons = section.querySelector('[data-slot="mod-plugin-icons"]')!
      expect(icons.parentElement).toBe(section)
      expect([...icons.children].map(icon => icon.getAttribute('data-testid'))).toEqual([`mod-plugin-link-${plugin}`])
    }
    // A plugin sits as far from the rule as from the frame's edge.
    for (const section of sections) {
      expect(section.classList).toContain('py-1')
      expect([...section.classList].filter(name => /^p[tb]-/.test(name))).toEqual([])
    }
    expect(sections[0]!.textContent).toContain('19% of context')
    expect(sections[1]!.textContent).toContain('12:00')
    const dividers = screen.getAllByTestId('mod-band-divider')
    expect(dividers).toHaveLength(1)
    expect(dividers[0]!.classList).toContain('border-dashed')
    expect(dividers[0]!.previousElementSibling).toBe(sections[0])
    expect(dividers[0]!.nextElementSibling).toBe(sections[1])
    fireEvent.click(clockLink)
    expect(open).toHaveBeenCalledWith('clock')
  })

  it("a pane's body takes its plugin's icon, clear of the header's close mark", async () => {
    draw({ tree: { type: 'Text', children: ['tick'] } }, createElement(ModPanes), {
      panes: [{ plugin: 'clock', id: 'c', title: 'Clock', isShown: true }] as never,
    })
    const link = await screen.findByTestId('mod-plugin-link-clock')
    const body = document.querySelector('[data-slot="mod-pane-body"]')!
    expect(body.contains(link)).toBe(true)
    expect(body.contains(screen.getByTestId('mod-pane-clock-c'))).toBe(true)
  })
})

describe('ModDockedPane — a pane docked in the Right Panel', () => {
  const pane = { plugin: 'p', id: 'clock', title: 'Clock', isShown: true, isFocused: false, closeOnEscape: false }

  it("asks for the pane's tree with placement 'dock' and draws it as the tab's body", async () => {
    const render$ = vi.fn(async () => ({ kind: 'tree' as const, tree: { type: 'Text', children: ['tick 1'] }, plugin: 'p' }))
    render(withUi({ panes: [pane], hooked: [{ plugin: 'p' }], render: render$ }, createElement(ModDockedPane, { plugin: 'p', id: 'clock' })))
    const body = screen.getByTestId('mod-pane-p-clock')
    expect(body.getAttribute('data-mod-placement')).toBe('dock')
    await waitFor(() => expect(body.textContent).toContain('tick 1'))
    expect(render$).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'Pane',
        requestId: 'clock',
        props: expect.objectContaining({ title: 'Clock', placement: 'dock' }),
      }),
    )
    // The docked body has no header of its own: the panel's tab is it.
    expect(screen.queryByTestId('mod-pane-title-p-clock')).toBeNull()
  })

  it('draws nothing for a pane the runtime no longer holds', () => {
    const { container } = render(withUi({ panes: [] }, createElement(ModDockedPane, { plugin: 'p', id: 'clock' })))
    expect(container.innerHTML).toBe('')
  })

  it('with the panes docked, the strip above the prompt steps aside', () => {
    const { container } = render(withUi({ panes: [pane], panesDocked: true }, createElement(ModPanes)))
    expect(container.innerHTML).toBe('')
  })
})
