import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentWorkerOutboundMessage } from '../browser/worker/workerProtocol'
import {
  BrowserRuntimeClient,
  type BrowserWorkerClientTransport,
} from '../browser/webview/BrowserRuntimeClient'

const gate = vi.hoisted(() => ({
  release: null as (() => void) | null,
  fail: false,
}))

vi.mock('../browser/webview/RuntimeClientDetailRequests', async importOriginal => {
  await new Promise<void>(resolve => {
    gate.release = resolve
  })
  if (gate.fail) throw new Error('chunk load failed')
  return importOriginal()
})

function createTransport(): BrowserWorkerClientTransport {
  const listeners = new Set<(message: AgentWorkerOutboundMessage) => void>()
  return {
    async postMessage(message) {
      const reply: AgentWorkerOutboundMessage | null =
        message.type === 'worker.init'
          ? { type: 'worker.ready', payload: {} as never }
          : message.type === 'worker.getToolCallDetail'
            ? {
                type: 'worker.toolCallDetail',
                payload: { toolCallId: message.payload.toolCallId, detail: null },
              }
            : null
      if (!reply) return
      for (const listener of listeners) listener(reply)
    },
    addMessageListener(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const hostBridgeTransport = {
  async request() {
    return { ok: true } as never
  },
}

async function untilGateWaits(): Promise<void> {
  await vi.waitFor(() => expect(gate.release).not.toBeNull())
}

describe('BrowserRuntimeClient detail-request import failure', () => {
  afterEach(() => {
    gate.release?.()
  })

  it('a failed import is not cached: the next detail request imports again', async () => {
    gate.fail = true
    const client = new BrowserRuntimeClient({
      createWorkerTransport: createTransport,
      hostBridgeTransport,
      initPayload: { cwd: '/workspace' },
    })
    await client.start()

    const failed = client.loadToolCallDetail('tool-1')
    await untilGateWaits()
    gate.release!()
    await expect(failed).rejects.toThrow()

    const load = (client as unknown as { detailRequestsLoad: unknown }).detailRequestsLoad
    expect(load).toBeNull()
  })
})
