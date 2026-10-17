// @vitest-environment happy-dom
/**
 * The page's half of `prompt.autocomplete`, `prompt.change` and `virtualText` (F-25): the query the typeahead asks
 * the mods, the box's untyped changes it tells (a clear, an undo), and the virtual text drawn after the draft for
 * as long as the draft is the one it was drawn on. The runtime's half is `mod-prompt-box-events`.
 */
import * as React from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import type { ModsPromptChange } from '../browser/runtimeProtocol'
import { modsComposerControls } from '../browser/webview/mods/modsUiView'
import {
  autocompleteQueryAt,
  autocompleteQueryKey,
  landFillRuns,
  trailingVirtualText,
  untypedInputCause,
} from '../components/assistant-ui/mod-prompt-box'
import { EMPTY_MOD_UI, ModUiContext, type ModUiComposerRequest, type ModUiContextValue } from '../components/assistant-ui/mod-ui-context'
import { useModComposer, type ModComposerRuntime } from '../components/assistant-ui/use-mod-composer'

describe('the helpers', () => {
  it("a fill's runs land where its text does: at 0 for replace, after the draft for append, at the caret for insert", () => {
    const runs = [{ start: 0, end: 2, virtualText: '!' }]
    const before = { text: 'hello', cursor: 2 }
    expect(landFillRuns(runs, 'replace', before)).toEqual([{ start: 0, end: 2, virtualText: '!' }])
    expect(landFillRuns(runs, 'append', before)).toEqual([{ start: 5, end: 7, virtualText: '!' }])
    expect(landFillRuns(runs, 'insert', before)).toEqual([{ start: 2, end: 4, virtualText: '!' }])
  })

  it("the virtual text drawn is the runs ending at the draft's end, for that draft alone", () => {
    const draft = { text: 'deploy', runs: [{ start: 0, end: 6, virtualText: ' to' }, { start: 0, end: 3, virtualText: 'mid' }, { start: 6, end: 9, virtualText: ' staging' }] }
    expect(trailingVirtualText(draft, 'deploy')).toBe(' to staging')
    expect(trailingVirtualText(draft, 'deploy!')).toBeNull()
    expect(trailingVirtualText({ text: 'ab', runs: [{ start: 0, end: 1, virtualText: 'x' }] }, 'ab')).toBeNull()
    expect(trailingVirtualText(null, '')).toBeNull()
  })

  it('the typeahead asks about the token ending at the caret; an undo or a redo is the untyped input', () => {
    expect(autocompleteQueryAt('see #ab', 7)).toEqual({ text: 'see #ab', cursor: 7, token: '#ab', start: 4 })
    expect(autocompleteQueryAt('see ', 4)).toBeNull()
    expect(autocompleteQueryKey({ text: 'a', cursor: 1, token: 'a', start: 0 })).not.toBe(
      autocompleteQueryKey({ text: 'ab', cursor: 1, token: 'a', start: 0 }),
    )
    expect(untypedInputCause('historyUndo')).toBe('undo')
    expect(untypedInputCause('historyRedo')).toBe('undo')
    expect(untypedInputCause('insertText')).toBeNull()
  })
})

describe('the wire', () => {
  it('a connection that may ask gets promptAutocomplete and promptChange; one that may not, neither', async () => {
    const request = vi.fn(async (route: string) => (route === 'mods.promptAutocomplete' ? { suggestions: [{ text: '#abc' }] } : {}))
    const connection = { subscribe: () => () => {}, request, can: () => true } as unknown as RuntimeConnection
    const controls = modsComposerControls(connection, 's1')
    const query = { text: '#a', cursor: 2, token: '#a', start: 0 }
    await expect(controls.promptAutocomplete!(query)).resolves.toEqual([{ text: '#abc' }])
    await controls.promptChange!({ text: '', cursor: 0, cause: 'clear' })
    expect(request).toHaveBeenCalledWith('mods.promptAutocomplete', { sessionId: 's1', query })
    expect(request).toHaveBeenCalledWith('mods.promptChange', { sessionId: 's1', change: { text: '', cursor: 0, cause: 'clear' } })
    const none = { subscribe: () => () => {}, request, can: () => false } as unknown as RuntimeConnection
    expect(modsComposerControls(none, 's1')).toEqual({})
  })
})

describe('useModComposer', () => {
  function fakeComposer(initial = ''): ModComposerRuntime {
    let text = initial
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

  function mount(composer: ModComposerRuntime, changeHooked = false) {
    let listener: ((request: ModUiComposerRequest) => void) | undefined
    const changes: ModsPromptChange[] = []
    const value: ModUiContextValue = {
      ...EMPTY_MOD_UI,
      onComposerRequest: next => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      answerComposer: async () => {},
      changeHooked,
      promptChange: async change => {
        changes.push(change)
      },
    }
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    const input = { current: textarea }
    const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(ModUiContext.Provider, { value }, children)
    const hook = renderHook(() => useModComposer({ composer, input, isRunning: false, isBlocked: false }), { wrapper })
    return { hook, textarea, changes, ask: (request: ModUiComposerRequest) => act(() => listener?.(request)) }
  }

  it("a fill's virtual text is drawn after the draft it landed in, and goes at the draft's next change", async () => {
    const composer = fakeComposer('ship')
    const { hook, ask } = mount(composer)
    expect(hook.result.current.virtualText).toBeNull()
    await ask({ requestId: 'f', op: 'fill', text: ' it', mode: 'append', decorations: [{ start: 0, end: 3, virtualText: ' — Tab to send' }] })
    expect(composer.getState().text).toBe('ship it')
    expect(hook.result.current.virtualText).toEqual({ draft: 'ship it', text: ' — Tab to send' })
    act(() => composer.setText('ship it!'))
    expect(hook.result.current.virtualText).toBeNull()
    expect(composer.getState().text).toBe('ship it!')
  })

  it('while a mod hooks prompt.change, the box emptied by a send is a clear and an undo is told; typing is neither', async () => {
    const composer = fakeComposer('draft')
    const { textarea, changes } = mount(composer, true)
    act(() => composer.setText(''))
    expect(changes).toEqual([{ text: '', cursor: 0, cause: 'clear' }])

    act(() => {
      composer.setText('typed')
    })
    textarea.value = 'dra'
    act(() => {
      textarea.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyUndo' }))
      textarea.dispatchEvent(new InputEvent('input', { inputType: 'historyUndo' }))
    })
    expect(changes.at(-1)).toMatchObject({ text: 'dra', cause: 'undo' })

    const before = changes.length
    act(() => {
      textarea.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward' }))
      composer.setText('')
    })
    expect(changes).toHaveLength(before)
  })

  it('without a prompt.change hook nothing is told', () => {
    const composer = fakeComposer('draft')
    const { changes } = mount(composer, false)
    act(() => composer.setText(''))
    expect(changes).toEqual([])
  })
})
