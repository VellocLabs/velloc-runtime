// @vitest-environment happy-dom
/**
 * The page's half of `$.prompt.read` / `.fill` / `.suggest` (F-25): the client store hands a `composer` request to
 * the composer mounted last, which answers with `mods.composerAnswer` (offered only where it may) from the box as
 * it stands. The runtime's half is `mod-prompt-composer`.
 */
import * as React from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { holdModsUiView, modsComposerControls } from '../browser/webview/mods/modsUiView'
import {
  EMPTY_MOD_UI,
  ModUiContext,
  type ModUiComposerAnswer,
  type ModUiComposerRequest,
  type ModUiContextValue,
} from '../components/assistant-ui/mod-ui-context'
import { answerComposerRequest, useModComposer, type ModComposerRuntime } from '../components/assistant-ui/use-mod-composer'

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
    can: (_cap: string, act: string) => (act !== 'composerAnswer' && act !== 'promptEdit') || canAnswer,
  } as unknown as RuntimeConnection
  return { connection, requests, emit: (topic: string, type: string, payload: unknown) => handlers.get(topic)?.({ type, payload }) }
}

describe('the client store', () => {
  it('a composer request goes to the composer mounted last; none mounted, it is left unanswered', async () => {
    const { connection, requests, emit } = fakeConnection()
    const release = holdModsUiView(connection, 's1', () => {})
    const controls = modsComposerControls(connection, 's1')
    const first: ModUiComposerRequest[] = []
    const second: ModUiComposerRequest[] = []
    emit('mods/ui/s1', 'composer', { requestId: 'c0', op: 'read' })
    const offFirst = controls.onComposerRequest!(request => first.push(request))
    const offSecond = controls.onComposerRequest!(request => second.push(request))
    emit('mods/ui/s1', 'composer', { requestId: 'c1', op: 'suggest', text: 'go' })
    emit('mods/ui/s1', 'composer', { requestId: 'c2', op: 'fill', text: 'x', mode: 'sideways' })
    expect(first).toEqual([])
    expect(second).toEqual([{ requestId: 'c1', op: 'suggest', text: 'go' }])
    offSecond()
    emit('mods/ui/s1', 'composer', { requestId: 'c3', op: 'read' })
    expect(first).toEqual([{ requestId: 'c3', op: 'read' }])
    await controls.answerComposer!({ requestId: 'c3', op: 'read', box: { text: '', cursor: 0 } })
    expect(requests).toEqual([
      { route: 'mods.composerAnswer', payload: { sessionId: 's1', requestId: 'c3', op: 'read', box: { text: '', cursor: 0 } } },
    ])
    offFirst()
    release()
  })

  it('a connection that may not answer is offered neither half', () => {
    const { connection } = fakeConnection(false)
    expect(modsComposerControls(connection, 's1')).toEqual({})
  })
})

describe('the answer, from the box as it stands', () => {
  const box = { text: 'hello', cursor: 2 }
  const idle = { isRunning: false, isBlocked: false }

  it('a read is the box; a fill is written by mode, refused with dialog under a question', () => {
    expect(answerComposerRequest({ requestId: 'r', op: 'read' }, box, idle).answer).toEqual({ requestId: 'r', op: 'read', box })
    const filled = answerComposerRequest({ requestId: 'f', op: 'fill', text: 'XX', mode: 'insert' }, box, idle)
    expect(filled.write).toEqual({ text: 'heXXllo', cursor: 4 })
    expect(filled.answer).toEqual({ requestId: 'f', op: 'fill', isFilled: true, box: { text: 'heXXllo', cursor: 4 } })
    const blocked = answerComposerRequest({ requestId: 'f', op: 'fill', text: 'XX', mode: 'insert' }, box, { ...idle, isBlocked: true })
    expect(blocked.write).toBeUndefined()
    expect(blocked.answer).toEqual({ requestId: 'f', op: 'fill', isFilled: false, refusal: 'dialog', box })
  })

  it('a suggestion shows in the empty box alone, while no turn runs', () => {
    const empty = { text: '', cursor: 0 }
    expect(answerComposerRequest({ requestId: 's', op: 'suggest', text: 'go' }, empty, idle)).toEqual({
      answer: { requestId: 's', op: 'suggest', isShown: true },
      suggest: 'go',
    })
    expect(answerComposerRequest({ requestId: 's', op: 'suggest', text: 'go' }, box, idle).answer).toMatchObject({ isShown: false })
    expect(answerComposerRequest({ requestId: 's', op: 'suggest', text: 'go' }, empty, { ...idle, isRunning: true }).answer).toMatchObject({ isShown: false })
  })
})

