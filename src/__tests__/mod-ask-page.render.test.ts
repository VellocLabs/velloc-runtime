// @vitest-environment happy-dom
/**
 * The page's half of `$.ui.ask` (F-25): the client store takes questions off each `state` delta; the card above the
 * prompt draws them and answers with `mods.askAnswer` (a label, the comma-joined labels, "Other" text, or a
 * dismissal), offered only where it may. The runtime's half is `mod-ui-ask`.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { holdModsUiView, modsUiActions, type ModsUiView } from '../browser/webview/mods/modsUiView'
import { ModAsks, modAskAnswerOf } from '../components/assistant-ui/mod-ui'
import { FOOTER_BAR_FRAME } from '../components/assistant-ui/footer-bar-frame'
import { TooltipProvider } from '../components/ui/tooltip'
import {
  EMPTY_MOD_UI,
  ModUiContext,
  type ModUiAskRow,
  type ModUiContextValue,
} from '../components/assistant-ui/mod-ui-context'

afterEach(() => cleanup())

type Handler = (event: { type?: string; payload: unknown }) => void

function fakeConnection(canAnswer = true) {
  const handlers = new Map<string, Handler>()
  const requests: Array<{ route: string; payload: unknown }> = []
  const connection = {
    subscribe: (topic: string, handler: Handler) => {
      handlers.set(topic, handler)
      return () => handlers.delete(topic)
    },
    request: async (route: string, payload: unknown) => {
      requests.push({ route, payload })
      return {}
    },
    can: (_cap: string, act: string) => act !== 'askAnswer' || canAnswer,
  } as unknown as RuntimeConnection
  return { connection, requests, emit: (topic: string, type: string, payload: unknown) => handlers.get(topic)?.({ type, payload }) }
}

const ASK: ModUiAskRow = {
  requestId: 'a1',
  plugin: 'careful',
  question: 'How careful?',
  header: 'Mode',
  options: [{ label: 'Bold' }, { label: 'Careful' }],
  multiSelect: false,
}

function withUi(value: Partial<ModUiContextValue>) {
  return createElement(ModUiContext.Provider, { value: { ...EMPTY_MOD_UI, ...value } }, createElement(ModAsks))
}

describe('the client store and the action', () => {
  it("a state delta's questions reach the view, and none clears them; the answer is mods.askAnswer", async () => {
    const { connection, requests, emit } = fakeConnection()
    const views: ModsUiView[] = []
    const release = holdModsUiView(connection, 's1', view => views.push(view))
    emit('mods/ui/s1', 'state', { status: [], notices: [], asks: [ASK] })
    expect(views.at(-1)!.asks).toEqual([ASK])
    emit('mods/ui/s1', 'state', { status: [], notices: [] })
    expect(views.at(-1)!.asks).toEqual([])
    const { answerAsk } = modsUiActions(connection, 's1')
    await answerAsk!({ requestId: 'a1', answer: 'Bold' })
    await answerAsk!({ requestId: 'a1', dismissed: true })
    expect(requests).toEqual([
      { route: 'mods.askAnswer', payload: { sessionId: 's1', requestId: 'a1', answer: 'Bold' } },
      { route: 'mods.askAnswer', payload: { sessionId: 's1', requestId: 'a1', dismissed: true } },
    ])
    release()
  })

  it('a connection that may not answer is not offered the action', () => {
    const { connection } = fakeConnection(false)
    expect(modsUiActions(connection, 's1').answerAsk).toBeUndefined()
  })
})

describe('the answer, from what the person picked', () => {
  it('one label; the typed text under Other; several labels in the order offered, the text last', () => {
    expect(modAskAnswerOf(ASK, new Set(), null)).toBeNull()
    expect(modAskAnswerOf(ASK, new Set(['Careful']), null)).toBe('Careful')
    expect(modAskAnswerOf(ASK, new Set(), '  slowly ')).toBe('slowly')
    expect(modAskAnswerOf(ASK, new Set(), '  ')).toBeNull()
    const multi = { ...ASK, multiSelect: true }
    expect(modAskAnswerOf(multi, new Set(['Careful', 'Bold']), null)).toBe('Bold, Careful')
    expect(modAskAnswerOf(multi, new Set(['Careful']), 'and quiet')).toBe('Careful, and quiet')
  })
})

describe('the card', () => {
  it("draws the mod's question, chip and labels; Submit sends the label once one is picked", () => {
    const answerAsk = vi.fn(async () => {})
    render(withUi({ asks: [ASK], answerAsk }))
    const card = screen.getByTestId('mod-ask-careful')
    expect(card.getAttribute('role')).toBe('dialog')
    expect(card.textContent).toContain('careful')
    expect(card.textContent).toContain('Mode')
    expect(card.textContent).toContain('How careful?')
    const submit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Careful'))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    expect(answerAsk).toHaveBeenCalledWith({ requestId: 'a1', answer: 'Careful' })
  })

  it('the text typed under Other is the answer; Dismiss and Escape dismiss', () => {
    const answerAsk = vi.fn(async () => {})
    render(withUi({ asks: [ASK, { ...ASK, requestId: 'a2', plugin: 'second' }], answerAsk }))
    const first = screen.getByTestId('mod-ask-careful')
    fireEvent.change(first.querySelector('input[type="text"]')!, { target: { value: 'slowly' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Submit' })[0]!)
    expect(answerAsk).toHaveBeenCalledWith({ requestId: 'a1', answer: 'slowly' })
    fireEvent.keyDown(screen.getByTestId('mod-ask-second'), { key: 'Escape' })
    expect(answerAsk).toHaveBeenCalledWith({ requestId: 'a2', dismissed: true })
  })

  it('a padded Yes/No is drawn from the catalog and answers with its label', () => {
    const answerAsk = vi.fn(async () => {})
    render(
      withUi({
        asks: [{ ...ASK, header: undefined, options: [{ label: 'Yes', engine: 'yes' }, { label: 'No', engine: 'no' }] }],
        answerAsk,
      }),
    )
    fireEvent.click(screen.getByLabelText('No'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(answerAsk).toHaveBeenCalledWith({ requestId: 'a1', answer: 'No' })
  })

  it("sits in the plugin frame with the asking plugin's icon, in the corner of the card, opening the plugin in Settings", () => {
    const openPluginSettings = vi.fn()
    // The card runs to several lines: taller than one and a half line heights.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 160 } as DOMRect)
    render(createElement(TooltipProvider, null, withUi({ asks: [ASK], answerAsk: async () => {}, openPluginSettings })))
    rect.mockRestore()
    const card = screen.getByTestId('mod-ask-careful')
    expect(card.getAttribute('data-slot')).toBe('mod-ask')
    expect(card.getAttribute('role')).toBe('dialog')
    expect(card.classList).toContain('group/mod-bar')
    for (const name of FOOTER_BAR_FRAME.split(' ')) expect(card.classList).toContain(name)
    expect(card.getAttribute('data-plugin-icons')).toBe('corner')
    const icons = card.querySelector('[data-slot="mod-plugin-icons"]')!
    expect(icons.parentElement).toBe(card)
    expect([...icons.children].map(icon => icon.getAttribute('data-testid'))).toEqual(['mod-plugin-link-careful'])
    const link = screen.getByTestId('mod-plugin-link-careful')
    expect(link.getAttribute('aria-label')).toBe('Open careful in Plugins & Mods')
    fireEvent.click(link)
    expect(openPluginSettings).toHaveBeenCalledWith('careful')
    // The icon is the plugin's mark, not an answer.
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true)
  })

  it('no opener, no icon: the card is still framed and names its plugin', () => {
    render(withUi({ asks: [ASK], answerAsk: async () => {} }))
    const card = screen.getByTestId('mod-ask-careful')
    expect(card.getAttribute('data-framed')).toBe('true')
    expect(card.querySelector('[data-slot="mod-plugin-icons"]')).toBeNull()
    expect(card.textContent).toContain('careful')
  })

  it('without the action the question is shown, not answerable; with none, nothing is drawn', () => {
    render(withUi({ asks: [ASK] }))
    expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const { container } = render(withUi({}))
    expect(container.querySelector('[data-slot="mod-asks"]')).toBeNull()
  })
})

describe('the dev mods turned-on notice', () => {
  it('a state delta carries it to the view and one without it clears it', () => {
    const { connection, emit } = fakeConnection()
    const views: ModsUiView[] = []
    const release = holdModsUiView(connection, 's1', view => views.push(view))
    const notice = { requestId: 'dev7', plugins: ['band-mod', 'panel-mod'] }
    emit('mods/ui/s1', 'state', { status: [], notices: [], devModsOn: notice })
    expect(views.at(-1)!.devModsOn).toEqual(notice)
    emit('mods/ui/s1', 'state', { status: [], notices: [] })
    expect(views.at(-1)!.devModsOn).toBeUndefined()
    release()
  })

  it('names every plugin it loaded, and dismissing it sends mods.devModsAnswer dismissed', () => {
    const answerDevMods = vi.fn(async () => {})
    render(withUi({ devModsOn: { requestId: 'dev7', plugins: ['band-mod', 'panel-mod'] }, answerDevMods }))
    const notice = screen.getByTestId('mod-dev-on')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('band-mod, panel-mod')
    fireEvent.click(screen.getByTestId('mod-dev-on-dismiss'))
    expect(answerDevMods).toHaveBeenCalledWith('dev7', 'dismissed')
  })

  it('is still shown, without a dismiss button, where the connection may not answer', () => {
    render(withUi({ devModsOn: { requestId: 'dev7', plugins: ['band-mod'] } }))
    expect(screen.getByTestId('mod-dev-on').textContent).toContain('band-mod')
    expect(screen.queryByTestId('mod-dev-on-dismiss')).toBeNull()
  })
})

describe('the dev mods question, for a test run', () => {
  it('asks whether to run the folder\'s tests, and offers run and not now, not the session-long decline', () => {
    const answerDevMods = vi.fn(async () => {})
    render(withUi({ devModsAsk: { requestId: 'dev9', plugins: ['D:/work/demo'], purpose: 'test' }, answerDevMods }))
    const card = screen.getByTestId('mod-dev-ask')
    expect(card.getAttribute('aria-label')).toBe("Run a folder's tests")
    expect(card.getAttribute('data-purpose')).toBe('test')
    expect(card.textContent).toContain('Run the tests in D:/work/demo?')
    expect(screen.queryByTestId('mod-dev-ask-decline')).toBeNull()
    fireEvent.click(screen.getByTestId('mod-dev-ask-on'))
    expect(answerDevMods).toHaveBeenCalledWith('dev9', 'on')
  })

  it('a protocol state with an unknown purpose is not accepted', () => {
    const { connection, emit } = fakeConnection()
    const views: ModsUiView[] = []
    const release = holdModsUiView(connection, 's1', view => views.push(view))
    emit('mods/ui/s1', 'state', { status: [], notices: [], devModsAsk: { requestId: 'dev9', plugins: ['x'], purpose: 'test' } })
    expect(views.at(-1)!.devModsAsk).toMatchObject({ purpose: 'test' })
    const seen = views.length
    emit('mods/ui/s1', 'state', { status: [], notices: [], devModsAsk: { requestId: 'dev9', plugins: ['x'], purpose: 'other' } })
    expect(views.length).toBe(seen)
    release()
  })

  it('the load question keeps its own wording and its decline', () => {
    render(withUi({ devModsAsk: { requestId: 'dev8', plugins: ['panel-mod'] }, answerDevMods: vi.fn(async () => {}) }))
    expect(screen.getByTestId('mod-dev-ask').textContent).toContain('Load the mods the agent wrote for this session: panel-mod?')
    expect(screen.getByTestId('mod-dev-ask-decline')).toBeTruthy()
  })
})
