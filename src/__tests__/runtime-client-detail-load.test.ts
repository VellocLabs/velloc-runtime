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

describe('BrowserRuntimeClient lazy detail requests', () => {
  afterEach(() => {
    gate.release?.()
  })

  it('a detail request pending across dispose resolves null and does not restart the client', async () => {
    const createWorkerTransport = vi.fn(createTransport)
    const client = new BrowserRuntimeClient({
      createWorkerTransport,
      hostBridgeTransport,
      initPayload: { cwd: '/workspace' },
    })
    await client.start()
    expect(createWorkerTransport).toHaveBeenCalledTimes(1)

    const detail = client.loadToolCallDetail('tool-1')
    await untilGateWaits()
    await client.dispose()
    gate.release!()

    await expect(detail).resolves.toBeNull()
    expect(createWorkerTransport).toHaveBeenCalledTimes(1)
  })
})
