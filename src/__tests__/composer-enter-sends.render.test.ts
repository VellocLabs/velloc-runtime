// @vitest-environment happy-dom
/**
 * The composer's `enterSends` parameter (F-24): true (the default) sends on a
 * plain Enter; false leaves Enter to the text box (a newline) so only the Send
 * button sends. A key pressed during IME composition never sends.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import { I18nProvider } from '../browser/webview/i18n'
import { createPassageDraftStore } from '../browser/webview/capturedPassages'
import { ComposerPassagesProvider } from '../components/assistant-ui/composer-passages'
import { Composer } from '../components/assistant-ui/thread'
import { TooltipProvider } from '../components/ui/tooltip'

afterEach(() => cleanup())

const MESSAGES: ThreadMessageLike[] = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first ask' }] },
  { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
]

function Harness(props: { onNew: () => Promise<void>; enterSends?: boolean; isRunning?: boolean }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: MESSAGES,
    convertMessage: m => m,
    isRunning: props.isRunning ?? false,
    onNew: props.onNew,
  })
  const composerProps = props.enterSends === undefined ? null : { enterSends: props.enterSends }
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
          ComposerPassagesProvider,
          { store: createPassageDraftStore() },
          createElement(Composer, composerProps),
        ),
      ),
    ),
  )
}

const input = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!

async function typeInto(box: HTMLTextAreaElement, text: string) {
  act(() => {
    fireEvent.change(box, { target: { value: text } })
  })
  await waitFor(() => expect(box.value).toBe(text))
}

/** Presses Enter; returns false when a handler claimed the key (preventDefault). */
function pressEnter(box: HTMLTextAreaElement, init: { isComposing?: boolean } = {}): boolean {
  let notClaimed = true
  act(() => {
    notClaimed = fireEvent.keyDown(box, { key: 'Enter', ...init })
  })
  return notClaimed
}

describe('composer enterSends', () => {
  it('sends on a plain Enter by default', async () => {
    const onNew = vi.fn(async () => {})
    const { container } = render(createElement(Harness, { onNew }))
    const box = input(container)
    await typeInto(box, 'hello')
    expect(pressEnter(box)).toBe(false)
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1))
  })

  it('sends on a plain Enter when true', async () => {
    const onNew = vi.fn(async () => {})
    const { container } = render(createElement(Harness, { onNew, enterSends: true }))
    const box = input(container)
    await typeInto(box, 'hello')
    pressEnter(box)
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1))
  })

  it('leaves a plain Enter to the text box when false; the Send button still sends', async () => {
    const onNew = vi.fn(async () => {})
    const { container } = render(createElement(Harness, { onNew, enterSends: false }))
    const box = input(container)
    await typeInto(box, 'line one')
    expect(pressEnter(box)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(onNew).not.toHaveBeenCalled()
    expect(box.value).toBe('line one')

    const send = container.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!
    act(() => {
      fireEvent.click(send)
    })
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1))
  })

  it('does not add to a running turn on a plain Enter when false', async () => {
    const onNew = vi.fn(async () => {})
    const { container } = render(createElement(Harness, { onNew, enterSends: false, isRunning: true }))
    const box = input(container)
    await typeInto(box, 'more context')
    expect(pressEnter(box)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(onNew).not.toHaveBeenCalled()
    expect(box.value).toBe('more context')
  })

  it('sends on Ctrl/Cmd+Enter when false, which the shortcut list still offers', async () => {
    const onNew = vi.fn(async () => {})
    const { container } = render(createElement(Harness, { onNew, enterSends: false }))
    const box = input(container)
    await typeInto(box, 'hello')
    act(() => {
      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    })
    await waitFor(() => expect(onNew).toHaveBeenCalledTimes(1))
  })

  it('teaches Enter as a send key by default', async () => {
    const onNew = vi.fn(async () => {})
    const { container } = render(createElement(Harness, { onNew }))
    await typeInto(input(container), 'hello')
    expect(container.textContent).toContain('Enter to send')
    expect(container.textContent).not.toContain('Enter starts a new line')
  })

  it('teaches the Send button instead of Enter when false', async () => {
    const onNew = vi.fn(async () => {})
    const { container } = render(createElement(Harness, { onNew, enterSends: false }))
    await typeInto(input(container), 'hello')
    expect(container.textContent).toContain('Enter starts a new line')
    expect(container.textContent).not.toContain('Enter to send')
  })

  it.each([true, false])('never sends during IME composition (enterSends %s)', async enterSends => {
    const onNew = vi.fn(async () => {})
    const { container } = render(createElement(Harness, { onNew, enterSends }))
    const box = input(container)
    await typeInto(box, 'にほんご')
    expect(pressEnter(box, { isComposing: true })).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(onNew).not.toHaveBeenCalled()
  })
})
