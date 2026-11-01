// @vitest-environment happy-dom
import { createElement, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'

import { composerSendText, createPassageDraftStore, type PassageDraftStore } from '../browser/webview/capturedPassages'
import {
  COMPOSER_DRAFT_DEBOUNCE_MS,
  useComposerDraftSync,
  withPassageDraft,
  type ComposerDraftRuntime,
} from '../browser/webview/useComposerDraftSync'
import { ComposerPassagesProvider, ComposerPassageStrip, useComposerPassages } from '../components/assistant-ui/composer-passages'
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import { I18nProvider } from '../browser/webview/i18n'
import { Composer, SnapshotNeedsAnswerProvider } from '../components/assistant-ui/thread'
import { TooltipProvider } from '../components/ui/tooltip'

/**
 * The composer's quote cards (F-22): a card is a text-only blockquote with a
 * short excerpt; it opens a preview of the whole body and closes back to the
 * card; remove (button or Delete) drops only that card and moves focus on; a
 * refusal says why; and the saved draft carries the cards, restoring them
 * without counting as an edit.
 */

afterEach(() => cleanup())

let captureFrom: ReturnType<typeof useComposerPassages> = null
function CaptureProbe() {
  captureFrom = useComposerPassages()
  return null
}

const renderStrip = (store: PassageDraftStore) =>
  render(
    createElement(
      ComposerPassagesProvider,
      { store },
      createElement('textarea', { 'data-testid': 'composer-input' }),
      createElement(ComposerPassageStrip),
      createElement(CaptureProbe),
    ),
  )

const add = (store: PassageDraftStore, body: string) => store.add({ body, method: 'range', anchors: [] })

describe('quote cards', () => {
  it('shows each card as a text excerpt, never markup or an image', () => {
    const store = createPassageDraftStore()
    add(store, '<img src=x onerror=alert(1)> **bold**\n\nnext   line')
    renderStrip(store)
    const tile = screen.getByTestId('passage-tile')
    const quote = tile.querySelector('blockquote')!
    expect(quote.textContent).toBe('<img src=x onerror=alert(1)> **bold** next line')
    expect(tile.querySelector('img, canvas, svg image')).toBeNull()
    expect(tile.querySelectorAll('button button')).toHaveLength(0)
  })

  it('opens the whole body with its line breaks and count, and closes back to the card', () => {
    const store = createPassageDraftStore()
    const body = `first line\n${'x'.repeat(400)}`
    add(store, body)
    renderStrip(store)
    fireEvent.click(screen.getByTestId('passage-tile').querySelector('[data-passage-open]')!)
    expect(screen.getByTestId('passage-inspector-body').textContent).toBe(body)
    expect(screen.getByTestId('passage-character-count').textContent).toContain(String(body.length))
    fireEvent.click(screen.getByTestId('passage-inspector-close'))
    expect(screen.queryByTestId('passage-inspector')).toBeNull()
    expect(store.getPassages()).toHaveLength(1)
  })

  it('removes only the card asked, by button or Delete, and announces it', async () => {
    const store = createPassageDraftStore()
    add(store, 'same text')
    add(store, 'same text')
    renderStrip(store)
    const [first, second] = store.getPassages()
    fireEvent.click(screen.getAllByTestId('passage-remove')[0]!)
    expect(store.getPassages().map(p => p.passageKey)).toEqual([second!.passageKey])
    expect(first).toBeDefined()
    expect(screen.getByTestId('passage-live-region').textContent).toBe('Excerpt removed')
    const open = screen.getByTestId('passage-tile').querySelector<HTMLElement>('[data-passage-open]')!
    open.focus()
    fireEvent.keyDown(open, { key: 'Delete' })
    expect(store.getPassages()).toHaveLength(0)
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.activeElement?.getAttribute('data-testid')).toBe('composer-input')
  })

  it('a capture adds, announces and focuses the composer; a refusal changes nothing and says why', () => {
    const store = createPassageDraftStore()
    renderStrip(store)
    act(() => {
      expect(captureFrom!.capture({ body: 'quoted', method: 'range', anchors: [] })).toBe(true)
    })
    expect(store.getPassages()).toHaveLength(1)
    expect(screen.getByTestId('passage-live-region').textContent).toBe('Excerpt added')
    expect(document.activeElement?.getAttribute('data-testid')).toBe('composer-input')
    act(() => {
      expect(captureFrom!.capture({ body: 'a'.repeat(100_001), method: 'range', anchors: [] })).toBe(false)
    })
    expect(store.getPassages()).toHaveLength(1)
    expect(screen.getByTestId('passage-refusal').textContent).toContain('too long')
  })
})

