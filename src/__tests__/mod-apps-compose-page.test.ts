// @vitest-environment happy-dom
/**
 * The reserved `compose` event of an app's own surfaces (F-40): a press puts
 * the event's text in the session's composer, restores an expanded pane and
 * focuses that session's composer; it sends nothing and calls no module. A
 * compose without text is ignored, and a chat surface's `compose` goes to the
 * model as any other action.
 */
import { createElement as h, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime, type ThreadMessage } from '@assistant-ui/react'

import { A2uiProviderHost } from '../browser/webview/a2ui/A2uiProviderHost'
import { A2uiInlineSurface } from '../browser/webview/a2ui/A2uiInlineSurface'
import {
  onPaneRequest,
  setActionsSlot,
  setOwner,
  setShownSession,
  setSlot,
  type A2uiPaneRequest,
} from '../browser/webview/a2ui/a2uiPaneBus'
import { APP_COMPOSE_MAX_CHARS, APP_COMPOSE_QUOTE_MAX_CHARS, composeDraftOf, composeQuoteOf } from '../browser/webview/apps/appCompose'
import { createPassageDraftStore, type PassageDraftStore } from '../browser/webview/capturedPassages'
import { ComposerPassagesProvider } from '../components/assistant-ui/composer-passages'
import type { AppSurfaceState } from '../browser/runtimeProtocol/modApps'
import type { Message } from '../runtime/RuntimeTypes'

const releases: Array<() => void> = []
afterEach(() => {
  cleanup()
  for (const release of releases.splice(0)) release()
  setSlot(null, null)
  setActionsSlot(null)
  setOwner(null)
  setShownSession(null)
})

const BODY = [
  'surface("dashboard")',
  'root = Column([draft, empty, wrong, blank, work, quoted, quoteOnly])',
  'draft = Button(Text("Draft reply"), action=Event("compose", {text: "  Refund order 42 in full.  "}))',
  'empty = Button(Text("No context"), action=Event("compose"))',
  'wrong = Button(Text("Number text"), action=Event("compose", {text: 5}))',
  'blank = Button(Text("Blank text"), action=Event("compose", {text: "   "}))',
  'work = Button(Text("Work this case"), action=Event("open_case", {id: 7}))',
  'quoted = Button(Text("Discuss case"), action=Event("compose", {text: "Why refund?", quote: "  Verdict: refund the second charge.  "}))',
  'quoteOnly = Button(Text("Quote only"), action=Event("compose", {quote: "Verdict: contest it."}))',
].join('\n')

const board = (localActions?: string[]): AppSurfaceState => ({
  appId: 'pay-board',
  surface: { body: BODY, hash: 'h1', surfaceIds: ['dashboard'] },
  data: {},
  refreshing: false,
  ...(localActions ? { localActions } : {}),
})

/** A chat-drawn surface whose button sends an event named `compose`. */
const chatTranscript = [
  {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tc-chat',
          toolName: 'a2ui_create_surface',
          args: {
            surfaceId: 'chart',
            root: 'root',
            components: [
              { id: 'root', component: 'Button', child: 'label', action: { event: { name: 'compose', context: { text: 'from chat' } } } },
              { id: 'label', component: 'Text', text: 'Chat compose' },
            ],
            dataModel: {},
          },
        },
      ],
    },
  },
] as unknown as Message[]

/** A thread runtime and its composer, inside the session's thread root. */
function Runtime({
  sessionId,
  disabled,
  passages,
  children,
}: {
  sessionId: string
  disabled: boolean
  passages: PassageDraftStore
  children?: ReactNode
}) {
  const runtime = useExternalStoreRuntime({ messages: [] as ThreadMessage[], onNew: async () => undefined })
  return h(
    AssistantRuntimeProvider,
    { runtime },
    h(
      ComposerPassagesProvider,
      { store: passages },
      h(
        'div',
        { className: 'aui-thread-root', 'data-thread-session': sessionId },
        h(ComposerPrimitive.Root, null, h(ComposerPrimitive.Input, { 'data-testid': 'composer-input', disabled } as never)),
        children,
      ),
    ),
  )
}

