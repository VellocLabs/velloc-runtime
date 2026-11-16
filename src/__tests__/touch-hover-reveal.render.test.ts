// @vitest-environment happy-dom
/**
 * Controls the conversation reveals only on hover carry the `(hover: none)`
 * classes that show them on a touch screen, and keep their hover reveal for a
 * mouse (F-24). The media query itself is applied by the browser; the phone
 * e2e checks the computed result under touch emulation.
 */
import { createElement as h, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

import { TRANSCRIPT_MESSAGE_COMPONENTS } from '../components/assistant-ui/thread'
import { InjectMessagesContext } from '../components/assistant-ui/inject-message-context'
import { CopyButton } from '../components/assistant-ui/file-content-view'
import {
  HIDDEN_WITHOUT_HOVER,
  IN_FLOW_WITHOUT_HOVER,
  SHOWN_WITHOUT_HOVER,
} from '../components/assistant-ui/touch-reveal'
import { TooltipProvider } from '../components/ui/tooltip'

vi.mock('../browser/webview/i18n', () => ({
  useT: () => (key: string) => key,
}))

afterEach(() => cleanup())

const MESSAGES: ThreadMessageLike[] = [
  { id: 'u1', role: 'user', content: 'run the tests' },
  { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'All green.' }] },
  { id: 'u2', role: 'user', content: 'and lint', metadata: { custom: { injectState: 'pending' } } },
]

const Harness: FC<{ index: number }> = ({ index }) => {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: MESSAGES,
    convertMessage: m => m,
    isRunning: false,
    onNew: async () => {},
  })
  return h(
    TooltipProvider,
    null,
    h(
      AssistantRuntimeProvider,
      { runtime },
      h(
        InjectMessagesContext.Provider,
        { value: { removeInjectMessage: async () => ({ ok: true }) } },
        h(
          ThreadPrimitive.Root,
          null,
          h(ThreadPrimitive.MessageByIndex, { index, components: TRANSCRIPT_MESSAGE_COMPONENTS } as never),
        ),
      ),
    ),
  )
}

const classesOf = (el: Element | null) => new Set((el?.getAttribute('class') ?? '').split(/\s+/))
const tokens = (set: string) => set.split(' ')

function expectHas(el: Element | null, ...sets: string[]) {
  expect(el).not.toBeNull()
  const classes = classesOf(el)
  for (const token of sets.flatMap(tokens)) expect(classes, token).toContain(token)
}

describe('hover-only conversation controls on a touch screen', () => {
  it("a user row's action bar (Copy, Rewind, Fork) is shown in flow; its hover bridge is dropped", () => {
    const { container } = render(h(Harness, { index: 0 }))
    const bar = container.querySelector('.aui-user-action-bar-wrapper')
    expectHas(bar, IN_FLOW_WITHOUT_HOVER, SHOWN_WITHOUT_HOVER, 'opacity-0 group-hover:opacity-100')
    expectHas(container.querySelector('.aui-user-action-bar-bridge'), HIDDEN_WITHOUT_HOVER)
  })

  it("an assistant row's action bar is shown in flow; its hover bridge is dropped", () => {
    const { container } = render(h(Harness, { index: 1 }))
    const bar = container.querySelector('.aui-assistant-message-footer')
    expectHas(bar, IN_FLOW_WITHOUT_HOVER, SHOWN_WITHOUT_HOVER, 'opacity-0 group-hover:opacity-100')
    expectHas(container.querySelector('.aui-assistant-message-footer-bridge'), HIDDEN_WITHOUT_HOVER)
  })

  it("a pending inject's remove button is shown", () => {
    const { container } = render(h(Harness, { index: 2 }))
    expectHas(
      container.querySelector('[data-testid="inject-message-remove"]'),
      SHOWN_WITHOUT_HOVER,
      'opacity-0 group-hover:opacity-100',
    )
  })

  it("a file view's hover Copy button is shown; an always-visible one is unchanged", () => {
    const { container } = render(
      h(TooltipProvider, null, h('div', null, h(CopyButton, { text: 'a.ts' }), h(CopyButton, { text: 'b.ts', alwaysVisible: true }))),
    )
    const [hover, always] = Array.from(container.querySelectorAll('button'))
    expectHas(hover, SHOWN_WITHOUT_HOVER, 'opacity-0 group-hover:opacity-100')
    for (const token of tokens(SHOWN_WITHOUT_HOVER)) expect(classesOf(always)).not.toContain(token)
  })
})