describe('the provider', () => {
  it('never remounts the thread beneath it when the store comes or goes', () => {
    let mounts = 0
    function Child() {
      useEffect(() => {
        mounts++
      }, [])
      captureFrom = useComposerPassages()
      return null
    }
    const store = createPassageDraftStore()
    const view = render(createElement(ComposerPassagesProvider, { store }, createElement(Child)))
    expect(captureFrom?.store).toBe(store)
    view.rerender(createElement(ComposerPassagesProvider, { store: null }, createElement(Child)))
    expect(captureFrom).toBeNull()
    view.rerender(createElement(ComposerPassagesProvider, { store }, createElement(Child)))
    expect(mounts).toBe(1)
  })
})

describe('every composer submit carries the cards', () => {
  function Harness({ store, sent }: { store: PassageDraftStore; sent: string[][] }) {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [],
      convertMessage: m => m,
      isRunning: false,
      onNew: async message => {
        sent.push(store.takeForSend(composerSendText(message.content)).map(p => p.payload.body))
      },
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
            SnapshotNeedsAnswerProvider,
            { value: true },
            createElement(ComposerPassagesProvider, { store }, createElement(Composer)),
          ),
        ),
      ),
    )
  }

  it('an Enter during a plan-approval halt sends the cards with the words', async () => {
    const store = createPassageDraftStore()
    add(store, 'claim')
    const sent: string[][] = []
    const { container } = render(createElement(Harness, { store, sent }))
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!
    fireEvent.change(input, { target: { value: 'why?' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
      await Promise.resolve()
    })
    expect(sent).toEqual([['claim']])
    expect(store.getPassages()).toHaveLength(0)
  })
})

describe('the saved draft carries the cards', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function createComposer(): ComposerDraftRuntime {
    let text = ''
    const listeners = new Set<() => void>()
    return {
      getState: () => ({ text }),
      setText: next => {
        text = next
        for (const listener of [...listeners]) listener()
      },
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
  }

  it('saves cards and words in the wire form after the debounce', () => {
    const composer = createComposer()
    const store = createPassageDraftStore()
    const onEdit = vi.fn()
    renderHook(() => useComposerDraftSync(withPassageDraft(composer, store), undefined, onEdit))
    add(store, 'claim')
    composer.setText('why?')
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS * 2)
    expect(onEdit).toHaveBeenLastCalledWith('[Quoted context 1]\n> claim\n\n[User message]\nwhy?', expect.any(Number))
  })

  it('restores a saved draft into cards plus words without reporting an edit', () => {
    const composer = createComposer()
    const store = createPassageDraftStore()
    const onEdit = vi.fn()
    const draft = withPassageDraft(composer, store)
    renderHook(() =>
      useComposerDraftSync(draft, '[Quoted context 1]\n> a\n\n[Quoted context 2]\n> b\n\n[User message]\nwhy?', onEdit),
    )
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS * 2)
    expect(store.getPassages().map(p => p.payload.body)).toEqual(['a', 'b'])
    expect(composer.getState().text).toBe('why?')
    expect(onEdit).not.toHaveBeenCalled()
  })
})
