// @vitest-environment happy-dom
import { createElement, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { BackgroundTasksFooterControl } from '../components/assistant-ui/background-tasks-footer-control'
import { BackgroundTasksContext } from '../components/assistant-ui/background-tasks-context'

/**
 * The composer-footer "session still working" indicator: a settled turn with
 * running background tasks WILL receive more task-notification turns, so the
 * session must not read as fully done. Needs a live runtime (thread.isRunning)
 * + the BackgroundTasksContext feed.
 */

const SETTLED_MESSAGE: ThreadMessageLike = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done.' }],
}

function makeHarness(
  isRunning: boolean,
  contextValue: {
    openTasksDrawer?: (id?: string) => void
    runningTaskCount?: number
  },
): FC {
  const AssistantMessage: FC = () => null
  const UserMessage: FC = () => null
  return function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [SETTLED_MESSAGE],
      convertMessage: (m) => m,
      isRunning,
      onNew: async () => {},
    })
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(
        BackgroundTasksContext.Provider,
        { value: contextValue },
        createElement(
          ThreadPrimitive.Root,
          null,
          createElement(
            ThreadPrimitive.Viewport,
            null,
            createElement(ThreadPrimitive.Messages, {
              components: { AssistantMessage, UserMessage },
            }),
            createElement(BackgroundTasksFooterControl),
          ),
        ),
      ),
    )
  }
}

const control = () =>
  document.querySelector('[data-testid="background-tasks-footer-control"]')

afterEach(() => cleanup())

describe('BackgroundTasksFooterControl', () => {
  it('shows when the turn is settled but background tasks are still running, and opens the drawer', () => {
    const openTasksDrawer = vi.fn()
    render(
      createElement(
        makeHarness(false, { openTasksDrawer, runningTaskCount: 2 }),
      ),
    )
    expect(control()).not.toBeNull()
    expect(control()!.textContent).toContain(
      '2 background tasks still running',
    )
    expect(control()!.textContent).toContain('results will be posted here')
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="background-tasks-footer-view"]',
      )!
      .click()
    expect(openTasksDrawer).toHaveBeenCalledTimes(1)
  })

  it('singular copy for one task', () => {
    render(createElement(makeHarness(false, { runningTaskCount: 1 })))
    expect(control()!.textContent).toContain(
      '1 background task still running',
    )
  })

  it('hidden while the turn is streaming (RunningIndicator owns that state)', () => {
    render(
      createElement(makeHarness(true, { runningTaskCount: 2 })),
    )
    expect(control()).toBeNull()
  })

  it('hidden with no running background tasks', () => {
    render(createElement(makeHarness(false, { runningTaskCount: 0 })))
    expect(control()).toBeNull()
    cleanup()
    render(createElement(makeHarness(false, {})))
    expect(control()).toBeNull()
  })
})
