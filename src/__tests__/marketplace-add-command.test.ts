// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { AppendMessage } from '@assistant-ui/react'

import { marketplaceAddSourceOf } from '../browser/webview/customize/marketplaceAddCommand'
import { useComposerSubmit } from '../browser/webview/useComposerSubmit'

describe('marketplaceAddSourceOf', () => {
  it('reads the repository from each spelling of the add command', () => {
    expect(marketplaceAddSourceOf('/plugin marketplace add acme/tools')).toBe('acme/tools')
    expect(marketplaceAddSourceOf('/plugin market add acme/tools')).toBe('acme/tools')
    expect(marketplaceAddSourceOf('/marketplace add https://github.com/acme/tools')).toBe('https://github.com/acme/tools')
    expect(marketplaceAddSourceOf('  /marketplace   add   acme/tools  ')).toBe('acme/tools')
  })

  it('leaves every other text to be sent as typed', () => {
    expect(marketplaceAddSourceOf('/marketplace add')).toBeNull()
    expect(marketplaceAddSourceOf('/marketplace add not a repository')).toBeNull()
    expect(marketplaceAddSourceOf('/marketplace add https://gitlab.com/acme/tools')).toBeNull()
    expect(marketplaceAddSourceOf('/marketplace list')).toBeNull()
    expect(marketplaceAddSourceOf('/plugin install cool@acme')).toBeNull()
    expect(marketplaceAddSourceOf('please run /marketplace add acme/tools')).toBeNull()
    expect(marketplaceAddSourceOf('/marketplace add acme/tools\nand more')).toBeNull()
  })
})

describe('useComposerSubmit — a command the shell takes', () => {
  const message = (text: string, attachments: unknown[] = []) =>
    ({
      role: 'user',
      content: [{ type: 'text', text }],
      attachments,
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    }) as unknown as AppendMessage

  function submitHook(intercept: (text: string) => boolean) {
    const submitComposerMessage = vi.fn(async () => {})
    const setRestoreComposerText = vi.fn()
    const interceptComposerText = vi.fn(intercept)
    const { result } = renderHook(() =>
      useComposerSubmit({
        state: { transcriptMessages: [] } as never,
        readOnly: false,
        activeSessionId: 's1',
        submitPrompt: vi.fn(async () => {}),
        submitComposerMessage,
        interceptComposerText,
        onSendInForkedSession: undefined,
        onAdoptDefaultSelection: undefined,
        snapshotRef: { current: null },
        // Parks the send gate: only what happens before it is under test.
        waitForSnapshot: () => new Promise<void>(() => {}),
        runtimeBusyRef: { current: false },
        lockToBottomRef: { current: false },
        nextDeliveryRef: { current: undefined },
        findViewport: () => null,
        setProviderPrompt: vi.fn(),
        setRestoreComposerText,
      }),
    )
    return { onNew: result.current.onNew, submitComposerMessage, setRestoreComposerText, interceptComposerText }
  }

  it('a taken text is neither sent nor handed back to the composer', async () => {
    const hook = submitHook(() => true)
    await hook.onNew(message('/marketplace add acme/tools'))
    expect(hook.interceptComposerText).toHaveBeenCalledWith('/marketplace add acme/tools')
    expect(hook.submitComposerMessage).not.toHaveBeenCalled()
    expect(hook.setRestoreComposerText).not.toHaveBeenCalled()
  })

  it('a text with an attachment is never offered to the shell', () => {
    const hook = submitHook(() => true)
    void hook.onNew(message('/marketplace add acme/tools', [{ id: 'a1' }]))
    expect(hook.interceptComposerText).not.toHaveBeenCalled()
  })
})
