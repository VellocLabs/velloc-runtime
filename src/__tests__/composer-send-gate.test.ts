import { describe, expect, it, vi } from 'vitest'
import { resolveComposerSendGate } from '../browser/webview/AssistantUiThread'
import {
  canCompactSession,
  continueReasonMessageKey,
  resolveComposerActionDisabled,
  resolveComposerActionVisibility,
  sendCompactCommand,
  shouldSendOnRunningEnter,
} from '../components/assistant-ui/thread'
import type { AgentRuntimeWorkerSnapshot } from '../browser/worker/workerProtocol'

/**
 * The composer gates, pure so they are pinned without mounting assistant-ui: `resolveComposerSendGate` (every
 * outcome but `send` is a refusal the caller pairs with a text restore), `shouldSendOnRunningEnter` (Enter
 * submits while running), `resolveComposerActionVisibility` (exactly one of Send / Stop / Continue renders) and
 * `continueReasonMessageKey` (the Continue tooltip's sentence).
 */

function snapshot(
  overrides: Partial<AgentRuntimeWorkerSnapshot> = {},
): AgentRuntimeWorkerSnapshot {
  return {
    initialized: true,
    sessionId: 'session-a',
    cwd: '/workspace',
    currentProviderId: 'demo',
    activeModelId: 'demo-model',
    currentSelection: { providerId: 'demo', modelId: 'demo-model' },
    modelCatalog: {
      providers: [
        {
          id: 'demo',
          name: 'Demo',
          enabled: true,
          models: [{ id: 'demo-model', name: 'Demo Model', enabled: true }],
        },
      ],
      defaultSelection: { providerId: 'demo', modelId: 'demo-model' },
    } as unknown as AgentRuntimeWorkerSnapshot['modelCatalog'],
    availableModels: ['demo-model'],
    toolNames: [],
    commandNames: [],
    messageCount: 0,
    isBusy: false,
    isStopping: false,
    pendingBridgeRequestIds: [],
    ...overrides,
  }
}

describe('resolveComposerSendGate', () => {
  it('sends when the session is ready and its pinned model is usable', () => {
    expect(
      resolveComposerSendGate({
        snapshot: snapshot(),
        activeSessionId: 'session-a',
        canAdoptDefault: true,
      }),
    ).toEqual({ kind: 'send' })
  })

  it('sends while the agent is BUSY — a mid-turn submit is the next message', () => {
    expect(
      resolveComposerSendGate({
        snapshot: snapshot({ isBusy: true }),
        activeSessionId: 'session-a',
        canAdoptDefault: true,
      }).kind,
    ).toBe('send')
  })

  it('refuses before the snapshot arrives', () => {
    expect(
      resolveComposerSendGate({
        snapshot: null,
        activeSessionId: 'session-a',
        canAdoptDefault: true,
      }),
    ).toEqual({ kind: 'not-ready' })
  })

  it('refuses when this thread is not the session the submit callbacks target', () => {
    // Every submit path is bound to the ACTIVE session's client, so a
    // background thread would gate on ITS snapshot and send into another
    // session. Unreachable today (background threads are display:none) — the
    // guard keeps the gate and the target from drifting apart.
    expect(
      resolveComposerSendGate({
        snapshot: snapshot({ sessionId: 'session-b' }),
        activeSessionId: 'session-a',
        canAdoptDefault: true,
      }),
    ).toEqual({ kind: 'wrong-session' })
  })

  it('sends in a single-session embed with no activeSessionId', () => {
    expect(
      resolveComposerSendGate({
        snapshot: snapshot({ sessionId: 'session-b' }),
        canAdoptDefault: true,
      }).kind,
    ).toBe('send')
  })

  it('refuses while halted on a permission / plan approval', () => {
    // Reachable via Enter: the send BUTTON is disabled for this, but the
    // composer input deliberately is not (the user may draft while deciding).
    expect(
      resolveComposerSendGate({
        snapshot: snapshot({
          approvalQueue: [{ approvalCallId: 'tu-1' }],
        } as unknown as Partial<AgentRuntimeWorkerSnapshot>),
        activeSessionId: 'session-a',
        canAdoptDefault: true,
      }),
    ).toEqual({ kind: 'awaiting-confirm' })
  })

  it('refuses until a code session has bound a project folder', () => {
    expect(
      resolveComposerSendGate({
        snapshot: snapshot({
          needsProjectFolder: true,
        } as Partial<AgentRuntimeWorkerSnapshot>),
        activeSessionId: 'session-a',
        canAdoptDefault: true,
      }),
    ).toEqual({ kind: 'needs-project-folder' })
  })

  it('adopts the catalog default when the pinned model went away', () => {
    const decision = resolveComposerSendGate({
      snapshot: snapshot({
        currentSelection: { providerId: 'demo', modelId: 'retired-model' },
      }),
      activeSessionId: 'session-a',
      canAdoptDefault: true,
    })
    expect(decision.kind).toBe('adopt-default')
    expect(
      decision.kind === 'adopt-default' ? decision.selection : null,
    ).toEqual({ providerId: 'demo', modelId: 'demo-model' })
  })

  it('falls back to the provider dialog when nothing usable is configured', () => {
    expect(
      resolveComposerSendGate({
        snapshot: snapshot({
          currentSelection: { providerId: 'demo', modelId: 'retired-model' },
          modelCatalog: null,
        }),
        activeSessionId: 'session-a',
        canAdoptDefault: true,
      }),
    ).toEqual({ kind: 'provider-missing' })
  })
})