function rig(
  state: AppSurfaceState | null,
  options: { busy?: boolean; disabled?: boolean; messages?: Message[]; children?: ReactNode } = {},
) {
  // Another session's composer comes first in the document.
  const other = document.createElement('div')
  other.className = 'aui-thread-root'
  other.dataset.threadSession = 's0'
  other.innerHTML = '<textarea data-testid="composer-input"></textarea>'
  document.body.appendChild(other)
  releases.push(() => other.remove())
  const slot = document.createElement('div')
  document.body.appendChild(slot)
  releases.push(() => slot.remove())
  setSlot(slot, 's1')
  const requests: A2uiPaneRequest[] = []
  releases.push(onPaneRequest(request => requests.push(request)))
  const submit = vi.fn(async (_prompt: string) => undefined)
  const actFn = vi.fn(async () => ({ handled: true }))
  const appBoard = { state, reload: async () => undefined, act: actFn }
  const passages = createPassageDraftStore()
  const view = render(
    h(
      Runtime,
      { sessionId: 's1', disabled: options.disabled ?? false, passages },
      h(A2uiProviderHost, {
        sessionId: 's1',
        messages: options.messages ?? [],
        busy: options.busy ?? false,
        submitActionMessage: submit,
        appBoard,
        children: options.children ?? null,
      }),
    ),
  )
  const input = () => view.container.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!
  const button = (text: string) => [...slot.querySelectorAll('button')].find(el => el.textContent?.includes(text))!
  const type = (text: string) => fireEvent.change(input(), { target: { value: text } })
  return { submit, actFn, requests, input, button, type, passages }
}

