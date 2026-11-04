import { describe, expect, it } from 'vitest'
import type { ModelReplyRow, WorkingState } from '../runtime/RuntimeTypes'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import { NoopPlatformCapabilities, createEmptyAppState, createNoopToolUseContext } from '../runtime/testing/noopAdapters'
import { declareTool, type ToolInvocation } from '../toolkit/toolContract'
import { executeToolCall } from '../toolkit/run/executeToolCall'

describe('the executor tells a tool which call it is running', () => {
  it('passes each call its own id, also when one reply holds two calls of the same tool', async () => {
    const seen: Array<ToolInvocation | undefined> = []
    const tool = declareTool({
      name: 'Probe',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Probe',
      call: async (_input, _context, _permission, _row, _progress, invocation) => {
        seen.push(invocation)
        return { data: { ok: true } }
      },
      readsOnly: () => true,
    })
    let state: WorkingState = createEmptyAppState()
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: state,
      setAppState: updater => { state = updater(state) },
    })
    const calls = [
      { type: 'tool-call' as const, toolCallId: 'call-a', toolName: 'Probe', args: {} },
      { type: 'tool-call' as const, toolCallId: 'call-b', toolName: 'Probe', args: {} },
    ]
    const reply: ModelReplyRow = { type: 'assistant', uuid: 'assistant-probe', message: { role: 'assistant', content: calls } }
    for (const call of calls) {
      for await (const _update of executeToolCall(call, reply, async () => ({ behavior: 'allow' }), context, { uuid: () => 'u' } as QueryRuntimeDeps)) { /* drain */ }
    }
    expect(seen).toEqual([{ toolCallId: 'call-a' }, { toolCallId: 'call-b' }])
  })
})
