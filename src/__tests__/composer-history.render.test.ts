// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import { I18nProvider } from '../browser/webview/i18n'
import { createPassageDraftStore } from '../browser/webview/capturedPassages'
import { ComposerPassagesProvider } from '../components/assistant-ui/composer-passages'
import { Composer, SlashCommandsProvider } from '../components/assistant-ui/thread'
import { TooltipProvider } from '../components/ui/tooltip'

afterEach(() => cleanup())

const MESSAGES: ThreadMessageLike[] = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first ask' }] },
  { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
  { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second ask' }] },
]
const SLASH_LAST: ThreadMessageLike[] = [
  ...MESSAGES,
  { id: 'u3', role: 'user', content: [{ type: 'text', text: '/compact' }] },
]

function Harness({ messages = MESSAGES }: { messages?: ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: m => m,
    isRunning: false,
    onNew: async () => {},
  })
  return createElement(
    TooltipProvider,
    null,
    createElement(
      I18nProvider,
      { locale: 'en' as const },
      createElement(
        AssistantRuntimeProvider,
        { runtime },
        createElement(
          SlashCommandsProvider,
          { value: [{ name: 'compact', description: 'Compact', kind: 'builtin' }] },
          createElement(ComposerPassagesProvider, { store: createPassageDraftStore() }, createElement(Composer)),
        ),
      ),
    ),
  )
}

const input = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!

const press = (el: HTMLTextAreaElement, key: string) =>
  act(() => {
    fireEvent.keyDown(el, { key })
  })

describe('composer history keys', () => {
  const shows = async (box: HTMLTextAreaElement, value: string, label: string) =>
    waitFor(() => {
      expect(box.value).toBe(value)
      expect(screen.getByTestId('composer-history-label').textContent).toBe(label)
    })

  it('ArrowUp on the empty box recalls the newest message, then older; Down comes back', async () => {
    const { container } = render(createElement(Harness))
    const box = input(container)
    press(box, 'ArrowUp')
    await shows(box, 'second ask', 'History 2/2')
    box.setSelectionRange(0, 0)
    press(box, 'ArrowUp')
    await shows(box, 'first ask', 'History 1/2')
    box.setSelectionRange(box.value.length, box.value.length)
    press(box, 'ArrowDown')
    await shows(box, 'second ask', 'History 2/2')
  })

  it('an edit ends browsing and the arrows go back to the caret', async () => {
    const { container } = render(createElement(Harness))
    const box = input(container)
    press(box, 'ArrowUp')
    await shows(box, 'second ask', 'History 2/2')
    fireEvent.change(box, { target: { value: 'second ask!' } })
    await waitFor(() => expect(screen.queryByTestId('composer-history-label')).toBeNull())
    press(box, 'ArrowUp')
    await waitFor(() => expect(box.value).toBe('second ask!'))
  })

  it('a recalled slash command keeps the command popover shut, so ArrowUp steps on', async () => {
    const { container } = render(createElement(Harness, { messages: SLASH_LAST }))
    const box = input(container)
    press(box, 'ArrowUp')
    await shows(box, '/compact', 'History 3/3')
    expect(container.querySelector('.aui-slash-popover')).toBeNull()
    press(box, 'ArrowUp')
    await shows(box, 'second ask', 'History 2/3')
  })

  it('a modifier key never opens history', () => {
    const { container } = render(createElement(Harness))
    const box = input(container)
    act(() => {
      fireEvent.keyDown(box, { key: 'ArrowUp', shiftKey: true })
    })
    expect(box.value).toBe('')
    expect(screen.queryByTestId('composer-history-label')).toBeNull()
  })
})