describe('compose on an app surface', () => {
  it('replaces the composer text, restores the pane and focuses this session\'s composer, sending nothing', async () => {
    const { submit, actFn, requests, input, button, type } = rig(board())
    await waitFor(() => expect(button('Draft reply')).toBeDefined())
    type('an old draft')
    expect(input().value).toBe('an old draft')
    fireEvent.click(button('Draft reply'))
    await waitFor(() => expect(input().value).toBe('Refund order 42 in full.'))
    expect(requests).toContainEqual({ sessionId: 's1', restore: true })
    await waitFor(() => expect(document.activeElement).toBe(input()))
    expect(input().selectionStart).toBe(input().value.length)
    await act(async () => undefined)
    expect(submit).not.toHaveBeenCalled()
    expect(actFn).not.toHaveBeenCalled()
  })

  it('is not offered to the module even when the manifest lists it, and works while a turn runs', async () => {
    const { submit, actFn, input, button } = rig(board(['compose']), { busy: true })
    await waitFor(() => expect(button('Draft reply')).toBeDefined())
    fireEvent.click(button('Draft reply'))
    await waitFor(() => expect(input().value).toBe('Refund order 42 in full.'))
    await act(async () => undefined)
    expect(actFn).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('replaces the quote cards with the draft too', async () => {
    const { input, button, passages } = rig(board())
    await waitFor(() => expect(button('Draft reply')).toBeDefined())
    act(() => {
      passages.add({ body: 'a quoted passage from earlier', method: 'range', anchors: [] })
    })
    expect(passages.getPassages()).toHaveLength(1)
    fireEvent.click(button('Draft reply'))
    await waitFor(() => expect(input().value).toBe('Refund order 42 in full.'))
    expect(passages.getPassages()).toEqual([])
  })

  it('puts a quote as the one quote card of the draft, replacing earlier cards, with the text below it', async () => {
    const { submit, input, button, passages } = rig(board())
    await waitFor(() => expect(button('Discuss case')).toBeDefined())
    act(() => {
      passages.add({ body: 'a quoted passage from earlier', method: 'range', anchors: [] })
    })
    fireEvent.click(button('Discuss case'))
    await waitFor(() => expect(input().value).toBe('Why refund?'))
    expect(passages.getPassages().map(passage => passage.payload.body)).toEqual(['Verdict: refund the second charge.'])
    await act(async () => undefined)
    expect(submit).not.toHaveBeenCalled()
  })

  it('takes a quote without text: the card shows and the composer is left empty and focused', async () => {
    const { requests, input, button, type, passages } = rig(board())
    await waitFor(() => expect(button('Quote only')).toBeDefined())
    type('an old draft')
    fireEvent.click(button('Quote only'))
    await waitFor(() => expect(passages.getPassages().map(passage => passage.payload.body)).toEqual(['Verdict: contest it.']))
    expect(input().value).toBe('')
    expect(requests).toContainEqual({ sessionId: 's1', restore: true })
    await waitFor(() => expect(document.activeElement).toBe(input()))
  })

  it('is ignored while the composer is disabled: the draft stays and the pane is not restored', async () => {
    const { submit, requests, input, button, passages } = rig(board(), { disabled: true })
    await waitFor(() => expect(button('Draft reply')).toBeDefined())
    fireEvent.change(input(), { target: { value: 'half typed' } })
    act(() => {
      passages.add({ body: 'a quoted passage from earlier', method: 'range', anchors: [] })
    })
    fireEvent.click(button('Draft reply'))
    await act(async () => undefined)
    expect(input().value).toBe('half typed')
    expect(passages.getPassages()).toHaveLength(1)
    expect(requests.filter(request => 'restore' in request)).toEqual([])
    expect(submit).not.toHaveBeenCalled()
  })

  it('is ignored without a non-empty string text: nothing changes and nothing is sent', async () => {
    const { submit, actFn, requests, input, button, type } = rig(board())
    await waitFor(() => expect(button('No context')).toBeDefined())
    type('kept')
    for (const label of ['No context', 'Number text', 'Blank text']) fireEvent.click(button(label))
    await act(async () => undefined)
    expect(input().value).toBe('kept')
    expect(requests.filter(request => 'restore' in request)).toEqual([])
    expect(submit).not.toHaveBeenCalled()
    expect(actFn).not.toHaveBeenCalled()
  })

  it('leaves other events on the app surface as they were', async () => {
    const { submit, input, button } = rig(board())
    await waitFor(() => expect(button('Work this case')).toBeDefined())
    fireEvent.click(button('Work this case'))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(submit.mock.calls[0]![0] as unknown as string).toContain('"action":"open_case"')
    expect(input().value).toBe('')
  })
})

describe('compose on a chat surface', () => {
  it('goes to the model as any other action and leaves the composer alone', async () => {
    setShownSession('s1')
    const { submit, requests, input, button } = rig(board(), {
      messages: chatTranscript,
      children: h(A2uiInlineSurface, { surfaceId: 'chart', mentionKey: 'tc-chat' }),
    })
    const open = () => document.querySelector<HTMLButtonElement>('[data-slot="a2ui-open-in-panel"]')
    await waitFor(() => expect(open()?.disabled).toBe(false))
    fireEvent.click(open()!)
    await waitFor(() => expect(button('Chat compose')).toBeDefined())
    fireEvent.click(button('Chat compose'))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(submit.mock.calls[0]![0] as unknown as string).toContain('"action":"compose"')
    expect(input().value).toBe('')
    expect(requests.filter(request => 'restore' in request)).toEqual([])
  })
})

describe('composeQuoteOf', () => {
  it('trims and caps the quote, and refuses anything but a non-blank string', () => {
    expect(composeQuoteOf({ quote: '  **Verdict**\n- why \n' })).toBe('**Verdict**\n- why')
    expect(composeQuoteOf({ quote: 'x'.repeat(APP_COMPOSE_QUOTE_MAX_CHARS + 9) })).toHaveLength(APP_COMPOSE_QUOTE_MAX_CHARS)
    for (const context of [null, { text: 'only text' }, { quote: 5 }, { quote: '  ' }]) {
      expect(composeQuoteOf(context)).toBeNull()
    }
  })
})

describe('composeDraftOf', () => {
  it('trims, caps at the limit without splitting a surrogate pair, and refuses anything but text', () => {
    expect(composeDraftOf({ text: '  hi \n' })).toBe('hi')
    expect(composeDraftOf({ text: 'x'.repeat(APP_COMPOSE_MAX_CHARS + 50) })).toHaveLength(APP_COMPOSE_MAX_CHARS)
    const cut = composeDraftOf({ text: 'x'.repeat(APP_COMPOSE_MAX_CHARS - 1) + '😀' })!
    expect(cut).toHaveLength(APP_COMPOSE_MAX_CHARS - 1)
    for (const context of [null, undefined, 'text', {}, { text: 5 }, { text: ' \t ' }]) {
      expect(composeDraftOf(context)).toBeNull()
    }
  })
})
