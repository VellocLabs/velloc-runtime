// @vitest-environment happy-dom
/**
 * An app's local actions (F-40), page half: a press on one of the app's own
 * surfaces that the manifest names local is offered to the app's background
 * module (`mods.appAction`) and goes to the model only when the module did
 * not take it; any other press goes to the model as before, and none while
 * a turn runs. Also the board's `act`.
 */
import { createElement as h, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'

import { A2uiProviderHost } from '../browser/webview/a2ui/A2uiProviderHost'
import { A2uiInlineSurface } from '../browser/webview/a2ui/A2uiInlineSurface'
import { setActionsSlot, setOwner, setShownSession, setSlot } from '../browser/webview/a2ui/a2uiPaneBus'
import { useAppBoard } from '../browser/webview/apps/appSurfaceView'
import { setModContributions } from '../browser/webview/mods/modContributionsView'
import { EMPTY_MOD_CONTRIBUTIONS } from '../browser/runtimeProtocol/modContributions'
import type { AppSurfaceState, ModsAppActionResult } from '../browser/runtimeProtocol/modApps'
import type { Message } from '../runtime/RuntimeTypes'

afterEach(() => {
  cleanup()
  setSlot(null, null)
  setActionsSlot(null)
  setOwner(null)
  setShownSession(null)
  act(() => setModContributions(EMPTY_MOD_CONTRIBUTIONS))
})

const BODY = [
  'surface("dashboard")',
  'root = Column([refresh, open])',
  'refresh = Button(Text("Refresh"), action=Event("refresh"))',
  'open = Button(Text("Work this case"), action=Event("open_case", {id: 7}))',
].join('\n')

const state = (localActions?: string[]): AppSurfaceState => ({
  appId: 'pay-board',
  surface: { body: BODY, hash: 'h1', surfaceIds: ['dashboard'] },
  data: { total: 1 },
  refreshing: false,
  ...(localActions ? { localActions } : {}),
})

/** A chat-drawn surface with a "refresh" button of its own, not the app's. */
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
              { id: 'root', component: 'Button', child: 'label', action: { event: { name: 'refresh' } } },
              { id: 'label', component: 'Text', text: 'Chat refresh' },
            ],
            dataModel: {},
          },
        },
      ],
    },
  },
] as unknown as Message[]

function rig(
  board: AppSurfaceState | null,
  options: { busy?: boolean; messages?: Message[]; children?: ReactNode; act?: (action: string, context: unknown) => Promise<ModsAppActionResult | undefined> } = {},
) {
  const slot = document.createElement('div')
  document.body.appendChild(slot)
  setSlot(slot, 's1')
  const submit = vi.fn(async (_prompt: string) => undefined)
  const actFn = vi.fn(options.act ?? (async () => ({ handled: true })))
  const appBoard = { state: board, reload: async () => undefined, act: actFn }
  const view = render(
    h(A2uiProviderHost, { sessionId: 's1', messages: options.messages ?? [], busy: options.busy ?? false, submitActionMessage: submit, appBoard, children: options.children ?? null }),
  )
  const button = (text: string) => [...slot.querySelectorAll('button')].find(el => el.textContent?.includes(text))!
  return { slot, submit, actFn, view, button }
}