describe('shouldSendOnRunningEnter', () => {
  const base = {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    defaultPrevented: false,
    isRunning: true,
    sendBlocked: false,
    hasContent: true,
  }

  it('sends a mid-turn Enter — the case the primitive refuses to handle', () => {
    expect(shouldSendOnRunningEnter(base)).toBe(true)
  })

  it('leaves an idle Enter to the primitive', () => {
    expect(shouldSendOnRunningEnter({ ...base, isRunning: false })).toBe(false)
  })

  it('never steals a key the slash-command picker already consumed', () => {
    // The picker listens on the document in the CAPTURE phase, so it runs
    // first and marks the event handled.
    expect(shouldSendOnRunningEnter({ ...base, defaultPrevented: true })).toBe(
      false,
    )
  })

  it('keeps Shift+Enter as a newline', () => {
    expect(shouldSendOnRunningEnter({ ...base, shiftKey: true })).toBe(false)
  })

  it.each(['ctrlKey', 'metaKey', 'altKey'] as const)(
    'ignores Enter with %s held',
    modifier => {
      expect(shouldSendOnRunningEnter({ ...base, [modifier]: true })).toBe(false)
    },
  )

  it('ignores an IME composition commit', () => {
    expect(shouldSendOnRunningEnter({ ...base, isComposing: true })).toBe(false)
  })

  it('ignores a non-Enter key', () => {
    expect(shouldSendOnRunningEnter({ ...base, key: 'a' })).toBe(false)
  })

  it('does not send an empty composer', () => {
    expect(shouldSendOnRunningEnter({ ...base, hasContent: false })).toBe(false)
  })

  it('mirrors the send button: blocked while a question is unanswered', () => {
    expect(shouldSendOnRunningEnter({ ...base, sendBlocked: true })).toBe(false)
  })
})

describe('resolveComposerActionVisibility', () => {
  it('idle + empty: Send only (the disabled affordance), no Stop', () => {
    expect(
      resolveComposerActionVisibility({ isRunning: false, hasContent: false }),
    ).toEqual({ showSend: true, showStop: false, showContinue: false })
  })

  it('idle + has content: Send only, no Stop', () => {
    expect(
      resolveComposerActionVisibility({ isRunning: false, hasContent: true }),
    ).toEqual({ showSend: true, showStop: false, showContinue: false })
  })

  it('running + empty: Stop only, Send hidden', () => {
    expect(
      resolveComposerActionVisibility({ isRunning: true, hasContent: false }),
    ).toEqual({ showSend: false, showStop: true, showContinue: false })
  })

  it('running + has content: Send only — Stop is HIDDEN while text is typed', () => {
    // The regression this pins: typing mid-turn used to render Send AND Stop
    // side by side; the contract is that Send is the sole action then.
    expect(
      resolveComposerActionVisibility({ isRunning: true, hasContent: true }),
    ).toEqual({ showSend: true, showStop: false, showContinue: false })
  })

  it('never shows both buttons in any state', () => {
    for (const isRunning of [true, false]) {
      for (const hasContent of [true, false]) {
        const { showSend, showStop } = resolveComposerActionVisibility({
          isRunning,
          hasContent,
        })
        expect(showSend && showStop).toBe(false)
        // And at least one affordance is always present.
        expect(showSend || showStop).toBe(true)
      }
    }
  })

  it('empty composer alone does NOT show Stop — the turn must also be running', () => {
    // "Empty is a precondition for Stop's visibility, not a guarantee."
    expect(
      resolveComposerActionVisibility({ isRunning: false, hasContent: false })
        .showStop,
    ).toBe(false)
  })

  describe('with a resumable conversation (canContinue)', () => {
    it('idle + empty: Continue REPLACES Send — the disabled slot is reused', () => {
      // The point of the change: no standalone continue banner above the
      // composer, and no Continue rendered alongside Send.
      expect(
        resolveComposerActionVisibility({
          isRunning: false,
          hasContent: false,
          canContinue: true,
        }),
      ).toEqual({ showSend: false, showStop: false, showContinue: true })
    })

    it('idle + has content: typing swaps Continue back to Send', () => {
      expect(
        resolveComposerActionVisibility({
          isRunning: false,
          hasContent: true,
          canContinue: true,
        }),
      ).toEqual({ showSend: true, showStop: false, showContinue: false })
    })

    it('running + empty: Stop wins — mid-turn there is nothing to resume', () => {
      expect(
        resolveComposerActionVisibility({
          isRunning: true,
          hasContent: false,
          canContinue: true,
        }),
      ).toEqual({ showSend: false, showStop: true, showContinue: false })
    })

    it('running + has content: Send, never Continue', () => {
      expect(
        resolveComposerActionVisibility({
          isRunning: true,
          hasContent: true,
          canContinue: true,
        }),
      ).toEqual({ showSend: true, showStop: false, showContinue: false })
    })

    it('exactly one action button is visible in every state', () => {
      for (const isRunning of [true, false]) {
        for (const hasContent of [true, false]) {
          for (const canContinue of [true, false]) {
            const { showSend, showStop, showContinue } =
              resolveComposerActionVisibility({
                isRunning,
                hasContent,
                canContinue,
              })
            expect(
              [showSend, showStop, showContinue].filter(Boolean).length,
            ).toBe(1)
          }
        }
      }
    })

    it('canContinue defaults to false so the plain Send/Stop contract is unchanged', () => {
      expect(
        resolveComposerActionVisibility({ isRunning: false, hasContent: false })
          .showContinue,
      ).toBe(false)
    })
  })
})

