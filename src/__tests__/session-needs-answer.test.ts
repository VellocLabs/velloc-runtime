import { describe, expect, it } from 'vitest'
import {
  snapshotHaltedOnUser,
  snapshotNeedsAnswer,
  submitCarriesToolResult,
  toolResultIdsInPrompt,
} from '../utils/sessionNeedsAnswer'
import type { AgentRuntimeWorkerSnapshot } from '../browser/worker/workerProtocol'

/**
 * `snapshotNeedsAnswer` is the shell-side predicate for the session-list
 * "needs your response" dot: true iff the session is HALTED on an approval
 * control the user must resolve. It must NOT fire for a merely-busy session
 * (streaming / inflight tools) — only for the interactive halts.
 */

function snap(
  partial: Partial<AgentRuntimeWorkerSnapshot>,
): AgentRuntimeWorkerSnapshot {
  return partial as AgentRuntimeWorkerSnapshot
}

describe('snapshotNeedsAnswer', () => {
  it('is false for a missing / empty snapshot', () => {
    expect(snapshotNeedsAnswer(null)).toBe(false)
    expect(snapshotNeedsAnswer(undefined)).toBe(false)
    expect(snapshotNeedsAnswer(snap({}))).toBe(false)
  })

  it('is true when a tool-use confirm is queued (plan/enter-plan/permission ask)', () => {
    expect(
      snapshotNeedsAnswer(
        snap({
          approvalQueue: [
            { toolName: 'ExitPlanMode', approvalCallId: 't1' },
          ] as never,
        }),
      ),
    ).toBe(true)
  })

  it('is true when a plan approval is staged', () => {
    expect(
      snapshotNeedsAnswer(
        snap({
          pendingPlanApproval: {
            t1: { toolName: 'ExitPlanMode', planText: '# plan' },
          } as never,
        }),
      ),
    ).toBe(true)
  })

  it('is true when a permission ask is pending', () => {
    expect(
      snapshotNeedsAnswer(
        snap({ pendingPermissions: { t1: { toolName: 'Bash' } } as never }),
      ),
    ).toBe(true)
  })

  it('is true when a user-interaction tool (AskUserQuestion) is halted', () => {
    expect(
      snapshotNeedsAnswer(
        snap({
          pendingUserInteraction: { t1: { toolName: 'AskUserQuestion' } },
        }),
      ),
    ).toBe(true)
  })

  it('is false for empty collections (busy-but-not-waiting)', () => {
    expect(
      snapshotNeedsAnswer(
        snap({
          approvalQueue: [],
          pendingPlanApproval: {},
          pendingPermissions: {},
          pendingUserInteraction: {},
          isBusy: true,
        }),
      ),
    ).toBe(false)
  })
})

describe('snapshotHaltedOnUser (the parked-input consume gate)', () => {
  it('is true only for a question halt or a staged plan approval', () => {
    expect(snapshotHaltedOnUser(null)).toBe(false)
    expect(snapshotHaltedOnUser(snap({}))).toBe(false)
    expect(
      snapshotHaltedOnUser(snap({ pendingUserInteraction: { t: { toolName: 'AskUserQuestion' } } })),
    ).toBe(true)
    expect(snapshotHaltedOnUser(snap({ pendingPlanApproval: { t: {} as never } }))).toBe(true)
  })

  it('ignores in-turn asks (permission, confirm queue) that snapshotNeedsAnswer counts', () => {
    const inTurn = snap({
      pendingPermissions: { t: {} as never },
      approvalQueue: [{ toolName: 'Bash', approvalCallId: 't' }] as never,
    })
    expect(snapshotNeedsAnswer(inTurn)).toBe(true)
    expect(snapshotHaltedOnUser(inTurn)).toBe(false)
  })
})

describe('submitCarriesToolResult', () => {
  it('is false for a string prompt', () => {
    expect(submitCarriesToolResult('hello')).toBe(false)
  })

  it('is false for a prompt with no tool-result blocks', () => {
    expect(
      submitCarriesToolResult([{ type: 'text', text: 'hi' }]),
    ).toBe(false)
    expect(submitCarriesToolResult([])).toBe(false)
  })

  it('is true for the internal tool-result shape (BrowserRuntimeClient.submitToolResult)', () => {
    expect(
      submitCarriesToolResult([
        { type: 'tool-result', toolCallId: 'tc-1', result: 'ok' },
      ]),
    ).toBe(true)
  })

  it('is true for the Anthropic tool_result shape (defensive)', () => {
    expect(
      submitCarriesToolResult([
        { type: 'tool_result', tool_use_id: 'tc-1', content: 'ok' },
      ]),
    ).toBe(true)
  })

  it('is true when any block in a mixed prompt is a tool-result', () => {
    expect(
      submitCarriesToolResult([
        { type: 'text', text: 'see attached' },
        { type: 'tool-result', toolCallId: 'tc-2', result: 'noted' },
      ]),
    ).toBe(true)
  })
})

describe('toolResultIdsInPrompt', () => {
  it('is empty for a string prompt or a prompt with no tool-result blocks', () => {
    expect(toolResultIdsInPrompt('hello')).toEqual([])
    expect(toolResultIdsInPrompt([{ type: 'text', text: 'hi' }])).toEqual([])
  })

  it('reads both shapes, in order, and skips an id-less result', () => {
    expect(
      toolResultIdsInPrompt([
        { type: 'tool-result', toolCallId: 'tc-1', result: 'ok' },
        { type: 'text', text: 'see attached' },
        { type: 'tool_result', tool_use_id: 'tc-2', content: 'ok' },
        { type: 'tool-result', result: 'no id' },
      ]),
    ).toEqual(['tc-1', 'tc-2'])
  })

  it('ignores an id on a block that is not a tool result', () => {
    // A tool-call block carries a toolCallId too; it answers nothing.
    expect(
      toolResultIdsInPrompt([{ type: 'tool-call', toolCallId: 'tc-3' }]),
    ).toEqual([])
  })
})