describe('useModComposer', () => {
  function fakeComposer(initial = ''): ModComposerRuntime & { type(text: string): void } {
    let text = initial
    const listeners = new Set<() => void>()
    const set = (next: string) => {
      text = next
      for (const listener of [...listeners]) listener()
    }
    return {
      getState: () => ({ text }),
      setText: set,
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      type: set,
    }
  }

  function mount(composer: ModComposerRuntime, props: { isRunning?: boolean; isBlocked?: boolean } = {}) {
    let listener: ((request: ModUiComposerRequest) => void) | undefined
    const answers: ModUiComposerAnswer[] = []
    const value: ModUiContextValue = {
      ...EMPTY_MOD_UI,
      onComposerRequest: next => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      answerComposer: async answer => {
        answers.push(answer)
      },
    }
    const textarea = document.createElement('textarea')
    const input = { current: textarea }
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(ModUiContext.Provider, { value }, children)
    const hook = renderHook(
      ({ isRunning, isBlocked }: { isRunning: boolean; isBlocked: boolean }) =>
        useModComposer({ composer, input, isRunning, isBlocked }),
      { wrapper, initialProps: { isRunning: props.isRunning ?? false, isBlocked: props.isBlocked ?? false } },
    )
    return { hook, answers, textarea, ask: (request: ModUiComposerRequest) => act(() => listener?.(request)) }
  }

  it('a fill is answered before the box is written: a slow re-render cannot outlast the runtime wait', () => {
    const composer = fakeComposer('')
    const { answers, ask } = mount(composer)
    let answeredAtWrite: number | null = null
    const setText = composer.setText
    composer.setText = text => {
      answeredAtWrite = answers.length
      setText(text)
    }
    ask({ requestId: 'f', op: 'fill', text: 'draft', mode: 'replace' })
    expect(composer.getState().text).toBe('draft')
    expect(answeredAtWrite).toBe(1)
    expect(answers).toEqual([{ requestId: 'f', op: 'fill', isFilled: true, box: { text: 'draft', cursor: 5 } }])
  })

  it('a fill writes the draft and puts the caret after the text; a read answers the caret', () => {
    vi.useFakeTimers()
    try {
      const composer = fakeComposer('hello')
      const { answers, textarea, ask } = mount(composer)
      textarea.value = 'hello'
      textarea.setSelectionRange(2, 2)
      ask({ requestId: 'r', op: 'read' })
      ask({ requestId: 'f', op: 'fill', text: 'XX', mode: 'insert' })
      expect(composer.getState().text).toBe('heXXllo')
      // A read before the textarea holds the text answers the caret placed.
      ask({ requestId: 'r2', op: 'read' })
      textarea.value = 'heXXllo'
      act(() => {
        vi.runAllTimers()
      })
      expect(textarea.selectionStart).toBe(4)
      expect(answers).toEqual([
        { requestId: 'r', op: 'read', box: { text: 'hello', cursor: 2 } },
        { requestId: 'f', op: 'fill', isFilled: true, box: { text: 'heXXllo', cursor: 4 } },
        { requestId: 'r2', op: 'read', box: { text: 'heXXllo', cursor: 4 } },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a suggestion shows in the empty box; Tab takes it; typing or a turn takes it away', () => {
    const composer = fakeComposer('')
    const { hook, answers, ask } = mount(composer)
    ask({ requestId: 's1', op: 'suggest', text: 'run the tests' })
    expect(answers.at(-1)).toEqual({ requestId: 's1', op: 'suggest', isShown: true })
    expect(hook.result.current.suggestion).toBe('run the tests')
    let taken = false
    act(() => {
      taken = hook.result.current.takeSuggestion()
    })
    expect(taken).toBe(true)
    expect(composer.getState().text).toBe('run the tests')
    expect(hook.result.current.suggestion).toBeNull()

    act(() => composer.type(''))
    ask({ requestId: 's2', op: 'suggest', text: 'again' })
    expect(hook.result.current.suggestion).toBe('again')
    act(() => composer.type('m'))
    expect(hook.result.current.suggestion).toBeNull()

    act(() => composer.type(''))
    ask({ requestId: 's3', op: 'suggest', text: 'once more' })
    expect(hook.result.current.suggestion).toBe('once more')
    hook.rerender({ isRunning: true, isBlocked: false })
    expect(hook.result.current.suggestion).toBeNull()
    ask({ requestId: 's4', op: 'suggest', text: 'mid-turn' })
    expect(answers.at(-1)).toEqual({ requestId: 's4', op: 'suggest', isShown: false })
    expect(hook.result.current.suggestion).toBeNull()
  })

  it('under a question a fill is refused with dialog and the draft is untouched', () => {
    const composer = fakeComposer('typed')
    const { answers, textarea, ask } = mount(composer, { isBlocked: true })
    textarea.value = 'typed'
    textarea.setSelectionRange(5, 5)
    ask({ requestId: 'f', op: 'fill', text: 'x', mode: 'replace' })
    expect(composer.getState().text).toBe('typed')
    expect(answers).toEqual([{ requestId: 'f', op: 'fill', isFilled: false, refusal: 'dialog', box: { text: 'typed', cursor: 5 } }])
  })
})