describe('a press on the app\'s surface', () => {
  it('a local action goes to the module and not to the model when the module takes it', async () => {
    const { submit, actFn, button } = rig(state(['refresh']))
    await waitFor(() => expect(button('Refresh')).toBeDefined())
    fireEvent.click(button('Refresh'))
    await waitFor(() => expect(actFn).toHaveBeenCalledTimes(1))
    expect(actFn.mock.calls[0]![0]).toBe('refresh')
    await act(async () => undefined)
    expect(submit).not.toHaveBeenCalled()
  })

  it('a local action the module declines, or that fails, goes to the model as a turn with the action and the data', async () => {
    const answers: Array<() => Promise<ModsAppActionResult | undefined>> = [async () => ({ handled: false }), async () => undefined, () => Promise.reject(new Error('no runtime'))]
    const { submit, actFn, button } = rig(state(['refresh']), { act: () => answers.shift()!() })
    await waitFor(() => expect(button('Refresh')).toBeDefined())
    for (let i = 1; i <= 3; i += 1) {
      fireEvent.click(button('Refresh'))
      await waitFor(() => expect(submit).toHaveBeenCalledTimes(i))
    }
    expect(actFn).toHaveBeenCalledTimes(3)
    const turn = submit.mock.calls[0]![0] as unknown as string
    expect(turn).toContain('"action":"refresh"')
    expect(turn).toContain('"surfaceId":"dashboard"')
    expect(turn).toContain('"total":1')
  })

  it('an action the manifest does not name goes to the model at once, with its context; so does one with no local actions at all', async () => {
    const { submit, actFn, button } = rig(state(['refresh']))
    await waitFor(() => expect(button('Work this case')).toBeDefined())
    fireEvent.click(button('Work this case'))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(actFn).not.toHaveBeenCalled()
    expect(submit.mock.calls[0]![0] as unknown as string).toContain('"action":"open_case"')
    expect(submit.mock.calls[0]![0] as unknown as string).toContain('"context":{"id":7}')
    cleanup()
    const plain = rig(state())
    await waitFor(() => expect(plain.button('Refresh')).toBeDefined())
    fireEvent.click(plain.button('Refresh'))
    await waitFor(() => expect(plain.submit).toHaveBeenCalledTimes(1))
    expect(plain.actFn).not.toHaveBeenCalled()
  })

  it('a chat surface\'s action of the same name is the model\'s, not the module\'s', async () => {
    setShownSession('s1')
    const { submit, actFn, view, button } = rig(state(['refresh']), { messages: chatTranscript, children: h(A2uiInlineSurface, { surfaceId: 'chart', mentionKey: 'tc-chat' }) })
    // The chat surface lives in the pane: its card opens it there, over the app's tab.
    await waitFor(() => expect(view.container.querySelector<HTMLButtonElement>('[data-slot="a2ui-open-in-panel"]')?.disabled).toBe(false))
    fireEvent.click(view.container.querySelector('[data-slot="a2ui-open-in-panel"]')!)
    await waitFor(() => expect(button('Chat refresh')).toBeDefined())
    fireEvent.click(button('Chat refresh'))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(actFn).not.toHaveBeenCalled()
  })

  it('while a turn runs no action goes anywhere', async () => {
    const { submit, actFn, button } = rig(state(['refresh']), { busy: true })
    await waitFor(() => expect(button('Refresh')).toBeDefined())
    fireEvent.click(button('Refresh'))
    fireEvent.click(button('Work this case'))
    await act(async () => undefined)
    expect(actFn).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('while the module has a local action in hand, further presses go nowhere; after its answer they go again', async () => {
    let answer!: (result: ModsAppActionResult) => void
    const { submit, actFn, button } = rig(state(['refresh']), { act: () => new Promise(resolve => { answer = resolve }) })
    await waitFor(() => expect(button('Refresh')).toBeDefined())
    fireEvent.click(button('Refresh'))
    fireEvent.click(button('Refresh'))
    fireEvent.click(button('Work this case'))
    await act(async () => undefined)
    expect(actFn).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
    await act(async () => answer({ handled: true }))
    fireEvent.click(button('Refresh'))
    await waitFor(() => expect(actFn).toHaveBeenCalledTimes(2))
  })
})

describe('the board\'s act', () => {
  it('sends mods.appAction for the session with the action and its context', async () => {
    act(() =>
      setModContributions({
        ...EMPTY_MOD_CONTRIBUTIONS,
        apps: [{ type: 'pay:board', appId: 'pay-board', plugin: 'pay', title: 'Payments' }],
      }),
    )
    const request = vi.fn(async () => ({ handled: true }))
    const connection = { subscribe: vi.fn(() => () => undefined), request } as never
    const { result } = renderHook(() => useAppBoard(async () => connection, 's1', 'pay:board'))
    await waitFor(() => expect(result.current).toBeDefined())
    await expect(result.current!.act('open_case', { id: 7 })).resolves.toEqual({ handled: true })
    await expect(result.current!.act('refresh', undefined)).resolves.toEqual({ handled: true })
    expect(request.mock.calls.map(call => call as unknown[])).toEqual([
      ['mods.appAction', { sessionId: 's1', action: 'open_case', context: { id: 7 } }],
      ['mods.appAction', { sessionId: 's1', action: 'refresh' }],
    ])
  })
})
