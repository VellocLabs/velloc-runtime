// @vitest-environment happy-dom
/**
 * The mods' lines as a thread draws them (F-25): the status lines, the
 * toast stack, and the notice under the open permission dialog.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { COMPOSER_STATUS_INLINE, ModComposerStatus, ModNoticeLine, ModPluginFrame, ModPluginLink, ModToasts, ModTurnNote } from '../components/assistant-ui/mod-ui'
import { TooltipProvider } from '../components/ui/tooltip'
import { FOOTER_BAR_FRAME } from '../components/assistant-ui/footer-bar-frame'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '../components/assistant-ui/mod-ui-context'
import { PermissionAskFooterControl } from '../components/assistant-ui/permission-ask-footer-control'
import { PermissionAskContext } from '../components/assistant-ui/permission-ask-context'

afterEach(() => cleanup())

function withUi(value: Partial<ModUiContextValue>, child: React.ReactElement) {
  const full: ModUiContextValue = {
    ...EMPTY_MOD_UI,
    ...value,
  }
  return createElement(ModUiContext.Provider, { value: full }, child)
}

describe('ModComposerStatus', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ plugin: `p${i}`, text: `line ${i}` }))

  it('draws the plugins side by side on one row, the mod\'s text as is; nothing (no row) with none', () => {
    render(withUi({ status: [{ plugin: 'greeter', text: 'thinking…' }, { plugin: 'lint', text: '3 issues' }] }, createElement(ModComposerStatus)))
    const row = document.querySelector('[data-slot="mod-composer-status"]')!
    expect(screen.getByTestId('mod-status-greeter').textContent).toBe('greeterthinking…')
    expect(screen.getByTestId('mod-status-lint').textContent).toBe('lint3 issues')
    expect(screen.getByTestId('mod-status-lint').getAttribute('title')).toBe('lint: 3 issues')
    // One row: a flex line, no column, no frame of its own.
    expect(row.classList).toContain('flex')
    expect(row.classList).not.toContain('flex-col')
    for (const token of FOOTER_BAR_FRAME.split(' ')) expect(row.classList).not.toContain(token)
    expect(screen.queryByTestId('mod-status-more')).toBeNull()
    cleanup()
    const empty = render(withUi({}, createElement(ModComposerStatus)))
    expect(empty.container.innerHTML).toBe('')
  })

  it('past the inline count the rest wait behind +N, which lists every line whole', async () => {
    render(createElement(TooltipProvider, null, withUi({ status: lines(COMPOSER_STATUS_INLINE + 3) }, createElement(ModComposerStatus))))
    for (let i = 0; i < COMPOSER_STATUS_INLINE; i++) expect(screen.getByTestId(`mod-status-p${i}`)).toBeTruthy()
    expect(screen.queryByTestId(`mod-status-p${COMPOSER_STATUS_INLINE}`)).toBeNull()
    const more = screen.getByTestId('mod-status-more')
    expect(more.textContent).toBe('+3')
    expect(more.getAttribute('aria-label')).toBe('Show 3 more plugin status lines')
    fireEvent.click(more)
    const all = await screen.findByTestId('mod-status-all')
    expect([...all.querySelectorAll('[data-testid^="mod-status-all-"]')].map(el => el.textContent)).toEqual(
      lines(COMPOSER_STATUS_INLINE + 3).map(line => `${line.plugin}${line.text}`),
    )
  })

  it('a press on the row keeps the focus where it is (the prompt)', () => {
    render(withUi({ status: lines(1) }, createElement(ModComposerStatus)))
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    screen.getByTestId('mod-status-p0').dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
  })
})

describe('ModTurnNote', () => {
  it('draws the turn\'s note alone, nothing without one', () => {
    render(withUi({ turnNote: { turnId: 't1', text: 'TL;DR: done' }, status: [{ plugin: 'lint', text: 'x' }] }, createElement(ModTurnNote)))
    expect(screen.getByTestId('mod-turn-note').textContent).toBe('TL;DR: done')
    expect(screen.queryByTestId('mod-status-lint')).toBeNull()
    cleanup()
    expect(render(withUi({}, createElement(ModTurnNote))).container.innerHTML).toBe('')
  })
})

describe('ModToasts', () => {
  it('stacks the toasts under their plugin\'s name; a click or the dismiss button takes one off; the pointer holds it', () => {
    const dismissToast = vi.fn()
    const holdToast = vi.fn()
    render(
      withUi(
        {
          toasts: [
            { id: 't1', plugin: 'greeter', text: 'turn took 3 s', timeoutMs: 4000 },
            { id: 't2', plugin: 'lint', text: 'clean', timeoutMs: 4000 },
          ],
          dismissToast,
          holdToast,
        },
        createElement(ModToasts),
      ),
    )
    const first = screen.getByTestId('mod-toast-greeter')
    expect(first.textContent).toContain('greeter')
    expect(first.textContent).toContain('turn took 3 s')
    fireEvent.mouseEnter(first)
    expect(holdToast).toHaveBeenCalledWith('t1', true)
    fireEvent.mouseLeave(first)
    expect(holdToast).toHaveBeenCalledWith('t1', false)
    fireEvent.click(first)
    expect(dismissToast).toHaveBeenCalledWith('t1')
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[1]!)
    expect(dismissToast).toHaveBeenCalledWith('t2')
  })
})

describe('the notice under the permission dialog', () => {
  it('shows the mod\'s line for the open call alone', () => {
    const pending = { toolCallId: 'tc-1', request: { toolName: 'Bash', input: {}, message: 'Run it?' } }
    render(
      createElement(
        PermissionAskContext.Provider,
        { value: { pending: pending as never, resolve: async () => {} } },
        withUi(
          { notices: [{ toolUseId: 'tc-1', plugin: 'guard', text: 'checked by guard' }, { toolUseId: 'tc-2', plugin: 'other', text: 'not this one' }] },
          createElement(PermissionAskFooterControl),
        ),
      ),
    )
    expect(screen.getByTestId('mod-notice-guard').textContent).toContain('checked by guard')
    expect(screen.queryByTestId('mod-notice-other')).toBeNull()
  })

  it('ModNoticeLine alone draws nothing for a call with no line', () => {
    const { container } = render(withUi({ notices: [] }, createElement(ModNoticeLine, { toolUseId: 'tc-1' })))
    expect(container.innerHTML).toBe('')
  })
})

describe('where the mods\' rows sit in the composer footer', () => {
  // The plugin rows are the last thing before the prompt: an engine bar (the
  // background-tasks line, a permission ask, a plan approval) seated between
  // them and the composer split a plugin's row from the box it belongs to.
  it('the panes, band and asks come after every engine bar, right before <Composer />', () => {
    const thread = readFileSync(join(__dirname, '..', 'components', 'assistant-ui', 'thread.tsx'), 'utf8')
    // A JSX element opens a line of its own; a mention in a comment does not.
    const at = (tag: string) => {
      const index = thread.search(new RegExp(`^\\s*<${tag}[\\s/>]`, 'm'))
      expect(index, tag).toBeGreaterThan(-1)
      return index
    }
    const composer = at('Composer')
    const mods = ['ModPanes', 'ModAbovePrompt', 'ModAsks'].map(at)
    for (const engine of ['PermissionAskFooterControl', 'PlanApprovalFooterControl', 'EnterPlanModeFooterControl', 'BackgroundTasksFooterControl']) {
      expect(at(engine), engine).toBeLessThan(Math.min(...mods))
    }
    expect(mods).toEqual([...mods].sort((a, b) => a - b))
    expect(Math.max(...mods)).toBeLessThan(composer)
    // Nothing between the last mod row and the composer.
    expect(thread.slice(Math.max(...mods), composer).trim()).toMatch(/^<ModAsks \/>$/)
  })

  it('the status lines are the prompt box\'s top row, and the turn note sits in the transcript under the last answer', () => {
    const thread = readFileSync(join(__dirname, '..', 'components', 'assistant-ui', 'thread.tsx'), 'utf8')
    const at = (tag: string, from = 0) => {
      const index = thread.slice(from).search(new RegExp(`^\\s*<${tag}[\\s/>]`, 'm'))
      expect(index, tag).toBeGreaterThan(-1)
      return from + index
    }
    // Inside the composer's shell, before the attachments and the input.
    const shell = thread.indexOf('data-slot="composer-shell"')
    expect(shell).toBeGreaterThan(-1)
    const status = at('ModComposerStatus', shell)
    expect(status).toBeLessThan(at('ComposerAttachments', shell))
    expect(status).toBeLessThan(at('ComposerPrimitive.Input', shell))
    expect(thread.search(/^\s*<ModComposerStatus[\s/>]/m)).toBe(status)
    // The note follows the message list, before the composer's footer.
    const note = at('ModTurnNote')
    expect(note).toBeGreaterThan(at('VirtualizedThreadMessages'))
    expect(note).toBeLessThan(at('ThreadPrimitive.ViewportFooter'))
    // The run status is the transcript's own last row, ahead of the turn note,
    // not a bar in the composer's footer.
    const runStatus = at('ConversationRunStatus')
    expect(runStatus).toBeGreaterThan(at('VirtualizedThreadMessages'))
    expect(runStatus).toBeLessThan(note)
  })
})

describe("the plugin's icon on its rows above the prompt", () => {
  const withTooltips = (value: Partial<ModUiContextValue>, child: React.ReactElement) =>
    createElement(TooltipProvider, null, withUi(value, child))

  it('is drawn only where Settings can be opened at the plugin', () => {
    render(withTooltips({ status: [{ plugin: 'lint', text: '3 issues' }] }, createElement(ModComposerStatus)))
    expect(screen.queryByTestId('mod-plugin-link-lint')).toBeNull()
  })

  it('its card names the plugin with its version, description and state', async () => {
    render(
      withTooltips(
        {
          openPluginSettings: () => {},
          plugins: { lint: { version: '1.2.0', description: 'Lints every edit.', state: 'loaded' } },
        },
        createElement(ModPluginLink, { plugin: 'lint' }),
      ),
    )
    act(() => screen.getByTestId('mod-plugin-link-lint').focus())
    const [card] = await screen.findAllByTestId('mod-plugin-card-lint')
    expect(card.textContent).toContain('lint')
    expect(card.textContent).toContain('v1.2.0')
    expect(card.textContent).toContain('Lints every edit.')
    expect(card.textContent).toContain('Loaded')
    expect(card.textContent).toContain('Click to open it in Settings → Plugins & Mods')
  })

  it('a plugin the mods state does not know yet is named alone', async () => {
    render(withTooltips({ openPluginSettings: () => {} }, createElement(ModPluginLink, { plugin: 'fresh' })))
    act(() => screen.getByTestId('mod-plugin-link-fresh').focus())
    const [card] = await screen.findAllByTestId('mod-plugin-card-fresh')
    expect(card.textContent).toContain('fresh')
    expect(card.textContent).not.toContain('Loaded')
  })

  it('the Plugins row it lands on flashes three times', () => {
    const css = readFileSync(join(__dirname, '..', 'styles', 'globals.css'), 'utf8')
    expect(css).toMatch(/\.nexus-plugin-flash\s*\{\s*animation:\s*nexus-plugin-flash\s+[\d.]+m?s\s+[\w-]+\s+3;/)
  })

  it('sits at the status row\'s right end, one per plugin, hidden until the row is hovered, and a click opens the plugin in Settings', () => {
    const openPluginSettings = vi.fn()
    render(
      withTooltips(
        { status: [{ plugin: 'greeter', text: 'hi' }, { plugin: 'lint', text: '3 issues' }], openPluginSettings },
        createElement(ModComposerStatus),
      ),
    )
    const frame = document.querySelector('[data-slot="mod-composer-status"]')!
    expect(frame.classList).toContain('group/mod-bar')
    const icons = frame.querySelector('[data-slot="mod-plugin-icons"]')!
    expect(icons.parentElement).toBe(frame)
    expect([...icons.children].map(icon => icon.getAttribute('data-testid'))).toEqual(['mod-plugin-link-greeter', 'mod-plugin-link-lint'])
    // Not on the lines: the row carries them, as a frame does.
    expect(screen.getByTestId('mod-status-lint').querySelector('button')).toBeNull()
    const link = screen.getByTestId('mod-plugin-link-lint')
    expect(link.className).toContain('opacity-0')
    expect(link.className).toContain('group-hover/mod-bar:opacity-100')
    expect(link.getAttribute('aria-label')).toBe('Open lint in Plugins & Mods')
    fireEvent.click(link)
    expect(openPluginSettings).toHaveBeenCalledWith('lint')
  })
})

describe('ModPluginFrame', () => {
  const withTooltips = (value: Partial<ModUiContextValue>, child: React.ReactElement) =>
    createElement(TooltipProvider, null, withUi(value, child))
  const frame = (plugins: string[], height: number) => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect)
    render(
      withTooltips(
        { openPluginSettings: () => {} },
        createElement(ModPluginFrame, { slot: 'probe', plugins, children: createElement('span', null, 'drawn') }),
      ),
    )
    rect.mockRestore()
    return document.querySelector('[data-slot="probe"]') as HTMLElement
  }
  afterEach(() => vi.restoreAllMocks())

  it('one line: the icons sit at the right edge, centred on it', () => {
    const el = frame(['usage'], 18)
    expect(el.getAttribute('data-plugin-icons')).toBe('centred')
    const icons = el.querySelector('[data-slot="mod-plugin-icons"]')!
    expect(icons.className).toContain('top-1/2')
    expect(icons.className).toContain('-translate-y-1/2')
    expect(icons.className).toContain('right-1.5')
  })

  it('more than one line: the icons sit in the top right corner', () => {
    const el = frame(['usage'], 60)
    expect(el.getAttribute('data-plugin-icons')).toBe('corner')
    const icons = el.querySelector('[data-slot="mod-plugin-icons"]')!
    expect(icons.className).toContain('top-1.5')
    expect(icons.className).not.toContain('top-1/2')
  })

  it('keeps a strip clear for the icons, so they never cover the drawing; a plugin named twice gets one icon', () => {
    const el = frame(['usage', 'clock', 'usage'], 18)
    expect(el.querySelectorAll('[data-slot="mod-plugin-icons"] button')).toHaveLength(2)
    const content = el.firstElementChild as HTMLElement
    expect(content.textContent).toBe('drawn')
    expect(content.style.paddingRight).toBe('40px')
  })

  it('no icon, no strip, without plugins, without Settings to open, or unframed', () => {
    const el = frame([], 18)
    expect(el.getAttribute('data-plugin-icons')).toBeNull()
    expect((el.firstElementChild as HTMLElement).style.paddingRight).toBe('')
    cleanup()
    render(withTooltips({}, createElement(ModPluginFrame, { slot: 'bare', plugins: ['usage'], children: 'x' })))
    expect(document.querySelector('[data-slot="bare"] button')).toBeNull()
    cleanup()
    render(withTooltips({ openPluginSettings: () => {} }, createElement(ModPluginFrame, { slot: 'off', framed: false, plugins: ['usage'], children: 'x' })))
    expect(document.querySelector('[data-slot="off"] button')).toBeNull()
  })
})