describe('resolveComposerActionDisabled', () => {
  const armed = {
    hasContent: true,
    awaitingAnswer: false,
    pendingSend: false,
    pendingCancel: false,
    isStopping: false,
    continuePending: false,
  }

  it('all three are live when nothing is pending', () => {
    expect(resolveComposerActionDisabled(armed)).toEqual({
      sendDisabled: false,
      cancelDisabled: false,
      continueDisabled: false,
    })
  })

  // The rule the three buttons share: a click makes THAT button inert until
  // the state it is waiting for arrives. Without it a second click lands on
  // work already in flight — a duplicate submit, a duplicate abort, or a
  // second resume that replays the whole context.
  it('a pending click disables its own button and only its own', () => {
    expect(
      resolveComposerActionDisabled({ ...armed, pendingSend: true }),
    ).toEqual({
      sendDisabled: true,
      cancelDisabled: false,
      continueDisabled: false,
    })
    expect(
      resolveComposerActionDisabled({ ...armed, pendingCancel: true }),
    ).toEqual({
      sendDisabled: false,
      cancelDisabled: true,
      continueDisabled: false,
    })
    expect(
      resolveComposerActionDisabled({ ...armed, continuePending: true }),
    ).toEqual({
      sendDisabled: false,
      cancelDisabled: false,
      continueDisabled: true,
    })
  })

  it('Stop stays inert while the worker is tearing the turn down', () => {
    // `isStopping` is the worker's own signal; the local pendingCancel flag
    // only covers the round-trip before it arrives.
    expect(
      resolveComposerActionDisabled({ ...armed, isStopping: true })
        .cancelDisabled,
    ).toBe(true)
  })

  it('Send needs content, and stays inert while a question is unanswered', () => {
    expect(
      resolveComposerActionDisabled({ ...armed, hasContent: false })
        .sendDisabled,
    ).toBe(true)
    expect(
      resolveComposerActionDisabled({ ...armed, awaitingAnswer: true })
        .sendDisabled,
    ).toBe(true)
  })
})

describe('continueReasonMessageKey', () => {
  it('maps each known terminal reason to its own sentence', () => {
    expect(continueReasonMessageKey('aborted_streaming')).toBe(
      'thread.conversationCancelled',
    )
    expect(continueReasonMessageKey('max_output_tokens')).toBe(
      'thread.hitTokenLimit',
    )
    expect(continueReasonMessageKey('completed')).toBe('thread.addFollowUp')
  })

  it('falls back to the generic line for unknown / absent reasons', () => {
    expect(continueReasonMessageKey(undefined)).toBe(
      'thread.conversationInterrupted',
    )
    expect(continueReasonMessageKey('something_new')).toBe(
      'thread.conversationInterrupted',
    )
  })
})

describe('Compact session (context ring)', () => {
  const idle = {
    isRunning: false,
    sendBlocked: false,
    isStopping: false,
    runtimeReady: true,
  }

  it('is enabled only where a send would be accepted', () => {
    expect(canCompactSession(idle)).toBe(true)
    expect(canCompactSession({ ...idle, isRunning: true })).toBe(false)
    // An AskUserQuestion halt is not running, yet the send button and Enter
    // refuse there — so must Compact.
    expect(canCompactSession({ ...idle, sendBlocked: true })).toBe(false)
    expect(canCompactSession({ ...idle, isStopping: true })).toBe(false)
    expect(canCompactSession({ ...idle, runtimeReady: false })).toBe(false)
  })

  it('appends /compact on its own, leaving the draft and its attachments in the composer', () => {
    // A composer holding a draft with an attachment: `composer.send()` would
    // take the attachment along with the command and clear it.
    const composer = {
      setText: vi.fn(),
      send: vi.fn(),
      clearAttachments: vi.fn(),
      reset: vi.fn(),
    }
    const append = vi.fn()
    const thread = { append, composer }
    sendCompactCommand(thread)
    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith('/compact')
    expect(composer.send).not.toHaveBeenCalled()
    expect(composer.setText).not.toHaveBeenCalled()
    expect(composer.clearAttachments).not.toHaveBeenCalled()
    expect(composer.reset).not.toHaveBeenCalled()
  })
})
